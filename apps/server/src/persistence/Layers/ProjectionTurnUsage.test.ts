import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { createOverrideRateTable } from "../../usage/usagePricing.ts";
import { UsageService } from "../../usage/UsageService.ts";
import { runMigrations } from "../Migrations.ts";
import { ProjectionTurnUsageRepository } from "../Services/ProjectionTurnUsage.ts";
import { ProjectionTurnUsageRepositoryLive } from "./ProjectionTurnUsage.ts";

const usageService = Layer.mock(UsageService)({
  readRateTables: Effect.succeed({
    rates: new Map(),
    // $3 / 1M input, $0.30 / 1M cache read, $15 / 1M output.
    overrides: createOverrideRateTable({
      "acme-model-1": {
        inputCostPerMillionTokens: 3,
        outputCostPerMillionTokens: 15,
        cacheReadCostPerMillionTokens: 0.3,
      },
    }),
    aliases: new Map(),
  }),
});
const layer = ProjectionTurnUsageRepositoryLive.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeSqliteClient.layerMemory(), usageService)),
);

/** Seeds one v2 thread, run, attempt, provider thread and provider turn. */
const seedTurn = (input: {
  readonly threadId: string;
  readonly ordinal: number;
  readonly model: string;
  readonly instanceId: string;
  readonly turnTokenUsage: unknown;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly status?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const runId = `${input.threadId}:run-${input.ordinal}`;
    const attemptId = `${runId}:attempt-1`;
    const providerThreadId = `${input.threadId}:provider-thread`;
    const providerTurnId = `${input.threadId}:provider-turn-${input.ordinal}`;
    yield* sql`
      INSERT OR IGNORE INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, payload_json, provider_instance_id
      ) VALUES (
        ${input.threadId}, 'project-acme', 'Usage', ${input.instanceId}, 'full-access',
        'default', ${input.startedAt}, ${input.completedAt}, '{}', ${input.instanceId}
      )
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at,
        completed_at, payload_json, provider_instance_id
      ) VALUES (
        ${runId}, ${input.threadId}, ${input.ordinal}, ${input.instanceId}, ${providerThreadId},
        'completed', ${input.startedAt}, ${input.completedAt},
        ${JSON.stringify({ modelSelection: { instanceId: input.instanceId, model: input.model } })},
        ${input.instanceId}
      )
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_run_attempts (
        attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider,
        provider_thread_id, provider_turn_id, status, payload_json, provider_instance_id
      ) VALUES (
        ${attemptId}, ${input.threadId}, ${runId}, 1, ${`${runId}:root`}, ${input.instanceId},
        ${providerThreadId}, ${providerTurnId}, 'completed', '{}', ${input.instanceId}
      )
    `;
    yield* sql`
      INSERT OR IGNORE INTO orchestration_v2_projection_provider_threads (
        provider_thread_id, thread_id, provider, status, updated_at, payload_json, driver,
        provider_instance_id
      ) VALUES (
        ${providerThreadId}, ${input.threadId}, ${input.instanceId}, 'idle', ${input.completedAt},
        '{}', 'codex', ${input.instanceId}
      )
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_provider_turns (
        provider_turn_id, thread_id, provider_thread_id, node_id, run_attempt_id, ordinal,
        status, started_at, completed_at, payload_json
      ) VALUES (
        ${providerTurnId}, ${input.threadId}, ${providerThreadId}, ${`${runId}:root`},
        ${attemptId}, ${input.ordinal}, ${input.status ?? "completed"}, ${input.startedAt},
        ${input.completedAt},
        ${JSON.stringify(input.turnTokenUsage === undefined ? {} : { turnTokenUsage: input.turnTokenUsage })}
      )
    `;
  });

it.layer(layer)("ProjectionTurnUsageRepository on orchestration v2", (it) => {
  it.effect("maps v2 provider turn usage onto usage analytics rows", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ProjectionTurnUsageRepository;

      // Interactive turn: 1,000 input of which 100 cache reads and 50 cache writes.
      yield* seedTurn({
        threadId: "thread-usage",
        ordinal: 1,
        model: "acme-model-1",
        instanceId: "codex-main",
        startedAt: "2026-08-01T12:00:00.000Z",
        completedAt: "2026-08-01T12:00:30.000Z",
        turnTokenUsage: {
          usageScope: "main_agent",
          usageStatus: "complete",
          inputTokens: 1_000,
          cachedInputTokens: 100,
          cacheCreationTokens: 50,
          outputTokens: 200,
          reasoningTokens: 20,
          hasSubagents: false,
        },
      });
      // Command Center automation turn with partial usage.
      yield* seedTurn({
        threadId: "cc:run-usage",
        ordinal: 1,
        model: "acme-model-1",
        instanceId: "codex-main",
        startedAt: "2026-08-01T13:00:00.000Z",
        completedAt: "2026-08-01T13:00:10.000Z",
        turnTokenUsage: {
          usageScope: "main_agent",
          usageStatus: "partial",
          outputTokens: 10,
          hasSubagents: false,
        },
      });
      // Outside the window, and a turn with no usage report at all.
      yield* seedTurn({
        threadId: "thread-usage",
        ordinal: 2,
        model: "acme-model-1",
        instanceId: "codex-main",
        startedAt: "2026-08-03T12:00:00.000Z",
        completedAt: "2026-08-03T12:00:01.000Z",
        turnTokenUsage: {
          usageScope: "main_agent",
          usageStatus: "complete",
          inputTokens: 1,
          outputTokens: 1,
          hasSubagents: false,
        },
      });
      yield* seedTurn({
        threadId: "thread-usage",
        ordinal: 3,
        model: "acme-model-1",
        instanceId: "codex-main",
        startedAt: "2026-08-01T14:00:00.000Z",
        completedAt: "2026-08-01T14:00:01.000Z",
        turnTokenUsage: undefined,
      });
      yield* sql`
        INSERT INTO internal_generation_usage (
          operation_id, operation, provider_instance_id, model, duration_ms,
          input_tokens, output_tokens, cost_micro_usd, status, completed_at
        ) VALUES (
          'internal-1', 'title', 'codex-main', 'acme-model-1', 42,
          NULL, NULL, NULL, 'success', '2026-08-01T12:00:00.000Z'
        )
      `;

      const window = {
        from: "2026-08-01T00:00:00.000Z",
        to: "2026-08-02T00:00:00.000Z",
        bucket: "hour",
      } as const;
      const first = yield* repository.query({ ...window, limit: 1 });
      assert.equal(first.summary.turnCount, 2);
      assert.equal(first.summary.componentCount, 2);
      assert.equal(first.summary.completeComponentCount, 1);
      assert.equal(first.summary.tokens.uncachedInputTokens, 850);
      assert.equal(first.summary.tokens.cacheReadInputTokens, 100);
      assert.equal(first.summary.tokens.cacheWriteInputTokens, 50);
      assert.equal(first.summary.tokens.outputTokens, 210);
      assert.equal(first.summary.tokens.reasoningOutputTokens, 20);
      assert.equal(first.summary.tokens.durationMs, 40_000);
      // 850 x $3 + 100 x $0.30 + 50 x $3 (cache write defaults to input) + 210 x $15, per 1M.
      assert.equal(first.summary.cost.microUsd, 2_550 + 30 + 150 + 3_150);
      assert.equal(first.summary.cost.kind, "estimated");
      assert.deepEqual(
        first.byWorkload
          .map((row) => [row.key, row.summary.turnCount] as const)
          .toSorted(([left], [right]) => left.localeCompare(right)),
        [
          ["automation", 1],
          ["interactive", 1],
        ],
      );
      assert.deepEqual(first.pricingProvenance, [
        { key: "usagePriceOverrides", componentCount: 2 },
      ]);
      assert.equal(first.byTier[0]?.key, "Manual / unrouted");
      assert.equal(first.turns.length, 1);
      assert.equal(first.turns[0]?.threadId, "cc:run-usage");
      assert.equal(first.turns[0]?.provider, "codex");
      assert.equal(first.turns[0]?.model, "acme-model-1");
      assert.equal(first.nextCursor, "1");
      assert.equal(first.internalGeneration.summary.invocationCount, 1);
      assert.equal(first.internalGeneration.byOperation[0]?.key, "title");

      const second = yield* repository.query({ ...window, cursor: "1", limit: 1 });
      assert.equal(second.turns[0]?.threadId, "thread-usage");
      assert.equal(second.turns[0]?.projectId, "project-acme");
      assert.equal(second.nextCursor, null);

      const automation = yield* repository.query({ ...window, workload: "automation" });
      assert.equal(automation.summary.turnCount, 1);
      const reported = yield* repository.query({ ...window, quality: "reported" });
      assert.equal(reported.summary.turnCount, 1);
      const otherModel = yield* repository.query({ ...window, model: "acme-model-2" });
      assert.equal(otherModel.summary.turnCount, 0);
      const tiered = yield* repository.query({ ...window, tier: "standard" as never });
      assert.equal(tiered.summary.turnCount, 0);
    }),
  );
});
