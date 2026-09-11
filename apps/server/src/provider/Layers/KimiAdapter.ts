import {
  EventId,
  type KimiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import type { KimiRuntimeClient } from "../kimiRuntime.ts";
import { makeKimiRuntimeClient } from "../kimiRuntime.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { isCommandCenterThreadId } from "../security/CommandCenterProviderIsolation.ts";
import { prepareKimiCommandCenterLaunch } from "../security/KimiCommandCenterIsolation.ts";

const PROVIDER = ProviderDriverKind.make("kimi");
const RESUME_VERSION = 1 as const;

interface KimiResumeCursor {
  readonly schemaVersion: typeof RESUME_VERSION;
  readonly sessionId: string;
}

interface KimiSessionRecord {
  session: ProviderSession;
  readonly nativeSessionId: string;
  readonly runtime: KimiRuntimeClient;
  readonly workload: "interactive" | "automation";
  readonly scope: Scope.Closeable;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  readonly subagents: Map<string, Record<string, unknown>>;
  readonly pendingQuestions: Map<
    string,
    ReadonlyArray<{
      readonly id: string;
      readonly options: ReadonlyArray<{ readonly id: string; readonly label: string }>;
    }>
  >;
  activePromptId?: string;
  activeTurnId?: TurnId;
  lastUsage?: Record<string, unknown>;
}

function parseResumeCursor(value: unknown): KimiResumeCursor | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === RESUME_VERSION &&
    typeof record.sessionId === "string" &&
    record.sessionId.trim().length > 0
    ? { schemaVersion: RESUME_VERSION, sessionId: record.sessionId.trim() }
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function turnUsage(value: unknown) {
  const usage = asRecord(value);
  return {
    uncachedInputTokens: optionalNonNegative(usage.inputOther),
    cacheReadInputTokens: optionalNonNegative(usage.inputCacheRead),
    cacheWriteInputTokens: optionalNonNegative(usage.inputCacheCreation),
    outputTokens: optionalNonNegative(usage.output),
  };
}

function approvalDecision(
  decision: "accept" | "acceptAlways" | "acceptForSession" | "decline" | "cancel",
) {
  // Kimi's approval protocol has no permanent grant, so "always" lands on the
  // widest scope it does support: the rest of this session.
  if (decision === "acceptForSession" || decision === "acceptAlways")
    return { decision: "approved", scope: "session" } as const;
  if (decision === "accept") return { decision: "approved" } as const;
  if (decision === "decline") return { decision: "rejected" } as const;
  return { decision: "cancelled" } as const;
}

export const makeKimiAdapter = Effect.fn("makeKimiAdapter")(function* (
  settings: KimiSettings,
  runtime: KimiRuntimeClient,
  options: { readonly instanceId: ProviderInstanceId; readonly environment?: NodeJS.ProcessEnv },
) {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* ServerConfig;
  const adapterScope = yield* Scope.Scope;
  const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, KimiSessionRecord>();

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const randomId = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Failed to create a Kimi runtime identifier.",
          cause,
        }),
    ),
  );
  const base = (threadId: ThreadId, raw?: unknown) =>
    Effect.all({ eventId: randomId.pipe(Effect.map(EventId.make)), createdAt: nowIso }).pipe(
      Effect.map(({ eventId, createdAt }) => ({
        eventId,
        provider: PROVIDER,
        providerInstanceId: options.instanceId,
        threadId,
        createdAt,
        ...(raw === undefined ? {} : { raw: { source: "kimi.web.event" as const, payload: raw } }),
      })),
    );
  const emit = (event: ProviderRuntimeEvent) => Queue.offer(events, event).pipe(Effect.asVoid);

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<KimiSessionRecord, ProviderAdapterSessionNotFoundError> => {
    const session = sessions.get(threadId);
    return session
      ? Effect.succeed(session)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };
  const request = <T>(
    client: KimiRuntimeClient,
    method: string,
    path: string,
    init?: { readonly method?: string; readonly body?: unknown },
  ): Effect.Effect<T, ProviderAdapterRequestError> =>
    client.request<T>(path, init).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method,
            detail: cause.detail,
            cause,
          }),
      ),
    );

  const handleNativeEvent = (
    context: KimiSessionRecord,
    frame: Record<string, unknown>,
  ): Effect.Effect<void, ProviderAdapterError> =>
    Effect.gen(function* () {
      const payload = asRecord(frame.payload);
      const type = typeof frame.type === "string" ? frame.type : String(payload.type ?? "unknown");
      const agentId = String(frame.agent_id ?? payload.agentId ?? payload.agent_id ?? "main");
      const isMainAgent = agentId === "main";
      const activeTurnId = context.activeTurnId;

      if ((type === "assistant.delta" || type === "thinking.delta") && isMainAgent) {
        const delta = typeof payload.delta === "string" ? payload.delta : "";
        if (delta && activeTurnId) {
          yield* emit({
            type: "content.delta",
            ...(yield* base(context.session.threadId, frame)),
            turnId: activeTurnId,
            payload: {
              streamKind: type === "assistant.delta" ? "assistant_text" : "reasoning_text",
              delta,
            },
          });
        }
        return;
      }

      if (type === "tool.call.started" && activeTurnId && isMainAgent) {
        const toolId = String(payload.toolCallId ?? (yield* randomId));
        yield* emit({
          type: "item.started",
          ...(yield* base(context.session.threadId, frame)),
          turnId: activeTurnId,
          itemId: RuntimeItemId.make(toolId),
          payload: {
            itemType: "dynamic_tool_call",
            status: "inProgress",
            title: typeof payload.name === "string" ? payload.name : "Kimi tool",
            data: payload,
          },
        });
        return;
      }

      if (type === "tool.result" && activeTurnId && isMainAgent) {
        const toolId = String(payload.toolCallId ?? "unknown-tool");
        yield* emit({
          type: "item.completed",
          ...(yield* base(context.session.threadId, frame)),
          turnId: activeTurnId,
          itemId: RuntimeItemId.make(toolId),
          payload: {
            itemType: "dynamic_tool_call",
            status: payload.isError === true ? "failed" : "completed",
            data: payload,
          },
        });
        return;
      }

      if (type === "agent.status.updated") {
        const statusUsage = asRecord(payload.usage);
        const usage = asRecord(statusUsage.currentTurn);
        if (!isMainAgent) {
          const previous = context.subagents.get(agentId);
          if (previous !== undefined) {
            context.subagents.set(agentId, { ...previous, usage: turnUsage(usage) });
          }
          return;
        }
        context.lastUsage = usage;
        const inputOther = optionalNonNegative(usage.inputOther);
        const cacheRead = optionalNonNegative(usage.inputCacheRead);
        const cacheWrite = optionalNonNegative(usage.inputCacheCreation);
        const output = optionalNonNegative(usage.output);
        if (
          inputOther !== undefined ||
          cacheRead !== undefined ||
          cacheWrite !== undefined ||
          output !== undefined
        ) {
          const allInput = (inputOther ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
          yield* emit({
            type: "thread.token-usage.updated",
            ...(yield* base(context.session.threadId, frame)),
            payload: {
              usage: {
                usedTokens: allInput,
                totalProcessedTokens: allInput + (output ?? 0),
                ...(optionalNonNegative(payload.maxContextTokens) === undefined
                  ? {}
                  : { maxTokens: optionalNonNegative(payload.maxContextTokens) }),
                inputTokens: allInput,
                ...(cacheRead === undefined ? {} : { cachedInputTokens: cacheRead }),
                ...(cacheWrite === undefined ? {} : { cacheWriteInputTokens: cacheWrite }),
                ...(output === undefined ? {} : { outputTokens: output }),
                lastUsedTokens: allInput,
                lastInputTokens: allInput,
                ...(cacheRead === undefined ? {} : { lastCachedInputTokens: cacheRead }),
                ...(cacheWrite === undefined ? {} : { lastCacheWriteInputTokens: cacheWrite }),
                ...(output === undefined ? {} : { lastOutputTokens: output }),
              },
            },
          });
        }
        return;
      }

      if (type.startsWith("subagent.")) {
        const providerAgentId =
          typeof payload.subagentId === "string" ? payload.subagentId.trim() : "";
        if (providerAgentId.length === 0) return;
        const previous = context.subagents.get(providerAgentId) ?? {};
        const parentTurnId =
          activeTurnId ??
          (typeof previous.parentTurnId === "string"
            ? TurnId.make(previous.parentTurnId)
            : undefined);
        const state =
          type === "subagent.spawned"
            ? "spawned"
            : type === "subagent.started"
              ? "running"
              : type === "subagent.suspended"
                ? "suspended"
                : type === "subagent.completed"
                  ? "completed"
                  : "failed";
        const data = {
          ...previous,
          provider: PROVIDER,
          providerAgentId,
          name: String(payload.subagentName ?? previous.name ?? "Kimi subagent"),
          description:
            typeof payload.description === "string"
              ? payload.description
              : (previous.description as string | undefined),
          ...(typeof (
            payload.parentToolCallUuid ??
            payload.parentToolCallId ??
            previous.parentToolCallId
          ) === "string"
            ? {
                parentToolCallId: String(
                  payload.parentToolCallUuid ??
                    payload.parentToolCallId ??
                    previous.parentToolCallId,
                ),
              }
            : {}),
          ...(parentTurnId ? { parentTurnId } : {}),
          ...(optionalNonNegative(payload.swarmIndex) === undefined
            ? {}
            : { swarmIndex: optionalNonNegative(payload.swarmIndex) }),
          ...(optionalNonNegative(payload.swarmSize) === undefined ||
          optionalNonNegative(payload.swarmSize) === 0
            ? {}
            : { swarmSize: optionalNonNegative(payload.swarmSize) }),
          mode:
            payload.runInBackground === true || previous.mode === "background"
              ? "background"
              : "foreground",
          state,
          resultSummary:
            typeof payload.resultSummary === "string" ? payload.resultSummary : undefined,
          errorSummary: typeof payload.error === "string" ? payload.error : undefined,
          usage:
            type === "subagent.completed" || type === "subagent.failed"
              ? turnUsage(payload.usage)
              : previous.usage,
        };
        context.subagents.set(providerAgentId, data);
        const itemId = RuntimeItemId.make(`subagent:${providerAgentId}`);
        yield* emit({
          type:
            type === "subagent.spawned"
              ? "item.started"
              : type === "subagent.completed" || type === "subagent.failed"
                ? "item.completed"
                : "item.updated",
          ...(yield* base(context.session.threadId, frame)),
          ...(parentTurnId ? { turnId: parentTurnId } : {}),
          itemId,
          payload: {
            itemType: "collab_agent_tool_call",
            status:
              state === "failed" ? "failed" : state === "completed" ? "completed" : "inProgress",
            title: String(data.name),
            data,
          },
        });
        if ((type === "subagent.completed" || type === "subagent.failed") && parentTurnId) {
          const usage = turnUsage(payload.usage);
          const hasUsage = Object.values(usage).some((value) => value !== undefined);
          yield* emit({
            type: "turn.usage.recorded",
            ...(yield* base(context.session.threadId, frame)),
            turnId: parentTurnId,
            payload: {
              usage: {
                model: context.session.model ?? "kimi-code/k3",
                workload: context.workload,
                component: { kind: "subagent", id: providerAgentId, name: String(data.name) },
                quality: hasUsage ? "reported" : "partial",
                ...usage,
                contextUsedTokens: optionalNonNegative(payload.contextTokens),
                completedAt: yield* nowIso,
              },
            },
          });
        }
        return;
      }

      if (type === "event.approval.requested") {
        const requestIdValue = payload.approval_id ?? payload.approvalId ?? payload.toolCallId;
        if (typeof requestIdValue !== "string" || requestIdValue.trim().length === 0) return;
        const requestId = requestIdValue.trim();
        yield* emit({
          type: "request.opened",
          ...(yield* base(context.session.threadId, frame)),
          ...(activeTurnId ? { turnId: activeTurnId } : {}),
          requestId: RuntimeRequestId.make(requestId),
          payload: {
            requestType: "dynamic_tool_call",
            detail: typeof payload.action === "string" ? payload.action : "Kimi requests approval",
            args: payload,
          },
        });
        return;
      }

      if (type === "event.approval.resolved") {
        const requestId =
          typeof (payload.approval_id ?? payload.approvalId) === "string"
            ? String(payload.approval_id ?? payload.approvalId).trim()
            : "";
        if (requestId.length > 0) {
          yield* emit({
            type: "request.resolved",
            ...(yield* base(context.session.threadId, frame)),
            ...(activeTurnId ? { turnId: activeTurnId } : {}),
            requestId: RuntimeRequestId.make(requestId),
            payload: {
              requestType: "dynamic_tool_call",
              decision: String(payload.decision ?? "resolved"),
              resolution: payload,
            },
          });
        }
        return;
      }

      if (type === "event.question.requested") {
        const requestId =
          typeof (payload.question_id ?? payload.questionId) === "string"
            ? String(payload.question_id ?? payload.questionId).trim()
            : "";
        const rawQuestions = Array.isArray(payload.questions) ? payload.questions : [];
        const questions = rawQuestions.flatMap((value, questionIndex) => {
          const question = asRecord(value);
          const id = String(question.id ?? `q_${questionIndex}`);
          const rawOptions = Array.isArray(question.options) ? question.options : [];
          const options = rawOptions.flatMap((rawOption, optionIndex) => {
            const option = asRecord(rawOption);
            const label = String(option.label ?? "").trim();
            return label.length === 0
              ? []
              : [{ id: String(option.id ?? `opt_${questionIndex}_${optionIndex}`), label }];
          });
          const questionText = String(question.question ?? "").trim();
          if (questionText.length === 0 || options.length === 0) return [];
          return [
            {
              id,
              header: String(question.header ?? "Kimi").trim() || "Kimi",
              question: questionText,
              options: options.map((option) => ({
                label: option.label,
                description: String(
                  asRecord(rawOptions.find((candidate) => asRecord(candidate).id === option.id))
                    .description ?? option.label,
                ),
              })),
              multiSelect: question.multi_select === true,
              nativeOptions: options,
            },
          ];
        });
        if (requestId.length > 0 && questions.length > 0) {
          context.pendingQuestions.set(
            requestId,
            questions.map(({ id, nativeOptions }) => ({ id, options: nativeOptions })),
          );
          yield* emit({
            type: "user-input.requested",
            ...(yield* base(context.session.threadId, frame)),
            ...(activeTurnId ? { turnId: activeTurnId } : {}),
            requestId: RuntimeRequestId.make(requestId),
            payload: {
              questions: questions.map(
                ({ nativeOptions: _nativeOptions, ...question }) => question,
              ),
            },
          });
        }
        return;
      }

      if (type === "event.question.answered" || type === "event.question.dismissed") {
        const requestId =
          typeof (payload.question_id ?? payload.questionId) === "string"
            ? String(payload.question_id ?? payload.questionId).trim()
            : "";
        if (requestId.length > 0) {
          context.pendingQuestions.delete(requestId);
          yield* emit({
            type: "user-input.resolved",
            ...(yield* base(context.session.threadId, frame)),
            ...(activeTurnId ? { turnId: activeTurnId } : {}),
            requestId: RuntimeRequestId.make(requestId),
            payload: { answers: asRecord(payload.answers) },
          });
        }
        return;
      }

      if (type === "turn.ended" && activeTurnId && isMainAgent) {
        const usage = turnUsage(context.lastUsage);
        const reason = String(payload.reason ?? "completed");
        yield* emit({
          type: "turn.usage.recorded",
          ...(yield* base(context.session.threadId, frame)),
          turnId: activeTurnId,
          payload: {
            usage: {
              model: context.session.model ?? "kimi-code/k3",
              workload: context.workload,
              component: { kind: "main", id: "main" },
              quality: "reported",
              ...usage,
              durationMs: optionalNonNegative(payload.durationMs),
              completedAt: yield* nowIso,
            },
          },
        });
        yield* emit({
          type: "turn.completed",
          ...(yield* base(context.session.threadId, frame)),
          turnId: activeTurnId,
          payload: {
            state:
              reason === "cancelled" ? "cancelled" : reason === "failed" ? "failed" : "completed",
            stopReason: reason,
            usage: context.lastUsage,
            ...(typeof asRecord(payload.error).message === "string"
              ? { errorMessage: String(asRecord(payload.error).message) }
              : {}),
          },
        });
        delete context.activePromptId;
        delete context.activeTurnId;
        const { activeTurnId: _activeTurnId, ...rest } = context.session;
        context.session = { ...rest, status: "ready", updatedAt: yield* nowIso };
      }
    });

  const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) => {
    let pendingScope: Scope.Closeable | undefined;
    return Effect.gen(function* () {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected '${PROVIDER}', received '${input.provider}'.`,
        });
      }
      if (!input.cwd?.trim()) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "cwd is required.",
        });
      }
      const cwd = input.cwd.trim();
      const existing = sessions.get(input.threadId);
      if (existing) {
        sessions.delete(input.threadId);
        yield* Scope.close(existing.scope, Exit.void);
      }

      const requestedModel = input.modelSelection?.model ?? "kimi-code/k3";
      const scope = yield* Scope.make("sequential");
      pendingScope = scope;
      const commandCenterThread = isCommandCenterThreadId(input.threadId);
      const selectedRuntime = commandCenterThread
        ? yield* Effect.gen(function* () {
            const mcp = McpProviderSession.readMcpProviderSession(input.threadId);
            if (!mcp) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "startSession",
                issue: "Kimi automations require the scoped T3 workspace MCP session.",
              });
            }
            const environment = options.environment ?? process.env;
            const sourceHomePath = path.resolve(
              settings.homePath.trim().length > 0
                ? expandHomePath(settings.homePath)
                : environment.KIMI_CODE_HOME?.trim() || expandHomePath("~/.kimi-code"),
            );
            const launch = yield* prepareKimiCommandCenterLaunch({
              binaryPath: settings.binaryPath,
              sourceHomePath,
              stateDir: serverConfig.stateDir,
              threadId: input.threadId,
              runtimeMode: input.runtimeMode,
              cwd,
              model: requestedModel,
              environment,
              mcp,
            }).pipe(
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterValidationError({
                    provider: PROVIDER,
                    operation: "startSession",
                    issue: cause.detail,
                    cause,
                  }),
              ),
            );
            return yield* makeKimiRuntimeClient(settings, launch.environment, {
              command: launch.command,
              argsPrefix: launch.argsPrefix,
              tokenHomePath: launch.hostHomePath,
              daemonHomePath: launch.daemonHomePath,
              workspacePath: launch.workspacePath,
            }).pipe(
              Effect.provideService(Scope.Scope, scope),
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
            );
          })
        : runtime;
      const cursor = parseResumeCursor(input.resumeCursor);
      let nativeSession: Record<string, unknown> | undefined;
      if (cursor) {
        nativeSession = yield* request<Record<string, unknown>>(
          selectedRuntime,
          "GET /sessions/:id",
          `/sessions/${encodeURIComponent(cursor.sessionId)}`,
        ).pipe(
          Effect.option,
          Effect.map((option) => (option._tag === "Some" ? option.value : undefined)),
        );
      }
      if (!nativeSession) {
        nativeSession = yield* request<Record<string, unknown>>(
          selectedRuntime,
          "POST /sessions",
          "/sessions",
          {
            method: "POST",
            body: {
              metadata: { cwd: selectedRuntime.workspacePath ?? cwd },
              agent_config: {
                model: requestedModel,
                permission_mode: input.approvalPolicy === "never" ? "yolo" : "manual",
                plan_mode: false,
              },
            },
          },
        );
      }
      const nativeSessionId = String(nativeSession.id ?? cursor?.sessionId ?? "");
      if (!nativeSessionId) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "POST /sessions",
          detail: "Kimi returned a session without an id.",
        });
      }
      const createdAt = yield* nowIso;
      const generation = yield* randomId;
      const resumeCursor = { schemaVersion: RESUME_VERSION, sessionId: nativeSessionId } as const;
      const session: ProviderSession = {
        provider: PROVIDER,
        providerInstanceId: options.instanceId,
        sessionGeneration: generation,
        status: "ready",
        runtimeMode: input.runtimeMode,
        cwd,
        model: requestedModel,
        threadId: input.threadId,
        resumeCursor,
        createdAt,
        updatedAt: createdAt,
      };
      const context: KimiSessionRecord = {
        session,
        nativeSessionId,
        runtime: selectedRuntime,
        workload: commandCenterThread ? "automation" : "interactive",
        scope,
        turns: [],
        subagents: new Map(),
        pendingQuestions: new Map(),
      };
      const nativeEvents = yield* Queue.unbounded<Record<string, unknown>>();
      yield* Stream.runForEach(Stream.fromQueue(nativeEvents), (frame) =>
        handleNativeEvent(context, frame),
      ).pipe(
        Effect.catch((error) => Effect.logWarning(error.message)),
        Effect.forkIn(scope),
      );
      yield* selectedRuntime
        .subscribe(nativeSessionId, (frame) => {
          Queue.offerUnsafe(nativeEvents, frame);
        })
        .pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "WebSocket subscribe",
                detail: cause.detail,
                cause,
              }),
          ),
        );
      yield* emit({
        type: "session.started",
        ...(yield* base(input.threadId)),
        payload: { resume: resumeCursor },
      });
      yield* emit({
        type: "thread.started",
        ...(yield* base(input.threadId)),
        payload: { providerThreadId: nativeSessionId },
      });
      sessions.set(input.threadId, context);
      pendingScope = undefined;
      return session;
    }).pipe(
      Effect.onError(() =>
        pendingScope === undefined
          ? Effect.void
          : Scope.close(pendingScope, Exit.void).pipe(Effect.ignore),
      ),
    );
  };

  const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
    Effect.gen(function* () {
      const context = yield* requireSession(input.threadId);
      if (!input.input?.trim() && (!input.attachments || input.attachments.length === 0)) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "A message or attachment is required.",
        });
      }
      const model = input.modelSelection?.model ?? context.session.model ?? "kimi-code/k3";
      if (context.session.model && model !== context.session.model) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Kimi model changes require a new thread.",
        });
      }
      const content: Array<Record<string, unknown>> = [];
      if (input.input?.trim()) content.push({ type: "text", text: input.input.trim() });
      for (const attachment of input.attachments ?? []) {
        const attachmentPath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        if (!attachmentPath) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "sendTurn attachment",
            detail: `Invalid attachment id '${attachment.id}'.`,
          });
        }
        const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "sendTurn attachment",
                detail: `Could not read attachment '${attachment.name}'.`,
                cause,
              }),
          ),
        );
        content.push({
          type: "image",
          source: {
            kind: "base64",
            media_type: attachment.mimeType,
            data: Buffer.from(bytes).toString("base64"),
          },
        });
      }
      const result = yield* request<Record<string, unknown>>(
        context.runtime,
        "POST /sessions/:id/prompts",
        `/sessions/${encodeURIComponent(context.nativeSessionId)}/prompts`,
        {
          method: "POST",
          body: {
            content,
            model,
            permission_mode: "manual",
            plan_mode: input.interactionMode === "plan",
          },
        },
      );
      const promptId = String(result.prompt_id ?? (yield* randomId));
      const steering = context.activePromptId !== undefined && context.activeTurnId !== undefined;
      if (steering) {
        yield* request(
          context.runtime,
          "POST /sessions/:id/prompts/:id:steer",
          `/sessions/${encodeURIComponent(context.nativeSessionId)}/prompts/${encodeURIComponent(promptId)}:steer`,
          { method: "POST", body: {} },
        );
      }
      const turnId = context.activeTurnId ?? TurnId.make(promptId);
      context.activePromptId = promptId;
      context.activeTurnId = turnId;
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: turnId,
        updatedAt: yield* nowIso,
      };
      if (!steering) {
        context.turns.push({ id: turnId, items: [] });
        yield* emit({
          type: "turn.started",
          ...(yield* base(input.threadId)),
          turnId,
          payload: {
            model,
            ...(input.turnRequestSequence === undefined
              ? {}
              : { turnRequestSequence: input.turnRequestSequence }),
          },
        });
      }
      return {
        threadId: input.threadId,
        turnId,
        resumeCursor: context.session.resumeCursor,
        target: {
          sessionGeneration: context.session.sessionGeneration!,
          resumeCursor: context.session.resumeCursor,
        },
        ...(steering ? { steered: true } : {}),
      };
    });

  const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (threadId) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      if (context.activePromptId) {
        yield* request(
          context.runtime,
          "POST /sessions/:id/prompts/:id:abort",
          `/sessions/${encodeURIComponent(context.nativeSessionId)}/prompts/${encodeURIComponent(context.activePromptId)}:abort`,
          { method: "POST", body: {} },
        );
      } else {
        yield* request(
          context.runtime,
          "POST /sessions/:id:abort",
          `/sessions/${encodeURIComponent(context.nativeSessionId)}:abort`,
          {
            method: "POST",
            body: {},
          },
        );
      }
    });

  const respondToRequest: ProviderAdapterShape<ProviderAdapterError>["respondToRequest"] = (
    threadId,
    requestId,
    decision,
  ) =>
    requireSession(threadId).pipe(
      Effect.flatMap((context) =>
        request(
          context.runtime,
          "POST /sessions/:id/approvals/:id",
          `/sessions/${encodeURIComponent(context.nativeSessionId)}/approvals/${encodeURIComponent(requestId)}`,
          { method: "POST", body: approvalDecision(decision) },
        ),
      ),
      Effect.asVoid,
    );

  const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] = (
    threadId,
    requestId,
    answers,
  ) =>
    requireSession(threadId).pipe(
      Effect.flatMap((context) => {
        const pending = context.pendingQuestions.get(String(requestId)) ?? [];
        const nativeAnswers = Object.fromEntries(
          Object.entries(answers).map(([id, answer]) => {
            const options = pending.find((question) => question.id === id)?.options ?? [];
            if (Array.isArray(answer)) {
              const optionIds = answer.flatMap((value) => {
                const text = String(value);
                const option = options.find(
                  (candidate) => candidate.id === text || candidate.label === text,
                );
                return option === undefined ? [] : [option.id];
              });
              return [
                id,
                optionIds.length > 0
                  ? { kind: "multi", option_ids: optionIds }
                  : { kind: "skipped" },
              ];
            }
            const text = typeof answer === "string" ? answer : "";
            const option = options.find(
              (candidate) => candidate.id === text || candidate.label === text,
            );
            return [
              id,
              option === undefined
                ? text.length > 0
                  ? { kind: "other", text }
                  : { kind: "skipped" }
                : { kind: "single", option_id: option.id },
            ];
          }),
        );
        return request(
          context.runtime,
          "POST /sessions/:id/questions/:id",
          `/sessions/${encodeURIComponent(context.nativeSessionId)}/questions/${encodeURIComponent(requestId)}`,
          {
            method: "POST",
            body: { answers: nativeAnswers },
          },
        );
      }),
      Effect.asVoid,
    );

  const stopSession = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const context = sessions.get(threadId);
      if (!context) return;
      sessions.delete(threadId);
      yield* Scope.close(context.scope, Exit.void);
      yield* emit({
        type: "session.exited",
        ...(yield* base(threadId)),
        payload: { exitKind: "graceful" },
      });
    });

  const readThread = (
    threadId: ThreadId,
  ): Effect.Effect<ProviderThreadSnapshot, ProviderAdapterError> =>
    requireSession(threadId).pipe(Effect.map((context) => ({ threadId, turns: context.turns })));
  const rollbackThread = (threadId: ThreadId, numTurns: number) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      yield* request(
        context.runtime,
        "POST /sessions/:id:undo",
        `/sessions/${encodeURIComponent(context.nativeSessionId)}:undo`,
        {
          method: "POST",
          body: { count: numTurns },
        },
      );
      context.turns.splice(Math.max(0, context.turns.length - numTurns), numTurns);
      return { threadId, turns: context.turns };
    });

  const stopAll = Effect.forEach([...sessions.keys()], stopSession, {
    concurrency: "unbounded",
    discard: true,
  });
  yield* Scope.addFinalizer(adapterScope, stopAll.pipe(Effect.ignore));

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "unsupported" },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions: () => Effect.succeed([...sessions.values()].map((value) => value.session)),
    hasSession: (threadId) => Effect.succeed(sessions.has(threadId)),
    readThread,
    rollbackThread,
    stopAll: () => stopAll,
    streamEvents: Stream.fromQueue(events),
  } satisfies ProviderAdapterShape<ProviderAdapterError>;
});
