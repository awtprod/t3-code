import {
  EventId,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionProjectRepositoryLive } from "./ProjectionProjects.ts";
import { ProjectionThreadRepositoryLive } from "./ProjectionThreads.ts";
import { ProjectionThreadActivityRepositoryLive } from "./ProjectionThreadActivities.ts";
import { ProjectionTurnRepositoryLive } from "./ProjectionTurns.ts";
import { ProjectionProjectRepository } from "../Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../Services/ProjectionThreads.ts";
import { ProjectionThreadActivityRepository } from "../Services/ProjectionThreadActivities.ts";
import { ProjectionTurnRepository } from "../Services/ProjectionTurns.ts";

const projectionRepositoriesLayer = it.layer(
  Layer.mergeAll(
    ProjectionProjectRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionThreadRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionThreadActivityRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionTurnRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

projectionRepositoriesLayer("Projection repositories", (it) => {
  it.effect("stores SQL NULL for missing project model options", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectionProjectRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* projects.upsert({
        projectId: ProjectId.make("project-null-options"),
        title: "Null options project",
        workspaceRoot: "/tmp/project-null-options",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        scripts: [],
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
        deletedAt: null,
      });

      const rows = yield* sql<{
        readonly defaultModelSelection: string | null;
      }>`
        SELECT default_model_selection_json AS "defaultModelSelection"
        FROM projection_projects
        WHERE project_id = 'project-null-options'
      `;
      const row = rows[0];
      if (!row) {
        return yield* Effect.die("Expected projection_projects row to exist.");
      }

      assert.strictEqual(
        row.defaultModelSelection,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        }),
      );

      const persisted = yield* projects.getById({
        projectId: ProjectId.make("project-null-options"),
      });
      assert.deepStrictEqual(Option.getOrNull(persisted)?.defaultModelSelection, {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      });
    }),
  );

  it.effect("stores JSON for thread model options", () =>
    Effect.gen(function* () {
      const threads = yield* ProjectionThreadRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* threads.upsert({
        threadId: ThreadId.make("thread-null-options"),
        projectId: ProjectId.make("project-null-options"),
        title: "Null options thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurnId: null,
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
        archivedAt: null,
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        deletedAt: null,
      });

      const rows = yield* sql<{
        readonly modelSelection: string | null;
      }>`
        SELECT model_selection_json AS "modelSelection"
        FROM projection_threads
        WHERE thread_id = 'thread-null-options'
      `;
      const row = rows[0];
      if (!row) {
        return yield* Effect.die("Expected projection_threads row to exist.");
      }

      assert.strictEqual(
        row.modelSelection,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        }),
      );

      const persisted = yield* threads.getById({
        threadId: ThreadId.make("thread-null-options"),
      });
      assert.deepStrictEqual(Option.getOrNull(persisted)?.modelSelection, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      });
    }),
  );

  it.effect("round-trips correlated activity message ids and preserves SQL NULL", () =>
    Effect.gen(function* () {
      const activities = yield* ProjectionThreadActivityRepository;
      const turns = yield* ProjectionTurnRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-activity-correlation");

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-activity-correlation',
          'Activity correlation project',
          '/tmp/project-activity-correlation',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          '[]',
          '2026-03-24T00:00:00.000Z',
          '2026-03-24T00:00:00.000Z',
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          deleted_at
        )
        VALUES (
          ${threadId},
          'project-activity-correlation',
          'Activity correlation thread',
          NULL,
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          '2026-03-24T00:00:00.000Z',
          '2026-03-24T00:00:00.000Z',
          NULL,
          NULL,
          0,
          0,
          0,
          NULL
        )
      `;

      yield* activities.upsert({
        activityId: EventId.make("activity-correlated"),
        threadId,
        turnId: TurnId.make("turn-correlated"),
        correlatedMessageId: MessageId.make("message-correlated"),
        tone: "tool",
        kind: "tool.completed",
        summary: "correlated evidence",
        payload: { status: "completed" },
        createdAt: "2026-03-24T00:00:01.000Z",
      });
      yield* activities.upsert({
        activityId: EventId.make("activity-unattributed"),
        threadId,
        turnId: null,
        tone: "tool",
        kind: "tool.started",
        summary: "unattributed evidence",
        payload: { status: "started" },
        createdAt: "2026-03-24T00:00:02.000Z",
      });

      const persisted = yield* activities.listByThreadId({ threadId });
      assert.strictEqual(persisted[0]?.correlatedMessageId, "message-correlated");
      assert.strictEqual(persisted[1]?.correlatedMessageId, undefined);

      const rows = yield* sql<{
        readonly activityId: string;
        readonly correlatedMessageId: string | null;
      }>`
        SELECT
          activity_id AS "activityId",
          correlated_message_id AS "correlatedMessageId"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
        ORDER BY activity_id
      `;
      assert.deepStrictEqual(rows, [
        {
          activityId: "activity-correlated",
          correlatedMessageId: "message-correlated",
        },
        {
          activityId: "activity-unattributed",
          correlatedMessageId: null,
        },
      ]);

      yield* turns.upsertByTurnId({
        threadId,
        turnId: TurnId.make("turn-with-request-sequence"),
        pendingMessageId: MessageId.make("message-correlated"),
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        assistantMessageId: null,
        state: "running",
        requestedAt: "2026-03-24T00:00:03.000Z",
        requestSequence: NonNegativeInt.make(42),
        startedAt: "2026-03-24T00:00:03.000Z",
        completedAt: null,
        checkpointTurnCount: null,
        checkpointRef: null,
        checkpointStatus: null,
        checkpointFiles: [],
      });
      yield* turns.upsertByTurnId({
        threadId,
        turnId: TurnId.make("turn-with-historical-null-sequence"),
        pendingMessageId: MessageId.make("message-correlated"),
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        assistantMessageId: null,
        state: "running",
        requestedAt: "2026-03-24T00:00:04.000Z",
        requestSequence: null,
        startedAt: "2026-03-24T00:00:04.000Z",
        completedAt: null,
        checkpointTurnCount: null,
        checkpointRef: null,
        checkpointStatus: null,
        checkpointFiles: [],
      });

      const sequenced = yield* turns.getByTurnId({
        threadId,
        turnId: TurnId.make("turn-with-request-sequence"),
      });
      const historical = yield* turns.getByTurnId({
        threadId,
        turnId: TurnId.make("turn-with-historical-null-sequence"),
      });
      assert.strictEqual(Option.getOrThrow(sequenced).requestSequence, 42);
      assert.strictEqual(Option.getOrThrow(historical).requestSequence, null);
      const requestSequenceRows = yield* sql<{
        readonly turnId: string;
        readonly requestSequence: number | null;
      }>`
        SELECT
          turn_id AS "turnId",
          request_sequence AS "requestSequence"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id IS NOT NULL
        ORDER BY turn_id
      `;
      assert.deepStrictEqual(requestSequenceRows, [
        {
          turnId: "turn-with-historical-null-sequence",
          requestSequence: 0,
        },
        {
          turnId: "turn-with-request-sequence",
          requestSequence: 42,
        },
      ]);
    }),
  );
});
