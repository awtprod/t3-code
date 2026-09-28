import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { buildSubagentHandoffText, subagentReport } from "./SubagentDelegationReactor.ts";

const NOW = "2026-09-28T00:00:00.000Z";
const LATER = "2026-09-28T00:05:00.000Z";

const message = (
  id: string,
  role: "user" | "assistant",
  text: string,
  turnId: string | null = null,
): OrchestrationThread["messages"][number] => ({
  id: MessageId.make(id),
  role,
  text,
  turnId: turnId === null ? null : TurnId.make(turnId),
  streaming: false,
  createdAt: NOW,
  updatedAt: NOW,
});

const thread = (input: Partial<OrchestrationThread>): OrchestrationThread => ({
  id: ThreadId.make("thread"),
  projectId: ProjectId.make("project"),
  title: "Review plan",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
  ...input,
});

describe("buildSubagentHandoffText", () => {
  it("hands over the recent parent conversation and the task, not the task twice", () => {
    const text = buildSubagentHandoffText({
      parent: thread({
        messages: [
          message("m1", "user", "Review the plan"),
          message("m2", "assistant", "Two blockers: A and B"),
          message("m3", "user", "Now implement the fix"),
        ],
      }),
      delegatedMessageId: MessageId.make("m3"),
      task: "Now implement the fix",
    });
    expect(text).toContain('from the thread "Review plan" (on gpt-6-astra)');
    expect(text).toContain("--- assistant ---\nTwo blockers: A and B");
    expect(text.match(/Now implement the fix/g)).toHaveLength(1);
    expect(text.endsWith("Task:\nNow implement the fix")).toBe(true);
  });

  it("bounds the handed-over history", () => {
    const text = buildSubagentHandoffText({
      parent: thread({
        messages: Array.from({ length: 20 }, (_, index) =>
          message(`m${index}`, "user", `${index}:${"x".repeat(5_000)}`),
        ),
      }),
      delegatedMessageId: MessageId.make("task"),
      task: "go",
    });
    expect(text).not.toContain("--- user ---\n11:");
    expect(text).toContain("--- user ---\n12:");
    expect(text.length).toBeLessThan(8 * 1_600 + 1_000);
  });
});

describe("subagentReport", () => {
  it("waits while the delegated turn runs", () => {
    const child = thread({
      latestTurn: {
        turnId: TurnId.make("t1"),
        state: "running",
        requestedAt: LATER,
        startedAt: LATER,
        completedAt: null,
        assistantMessageId: null,
      },
    });
    expect(subagentReport(child, LATER)).toBeUndefined();
  });

  it("ignores a turn that finished before the delegation", () => {
    const child = thread({
      latestTurn: {
        turnId: TurnId.make("t0"),
        state: "completed",
        requestedAt: NOW,
        startedAt: NOW,
        completedAt: NOW,
        assistantMessageId: null,
      },
    });
    expect(subagentReport(child, LATER)).toBeUndefined();
  });

  it("reports the last assistant reply of the delegated turn", () => {
    const child = thread({
      latestTurn: {
        turnId: TurnId.make("t1"),
        state: "completed",
        requestedAt: LATER,
        startedAt: LATER,
        completedAt: LATER,
        assistantMessageId: null,
      },
      messages: [
        message("a0", "assistant", "old turn", "t0"),
        message("a1", "assistant", "working on it", "t1"),
        message("a2", "assistant", "Done: fixed A and B", "t1"),
      ],
    });
    expect(subagentReport(child, LATER)).toEqual({
      turnId: "t1",
      state: "completed",
      text: "Done: fixed A and B",
    });
  });
});
