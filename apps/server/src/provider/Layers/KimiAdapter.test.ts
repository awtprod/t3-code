import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  KimiSettings,
  ApprovalRequestId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import type { KimiRuntimeClient } from "../kimiRuntime.ts";
import { makeKimiAdapter } from "./KimiAdapter.ts";

const decodeKimiSettings = Schema.decodeEffect(KimiSettings);

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-kimi-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(testLayer)("KimiAdapter", (it) => {
  it.effect("preserves sessions and maps cache, questions, and native subagents", () =>
    Effect.gen(function* () {
      const calls: Array<{ path: string; body: unknown }> = [];
      let callback: ((event: Record<string, unknown>) => void) | undefined;
      const runtime: KimiRuntimeClient = {
        ensureServer: Effect.succeed({ origin: "http://127.0.0.1:1", token: "test" }),
        request: <T>(
          path: string,
          init?: { readonly method?: string; readonly body?: unknown },
        ) => {
          calls.push({ path, body: init?.body });
          if (path === "/sessions" && init?.method === "POST") {
            return Effect.succeed({ id: "kimi-session-1" } as T);
          }
          if (path === "/sessions/kimi-session-1") {
            return Effect.succeed({ id: "kimi-session-1" } as T);
          }
          if (path.endsWith("/prompts")) {
            return Effect.succeed({ prompt_id: "prompt-1" } as T);
          }
          return Effect.succeed({} as T);
        },
        subscribe: (_sessionId, onEvent) =>
          Effect.sync(() => {
            callback = onEvent;
            return { close: Effect.void };
          }),
      };
      const settings = yield* decodeKimiSettings({ enabled: true });
      const adapter = yield* makeKimiAdapter(settings, runtime, {
        instanceId: ProviderInstanceId.make("kimi-main"),
      });
      const events: ProviderRuntimeEvent[] = [];
      const completed = yield* Deferred.make<void>();
      const backgroundCompleted = yield* Deferred.make<void>();
      const questionOpened = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "user-input.requested"
              ? Deferred.succeed(questionOpened, undefined)
              : event.type === "turn.usage.recorded" &&
                  event.payload.usage.component.kind === "subagent"
                ? Deferred.succeed(backgroundCompleted, undefined)
                : event.type === "turn.completed"
                  ? Deferred.succeed(completed, undefined)
                  : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const threadId = ThreadId.make("kimi-thread");
      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("kimi-main"),
          model: "kimi-code/k3",
        },
      });
      yield* adapter.sendTurn({ threadId, input: "First turn" });
      assert.isDefined(callback);
      callback!({
        type: "agent.status.updated",
        session_id: "kimi-session-1",
        agent_id: "main",
        payload: {
          usage: {
            currentTurn: {
              inputOther: 100,
              inputCacheRead: 40,
              inputCacheCreation: 10,
              output: 20,
            },
          },
          maxContextTokens: 262_144,
        },
      });
      callback!({
        type: "subagent.spawned",
        session_id: "kimi-session-1",
        payload: {
          subagentId: "agent-1",
          subagentName: "Explore",
          parentToolCallId: "call-1",
          runInBackground: true,
          swarmIndex: 0,
        },
      });
      callback!({
        type: "event.question.requested",
        session_id: "kimi-session-1",
        payload: {
          question_id: "question-1",
          questions: [
            {
              id: "q_0",
              header: "Choice",
              question: "Pick one?",
              options: [
                { id: "opt-a", label: "A", description: "Choose A" },
                { id: "opt-b", label: "B", description: "Choose B" },
              ],
            },
          ],
        },
      });
      yield* Deferred.await(questionOpened);
      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("question-1"), {
        q_0: "B",
      });
      callback!({
        type: "turn.ended",
        session_id: "kimi-session-1",
        agent_id: "main",
        payload: { reason: "completed", durationMs: 25 },
      });
      yield* Deferred.await(completed);
      callback!({
        type: "subagent.completed",
        session_id: "kimi-session-1",
        payload: {
          subagentId: "agent-1",
          resultSummary: "Found the files",
          usage: {
            inputOther: 12,
            inputCacheRead: 3,
            inputCacheCreation: 1,
            output: 4,
          },
        },
      });
      yield* Deferred.await(backgroundCompleted);

      const usage = events.find((event) => event.type === "thread.token-usage.updated");
      assert.equal(
        usage?.type === "thread.token-usage.updated"
          ? usage.payload.usage.lastCacheWriteInputTokens
          : undefined,
        10,
      );
      const subagent = events.find(
        (event) => event.type === "item.completed" && String(event.itemId) === "subagent:agent-1",
      );
      assert.equal(
        subagent?.type === "item.completed" && typeof subagent.payload.data === "object"
          ? (subagent.payload.data as { swarmIndex?: number }).swarmIndex
          : undefined,
        0,
      );
      const subagentUsage = events.find(
        (event) =>
          event.type === "turn.usage.recorded" && event.payload.usage.component.kind === "subagent",
      );
      assert.equal(
        subagentUsage?.type === "turn.usage.recorded"
          ? subagentUsage.payload.usage.cacheReadInputTokens
          : undefined,
        3,
      );
      assert.deepStrictEqual(
        calls.find((call) => call.path.endsWith("/questions/question-1"))?.body,
        { answers: { q_0: { kind: "single", option_id: "opt-b" } } },
      );

      yield* adapter.stopSession(threadId);
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: session.resumeCursor,
        modelSelection: {
          instanceId: ProviderInstanceId.make("kimi-main"),
          model: "kimi-code/k3",
        },
      });
      assert.equal(calls.filter((call) => call.path === "/sessions").length, 1);
      assert.equal(calls.filter((call) => call.path === "/sessions/kimi-session-1").length, 1);
    }),
  );
});
