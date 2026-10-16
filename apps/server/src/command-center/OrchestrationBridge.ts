/**
 * The one seam between Command Center modules and upstream orchestration V2.
 *
 * Command Center's run dispatcher, run lifecycle, recovery coordinator, Space
 * agent, Instagram publisher, web push notifier, host usage and worktree
 * cleanup were written against the deleted V1 engine (projection snapshot
 * query, orchestration engine, command dispatcher, provider service). This
 * module exposes only the operations those callers use.
 *
 * Reads that map directly onto V2 (project and thread shells, shell
 * snapshots) are implemented against `ProjectStoreV2` / `ProjectionStoreV2`.
 * Operations whose V1 semantics have no V2 equivalent yet fail with a typed
 * `V2PortPending` error naming the operation, so a caller can never mistake
 * an unported path for success. Each such site carries a `V2PORT` tag.
 */
import type {
  CommandId,
  OrchestrationProjectShell,
  OrchestrationV2DomainEvent,
  ProviderRuntimeEvent,
  ProviderSession,
  OrchestrationV2ThreadShell,
  OrchestrationV2ThreadShellSnapshot,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import {
  ProjectionStoreV2,
  type ShellSnapshotOptions,
} from "../orchestration-v2/ProjectionStore.ts";

/** An operation Command Center still needs that has not been ported to orchestration V2. */
export class V2PortPending extends Schema.TaggedError<V2PortPending>()("V2PortPending", {
  operation: Schema.String,
  missing: Schema.String,
}) {
  override get message(): string {
    return `V2PORT: ${this.operation} is not available on orchestration V2 yet (${this.missing}).`;
  }
}

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

export type OrchestrationBridgeError = V2PortPending | OrchestrationBridgeReadError;

/**
 * A V1-shaped orchestration command as Command Center runs and the Space agent
 * still build them (`thread.create`, `thread.turn.start` with `bootstrap`,
 * `thread.session.stop`, ...). The V1 command schemas were deleted with the V1
 * engine; this loose shape keeps the builders compiling until S2 moves them
 * onto `OrchestrationV2Command`.
 */
/**
 * A V1 domain event as Command Center consumers still read them. V1 events
 * are no longer produced; the bridge's event stream fails with V2PortPending
 * until S2 derives what Command Center needs from V2 application events.
 */
export interface LegacyOrchestrationEvent {
  readonly type: string;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly aggregateKind?: string;
  readonly aggregateId?: string;
  readonly payload?: unknown;
}

/** The V1 `thread.session-set` event with an errored session, the one Run lifecycle consumed. */
export interface LegacySessionErrorEvent extends LegacyOrchestrationEvent {
  readonly type: "thread.session-set";
  readonly payload: {
    readonly threadId: string;
    readonly session: { readonly status: "error"; readonly lastError?: string | null };
  };
}

export const legacySessionErrorEvent = (
  event: LegacyOrchestrationEvent,
): LegacySessionErrorEvent | undefined => {
  if (event.type !== "thread.session-set") return undefined;
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null) return undefined;
  const threadId = (payload as { readonly threadId?: unknown }).threadId;
  const session = (payload as { readonly session?: unknown }).session;
  if (typeof threadId !== "string" || typeof session !== "object" || session === null) {
    return undefined;
  }
  const status = (session as { readonly status?: unknown }).status;
  const lastError = (session as { readonly lastError?: unknown }).lastError;
  if (status !== "error") return undefined;
  return {
    ...event,
    type: "thread.session-set",
    payload: {
      threadId,
      session: {
        status: "error",
        ...(typeof lastError === "string" ? { lastError } : {}),
      },
    },
  };
};

export interface LegacyOrchestrationCommand {
  readonly type: string;
  readonly commandId: CommandId;
  readonly [field: string]: unknown;
}

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
   * Dispatch a V1-shaped orchestration command (thread create / turn start /
   * session stop issued by Command Center runs and the Space agent).
   */
  readonly dispatchCommand: (
    command: LegacyOrchestrationCommand,
  ) => Effect.Effect<{ readonly sequence: number }, V2PortPending>;
  /** V2 domain events, as upstream's agent-awareness relay consumes them. */
  readonly streamThreadEvents: Stream.Stream<
    OrchestrationV2DomainEvent,
    OrchestrationBridgeReadError
  >;
  /** V1 domain events (thread.session-set, thread.turn-diff-completed, ...). */
  readonly streamDomainEvents: Stream.Stream<LegacyOrchestrationEvent, V2PortPending>;
  /** Provider runtime events and the live provider session list, as V1 ProviderService exposed them. */
  readonly streamProviderEvents: Stream.Stream<ProviderRuntimeEvent, V2PortPending>;
  readonly listProviderSessions: Effect.Effect<ReadonlyArray<ProviderSession>, V2PortPending>;
}

export class OrchestrationBridge extends Context.Service<
  OrchestrationBridge,
  OrchestrationBridgeShape
>()("@awtprod/command-center/command-center/OrchestrationBridge") {}

const readError = (operation: string) => (cause: unknown) =>
  new OrchestrationBridgeReadError({ operation, cause });

export const make = Effect.gen(function* () {
  const projects = yield* ProjectStoreV2;
  const projections = yield* ProjectionStoreV2;
  const threads = yield* ThreadManagementService;

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

  return OrchestrationBridge.of({
    getProjectShellById,
    getActiveProjectByWorkspaceRoot,
    getThreadShellById,
    getShellSnapshot,
    getArchivedShellSnapshot,
    streamThreadEvents: threads.streamDomainEvents.pipe(
      Stream.mapError(readError("streamThreadEvents")),
    ),
    // V2PORT: V1 command dispatch (thread.create + thread.turn.start with bootstrap,
    // thread.session.stop) has no V2 mapping yet; S2 routes these through
    // OrchestratorV2.dispatch / ThreadLaunchService.
    dispatchCommand: () =>
      Effect.fail(
        new V2PortPending({
          operation: "dispatchCommand",
          missing: "V1 command shapes are not mapped onto OrchestratorV2.dispatch",
        }),
      ),
    // V2PORT: V1 domain events (session-set, turn-diff-completed, settled) are not
    // derived from OrchestratorV2.streamDomainEvents yet.
    streamDomainEvents: Stream.fail(
      new V2PortPending({
        operation: "streamDomainEvents",
        missing: "V1 domain events are not derived from V2 application events",
      }),
    ),
    // V2PORT: V1 provider runtime event stream; V2 ingests provider events in
    // ProviderEventIngestor and exposes no equivalent public stream.
    streamProviderEvents: Stream.fail(
      new V2PortPending({
        operation: "streamProviderEvents",
        missing: "V2 exposes no provider runtime event stream",
      }),
    ),
    // V2PORT: V1 ProviderService.listSessions; V2 tracks sessions in ProviderSessionManager.
    listProviderSessions: Effect.fail(
      new V2PortPending({
        operation: "listProviderSessions",
        missing: "V1 provider session list is not mapped onto ProviderSessionManager",
      }),
    ),
  });
});

export const layer = Layer.effect(OrchestrationBridge, make);
