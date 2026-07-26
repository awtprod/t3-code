import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  OrchestrationProposedPlanId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = asProjectId("project-resume");
const THREAD_ID = asThreadId("thread-resume");
const USER_MESSAGE_ID = asMessageId("msg-user-1");
const ASSISTANT_MESSAGE_ID = asMessageId("msg-assistant-1");

// Seed a project + thread + one user message (and one assistant message) so the
// resume decider has a real user message to re-issue.
const seedReadModel = Effect.gen(function* () {
  const initial = createEmptyReadModel(NOW);
  const withProject = yield* projectEvent(initial, {
    sequence: 1,
    eventId: asEventId("evt-project-create"),
    aggregateKind: "project",
    aggregateId: PROJECT_ID,
    type: "project.created",
    occurredAt: NOW,
    commandId: asCommandId("cmd-project-create"),
    causationEventId: null,
    correlationId: asCommandId("cmd-project-create"),
    metadata: {},
    payload: {
      projectId: PROJECT_ID,
      title: "Project Resume",
      workspaceRoot: "/tmp/project-resume",
      defaultModelSelection: null,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
  });

  const withThread = yield* projectEvent(withProject, {
    sequence: 2,
    eventId: asEventId("evt-thread-create"),
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.created",
    occurredAt: NOW,
    commandId: asCommandId("cmd-thread-create"),
    causationEventId: null,
    correlationId: asCommandId("cmd-thread-create"),
    metadata: {},
    payload: {
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Thread Resume",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  });

  const withUserMessage = yield* projectEvent(withThread, {
    sequence: 3,
    eventId: asEventId("evt-user-message"),
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.message-sent",
    occurredAt: NOW,
    commandId: asCommandId("cmd-user-message"),
    causationEventId: null,
    correlationId: asCommandId("cmd-user-message"),
    metadata: {},
    payload: {
      threadId: THREAD_ID,
      messageId: USER_MESSAGE_ID,
      role: "user",
      text: "do the multi-step thing",
      attachments: [],
      turnId: null,
      streaming: false,
      createdAt: NOW,
      updatedAt: NOW,
    },
  });

  return yield* projectEvent(withUserMessage, {
    sequence: 4,
    eventId: asEventId("evt-assistant-message"),
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.message-sent",
    occurredAt: NOW,
    commandId: asCommandId("cmd-assistant-message"),
    causationEventId: null,
    correlationId: asCommandId("cmd-assistant-message"),
    metadata: {},
    payload: {
      threadId: THREAD_ID,
      messageId: ASSISTANT_MESSAGE_ID,
      role: "assistant",
      text: "working on it",
      attachments: [],
      turnId: null,
      streaming: false,
      createdAt: NOW,
      updatedAt: NOW,
    },
  });
});

const resumeCommand = (
  messageId: MessageId,
  options?: {
    readonly modelSelection?: { instanceId: ProviderInstanceId; model: string };
    readonly sourceProposedPlan?: { threadId: ThreadId; planId: OrchestrationProposedPlanId };
  },
): OrchestrationCommand => ({
  type: "thread.turn.resume",
  commandId: asCommandId("cmd-resume"),
  threadId: THREAD_ID,
  messageId,
  ...(options?.modelSelection !== undefined ? { modelSelection: options.modelSelection } : {}),
  ...(options?.sourceProposedPlan !== undefined
    ? { sourceProposedPlan: options.sourceProposedPlan }
    : {}),
  reason: "auto-resume after provider session exit: crashed",
  createdAt: NOW,
});

it.layer(NodeServices.layer)("decider thread.turn.resume", (it) => {
  it.effect("emits exactly one turn-start-requested and no message-sent", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const result = yield* decideOrchestrationCommand({
        command: resumeCommand(USER_MESSAGE_ID),
        readModel,
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events).toHaveLength(1);
      const [event] = events;
      expect(event.type).toBe("thread.turn-start-requested");
      // No duplicate user message: this is what keeps the transcript clean.
      expect(events.some((entry) => entry.type === "thread.message-sent")).toBe(false);

      // The re-issued turn targets the existing user message and carries the
      // thread's runtime/interaction modes (no modelSelection — resolved later).
      expect(event.type === "thread.turn-start-requested" ? event.payload.messageId : null).toBe(
        USER_MESSAGE_ID,
      );
      expect(event.type === "thread.turn-start-requested" ? event.payload.runtimeMode : null).toBe(
        "full-access",
      );
      // Without a command modelSelection the payload omits it (the reactor falls
      // back to the thread default), so the field is absent, not null.
      expect(
        event.type === "thread.turn-start-requested" ? event.payload.modelSelection : "unexpected",
      ).toBeUndefined();
    }),
  );

  it.effect("carries the interrupted turn's modelSelection into the re-issued turn", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const modelSelection = {
        instanceId: ProviderInstanceId.make("codex_high"),
        model: "gpt-5-codex-high",
      };
      const result = yield* decideOrchestrationCommand({
        command: resumeCommand(USER_MESSAGE_ID, { modelSelection }),
        readModel,
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events).toHaveLength(1);
      const [event] = events;
      expect(event.type).toBe("thread.turn-start-requested");
      // The interrupted turn's model selection is carried through so the
      // restarted session resolves to the same instance/model (findings 1 + 3).
      expect(
        event.type === "thread.turn-start-requested" ? event.payload.modelSelection : null,
      ).toEqual(modelSelection);
    }),
  );

  it.effect("carries the interrupted turn's source proposed-plan into the re-issued turn", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const sourceProposedPlan = {
        threadId: THREAD_ID,
        planId: OrchestrationProposedPlanId.make("plan-source-1"),
      };
      const result = yield* decideOrchestrationCommand({
        command: resumeCommand(USER_MESSAGE_ID, { sourceProposedPlan }),
        readModel,
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events).toHaveLength(1);
      const [event] = events;
      expect(event.type).toBe("thread.turn-start-requested");
      // The interrupted turn's source proposed-plan reference is carried through
      // so a resumed plan-implementation turn re-associates with (and can mark
      // implemented) its originating plan (R4-2). The resume decider does not
      // re-validate plan existence — the original turn-start already did.
      expect(
        event.type === "thread.turn-start-requested" ? event.payload.sourceProposedPlan : null,
      ).toEqual(sourceProposedPlan);
    }),
  );

  it.effect("carries both modelSelection and source proposed-plan together", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const modelSelection = {
        instanceId: ProviderInstanceId.make("codex_max"),
        model: "gpt-5-codex-max",
      };
      const sourceProposedPlan = {
        threadId: THREAD_ID,
        planId: OrchestrationProposedPlanId.make("plan-source-2"),
      };
      const result = yield* decideOrchestrationCommand({
        command: resumeCommand(USER_MESSAGE_ID, { modelSelection, sourceProposedPlan }),
        readModel,
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events).toHaveLength(1);
      const [event] = events;
      expect(event.type).toBe("thread.turn-start-requested");
      expect(
        event.type === "thread.turn-start-requested" ? event.payload.modelSelection : null,
      ).toEqual(modelSelection);
      expect(
        event.type === "thread.turn-start-requested" ? event.payload.sourceProposedPlan : null,
      ).toEqual(sourceProposedPlan);
    }),
  );

  // The two cases below assert the DECIDER's half of the contract only: it
  // plans nothing. That is not the same as "the command is a no-op" — the
  // engine turns an empty plan into an `OrchestrationCommandInvariantError`
  // ("Command produced no events.", OrchestrationEngine.ts:184), which the
  // auto-resume caller catches and logs as a benign skip
  // (ProviderRuntimeIngestion.ts:2192). Naming these "no-op" would describe the
  // observable behaviour of a layer this file does not exercise. The end-to-end
  // rejection is covered in OrchestrationEngine.test.ts ("rejects a resume for
  // a message that no longer exists"), so the two halves are asserted where
  // each actually lives.
  it.effect("plans no events when the referenced message does not exist", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const result = yield* decideOrchestrationCommand({
        command: resumeCommand(asMessageId("msg-does-not-exist")),
        readModel,
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events).toHaveLength(0);
    }),
  );

  it.effect("plans no events when the referenced message is not a user message", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const result = yield* decideOrchestrationCommand({
        command: resumeCommand(ASSISTANT_MESSAGE_ID),
        readModel,
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events).toHaveLength(0);
    }),
  );
});
