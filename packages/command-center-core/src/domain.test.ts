import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ApprovalStatus,
  CommandSubmission,
  ItemStatus,
  MemoryStatus,
  RunStatus,
} from "./domain.ts";
import { classifyActionRisk } from "./risk.ts";

it("accepts every public workflow status and rejects unknown statuses", () => {
  const decodeItemStatus = Schema.decodeUnknownSync(ItemStatus);
  const decodeRunStatus = Schema.decodeUnknownSync(RunStatus);
  const decodeApprovalStatus = Schema.decodeUnknownSync(ApprovalStatus);
  const decodeMemoryStatus = Schema.decodeUnknownSync(MemoryStatus);

  for (const status of [
    "captured",
    "ready",
    "in_progress",
    "waiting",
    "review",
    "done",
    "canceled",
  ] as const) {
    assert.strictEqual(decodeItemStatus(status), status);
  }
  for (const status of [
    "queued",
    "running",
    "waiting_approval",
    "waiting",
    "succeeded",
    "failed",
    "canceled",
  ] as const) {
    assert.strictEqual(decodeRunStatus(status), status);
  }
  for (const status of ["requested", "approved", "declined", "expired", "canceled"] as const) {
    assert.strictEqual(decodeApprovalStatus(status), status);
  }
  for (const status of ["candidate", "approved", "rejected", "expired", "archive"] as const) {
    assert.strictEqual(decodeMemoryStatus(status), status);
  }

  assert.throws(() => decodeItemStatus("paused"));
  assert.throws(() => decodeRunStatus("complete"));
  assert.throws(() => decodeApprovalStatus("accepted"));
  assert.throws(() => decodeMemoryStatus("trusted"));
});

it("trims command fields at the public boundary", () => {
  const decodeCommand = Schema.decodeUnknownSync(CommandSubmission);
  const command = decodeCommand({
    commandId: " command-1 ",
    text: " Summarize the sample project ",
    spaceId: " example-space ",
    providerId: " provider-a ",
    modelId: " model-a ",
  });

  assert.strictEqual(command.commandId, "command-1");
  assert.strictEqual(command.text, "Summarize the sample project");
  assert.strictEqual(command.spaceId, "example-space");
  assert.strictEqual(command.providerId, "provider-a");
  assert.strictEqual(command.modelId, "model-a");
});

it("classifies low-risk, reversible, approval-gated, and blocked actions", () => {
  assert.deepStrictEqual(classifyActionRisk("read"), {
    actionKind: "read",
    level: "low",
    approvalRequired: false,
    reversible: false,
  });
  assert.deepStrictEqual(classifyActionRisk("worktree.edit"), {
    actionKind: "worktree.edit",
    level: "reversible",
    approvalRequired: false,
    reversible: true,
  });
  assert.deepStrictEqual(classifyActionRisk("git.push"), {
    actionKind: "git.push",
    level: "approval-required",
    approvalRequired: true,
    reversible: false,
  });
  assert.deepStrictEqual(classifyActionRisk("google.write"), {
    actionKind: "google.write",
    level: "blocked",
    approvalRequired: false,
    reversible: false,
  });
});
