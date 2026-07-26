/**
 * ProjectionTurnRepository - Projection repository interface for unified turn state.
 *
 * Owns persistence operations for pending starts, running/completed turn lifecycle,
 * and checkpoint metadata in a single projection table.
 *
 * @module ProjectionTurnRepository
 */
import {
  CheckpointRef,
  IsoDateTime,
  MessageId,
  ModelSelection,
  NonNegativeInt,
  OrchestrationProposedPlanId,
  OrchestrationCheckpointFile,
  OrchestrationCheckpointStatus,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionTurnState = Schema.Literals([
  "pending",
  "running",
  "interrupted",
  "completed",
  "error",
]);
export type ProjectionTurnState = typeof ProjectionTurnState.Type;

export const ProjectionTurn = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  pendingMessageId: Schema.NullOr(MessageId),
  sourceProposedPlanThreadId: Schema.NullOr(ThreadId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
  assistantMessageId: Schema.NullOr(MessageId),
  state: ProjectionTurnState,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  checkpointTurnCount: Schema.NullOr(NonNegativeInt),
  checkpointRef: Schema.NullOr(CheckpointRef),
  checkpointStatus: Schema.NullOr(OrchestrationCheckpointStatus),
  checkpointFiles: Schema.Array(OrchestrationCheckpointFile),
});
export type ProjectionTurn = typeof ProjectionTurn.Type;

export const ProjectionTurnById = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  pendingMessageId: Schema.NullOr(MessageId),
  sourceProposedPlanThreadId: Schema.NullOr(ThreadId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
  assistantMessageId: Schema.NullOr(MessageId),
  state: ProjectionTurnState,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  checkpointTurnCount: Schema.NullOr(NonNegativeInt),
  checkpointRef: Schema.NullOr(CheckpointRef),
  checkpointStatus: Schema.NullOr(OrchestrationCheckpointStatus),
  checkpointFiles: Schema.Array(OrchestrationCheckpointFile),
});
export type ProjectionTurnById = typeof ProjectionTurnById.Type;

export const ProjectionPendingTurnStart = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  sourceProposedPlanThreadId: Schema.NullOr(ThreadId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
  requestedAt: IsoDateTime,
  /**
   * Globally-monotonic sequence of the originating turn-start-requested event.
   * Lets the reactor's supersession guard order same-millisecond re-requests
   * without the ties that `requestedAt` alone suffers.
   */
  requestSequence: NonNegativeInt,
  /**
   * Model selection of the originating turn-start-requested event, or null when
   * the start used the thread default. A session-exit auto-resume prefers this
   * over the provider session binding (which describes the older, last-sent
   * turn) so a pending steer resumes on the model the user chose for it.
   */
  modelSelection: Schema.NullOr(ModelSelection),
  /**
   * True when a user `thread.turn.interrupt` landed on this pending start before
   * the provider reported `turn.started` (an id-less interrupt the projection
   * could not otherwise attribute to a turn). The pending-start consumer births
   * the resulting turn `interrupted` rather than `running`, so the ensuing
   * session exit does not auto-resume work the user deliberately stopped.
   */
  pendingInterruptRequested: Schema.Boolean,
});
export type ProjectionPendingTurnStart = typeof ProjectionPendingTurnStart.Type;

export const ListProjectionTurnsByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionTurnsByThreadInput = typeof ListProjectionTurnsByThreadInput.Type;

export const GetProjectionTurnByTurnIdInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
});
export type GetProjectionTurnByTurnIdInput = typeof GetProjectionTurnByTurnIdInput.Type;

export const GetProjectionPendingTurnStartInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetProjectionPendingTurnStartInput = typeof GetProjectionPendingTurnStartInput.Type;

export const DeleteProjectionPendingTurnStartInput = Schema.Struct({
  threadId: ThreadId,
  /**
   * Identifies WHICH queued placeholder to remove. A thread can hold several at
   * once (one per turn-start-requested), so deleting by thread alone would drop
   * messages the provider has not run yet.
   */
  requestSequence: NonNegativeInt,
});
export type DeleteProjectionPendingTurnStartInput =
  typeof DeleteProjectionPendingTurnStartInput.Type;

export const DeleteProjectionTurnsByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionTurnsByThreadInput = typeof DeleteProjectionTurnsByThreadInput.Type;

export const ClearCheckpointTurnConflictInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
});
export type ClearCheckpointTurnConflictInput = typeof ClearCheckpointTurnConflictInput.Type;

export interface ProjectionTurnRepositoryShape {
  /**
   * Inserts or updates the canonical row for a concrete `{threadId, turnId}` turn lifecycle state.
   */
  readonly upsertByTurnId: (
    row: ProjectionTurnById,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Records one pending-start placeholder, keyed by its originating event's
   * `requestSequence`.
   *
   * Placeholders ACCUMULATE: queueing a second message while the first has not
   * yet reported `turn.started` leaves both rows in place. The previous
   * behavior — delete-all-then-insert — made this a single slot per thread, so
   * the second request evicted the first, a delayed `turn.started` then adopted
   * the wrong row's message/model/plan/interrupt metadata, and consuming it
   * erased the queued message with nothing left for reconciliation to find.
   *
   * Idempotent under replay: re-applying the same event is a no-op rather than
   * a duplicate row, because `requestSequence` is the row's identity.
   */
  readonly appendPendingTurnStart: (
    row: ProjectionPendingTurnStart,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Returns the OLDEST outstanding pending-start placeholder for a thread — the
   * next one a provider `turn.started` should consume.
   *
   * Oldest, not newest: the provider runs queued messages in the order they were
   * sent, so the earliest unconsumed placeholder is the one the next reported
   * turn belongs to. Returns `None` when the thread has nothing queued.
   */
  readonly getPendingTurnStartByThreadId: (
    input: GetProjectionPendingTurnStartInput,
  ) => Effect.Effect<Option.Option<ProjectionPendingTurnStart>, ProjectionRepositoryError>;

  /**
   * Returns every outstanding pending-start placeholder for a thread, oldest
   * first. Used by paths that must account for the whole queue rather than just
   * its head — notably crash reconciliation, which has to surface each stranded
   * message instead of only the first.
   */
  readonly listPendingTurnStartsByThreadId: (
    input: GetProjectionPendingTurnStartInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionPendingTurnStart>, ProjectionRepositoryError>;

  /**
   * Deletes ONE pending-start placeholder, identified by its `requestSequence`.
   *
   * Consuming a placeholder must not disturb the rest of the queue: a
   * `turn.started` settles the one request it corresponds to and leaves any
   * later queued messages waiting for their own turns.
   */
  readonly deletePendingTurnStart: (
    input: DeleteProjectionPendingTurnStartInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Deletes ALL pending-start placeholder rows (`turnId = null`) for a thread and leaves concrete turn rows untouched.
   * Reserved for whole-thread teardown; per-request consumption uses `deletePendingTurnStart`.
   */
  readonly deletePendingTurnStartByThreadId: (
    input: GetProjectionPendingTurnStartInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Flags the thread's pending-start placeholder row(s) as interrupted, recording that a
   * user interrupt arrived before the provider reported `turn.started`. A no-op when no
   * pending start exists (nothing is running to interrupt via this id-less path).
   */
  readonly markPendingTurnStartInterrupted: (
    input: GetProjectionPendingTurnStartInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Lists all projection rows for a thread, including pending placeholders, with checkpoint rows ordered before non-checkpoint rows.
   */
  readonly listByThreadId: (
    input: ListProjectionTurnsByThreadInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionTurn>, ProjectionRepositoryError>;

  /**
   * Looks up a concrete turn row by `{threadId, turnId}` and never returns pending placeholder rows.
   */
  readonly getByTurnId: (
    input: GetProjectionTurnByTurnIdInput,
  ) => Effect.Effect<Option.Option<ProjectionTurnById>, ProjectionRepositoryError>;

  /**
   * Clears checkpoint fields on conflicting rows that reuse the same checkpoint turn count in a thread, excluding the provided turn.
   */
  readonly clearCheckpointTurnConflict: (
    input: ClearCheckpointTurnConflictInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Hard-deletes all projection rows for a thread, including pending-start placeholders and checkpoint metadata rows.
   */
  readonly deleteByThreadId: (
    input: DeleteProjectionTurnsByThreadInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionTurnRepository extends Context.Service<
  ProjectionTurnRepository,
  ProjectionTurnRepositoryShape
>()("t3/persistence/Services/ProjectionTurns/ProjectionTurnRepository") {}
