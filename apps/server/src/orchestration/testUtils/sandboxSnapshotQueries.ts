/**
 * Test double for the narrow sandbox reads of `ProjectionSnapshotQuery`.
 *
 * Sandbox orchestration (the lifecycle reactor's reconcile and minute-by-minute
 * expiry sweep, thread deletion, and sandbox creation on `thread.create`) must
 * never hydrate the full read model: `getSnapshot` decodes every message and
 * activity on the server while holding its only database connection. Tests
 * keep describing their world as an `OrchestrationReadModel`; this derives the
 * narrow queries from it the way the SQL does, and makes `getSnapshot` die so
 * a regression back to the full snapshot fails loudly.
 *
 * @module orchestration/testUtils/sandboxSnapshotQueries
 */
import type { OrchestrationReadModel } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type {
  ProjectionSandboxThread,
  ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";

export const FULL_SNAPSHOT_FORBIDDEN =
  "sandbox orchestration must not hydrate the full projection snapshot";

const sandboxThreadsOf = (
  readModel: OrchestrationReadModel,
): ReadonlyArray<ProjectionSandboxThread> =>
  readModel.threads.flatMap((thread) =>
    thread.sandbox == null
      ? []
      : [
          {
            id: thread.id,
            projectId: thread.projectId,
            deletedAt: thread.deletedAt,
            sandbox: thread.sandbox,
          },
        ],
  );

/**
 * Narrow sandbox reads over `readModel`. Pass a function to re-read a mutable
 * fixture on every call, as the projection would.
 */
export const sandboxSnapshotQueries = (
  readModel: OrchestrationReadModel | (() => OrchestrationReadModel),
) => {
  const current = typeof readModel === "function" ? readModel : () => readModel;
  return {
    getSnapshot: () => Effect.die(FULL_SNAPSHOT_FORBIDDEN),
    listSandboxThreads: () => Effect.sync(() => sandboxThreadsOf(current())),
    getSandboxThreadById: (threadId) =>
      Effect.sync(() =>
        Option.fromUndefinedOr(
          sandboxThreadsOf(current()).find((thread) => thread.id === threadId),
        ),
      ),
    getProjectWorkspaceById: (projectId) =>
      Effect.sync(() =>
        Option.map(
          Option.fromUndefinedOr(current().projects.find((project) => project.id === projectId)),
          (project) => ({
            id: project.id,
            workspaceRoot: project.workspaceRoot,
            deletedAt: project.deletedAt,
          }),
        ),
      ),
  } satisfies Pick<
    ProjectionSnapshotQueryShape,
    "getSnapshot" | "listSandboxThreads" | "getSandboxThreadById" | "getProjectWorkspaceById"
  >;
};
