import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  CommandCenterInboxApproveAdjustmentInput,
  CommandCenterInboxProposalPayload,
} from "./commandCenterInbox.ts";

const proposal = {
  kind: "sprint-plan-task-patch",
  target: { kind: "sprint-plan", id: "fixture-plan" },
  expectedPlanVersion: 1,
  operations: [{ taskId: "fixture-task", field: "note", before: "old", after: "new" }],
  reason: "Clarify the synthetic task.",
  expectedBenefit: "Less ambiguity.",
  uncertainty: "Unmeasured.",
  reviewAt: "2026-10-30T00:00:00.000Z",
  preservedConstraints: ["Keep the unrelated tasks."],
} as const;

describe("Sprint plan adjustment boundary", () => {
  const decodeProposal = Schema.decodeUnknownSync(CommandCenterInboxProposalPayload);
  const decodeApproval = Schema.decodeUnknownSync(CommandCenterInboxApproveAdjustmentInput);

  it("accepts a bounded exact field patch and rejects duplicate, no-op, and wrong-type fields", () => {
    expect(decodeProposal(proposal).kind).toBe("sprint-plan-task-patch");
    expect(() => decodeProposal({ ...proposal, operations: [] })).toThrow();
    expect(() =>
      decodeProposal({
        ...proposal,
        operations: [proposal.operations[0], proposal.operations[0]],
      }),
    ).toThrow();
    expect(() =>
      decodeProposal({
        ...proposal,
        operations: [{ ...proposal.operations[0], after: "old" }],
      }),
    ).toThrow();
    expect(() =>
      decodeProposal({
        ...proposal,
        operations: [{ taskId: "fixture-task", field: "done", before: false, after: "true" }],
      }),
    ).toThrow();
    expect(() => decodeProposal({ ...proposal, expectedPlanVersion: -1 })).toThrow();
  });

  it("takes only identifiers and optimistic versions from an approval request", () => {
    const request = {
      spaceId: "fixture-space",
      itemId: "fixture-item",
      currentRevisionId: "revision:a",
      expectedInboxVersion: 2,
      expectedPlanVersion: 1,
      mutationId: "approve-a",
    };
    expect(
      decodeApproval({
        ...request,
        actor: "attacker",
        approved: true,
        payload: proposal,
        evidenceDigest: `sha256:${"0".repeat(64)}`,
        provenance: { kind: "manual" },
      }),
    ).toEqual(request);
    expect(() => decodeApproval({ ...request, expectedInboxVersion: -1 })).toThrow();
  });
});
