import {
  CommandId,
  type ClientOrchestrationCommand,
  type EfficiencyDecision,
  EventId,
  MessageId,
  type ModelSelection,
  OrchestrationDispatchCommandError,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  type ServerProvider,
  SUBAGENT_STARTED_ACTIVITY_KIND,
  ThreadId,
  ThreadSubagentDelegation,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import {
  interactiveTurnMatchesRule,
  resolveInteractiveEfficiency,
  routedSelectionNeedsSubagent,
  type TierJudgmentInput,
} from "../efficiency/EfficiencyRouting.ts";
import { Judge } from "../efficiency/Judge.ts";
import {
  buildTierJudgmentRequest,
  findRouteContext,
  tierJudgmentFromAnswers,
} from "../efficiency/TierJudgment.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { ProjectionThreadMessageRepositoryLive } from "../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { ProjectionThreadMessageRepository } from "../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { T3ProjectFileLoader } from "../project/T3ProjectFileLoader.ts";
import {
  resolveSandboxImage,
  resolveSandboxPreviewProxyImage,
} from "../sandbox/SandboxRuntimeManager.ts";
import {
  resolveSandboxGitBase,
  SandboxGitBaseUnavailableError,
} from "../sandbox/sandboxGitBase.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);
const isSandboxGitBaseUnavailableError = Schema.is(SandboxGitBaseUnavailableError);
const decodeSubagentDelegation = Schema.decodeUnknownOption(ThreadSubagentDelegation);
/** How many of a parent's most recent subagents are considered for reuse. */
const REUSABLE_SUBAGENT_LOOKBACK = 5;
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const toDispatchCommandError = (cause: unknown, fallbackMessage: string) =>
  isOrchestrationDispatchCommandError(cause)
    ? cause
    : new OrchestrationDispatchCommandError({
        message: cause instanceof Error ? cause.message : fallbackMessage,
        cause,
      });

const toBootstrapDispatchCommandCauseError = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return isOrchestrationDispatchCommandError(error)
    ? error
    : new OrchestrationDispatchCommandError({
        message: error instanceof Error ? error.message : "Failed to bootstrap thread turn start.",
        cause,
      });
};

/** Preserve the setup runner's broader pre-refactor message normalization. */
function legacySetupFailureDescription(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message;
  }
  return String(cause);
}

function setupScriptFailureDetail(
  error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError,
): string {
  switch (error._tag) {
    case "ProjectSetupScriptOperationError":
      return legacySetupFailureDescription(error.cause);
    case "ProjectSetupScriptProjectNotFoundError":
      return "Project was not found for setup script execution.";
  }
}

export interface OrchestrationCommandDispatcherShape {
  readonly dispatch: (
    command: ClientOrchestrationCommand,
  ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>;
  readonly dispatchNormalized: (
    command: OrchestrationCommand,
  ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>;
  /**
   * Token-efficiency routing for a normalized command, without dispatching it.
   * An auto-routed `thread.turn.start` comes back carrying its
   * `efficiencyDecision` (and the decided model / tier on any bootstrap
   * `createThread`); every other command is returned unchanged. The WebSocket
   * transport dispatches through its own bootstrap path, so it calls this
   * first rather than `dispatchNormalized`.
   */
  readonly resolve: (
    command: OrchestrationCommand,
  ) => Effect.Effect<OrchestrationCommand, OrchestrationDispatchCommandError>;
}

/**
 * Server-owned command handoff shared by WebSocket requests and durable
 * Command Center Run recovery. The caller chooses when dispatch is allowed;
 * this service deliberately does not depend on the startup command gate.
 */
export class OrchestrationCommandDispatcher extends Context.Service<
  OrchestrationCommandDispatcher,
  OrchestrationCommandDispatcherShape
>()("@awtprod/command-center/orchestration/CommandDispatcher/OrchestrationCommandDispatcher") {}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerRegistry = yield* ProviderRegistry;
  const serverSettings = yield* ServerSettingsService;
  const judge = yield* Judge;
  const projectionTurns = yield* ProjectionTurnRepository;
  const projectionMessages = yield* ProjectionThreadMessageRepository;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const projectFileLoader = yield* T3ProjectFileLoader;
  const setupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;

  const randomUUID = crypto.randomUUIDv4.pipe(
    Effect.mapError((cause) =>
      toDispatchCommandError(cause, "Failed to generate orchestration command identifier."),
    ),
  );
  const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

  const appendSetupScriptActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
    readonly summary: string;
    readonly createdAt: string;
    readonly payload: Record<string, unknown>;
    readonly tone: "info" | "error";
  }) =>
    Effect.all({
      commandId: serverCommandId("setup-script-activity"),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: input.tone,
            kind: input.kind,
            summary: input.summary,
            payload: input.payload,
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const refreshGitStatus = (cwd: string) =>
    vcsStatusBroadcaster
      .refreshStatus(cwd)
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

  const dispatchBootstrapTurnStart = (
    command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
  ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> =>
    Effect.gen(function* () {
      const bootstrap = command.bootstrap;
      const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
      let createdThread = false;
      const targetProjectId = bootstrap?.createThread?.projectId;
      const targetProjectCwd = bootstrap?.prepareWorktree?.projectCwd;
      let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;

      const cleanupCreatedThread = () =>
        createdThread
          ? serverCommandId("bootstrap-thread-delete").pipe(
              Effect.flatMap((commandId) =>
                orchestrationEngine.dispatch({
                  type: "thread.delete",
                  commandId,
                  threadId: command.threadId,
                }),
              ),
              Effect.ignoreCause({ log: true }),
            )
          : Effect.void;

      const recordSetupScriptLaunchFailure = (input: {
        readonly error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError;
        readonly requestedAt: string;
        readonly worktreePath: string;
      }) => {
        const detail = setupScriptFailureDetail(input.error);
        return appendSetupScriptActivity({
          threadId: command.threadId,
          kind: "setup-script.failed",
          summary: "Setup script failed to start",
          createdAt: input.requestedAt,
          payload: { detail, worktreePath: input.worktreePath },
          tone: "error",
        }).pipe(
          Effect.ignoreCause({ log: false }),
          Effect.flatMap(() =>
            Effect.logWarning("bootstrap turn start failed to launch setup script", {
              threadId: command.threadId,
              worktreePath: input.worktreePath,
              detail,
            }),
          ),
        );
      };

      const recordSetupScriptStarted = (input: {
        readonly requestedAt: string;
        readonly worktreePath: string;
        readonly scriptId: string;
        readonly scriptName: string;
        readonly terminalId: string;
      }) =>
        Effect.gen(function* () {
          const startedAt = yield* nowIso;
          const payload = {
            scriptId: input.scriptId,
            scriptName: input.scriptName,
            terminalId: input.terminalId,
            worktreePath: input.worktreePath,
          };
          yield* Effect.all([
            appendSetupScriptActivity({
              threadId: command.threadId,
              kind: "setup-script.requested",
              summary: "Starting setup script",
              createdAt: input.requestedAt,
              payload,
              tone: "info",
            }),
            appendSetupScriptActivity({
              threadId: command.threadId,
              kind: "setup-script.started",
              summary: "Setup script started",
              createdAt: startedAt,
              payload,
              tone: "info",
            }),
          ]).pipe(
            Effect.asVoid,
            Effect.catch((error) =>
              Effect.logWarning(
                "bootstrap turn start launched setup script but failed to record setup activity",
                {
                  threadId: command.threadId,
                  worktreePath: input.worktreePath,
                  scriptId: input.scriptId,
                  terminalId: input.terminalId,
                  detail: error.message,
                },
              ),
            ),
          );
        });

      const runSetupProgram = () =>
        Effect.gen(function* () {
          if (!bootstrap?.runSetupScript || !targetWorktreePath) return;
          const worktreePath = targetWorktreePath;
          const requestedAt = yield* nowIso;
          yield* setupScriptRunner
            .runForThread({
              threadId: command.threadId,
              ...(targetProjectId ? { projectId: targetProjectId } : {}),
              ...(targetProjectCwd ? { projectCwd: targetProjectCwd } : {}),
              worktreePath,
            })
            .pipe(
              Effect.matchEffect({
                onFailure: (error) =>
                  recordSetupScriptLaunchFailure({ error, requestedAt, worktreePath }),
                onSuccess: (setupResult) =>
                  setupResult.status !== "started"
                    ? Effect.void
                    : recordSetupScriptStarted({
                        requestedAt,
                        worktreePath,
                        scriptId: setupResult.scriptId,
                        scriptName: setupResult.scriptName,
                        terminalId: setupResult.terminalId,
                      }),
              }),
            );
        });

      const bootstrapProgram = Effect.gen(function* () {
        if (bootstrap?.createThread) {
          yield* orchestrationEngine.dispatch({
            type: "thread.create",
            commandId: yield* serverCommandId("bootstrap-thread-create"),
            threadId: command.threadId,
            projectId: bootstrap.createThread.projectId,
            title: bootstrap.createThread.title,
            modelSelection: bootstrap.createThread.modelSelection,
            routingMode: bootstrap.createThread.routingMode,
            ...(bootstrap.createThread.efficiencyTier === undefined
              ? {}
              : { efficiencyTier: bootstrap.createThread.efficiencyTier }),
            runtimeMode: bootstrap.createThread.runtimeMode,
            interactionMode: bootstrap.createThread.interactionMode,
            branch: bootstrap.createThread.branch,
            worktreePath: bootstrap.createThread.worktreePath,
            sandboxConfig: bootstrap.createThread.sandboxConfig,
            sandboxBranch: bootstrap.createThread.sandboxBranch,
            createdAt: bootstrap.createThread.createdAt,
          });
          createdThread = true;
        }

        if (bootstrap?.prepareWorktree) {
          const prepareWorktree = bootstrap.prepareWorktree;
          const worktreeBaseRef = yield* GitWorkflowService.resolveWorktreeBaseRef(
            gitWorkflow,
            prepareWorktree,
          );
          const worktree = yield* gitWorkflow.createWorktree({
            cwd: prepareWorktree.projectCwd,
            refName: worktreeBaseRef,
            newRefName: prepareWorktree.branch,
            baseRefName: prepareWorktree.baseBranch,
            path: null,
          });
          targetWorktreePath = worktree.worktree.path;
          yield* orchestrationEngine.dispatch({
            type: "thread.meta.update",
            commandId: yield* serverCommandId("bootstrap-thread-meta-update"),
            threadId: command.threadId,
            branch: worktree.worktree.refName,
            worktreePath: targetWorktreePath,
          });
          yield* refreshGitStatus(targetWorktreePath);
        }

        yield* runSetupProgram();
        return yield* orchestrationEngine.dispatch(finalTurnStartCommand);
      });

      return yield* bootstrapProgram.pipe(
        Effect.catchCause((cause) => {
          const dispatchError = toBootstrapDispatchCommandCauseError(cause);
          if (Cause.hasInterruptsOnly(cause)) return Effect.fail(dispatchError);
          return cleanupCreatedThread().pipe(Effect.flatMap(() => Effect.fail(dispatchError)));
        }),
      );
    });

  /**
   * The thread's current route: the latest turn's decision (for sticky
   * routing), the text of the message that started the route, and the turn
   * count. Best-effort — a lookup failure only drops the context.
   */
  const loadRouteContext = (
    thread: OrchestrationThreadShell | undefined,
  ): Effect.Effect<{
    readonly priorTurnCount: number;
    readonly priorDecision?: EfficiencyDecision;
    readonly taskMessage?: string;
  }> =>
    Effect.gen(function* () {
      const latestTurnId = thread?.latestTurn?.turnId;
      if (thread === undefined || latestTurnId === undefined) return { priorTurnCount: 0 };
      const turns = yield* projectionTurns.listByThreadId({ threadId: thread.id });
      const context = findRouteContext(turns, latestTurnId);
      const taskMessage =
        context.taskMessageId === undefined
          ? undefined
          : Option.getOrUndefined(
              yield* projectionMessages.getByMessageId({
                messageId: MessageId.make(context.taskMessageId),
              }),
            )?.text;
      return {
        priorTurnCount: Math.max(1, turns.filter((turn) => turn.turnId !== null).length),
        ...(context.priorDecision === undefined ? {} : { priorDecision: context.priorDecision }),
        ...(taskMessage === undefined ? {} : { taskMessage }),
      };
    }).pipe(
      Effect.catch((error) =>
        Effect.logDebug("efficiency route context unavailable", { error }).pipe(
          Effect.as({ priorTurnCount: thread?.latestTurn ? 1 : 0 }),
        ),
      ),
    );

  const resolveTierJudgment = (
    command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
    thread: OrchestrationThreadShell | undefined,
    route: { readonly priorTurnCount: number; readonly taskMessage?: string },
  ): Effect.Effect<TierJudgmentInput | undefined> => {
    const projectId = command.bootstrap?.createThread?.projectId ?? thread?.projectId;
    const threadTitle = thread?.title ?? command.bootstrap?.createThread?.title;
    return judge
      .ask(
        buildTierJudgmentRequest({
          message: command.message.text,
          attachmentCount: command.message.attachments.length,
          interactionMode: command.interactionMode,
          ...(projectId === undefined ? {} : { projectId }),
          priorTurnCount: route.priorTurnCount,
          ...(threadTitle === undefined ? {} : { threadTitle }),
          ...(route.taskMessage === undefined ? {} : { taskMessage: route.taskMessage }),
        }),
        { threadId: command.threadId },
      )
      .pipe(
        Effect.map((result) => tierJudgmentFromAnswers(result.answers, result.model)),
        Effect.catchTag("JudgeError", (error) =>
          Effect.logDebug("tier judgment skipped", { reason: error.reason }).pipe(
            Effect.as(undefined),
          ),
        ),
      );
  };

  /**
   * The most recent live subagent of `parentThreadId` already on exactly
   * `selection`'s instance and model and not mid-turn, so a follow-up routed the
   * same way continues that conversation instead of starting a fresh one.
   * Best-effort: a lookup failure just starts a new subagent.
   */
  const findReusableSubagent = (parentThreadId: ThreadId, selection: ModelSelection) =>
    Effect.gen(function* () {
      const parent = Option.getOrUndefined(
        yield* projectionSnapshotQuery.getThreadDetailById(parentThreadId),
      );
      if (parent === undefined) return undefined;
      const childIds = [
        ...new Set(
          parent.activities
            .filter((activity) => activity.kind === SUBAGENT_STARTED_ACTIVITY_KIND)
            .flatMap((activity) =>
              Option.toArray(decodeSubagentDelegation(activity.payload)).map(
                (delegation) => delegation.childThreadId,
              ),
            )
            .toReversed(),
        ),
      ].slice(0, REUSABLE_SUBAGENT_LOOKBACK);
      for (const childId of childIds) {
        const child = Option.getOrUndefined(
          yield* projectionSnapshotQuery.getThreadShellById(childId),
        );
        if (child === undefined || child.archivedAt !== null) continue;
        if (child.latestTurn?.state === "running") continue;
        const instanceId = child.session?.providerInstanceId ?? child.modelSelection.instanceId;
        if (instanceId === selection.instanceId && child.modelSelection.model === selection.model) {
          return childId;
        }
      }
      return undefined;
    }).pipe(
      Effect.catch((error) =>
        Effect.logDebug("subagent reuse lookup failed", { error }).pipe(Effect.as(undefined)),
      ),
    );

  /**
   * A routed turn the thread's bound session cannot serve (see
   * `routedSelectionNeedsSubagent`) becomes a `thread.turn.delegate`: the parent
   * records the message and the subagent reactor runs the turn in a child
   * thread on the routed model.
   *
   * Accepting a proposed plan (`sourceProposedPlan`) and retrying a turn
   * (`retryOfTurnId`) are bound to this thread: the plan and the retried turn
   * live in its session, and a fresh child has neither. Those turns skip the
   * routed model and run unrouted (`unrouted`) on the thread's own provider,
   * exactly as a manual turn would.
   */
  const delegateToSubagentIfNeeded = (
    command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
    unrouted: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
    thread: OrchestrationThreadShell,
    providers: ReadonlyArray<ServerProvider>,
  ): Effect.Effect<OrchestrationCommand, OrchestrationDispatchCommandError> =>
    Effect.gen(function* () {
      const decision = command.efficiencyDecision;
      if (decision === undefined || command.bootstrap !== undefined) return command;
      if (!routedSelectionNeedsSubagent({ thread, selection: decision.modelSelection, providers }))
        return command;
      if (command.sourceProposedPlan !== undefined || command.retryOfTurnId !== undefined)
        return unrouted;
      const reusable = yield* findReusableSubagent(thread.id, decision.modelSelection);
      const childThreadId = reusable ?? ThreadId.make(yield* randomUUID);
      return {
        type: "thread.turn.delegate",
        commandId: command.commandId,
        threadId: command.threadId,
        message: command.message,
        delegation: {
          childThreadId,
          reuseChild: reusable !== undefined,
          messageId: command.message.messageId,
          modelSelection: decision.modelSelection,
          efficiencyDecision: decision,
          interactionMode: command.interactionMode,
        },
        createdAt: command.createdAt,
      } satisfies OrchestrationCommand;
    });

  const resolveEfficiency = (
    command: OrchestrationCommand,
  ): Effect.Effect<OrchestrationCommand, OrchestrationDispatchCommandError> => {
    if (command.type !== "thread.turn.start") return Effect.succeed(command);
    // Already routed (a subagent's child turn carries its parent's decision).
    if (command.efficiencyDecision !== undefined) return Effect.succeed(command);
    return Effect.gen(function* () {
      const thread = command.bootstrap?.createThread
        ? undefined
        : Option.getOrUndefined(
            yield* projectionSnapshotQuery.getThreadShellById(command.threadId),
          );
      const routingMode =
        command.routingMode ??
        command.bootstrap?.createThread?.routingMode ??
        thread?.routingMode ??
        "manual";
      if (routingMode !== "auto") return command;
      const settings = yield* serverSettings.getSettings;
      if (!settings.efficiency.enabled) return command;
      const providers = yield* providerRegistry.getProviders;
      // An explicit rule always wins over a judgment, so skip the judge
      // round-trip (its latency and cost) entirely when a rule already matches
      // this turn — the judgment would only be recorded and discarded.
      const ruleMatches = interactiveTurnMatchesRule({
        settings: settings.efficiency,
        projectId: command.bootstrap?.createThread?.projectId ?? thread?.projectId,
        interactionMode: command.interactionMode,
        attachmentCount: command.message.attachments.length,
      });
      // Resolve an optional judgment first. Any judge error (or a disabled
      // judge) leaves `tierJudgment` undefined, so routing proceeds exactly as
      // it does today (a prior decision is only reused on a judged
      // continuation).
      const judging = !ruleMatches && settings.efficiency.tierJudgment.enabled && judge.enabled;
      const route = judging ? yield* loadRouteContext(thread) : undefined;
      const tierJudgment =
        route === undefined ? undefined : yield* resolveTierJudgment(command, thread, route);
      const resolved = resolveInteractiveEfficiency({
        command,
        ...(thread === undefined ? {} : { thread }),
        settings: settings.efficiency,
        providers,
        ...(tierJudgment === undefined ? {} : { tierJudgment }),
        ...(route?.priorDecision === undefined ? {} : { priorDecision: route.priorDecision }),
      }).command;
      return thread === undefined
        ? resolved
        : yield* delegateToSubagentIfNeeded(resolved, command, thread, providers);
    }).pipe(
      Effect.mapError((cause) =>
        toDispatchCommandError(cause, "Failed to resolve token-efficiency routing"),
      ),
    );
  };

  const ensureThreadSandbox = Effect.fn("OrchestrationCommandDispatcher.ensureThreadSandbox")(
    function* (
      resolvedCommand: OrchestrationCommand,
    ): Effect.fn.Return<OrchestrationCommand, OrchestrationDispatchCommandError> {
      const create =
        resolvedCommand.type === "thread.create"
          ? resolvedCommand
          : resolvedCommand.type === "thread.turn.start"
            ? resolvedCommand.bootstrap?.createThread
            : undefined;
      if (create === undefined || create.sandboxBranch !== undefined) return resolvedCommand;
      const targetThreadId =
        resolvedCommand.type === "thread.create" || resolvedCommand.type === "thread.turn.start"
          ? resolvedCommand.threadId
          : undefined;
      if (targetThreadId === undefined) return resolvedCommand;
      const snapshot = yield* projectionSnapshotQuery
        .getSnapshot()
        .pipe(
          Effect.mapError((cause) =>
            toDispatchCommandError(cause, "Failed to load project for sandbox creation"),
          ),
        );
      const project = snapshot.projects.find((item) => item.id === create.projectId);
      if (!project)
        return yield* new OrchestrationDispatchCommandError({
          message: `Project '${create.projectId}' was not found.`,
        });
      const projectFile = Option.getOrUndefined(
        yield* projectFileLoader.load(project.workspaceRoot),
      );
      if (
        resolveSandboxImage(projectFile) === undefined ||
        resolveSandboxPreviewProxyImage() === undefined
      )
        return resolvedCommand;
      const base = yield* resolveSandboxGitBase({
        gitWorkflow,
        cwd: project.workspaceRoot,
      }).pipe(
        Effect.mapError((cause) =>
          isSandboxGitBaseUnavailableError(cause)
            ? new OrchestrationDispatchCommandError({ message: cause.message })
            : toDispatchCommandError(cause, "Failed to resolve the sandbox Git base"),
        ),
      );
      const sandboxFields = {
        sandboxConfig: {
          ...(projectFile?.sandbox?.limits === undefined
            ? {}
            : { limits: projectFile.sandbox.limits }),
          ...create.sandboxConfig,
        },
        sandboxBranch: {
          branchName: `t3/thread/${targetThreadId}`,
          baseCommit: base.commitSha,
        },
      };
      if (resolvedCommand.type === "thread.create") return { ...resolvedCommand, ...sandboxFields };
      if (resolvedCommand.type === "thread.turn.start")
        return {
          ...resolvedCommand,
          bootstrap: {
            ...resolvedCommand.bootstrap!,
            createThread: { ...resolvedCommand.bootstrap!.createThread!, ...sandboxFields },
          },
        };
      return resolvedCommand;
    },
  );

  const dispatchNormalized: OrchestrationCommandDispatcherShape["dispatchNormalized"] = (command) =>
    resolveEfficiency(command).pipe(
      Effect.flatMap(ensureThreadSandbox),
      Effect.flatMap((resolvedCommand) =>
        resolvedCommand.type === "thread.turn.start" && resolvedCommand.bootstrap
          ? dispatchBootstrapTurnStart(resolvedCommand)
          : orchestrationEngine
              .dispatch(resolvedCommand)
              .pipe(
                Effect.mapError((cause) =>
                  toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
                ),
              ),
      ),
    );

  const dispatch: OrchestrationCommandDispatcherShape["dispatch"] = (command) =>
    normalizeDispatchCommand(command).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig.ServerConfig, serverConfig),
      Effect.provideService(WorkspacePaths.WorkspacePaths, workspacePaths),
      Effect.flatMap(dispatchNormalized),
    );

  return OrchestrationCommandDispatcher.of({
    dispatch,
    dispatchNormalized,
    resolve: resolveEfficiency,
  });
});

export const layer = Layer.effect(OrchestrationCommandDispatcher, make).pipe(
  Layer.provide(
    Layer.mergeAll(ProjectionTurnRepositoryLive, ProjectionThreadMessageRepositoryLive),
  ),
);
