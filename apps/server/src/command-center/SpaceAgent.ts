import {
  ModelId,
  type ModelSelection as SpaceModelSelection,
  ProviderId,
  RunId,
  type Space as SpaceType,
} from "@command-center/core";
import {
  CLAUDE_WORKER_FALLBACK_MODEL,
  CommandCenterError,
  type CommandCenterSpaceAgentSummary,
  CommandId,
  MessageId,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as OrchestrationBridge from "./OrchestrationBridge.ts";
import { GoogleActivityBrief } from "./GoogleActivity.ts";
import { isManagedRepositoryWorkspacePath } from "./RepositoryProvisioningPolicy.ts";
import {
  commandCenterModelSelection,
  planRepositoryProjectResolution,
  renderSpaceAgentTurn,
  resolveCommandCenterSystemProject,
  SPACE_AGENT_TURN_TEXT_MAX_CHARS,
} from "./RunDispatcher.ts";
import * as CommandCenterService from "./Service.ts";
import { spaceAgentThreadId, spaceIdFromSpaceAgentThreadId } from "./SpaceAgentIds.ts";
import {
  EMPTY_SPACE_AGENT_WAKE_STATUS,
  querySpaceAgentWakeStatuses,
} from "./SpaceAgentWakeState.ts";
import type { SpaceBriefMailCalendar } from "./SpaceBrief.ts";

/** Default model for a Space agent with no agent or Space model configured. */
const SPACE_AGENT_DEFAULT_MODEL: SpaceModelSelection = {
  providerId: ProviderId.make("claudeAgent"),
  modelId: ModelId.make(CLAUDE_WORKER_FALLBACK_MODEL),
};

/**
 * Unattended, classifier-gated provider permissions. Command Center authority
 * comes from the scoped MCP tools and the server-side autonomy gate, not from
 * this mode. The user can change it on the thread; later turns keep it.
 */
export const SPACE_AGENT_RUNTIME_MODE = "auto" as const;

export const SPACE_AGENT_MANUAL_WAKE_TEXT =
  "Manual wake: review the brief and act on anything that needs doing.";

const SPACE_AGENT_BOOTSTRAP_TEXT =
  "You have just been set up as this Space's agent. Review the brief, note anything that needs attention, and record what you learn in memory.";

export type SpaceAgentTurnReason = "manual" | "wake";

export interface SpaceAgentTurnResult {
  readonly spaceId: string;
  readonly threadId: ThreadId;
  readonly created: boolean;
  readonly sequence: number;
}

export interface SpaceAgentShape {
  /** Every configured Space with its agent state (enabled, thread, model). */
  readonly list: Effect.Effect<ReadonlyArray<CommandCenterSpaceAgentSummary>, CommandCenterError>;
  /**
   * Return the Space's agent thread, creating it once (with a bootstrap turn
   * that carries the role and brief) when it does not exist yet.
   */
  readonly ensureThread: (
    spaceId: string,
  ) => Effect.Effect<
    { readonly threadId: ThreadId; readonly created: boolean },
    CommandCenterError
  >;
  /** Send a server-authored turn (role, brief, text) to the Space's agent thread. */
  readonly sendTurn: (
    spaceId: string,
    input: { readonly text: string; readonly reason: SpaceAgentTurnReason },
  ) => Effect.Effect<SpaceAgentTurnResult, CommandCenterError>;
  /** Durable MCP scope for a Space agent thread; `undefined` when not enabled. */
  readonly resolveScope: McpSessionRegistry.McpThreadScopeResolver;
}

export class SpaceAgent extends Context.Service<SpaceAgent, SpaceAgentShape>()(
  "@awtprod/command-center/command-center/SpaceAgent",
) {}

const agentError = (
  reason: CommandCenterError["reason"],
  message: string,
  cause?: unknown,
): CommandCenterError =>
  new CommandCenterError({ reason, message, ...(cause === undefined ? {} : { cause }) });

/** The agent model: agent block, then the Space default, then Opus 5.5. */
const resolveSpaceAgentModel = (
  space: Pick<SpaceType, "agent" | "modelDefaults">,
): SpaceModelSelection => space.agent?.model ?? space.modelDefaults ?? SPACE_AGENT_DEFAULT_MODEL;

/** MCP scope of an enabled Space agent thread. Memory writes are approved. */
const spaceAgentScope = (
  space: Pick<SpaceType, "id" | "agent" | "policy" | "lifecycle">,
): McpSessionRegistry.McpThreadScope | undefined =>
  space.agent?.enabled === true && space.lifecycle === "active"
    ? {
        capabilities: new Set(space.policy.allowedCapabilities),
        spaceId: space.id,
        memoryWriteMode: "remember",
        role: "space-agent",
      }
    : undefined;

/**
 * The first repository binding with an existing managed project, using the
 * dispatcher's own project/binding matching rules. Ambiguous or conflicting
 * bindings are skipped rather than guessed.
 */
const selectSpaceAgentRepositoryProject = (input: {
  readonly space: Pick<SpaceType, "id" | "repositories">;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
}): OrchestrationProjectShell | undefined => {
  for (const binding of input.space.repositories) {
    try {
      const plan = planRepositoryProjectResolution({
        runId: RunId.make(`space-agent:${input.space.id}`),
        binding,
        explicitProjectId: null,
        projects: input.projects,
      });
      if (plan._tag === "Existing") return plan.project;
    } catch {
      // An ambiguous identity is not a usable target; try the next binding.
    }
  }
  return undefined;
};

const make = Effect.gen(function* () {
  const service = yield* CommandCenterService.CommandCenterService;
  const projection = yield* OrchestrationBridge.OrchestrationBridge;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const sql = yield* SqlClient.SqlClient;
  const googleBrief = yield* GoogleActivityBrief;
  // One writer at a time, so concurrent wakes cannot both create the thread.
  const threadLock = yield* Semaphore.make(1);

  const loadEnabledSpace = Effect.fn("SpaceAgent.loadEnabledSpace")(function* (spaceId: string) {
    const space = yield* service.getConfiguredSpace(spaceId);
    if (space.agent?.enabled !== true) {
      return yield* agentError("validation", `Space '${space.id}' does not have an enabled agent.`);
    }
    return space;
  });

  const findThread = (threadId: ThreadId) =>
    projection
      .getThreadShellById(threadId)
      .pipe(
        Effect.mapError((cause) =>
          agentError("persistence", "The Space agent thread could not be inspected.", cause),
        ),
      );

  const resolveProject = Effect.fn("SpaceAgent.resolveProject")(function* (
    space: SpaceType,
    modelSelection: ReturnType<typeof commandCenterModelSelection>,
    now: string,
  ) {
    const snapshot = yield* projection
      .getShellSnapshot()
      .pipe(
        Effect.mapError((cause) =>
          agentError("persistence", "Active projects could not be inspected.", cause),
        ),
      );
    const managedRepositoriesRoot = path.join(config.baseDir, "repositories");
    const repositoryProject = selectSpaceAgentRepositoryProject({
      space,
      projects: snapshot.projects.filter((project) =>
        isManagedRepositoryWorkspacePath({
          managedRepositoriesRoot,
          workspaceRoot: project.workspaceRoot,
          path,
        }),
      ),
    });
    if (repositoryProject !== undefined) return repositoryProject.id;
    const systemProject = yield* resolveCommandCenterSystemProject({
      runId: RunId.make(`space-agent:${space.id}`),
      baseDir: config.baseDir,
      fileSystem,
      path,
      projection,
      modelSelection,
      now,
      dispatchCommand: projection.dispatchCommand,
    }).pipe(
      Effect.mapError((cause) =>
        agentError("routing", "No project is available for the Space agent thread.", cause),
      ),
    );
    return systemProject.id;
  });

  const validateTurnText = (text: string): Effect.Effect<void, CommandCenterError> =>
    text.length === 0 || text.length > SPACE_AGENT_TURN_TEXT_MAX_CHARS
      ? Effect.fail(
          agentError(
            "validation",
            `A Space agent turn needs 1-${SPACE_AGENT_TURN_TEXT_MAX_CHARS} characters of text.`,
          ),
        )
      : Effect.void;

  const busyError = () => agentError("conflict", "The Space agent is already working on a turn.");

  /**
   * The Space's "Mail + calendar" brief input. Read before `threadLock`, which
   * every Space's turns and wakes share: a Google read can take up to its
   * timeout and must not stall another Space. The agent's own scope is the
   * Space policy, which `section` checks, so the server-injected brief is where
   * mail and calendar reach the agent.
   */
  const fetchMailCalendar = (space: SpaceType) => googleBrief.section(space);

  const startTurn = Effect.fn("SpaceAgent.startTurn")(function* (
    space: SpaceType,
    existing: OrchestrationV2ThreadShell | undefined,
    input: {
      readonly text: string;
      readonly reason: SpaceAgentTurnReason | "bootstrap";
      readonly mailCalendar: SpaceBriefMailCalendar | undefined;
    },
  ) {
    const text = input.text.trim();
    yield* validateTurnText(text);
    // A V2 shell reports work in flight as its active run.
    if (existing?.activeRunId != null) return yield* busyError();
    const threadId = ThreadId.make(spaceAgentThreadId(space.id));
    const { brief } = yield* service.spaceBrief({
      spaceId: space.id,
      mailCalendar: input.mailCalendar,
    });
    const now = DateTime.formatIso(yield* DateTime.now);
    const nonce = yield* crypto
      .randomUUIDv4()
      .pipe(
        Effect.mapError((cause) => agentError("persistence", "Could not mint a turn id.", cause)),
      );
    const message = {
      messageId: MessageId.make(`space-agent:${space.id}:message:${nonce}`),
      role: "user" as const,
      text: renderSpaceAgentTurn({ space, brief, reason: input.reason, text }),
      attachments: [],
    };
    const commandId = CommandId.make(`space-agent:${space.id}:turn:${nonce}`);
    // A follow-up turn on the agent's thread, or its first turn creating it.
    if (existing !== undefined) {
      const dispatched = yield* projection
        .dispatchCommand({
          type: "thread.turn.start",
          commandId,
          threadId,
          message,
          runtimeMode: existing.runtimeMode,
          interactionMode: existing.interactionMode,
          createdAt: now,
        })
        .pipe(
          Effect.mapError((cause) =>
            agentError("routing", "The Space agent turn could not be started.", cause),
          ),
        );
      return { threadId, created: false, sequence: dispatched.sequence };
    }
    const model = resolveSpaceAgentModel(space);
    const modelSelection = commandCenterModelSelection(model);
    const projectId = yield* resolveProject(space, modelSelection, now);
    const title = `${space.displayName} agent`.slice(0, 80);
    const dispatched = yield* projection
      .dispatchCommand({
        type: "thread.turn.start",
        commandId,
        threadId,
        message,
        modelSelection,
        titleSeed: title,
        runtimeMode: SPACE_AGENT_RUNTIME_MODE,
        interactionMode: "default",
        bootstrap: {
          createThread: {
            projectId,
            title,
            modelSelection,
            runtimeMode: SPACE_AGENT_RUNTIME_MODE,
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
          },
        },
        createdAt: now,
      })
      .pipe(
        Effect.mapError((cause) =>
          agentError(
            "routing",
            "The Space agent thread could not be created. If it was archived, unarchive it.",
            cause,
          ),
        ),
      );
    return { threadId, created: true, sequence: dispatched.sequence };
  });

  // Checks made before the lock (text, busy thread, existing thread) only skip
  // a needless Google read; the locked section re-checks the thread itself.
  const sendTurn: SpaceAgentShape["sendTurn"] = (spaceId, input) =>
    Effect.gen(function* () {
      const space = yield* loadEnabledSpace(spaceId);
      const threadId = ThreadId.make(spaceAgentThreadId(space.id));
      yield* validateTurnText(input.text.trim());
      const current = Option.getOrUndefined(yield* findThread(threadId));
      if (current?.activeRunId != null) return yield* busyError();
      const mailCalendar = yield* fetchMailCalendar(space);
      return yield* threadLock.withPermits(1)(
        Effect.gen(function* () {
          const existing = yield* findThread(threadId);
          const result = yield* startTurn(space, Option.getOrUndefined(existing), {
            ...input,
            mailCalendar,
          });
          return { spaceId: space.id, ...result };
        }),
      );
    });

  const ensureThread: SpaceAgentShape["ensureThread"] = (spaceId) =>
    Effect.gen(function* () {
      const space = yield* loadEnabledSpace(spaceId);
      const threadId = ThreadId.make(spaceAgentThreadId(space.id));
      if (Option.isSome(yield* findThread(threadId))) return { threadId, created: false };
      const mailCalendar = yield* fetchMailCalendar(space);
      return yield* threadLock.withPermits(1)(
        Effect.gen(function* () {
          if (Option.isSome(yield* findThread(threadId))) return { threadId, created: false };
          const created = yield* startTurn(space, undefined, {
            text: SPACE_AGENT_BOOTSTRAP_TEXT,
            reason: "bootstrap",
            mailCalendar,
          });
          return { threadId: created.threadId, created: true };
        }),
      );
    });

  const list: SpaceAgentShape["list"] = Effect.gen(function* () {
    const { spaces } = yield* service.querySpaces({});
    const statuses = yield* querySpaceAgentWakeStatuses({
      now: DateTime.formatIso(yield* DateTime.now),
      spaces,
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    return yield* Effect.forEach(spaces, (space) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make(spaceAgentThreadId(space.id));
        const existing = space.agent === undefined ? Option.none() : yield* findThread(threadId);
        return {
          spaceId: space.id,
          displayName: space.displayName,
          enabled: space.agent?.enabled === true,
          threadId: Option.isSome(existing) ? threadId : null,
          model: space.agent === undefined ? null : resolveSpaceAgentModel(space),
          ...(statuses.get(space.id) ?? EMPTY_SPACE_AGENT_WAKE_STATUS),
        } satisfies CommandCenterSpaceAgentSummary;
      }),
    );
  });

  const resolveScope: SpaceAgentShape["resolveScope"] = (threadId) => {
    const spaceId = spaceIdFromSpaceAgentThreadId(threadId);
    if (spaceId === undefined) return Effect.succeed(undefined);
    return service.getConfiguredSpace(spaceId).pipe(
      Effect.map(spaceAgentScope),
      // An unknown, archived, or unreadable Space grants nothing.
      Effect.orElseSucceed(() => undefined),
    );
  };

  return SpaceAgent.of({ list, ensureThread, sendTurn, resolveScope });
});

/**
 * Builds the service and installs its durable MCP scope resolver for the
 * server's lifetime. Scopes are derived from config on every credential issue,
 * so they survive restarts and disappear as soon as an agent is disabled.
 */
export const layer = Layer.effect(
  SpaceAgent,
  make.pipe(
    Effect.tap((spaceAgent) =>
      McpSessionRegistry.installMcpThreadScopeResolver(spaceAgent.resolveScope),
    ),
  ),
);
