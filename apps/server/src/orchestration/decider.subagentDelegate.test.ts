import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  SUBAGENT_STARTED_ACTIVITY_KIND,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-09-28T00:00:00.000Z";
const opus = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" };

function makeReadModel(settledOverride: "settled" | null): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("parent"),
        projectId: ProjectId.make("project-1"),
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
        settledOverride,
        settledAt: settledOverride === null ? null : NOW,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

const delegateCommand = {
  type: "thread.turn.delegate" as const,
  commandId: CommandId.make("cmd-delegate"),
  threadId: ThreadId.make("parent"),
  message: {
    messageId: MessageId.make("msg-1"),
    role: "user" as const,
    text: "Implement the fix",
    attachments: [],
  },
  delegation: {
    childThreadId: ThreadId.make("child"),
    reuseChild: false,
    messageId: MessageId.make("msg-1"),
    modelSelection: opus,
    efficiencyDecision: {
      tier: "quality" as const,
      modelSelection: opus,
      source: "tier-policy" as const,
      workload: "interactive" as const,
      contextThresholdPercent: 90,
      toolWarningThreshold: 24,
    },
    interactionMode: "default" as const,
  },
  createdAt: NOW,
};

it.layer(NodeServices.layer)("thread.turn.delegate decider", (it) => {
  it.effect("records the message and the subagent handoff without starting a parent turn", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: delegateCommand,
        readModel: makeReadModel(null),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.activity-appended",
      ]);
      const [message, activity] = events;
      if (message?.type === "thread.message-sent") {
        expect(message.payload.messageId).toBe("msg-1");
        expect(message.payload.role).toBe("user");
      }
      if (activity?.type === "thread.activity-appended") {
        expect(activity.causationEventId).toBe(message?.eventId);
        expect(activity.payload.activity.kind).toBe(SUBAGENT_STARTED_ACTIVITY_KIND);
        expect(activity.payload.activity.payload).toMatchObject({
          childThreadId: "child",
          reuseChild: false,
          modelSelection: opus,
        });
      }
    }),
  );

  it.effect("wakes a settled parent like any user message", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: delegateCommand,
        readModel: makeReadModel("settled"),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events[0]?.type).toBe("thread.unsettled");
    }),
  );
});
