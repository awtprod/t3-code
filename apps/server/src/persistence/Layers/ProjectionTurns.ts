import {
  EfficiencyDecision,
  ModelSelection,
  NonNegativeInt,
  OrchestrationCheckpointFile,
} from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Struct from "effect/Struct";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  ClearCheckpointTurnConflictInput,
  DeleteProjectionPendingTurnStartInput,
  DeleteProjectionTurnsByThreadInput,
  GetProjectionPendingTurnStartInput,
  GetProjectionTurnByTurnIdInput,
  ListProjectionTurnsByThreadInput,
  ProjectionPendingTurnStart,
  ProjectionTurn,
  ProjectionTurnById,
  ProjectionTurnRepository,
  type ProjectionTurnRepositoryShape,
} from "../Services/ProjectionTurns.ts";

// Decodes SQLite's 0/1 integer boolean column into a domain boolean and back.
const BooleanFromSqliteInt = Schema.Number.pipe(
  Schema.decodeTo(
    Schema.Boolean,
    SchemaTransformation.transformOrFail({
      decode: (value: number) => Effect.succeed(value !== 0),
      encode: (value: boolean) => Effect.succeed(value ? 1 : 0),
    }),
  ),
);

// Migration 043 gave historical rows the sentinel sequence zero. Concrete
// turns use only real event sequences (> 0), so expose that historical value as
// nullable while retaining the existing column and migration.
const NullableConcreteRequestSequenceFromSqlite = Schema.Number.pipe(
  Schema.decodeTo(
    Schema.NullOr(NonNegativeInt),
    SchemaTransformation.transformOrFail({
      decode: (value: number) => Effect.succeed(value === 0 ? null : value),
      encode: (value: number | null) => Effect.succeed(value ?? 0),
    }),
  ),
);

const ProjectionTurnDbRowSchema = ProjectionTurn.mapFields(
  Struct.assign({
    requestSequence: NullableConcreteRequestSequenceFromSqlite,
    checkpointFiles: Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)),
    efficiencyDecision: Schema.NullOr(Schema.fromJsonString(EfficiencyDecision)),
  }),
);

const ProjectionTurnByIdDbRowSchema = ProjectionTurnById.mapFields(
  Struct.assign({
    requestSequence: NullableConcreteRequestSequenceFromSqlite,
    checkpointFiles: Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)),
    efficiencyDecision: Schema.NullOr(Schema.fromJsonString(EfficiencyDecision)),
  }),
);

// Persists `modelSelection` as a nullable JSON text column (`model_selection`)
// and `pendingInterruptRequested` as a 0/1 integer (`pending_interrupt_requested`).
const ProjectionPendingTurnStartDbRowSchema = ProjectionPendingTurnStart.mapFields(
  Struct.assign({
    modelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
    efficiencyDecision: Schema.NullOr(Schema.fromJsonString(EfficiencyDecision)),
    pendingInterruptRequested: BooleanFromSqliteInt,
  }),
);

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionTurnRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionTurnById = SqlSchema.void({
    Request: ProjectionTurnByIdDbRowSchema,
    execute: (row) =>
      sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          request_sequence,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json,
          efficiency_decision_json
        )
        VALUES (
          ${row.threadId},
          ${row.turnId},
          ${row.pendingMessageId},
          ${row.sourceProposedPlanThreadId},
          ${row.sourceProposedPlanId},
          ${row.assistantMessageId},
          ${row.state},
          ${row.requestedAt},
          ${row.requestSequence ?? 0},
          ${row.startedAt},
          ${row.completedAt},
          ${row.checkpointTurnCount},
          ${row.checkpointRef},
          ${row.checkpointStatus},
          ${row.checkpointFiles},
          ${row.efficiencyDecision ?? null}
        )
        ON CONFLICT (thread_id, turn_id)
        DO UPDATE SET
          pending_message_id = excluded.pending_message_id,
          source_proposed_plan_thread_id = excluded.source_proposed_plan_thread_id,
          source_proposed_plan_id = excluded.source_proposed_plan_id,
          assistant_message_id = excluded.assistant_message_id,
          state = excluded.state,
          requested_at = excluded.requested_at,
          request_sequence = excluded.request_sequence,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          checkpoint_turn_count = excluded.checkpoint_turn_count,
          checkpoint_ref = excluded.checkpoint_ref,
          checkpoint_status = excluded.checkpoint_status,
          checkpoint_files_json = excluded.checkpoint_files_json,
          efficiency_decision_json = excluded.efficiency_decision_json
      `,
  });

  const clearPendingProjectionTurnsByThread = SqlSchema.void({
    Request: DeleteProjectionTurnsByThreadInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id IS NULL
          AND state = 'pending'
          AND checkpoint_turn_count IS NULL
      `,
  });

  const insertPendingProjectionTurn = SqlSchema.void({
    Request: ProjectionPendingTurnStartDbRowSchema,
    execute: (row) =>
      sql`
        INSERT OR IGNORE INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          request_sequence,
          model_selection,
          pending_interrupt_requested,
          efficiency_decision_json,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          ${row.threadId},
          NULL,
          ${row.messageId},
          ${row.sourceProposedPlanThreadId},
          ${row.sourceProposedPlanId},
          NULL,
          'pending',
          ${row.requestedAt},
          ${row.requestSequence},
          ${row.modelSelection},
          0,
          ${row.efficiencyDecision ?? null},
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          '[]'
        )
      `,
  });

  const getPendingProjectionTurn = SqlSchema.findOneOption({
    Request: GetProjectionPendingTurnStartInput,
    Result: ProjectionPendingTurnStartDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          pending_message_id AS "messageId",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          requested_at AS "requestedAt",
          request_sequence AS "requestSequence",
          model_selection AS "modelSelection",
          pending_interrupt_requested AS "pendingInterruptRequested"
          , efficiency_decision_json AS "efficiencyDecision"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id IS NULL
          AND state = 'pending'
          AND pending_message_id IS NOT NULL
          AND checkpoint_turn_count IS NULL
        ORDER BY request_sequence ASC, requested_at ASC
        LIMIT 1
      `,
  });

  const listPendingProjectionTurns = SqlSchema.findAll({
    Request: GetProjectionPendingTurnStartInput,
    Result: ProjectionPendingTurnStartDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          pending_message_id AS "messageId",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          requested_at AS "requestedAt",
          request_sequence AS "requestSequence",
          model_selection AS "modelSelection",
          pending_interrupt_requested AS "pendingInterruptRequested"
          , efficiency_decision_json AS "efficiencyDecision"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id IS NULL
          AND state = 'pending'
          AND pending_message_id IS NOT NULL
          AND checkpoint_turn_count IS NULL
        ORDER BY request_sequence ASC, requested_at ASC
      `,
  });

  const deletePendingProjectionTurn = SqlSchema.void({
    Request: DeleteProjectionPendingTurnStartInput,
    execute: ({ threadId, requestSequence }) =>
      sql`
        DELETE FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id IS NULL
          AND state = 'pending'
          AND pending_message_id IS NOT NULL
          AND checkpoint_turn_count IS NULL
          AND request_sequence = ${requestSequence}
      `,
  });

  const markPendingProjectionTurnInterrupted = SqlSchema.void({
    Request: GetProjectionPendingTurnStartInput,
    execute: ({ threadId }) =>
      sql`
        UPDATE projection_turns
        SET pending_interrupt_requested = 1
        WHERE thread_id = ${threadId}
          AND turn_id IS NULL
          AND state = 'pending'
          AND pending_message_id IS NOT NULL
          AND checkpoint_turn_count IS NULL
      `,
  });

  const listProjectionTurnsByThread = SqlSchema.findAll({
    Request: ListProjectionTurnsByThreadInput,
    Result: ProjectionTurnDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          pending_message_id AS "pendingMessageId",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          assistant_message_id AS "assistantMessageId",
          state,
          requested_at AS "requestedAt",
          request_sequence AS "requestSequence",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "checkpointStatus",
          checkpoint_files_json AS "checkpointFiles",
          efficiency_decision_json AS "efficiencyDecision"
        FROM projection_turns
        WHERE thread_id = ${threadId}
        ORDER BY
          CASE
            WHEN checkpoint_turn_count IS NULL THEN 1
            ELSE 0
          END ASC,
          checkpoint_turn_count ASC,
          requested_at ASC,
          turn_id ASC
      `,
  });

  const getProjectionTurnByTurnId = SqlSchema.findOneOption({
    Request: GetProjectionTurnByTurnIdInput,
    Result: ProjectionTurnByIdDbRowSchema,
    execute: ({ threadId, turnId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          pending_message_id AS "pendingMessageId",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          assistant_message_id AS "assistantMessageId",
          state,
          requested_at AS "requestedAt",
          request_sequence AS "requestSequence",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "checkpointStatus",
          checkpoint_files_json AS "checkpointFiles",
          efficiency_decision_json AS "efficiencyDecision"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id = ${turnId}
        LIMIT 1
      `,
  });

  const clearCheckpointTurnConflictRow = SqlSchema.void({
    Request: ClearCheckpointTurnConflictInput,
    execute: ({ threadId, turnId, checkpointTurnCount }) =>
      sql`
        UPDATE projection_turns
        SET
          checkpoint_turn_count = NULL,
          checkpoint_ref = NULL,
          checkpoint_status = NULL,
          checkpoint_files_json = '[]'
        WHERE thread_id = ${threadId}
          AND checkpoint_turn_count = ${checkpointTurnCount}
          AND (turn_id IS NULL OR turn_id <> ${turnId})
      `,
  });

  const deleteProjectionTurnsByThread = SqlSchema.void({
    Request: DeleteProjectionTurnsByThreadInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_turns
        WHERE thread_id = ${threadId}
      `,
  });

  const upsertByTurnId: ProjectionTurnRepositoryShape["upsertByTurnId"] = (row) =>
    upsertProjectionTurnById({ ...row, efficiencyDecision: row.efficiencyDecision ?? null }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnRepository.upsertByTurnId:query",
          "ProjectionTurnRepository.upsertByTurnId:encodeRequest",
        ),
      ),
    );

  // Appends rather than replaces: the queue holds one row per turn-start
  // request. The insert is `INSERT OR IGNORE` against the unique
  // (thread_id, request_sequence) placeholder index, which makes a replayed
  // event a no-op instead of a duplicate — so no read-then-write transaction is
  // needed to keep it idempotent.
  const appendPendingTurnStart: ProjectionTurnRepositoryShape["appendPendingTurnStart"] = (row) =>
    insertPendingProjectionTurn({
      ...row,
      efficiencyDecision: row.efficiencyDecision ?? null,
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnRepository.appendPendingTurnStart:query",
          "ProjectionTurnRepository.appendPendingTurnStart:encodeRequest",
        ),
      ),
    );

  const getPendingTurnStartByThreadId: ProjectionTurnRepositoryShape["getPendingTurnStartByThreadId"] =
    (input) =>
      getPendingProjectionTurn(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionTurnRepository.getPendingTurnStartByThreadId:query"),
        ),
      );

  const listPendingTurnStartsByThreadId: ProjectionTurnRepositoryShape["listPendingTurnStartsByThreadId"] =
    (input) =>
      listPendingProjectionTurns(input).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionTurnRepository.listPendingTurnStartsByThreadId:query",
            "ProjectionTurnRepository.listPendingTurnStartsByThreadId:decodeRows",
          ),
        ),
        Effect.map(
          (rows) => rows as ReadonlyArray<Schema.Schema.Type<typeof ProjectionPendingTurnStart>>,
        ),
      );

  const deletePendingTurnStart: ProjectionTurnRepositoryShape["deletePendingTurnStart"] = (input) =>
    deletePendingProjectionTurn(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnRepository.deletePendingTurnStart:query",
          "ProjectionTurnRepository.deletePendingTurnStart:encodeRequest",
        ),
      ),
    );

  const deletePendingTurnStartByThreadId: ProjectionTurnRepositoryShape["deletePendingTurnStartByThreadId"] =
    (input) =>
      clearPendingProjectionTurnsByThread(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionTurnRepository.deletePendingTurnStartByThreadId:query"),
        ),
      );

  const markPendingTurnStartInterrupted: ProjectionTurnRepositoryShape["markPendingTurnStartInterrupted"] =
    (input) =>
      markPendingProjectionTurnInterrupted(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionTurnRepository.markPendingTurnStartInterrupted:query"),
        ),
      );

  const listByThreadId: ProjectionTurnRepositoryShape["listByThreadId"] = (input) =>
    listProjectionTurnsByThread(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnRepository.listByThreadId:query",
          "ProjectionTurnRepository.listByThreadId:decodeRows",
        ),
      ),
      Effect.map((rows) => rows as ReadonlyArray<Schema.Schema.Type<typeof ProjectionTurn>>),
    );

  const getByTurnId: ProjectionTurnRepositoryShape["getByTurnId"] = (input) =>
    getProjectionTurnByTurnId(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnRepository.getByTurnId:query",
          "ProjectionTurnRepository.getByTurnId:decodeRow",
        ),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            Effect.succeed(Option.some(row as Schema.Schema.Type<typeof ProjectionTurnById>)),
        }),
      ),
    );

  const clearCheckpointTurnConflict: ProjectionTurnRepositoryShape["clearCheckpointTurnConflict"] =
    (input) =>
      clearCheckpointTurnConflictRow(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionTurnRepository.clearCheckpointTurnConflict:query"),
        ),
      );

  const deleteByThreadId: ProjectionTurnRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionTurnsByThread(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionTurnRepository.deleteByThreadId:query")),
    );

  return {
    upsertByTurnId,
    appendPendingTurnStart,
    getPendingTurnStartByThreadId,
    listPendingTurnStartsByThreadId,
    deletePendingTurnStart,
    deletePendingTurnStartByThreadId,
    markPendingTurnStartInterrupted,
    listByThreadId,
    getByTurnId,
    clearCheckpointTurnConflict,
    deleteByThreadId,
  } satisfies ProjectionTurnRepositoryShape;
});

export const ProjectionTurnRepositoryLive = Layer.effect(
  ProjectionTurnRepository,
  makeProjectionTurnRepository,
);
