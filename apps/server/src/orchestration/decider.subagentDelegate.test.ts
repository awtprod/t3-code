import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  SandboxId,
  SUBAGENT_STARTED_ACTIVITY_KIND,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-09-28T00:00:00.000Z";
const opus = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" };

function makeReadModel(
  settledOverride: "settled" | null,
  sandbox?: OrchestrationThread["sandbox"],
): OrchestrationReadModel {
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
        ...(sandbox === undefined ? {} : { sandbox }),
      },
    ],
    updatedAt: NOW,
  };
}

const sandbox = (
  overrides: Partial<NonNullable<OrchestrationThread["sandbox"]>>,
): NonNullable<OrchestrationThread["sandbox"]> => ({
  lifecycle: "ready",
  sandboxId: SandboxId.make("sandbox-parent"),
  runtime: "podman",
  runtimeRef: "t3-thread-parent",
  branch: { branchName: "thread/parent", baseCommit: "a".repeat(40) },
  limits: {
    cpuCount: 2,
    memoryBytes: 4_294_967_296,
    diskBytes: 21_474_836_480,
    processCount: 512,
    idleTimeoutSeconds: 3600,
    maximumLifetimeSeconds: 28_800,
  },
  desktop: { status: "unavailable" },
  services: [],
  controller: { kind: "none" },
  createdAt: NOW,
  lastActiveAt: NOW,
  ...overrides,
});

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

  it.effect("refuses to delegate while a human holds the sandbox takeover lease", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        decideOrchestrationCommand({
          command: delegateCommand,
          readModel: makeReadModel(
            null,
            sandbox({
              controller: {
                kind: "human",
                leaseId: "lease-1",
                sessionId: "viewer-1",
                acquiredAt: NOW,
              },
            }),
          ),
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(exit)).toContain("human takeover lease");
    }),
  );

  it.effect("refuses to delegate while the sandbox is not ready", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        decideOrchestrationCommand({
          command: delegateCommand,
          readModel: makeReadModel(null, sandbox({ lifecycle: "provisioning" })),
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(exit)).toContain("sandbox is provisioning");
    }),
  );

  it.effect("delegates from a ready sandbox thread", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: delegateCommand,
        readModel: makeReadModel(null, sandbox({})),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.activity-appended",
      ]);
    }),
  );
});
