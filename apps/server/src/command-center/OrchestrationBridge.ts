/**
 * The one seam between Command Center modules and upstream orchestration V2.
 *
 * Command Center's run dispatcher, run lifecycle, recovery coordinator, Space
 * agent, Instagram publisher, web push notifier, host usage, worktree cleanup
 * and Space activity feed reach orchestration only through this module.
 *
 * Reads map onto `ProjectStoreV2` / `ProjectionStoreV2`. Writes are the three
 * operations Command Center issues, as a typed command union:
 *
 * - `project.create` → `ProjectService.create` (+ `update` for the default
 *   model, which V2's create does not record).
 * - `thread.turn.start` with `bootstrap` → `ThreadMessageIntake.launchThread`
 *   (thread create, worktree preparation, setup script, first message).
 * - `thread.turn.start` on an existing thread → `ThreadMessageIntake.sendToThread`.
 *
 * Every launch or turn of a `cc:` thread passes the Command Center admission
 * gate first; it fails closed with `CommandCenterIsolationUnavailable`.
 */
import type {
  ChatAttachment,
  CommandId,
  MessageId,
  ModelSelection,
  OrchestrationProjectShell,
  OrchestrationV2DomainEvent,
  OrchestrationV2StoredEvent,
  OrchestrationV2ThreadShell,
  OrchestrationV2ThreadShellSnapshot,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { persistInlineImageAttachments } from "../attachmentPersistence.ts";
import * as ServerConfig from "../config.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import * as ThreadMessageIntake from "../orchestration-v2/ThreadMessageIntake.ts";
import { ThreadLaunchService } from "../orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import {
  ProjectionStoreV2,
  type ShellSnapshotOptions,
} from "../orchestration-v2/ProjectionStore.ts";
import { ProjectService } from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import {
  commandCenterProviderIsolationIssue,
  isCommandCenterThreadId,
} from "../provider/security/CommandCenterProviderIsolation.ts";
import * as ServerSettings from "../serverSettings.ts";

/** A V2 read the bridge performed on a caller's behalf failed. */
export class OrchestrationBridgeReadError extends Schema.TaggedError<OrchestrationBridgeReadError>()(
  "OrchestrationBridgeReadError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Orchestration read '${this.operation}' failed.`;
  }
}

/**
 * The Command Center admission gate refused a `cc:` thread. Fail closed: no
 * thread, worktree or provider session exists for the refused command.
 */
export class CommandCenterIsolationUnavailable extends Schema.TaggedError<CommandCenterIsolationUnavailable>()(
  "CommandCenterIsolationUnavailable",
  {
    threadId: Schema.String,
    providerInstanceId: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

/** A Command Center write to orchestration V2 failed after admission. */
export class OrchestrationBridgeDispatchError extends Schema.TaggedError<OrchestrationBridgeDispatchError>()(
  "OrchestrationBridgeDispatchError",
  {
    operation: Schema.Literals(["project.create", "thread.launch", "thread.send"]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export type OrchestrationBridgeError =
  | OrchestrationBridgeReadError
  | CommandCenterIsolationUnavailable
  | OrchestrationBridgeDispatchError;

/** An inline image a Command Center Run hands to its first turn. */
export interface CommandCenterInlineImage {
  readonly type: "image";
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly dataUrl: string;
}

export interface CommandCenterProjectCreateCommand {
  readonly type: "project.create";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly createWorkspaceRootIfMissing: boolean;
  readonly defaultModelSelection: ModelSelection;
  readonly createdAt: string;
}

export interface CommandCenterTurnStartCommand {
  readonly type: "thread.turn.start";
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly message: {
    readonly messageId: MessageId;
    readonly role: "user";
    readonly text: string;
    readonly attachments: ReadonlyArray<CommandCenterInlineImage>;
  };
  readonly modelSelection?: ModelSelection;
  readonly titleSeed?: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  /** Present only for a thread's first turn: creates the thread in a project. */
  readonly bootstrap?: {
    readonly createThread: {
      readonly projectId: ProjectId;
      readonly title: string;
      readonly modelSelection: ModelSelection;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
      readonly branch: null;
      readonly worktreePath: null;
      readonly createdAt: string;
    };
    /** Starts the thread in a new worktree off `baseBranch` (setup script runs there). */
    readonly prepareWorktree?: {
      readonly projectCwd: string;
      readonly baseBranch: string;
      readonly branch: string;
      readonly startFromOrigin: boolean;
    };
    readonly runSetupScript?: boolean;
  };
  readonly createdAt: string;
}

/** The orchestration writes Command Center issues. */
export type CommandCenterOrchestrationCommand =
  | CommandCenterProjectCreateCommand
  | CommandCenterTurnStartCommand;

/**
 * Shell snapshot in the shape Command Center callers consume (the V1 query's
 * shape): one list of V2 thread shells plus the active project shells.
 */
export interface OrchestrationBridgeShellSnapshot {
  readonly snapshotSequence: OrchestrationV2ThreadShellSnapshot["snapshotSequence"];
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
}

export interface OrchestrationBridgeShape {
  readonly getProjectShellById: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, OrchestrationBridgeReadError>;
  /** Exact-string match on the active project's workspace root; callers normalize first. */
  readonly getActiveProjectByWorkspaceRoot: (
    workspaceRoot: string,
  ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, OrchestrationBridgeReadError>;
  readonly getThreadShellById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationV2ThreadShell>, OrchestrationBridgeReadError>;
  /** Active (unarchived) threads plus every active project shell. */
  readonly getShellSnapshot: (
    options?: Pick<ShellSnapshotOptions, "unsettledOnly" | "projectId">,
  ) => Effect.Effect<OrchestrationBridgeShellSnapshot, OrchestrationBridgeReadError>;
  /** Archived threads plus every active project shell. */
  readonly getArchivedShellSnapshot: () => Effect.Effect<
    OrchestrationBridgeShellSnapshot,
    OrchestrationBridgeReadError
  >;
  /**
   * The provider failure message recorded for a V2 run (its latest `error`
   * turn item), or the thread's last session error; undefined when neither exists.
   */
  readonly getRunFailureMessage: (input: {
    readonly threadId: ThreadId;
    readonly runId: string;
  }) => Effect.Effect<string | undefined, OrchestrationBridgeReadError>;
  /**
   * The Command Center admission gate alone (no write). `dispatchCommand`
   * applies the same gate to every `cc:` thread it launches or sends to.
   */
  readonly admitThread: (input: {
    readonly threadId: ThreadId;
    readonly modelSelection: Pick<ModelSelection, "instanceId">;
    readonly runtimeMode: RuntimeMode;
  }) => Effect.Effect<void, CommandCenterIsolationUnavailable>;
  /** Create a project, or start a thread turn (creating the thread on `bootstrap`). */
  readonly dispatchCommand: (
    command: CommandCenterOrchestrationCommand,
  ) => Effect.Effect<
    { readonly sequence: number },
    CommandCenterIsolationUnavailable | OrchestrationBridgeDispatchError
  >;
  /** V2 domain events from the live tail (no history replay). */
  readonly streamThreadEvents: Stream.Stream<
    OrchestrationV2DomainEvent,
    OrchestrationBridgeReadError
  >;
  /**
   * Stored V2 events after `afterSequence` (bounded replay, then the live
   * tail), optionally filtered to one event type.
   */
  readonly streamStoredEventsFrom: (input: {
    readonly afterSequence: number;
    readonly eventType?: OrchestrationV2DomainEvent["type"];
  }) => Stream.Stream<OrchestrationV2StoredEvent, OrchestrationBridgeReadError>;
  /** Sequence of the newest stored V2 event (0 for an empty store). */
  readonly latestEventSequence: Effect.Effect<number, OrchestrationBridgeReadError>;
}

export class OrchestrationBridge extends Context.Service<
  OrchestrationBridge,
  OrchestrationBridgeShape
>()("@awtprod/command-center/command-center/OrchestrationBridge") {}

const readError = (operation: string) => (cause: unknown) =>
  new OrchestrationBridgeReadError({ operation, cause });

const dispatchError =
  (operation: OrchestrationBridgeDispatchError["operation"], message: string) => (cause: unknown) =>
    new OrchestrationBridgeDispatchError({ operation, message, cause });

/**
 * The Command Center admission gate for one `cc:` thread command. Non-`cc:`
 * threads (ordinary threads, Space agent threads) pass. A `cc:` thread is
 * refused on any provider the fork's isolation rule refuses (non-Codex,
 * full-access, unknown instance) and, until S1 wires isolation into the V2
 * Codex adapter, on Codex as well.
 */
export const admitCommandCenterThread = (input: {
  readonly threadId: string;
  readonly modelSelection: Pick<ModelSelection, "instanceId">;
  readonly runtimeMode: RuntimeMode;
  readonly providers: ReadonlyArray<{ readonly instanceId: string; readonly driver?: string }>;
}): Effect.Effect<void, CommandCenterIsolationUnavailable> => {
  if (!isCommandCenterThreadId(input.threadId)) return Effect.void;
  const providerInstanceId = String(input.modelSelection.instanceId);
  const refuse = (reason: string) =>
    Effect.fail(
      new CommandCenterIsolationUnavailable({
        threadId: input.threadId,
        providerInstanceId,
        reason,
      }),
    );
  const provider = input.providers.find((candidate) => candidate.instanceId === providerInstanceId);
  if (provider === undefined || provider.driver === undefined) {
    return refuse(
      `Command Center runs cannot start: provider instance '${providerInstanceId}' is not configured.`,
    );
  }
  const issue = commandCenterProviderIsolationIssue({
    threadId: input.threadId,
    provider: provider.driver,
    runtimeMode: input.runtimeMode,
  });
  if (issue !== undefined) return refuse(issue);
  // V2PORT: S1 13-17. The Codex isolation layer (isolated CODEX_HOME, locked
  // app-server args, env scrubbing, permission profile, live isolation probe)
  // is not wired into the V2 Codex adapter yet. This is the single seam S1
  // replaces with the isolated launch; until then every `cc:` thread is refused.
  return refuse(
    "Command Center runs are paused: Codex isolation is not wired on orchestration v2 yet.",
  );
};

/** Inline images go through the same persistence as the WS attachment RPC. */
const persistInlineImages = Effect.fn("OrchestrationBridge.persistInlineImages")(function* (input: {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly attachments: ReadonlyArray<CommandCenterInlineImage>;
}) {
  if (input.attachments.length === 0) return [] as ReadonlyArray<ChatAttachment>;
  const persisted: ReadonlyArray<ChatAttachment> = yield* persistInlineImageAttachments(input).pipe(
    Effect.mapError(
      (error) =>
        new OrchestrationBridgeDispatchError({
          operation: "thread.launch",
          message: error.message,
          ...(error.cause === undefined ? {} : { cause: error.cause }),
        }),
    ),
  );
  return persisted;
});

const make = Effect.gen(function* () {
  const projects = yield* ProjectStoreV2;
  const projections = yield* ProjectionStoreV2;
  const threads = yield* ThreadManagementService;
  const launches = yield* ThreadLaunchService;
  const projectService = yield* ProjectService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const sql = yield* SqlClient.SqlClient;
  // ThreadMessageIntake reads these from its context (attachment claims).
  const intakeContext = yield* Effect.context<
    | ThreadManagementService
    | ThreadLaunchService
    | FileSystem.FileSystem
    | Path.Path
    | ServerConfig.ServerConfig
    | ServerSettings.ServerSettingsService
  >();

  const getProjectShellById: OrchestrationBridgeShape["getProjectShellById"] = (projectId) =>
    projects.getShell(projectId).pipe(Effect.mapError(readError("getProjectShellById")));

  const getActiveProjectByWorkspaceRoot: OrchestrationBridgeShape["getActiveProjectByWorkspaceRoot"] =
    (workspaceRoot) =>
      projects.findActiveByWorkspaceRoot(workspaceRoot).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(Option.none<OrchestrationProjectShell>()),
            onSome: (row) => projects.getShell(row.projectId),
          }),
        ),
        Effect.mapError(readError("getActiveProjectByWorkspaceRoot")),
      );

  const getThreadShellById: OrchestrationBridgeShape["getThreadShellById"] = (threadId) =>
    projections
      .getThreadShell(threadId)
      .pipe(Effect.map(Option.fromNullishOr), Effect.mapError(readError("getThreadShellById")));

  const getShellSnapshot: OrchestrationBridgeShape["getShellSnapshot"] = (options) =>
    Effect.all([
      projections.getShellSnapshot({ ...options, location: "active" }),
      projects.listShells(),
    ]).pipe(
      Effect.map(([snapshot, projectShells]) => ({
        snapshotSequence: snapshot.snapshotSequence,
        threads: snapshot.threads,
        projects:
          options?.projectId === undefined
            ? projectShells
            : projectShells.filter((project) => project.id === options.projectId),
      })),
      Effect.mapError(readError("getShellSnapshot")),
    );

  const getArchivedShellSnapshot: OrchestrationBridgeShape["getArchivedShellSnapshot"] = () =>
    Effect.all([projections.getShellSnapshot({ location: "archive" }), projects.listShells()]).pipe(
      Effect.map(([snapshot, projectShells]) => ({
        snapshotSequence: snapshot.snapshotSequence,
        threads: snapshot.archivedThreads,
        projects: projectShells,
      })),
      Effect.mapError(readError("getArchivedShellSnapshot")),
    );

  const getRunFailureMessage: OrchestrationBridgeShape["getRunFailureMessage"] = (input) =>
    Effect.gen(function* () {
      const records = yield* projections.getThreadRecords(input.threadId, ["turnItems"], {
        turnItemRunIds: [input.runId as never],
        turnItemTypes: ["error"],
      });
      const failures = records.turnItems.flatMap((item) =>
        item.type === "error" && item.failure.message.trim().length > 0
          ? [{ ordinal: item.ordinal, message: item.failure.message.trim() }]
          : [],
      );
      const latest = failures.reduce<(typeof failures)[number] | undefined>(
        (current, next) =>
          current === undefined || next.ordinal >= current.ordinal ? next : current,
        undefined,
      );
      if (latest !== undefined) return latest.message;
      const shell = yield* projections.getThreadShell(input.threadId);
      const lastError = shell?.lastError?.trim();
      return lastError && lastError.length > 0 ? lastError : undefined;
    }).pipe(Effect.mapError(readError("getRunFailureMessage")));

  const admit = (input: {
    readonly threadId: ThreadId;
    readonly modelSelection: Pick<ModelSelection, "instanceId">;
    readonly runtimeMode: RuntimeMode;
  }) =>
    isCommandCenterThreadId(input.threadId)
      ? providerRegistry.getProviders.pipe(
          Effect.flatMap((providers) =>
            admitCommandCenterThread({
              ...input,
              providers: providers.map((provider) => ({
                instanceId: String(provider.instanceId),
                ...(provider.driver === undefined ? {} : { driver: String(provider.driver) }),
              })),
            }),
          ),
        )
      : Effect.void;

  const threadSequence = (operation: OrchestrationBridgeDispatchError["operation"], id: ThreadId) =>
    threads
      .getThreadEventSequence(id)
      .pipe(
        Effect.mapError(dispatchError(operation, "The started thread could not be read back.")),
      );

  const createProject = (command: CommandCenterProjectCreateCommand) =>
    Effect.gen(function* () {
      yield* projectService
        .create({
          commandId: command.commandId,
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          createWorkspaceRootIfMissing: command.createWorkspaceRootIfMissing,
        })
        .pipe(
          Effect.mapError(dispatchError("project.create", "The project could not be created.")),
        );
      // V2's create does not record a default model; set it as an update.
      yield* projectService
        .update({
          commandId: `${command.commandId}:default-model` as CommandId,
          projectId: command.projectId,
          defaultModelSelection: command.defaultModelSelection,
        })
        .pipe(
          Effect.mapError(
            dispatchError("project.create", "The project's default model could not be set."),
          ),
        );
      return { sequence: 0 };
    });

  const launchThread = (
    command: CommandCenterTurnStartCommand,
    bootstrap: NonNullable<CommandCenterTurnStartCommand["bootstrap"]>,
  ) =>
    Effect.gen(function* () {
      const create = bootstrap.createThread;
      yield* admit({
        threadId: command.threadId,
        modelSelection: create.modelSelection,
        runtimeMode: create.runtimeMode,
      });
      const attachments = yield* persistInlineImages({
        threadId: command.threadId,
        messageId: command.message.messageId,
        attachments: command.message.attachments,
      }).pipe(Effect.provide(intakeContext));
      const worktree = bootstrap.prepareWorktree;
      yield* ThreadMessageIntake.launchThread({
        commandId: command.commandId,
        threadId: command.threadId,
        projectId: create.projectId,
        title: create.title,
        generateTitle: false,
        modelSelection: create.modelSelection,
        runtimeMode: create.runtimeMode,
        interactionMode: create.interactionMode,
        workspaceStrategy:
          worktree === undefined
            ? { type: "root" }
            : {
                type: "worktree",
                baseRef: worktree.baseBranch,
                branch: worktree.branch,
                startFromOrigin: worktree.startFromOrigin,
              },
        initialMessage: {
          messageId: command.message.messageId,
          text: command.message.text,
          attachments,
        },
        createdBy: "system",
        creationSource: "server",
      }).pipe(
        Effect.provide(intakeContext),
        Effect.mapError(dispatchError("thread.launch", "The thread could not be started.")),
      );
      return { sequence: yield* threadSequence("thread.launch", command.threadId) };
    });

  const sendTurn = (command: CommandCenterTurnStartCommand) =>
    Effect.gen(function* () {
      const shell = yield* projections
        .getThreadShell(command.threadId)
        .pipe(Effect.mapError(dispatchError("thread.send", "The thread could not be read.")));
      if (shell === null) {
        return yield* new OrchestrationBridgeDispatchError({
          operation: "thread.send",
          message: "The thread does not exist.",
        });
      }
      yield* admit({
        threadId: command.threadId,
        modelSelection: command.modelSelection ?? shell.modelSelection,
        runtimeMode: command.runtimeMode,
      });
      const attachments = yield* persistInlineImages({
        threadId: command.threadId,
        messageId: command.message.messageId,
        attachments: command.message.attachments,
      }).pipe(Effect.provide(intakeContext));
      yield* ThreadMessageIntake.sendToThread({
        projectId: shell.projectId,
        commandId: command.commandId,
        threadId: command.threadId,
        messageId: command.message.messageId,
        text: command.message.text,
        attachments,
        ...(command.modelSelection === undefined ? {} : { modelSelection: command.modelSelection }),
        mode: "auto",
        createdBy: "system",
        creationSource: "server",
      }).pipe(
        Effect.provide(intakeContext),
        Effect.mapError(dispatchError("thread.send", "The turn could not be started.")),
      );
      return { sequence: yield* threadSequence("thread.send", command.threadId) };
    });

  const dispatchCommand: OrchestrationBridgeShape["dispatchCommand"] = (command) => {
    switch (command.type) {
      case "project.create":
        return createProject(command);
      case "thread.turn.start":
        return command.bootstrap === undefined
          ? sendTurn(command)
          : launchThread(command, command.bootstrap);
    }
  };

  const latestEventSequence: OrchestrationBridgeShape["latestEventSequence"] = sql<{
    readonly sequence: number | null;
  }>`SELECT MAX(sequence) AS sequence FROM orchestration_v2_events`.pipe(
    Effect.map((rows) => rows[0]?.sequence ?? 0),
    Effect.mapError(readError("latestEventSequence")),
  );

  return OrchestrationBridge.of({
    getProjectShellById,
    getActiveProjectByWorkspaceRoot,
    getThreadShellById,
    getShellSnapshot,
    getArchivedShellSnapshot,
    getRunFailureMessage,
    admitThread: admit,
    dispatchCommand,
    streamThreadEvents: threads.streamDomainEvents.pipe(
      Stream.mapError(readError("streamThreadEvents")),
    ),
    streamStoredEventsFrom: (input) =>
      threads
        .streamStoredEventsFrom({
          afterSequence: input.afterSequence,
          ...(input.eventType === undefined ? {} : { eventType: input.eventType }),
        })
        .pipe(Stream.mapError(readError("streamStoredEventsFrom"))),
    latestEventSequence,
  });
});

export const layer = Layer.effect(OrchestrationBridge, make);
