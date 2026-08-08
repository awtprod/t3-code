import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerSettingsService } from "../../serverSettings.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { ProjectionTurnUsageRepository } from "../Services/ProjectionTurnUsage.ts";
import { ProjectionTurnUsageRepositoryLive } from "./ProjectionTurnUsage.ts";

const persistence = NodeSqliteClient.layerMemory();
const dependencies = Layer.mergeAll(persistence, ServerSettingsService.layerTest());
const layer = ProjectionTurnUsageRepositoryLive.pipe(Layer.provideMerge(dependencies));

it.layer(layer)("ProjectionTurnUsageRepository", (it) => {
  it.effect("upserts replayed components and returns honest aggregates and pagination", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ProjectionTurnUsageRepository;
      const provider = ProviderDriverKind.make("kimi");
      const providerInstanceId = ProviderInstanceId.make("kimi-main");
      const threadId = ThreadId.make("usage-thread");
      const turnId = TurnId.make("turn-1");
      const completedAt = "2026-08-01T12:00:00.000Z";
      const base = {
        threadId,
        turnId,
        projectId: null,
        providerInstanceId,
        provider,
      } as const;

      yield* repository.record({
        ...base,
        usage: {
          component: { kind: "main", id: "main" },
          model: "kimi-code/k3",
          workload: "interactive",
          quality: "reported",
          uncachedInputTokens: 100,
          cacheReadInputTokens: 10,
          outputTokens: 20,
          billingMode: "api",
          completedAt,
        },
      });
      yield* sql`
        INSERT INTO internal_generation_usage (
          operation_id, operation, provider_instance_id, model, duration_ms,
          input_tokens, output_tokens, cost_micro_usd, status, completed_at
        ) VALUES (
          'internal-1', 'title', ${providerInstanceId}, 'kimi-code/k3', 42,
          NULL, NULL, NULL, 'success', ${completedAt}
        )
      `;
      // A replay updates the stable component row instead of counting it twice.
      yield* repository.record({
        ...base,
        usage: {
          component: { kind: "main", id: "main" },
          model: "kimi-code/k3",
          workload: "interactive",
          quality: "reported",
          uncachedInputTokens: 200,
          cacheReadInputTokens: 20,
          outputTokens: 40,
          billingMode: "api",
          completedAt,
        },
      });
      yield* repository.record({
        ...base,
        usage: {
          component: { kind: "subagent", id: "agent-1" },
          model: "kimi-code/k3",
          workload: "interactive",
          quality: "partial",
          cacheReadInputTokens: 5,
          completedAt,
        },
      });
      yield* repository.record({
        ...base,
        turnId: TurnId.make("turn-2"),
        usage: {
          component: { kind: "main", id: "main" },
          model: "kimi-code/k3",
          workload: "automation",
          quality: "partial",
          completedAt: "2026-08-01T13:00:00.000Z",
        },
      });

      const first = yield* repository.query({
        from: "2026-08-01T00:00:00.000Z",
        to: "2026-08-02T00:00:00.000Z",
        bucket: "hour",
        providerInstanceId,
        limit: 1,
      });
      assert.equal(first.summary.componentCount, 3);
      assert.equal(first.summary.turnCount, 2);
      assert.equal(first.summary.tokens.uncachedInputTokens, 200);
      assert.equal(first.summary.tokens.cacheReadInputTokens, 25);
      assert.equal(first.summary.completeComponentCount, 1);
      assert.equal(
        first.byComponent.find((row) => row.key === "subagent")?.summary.componentCount,
        1,
      );
      assert.equal(first.turns.length, 1);
      assert.equal(first.nextCursor, "1");
      assert.equal(first.summary.cost.kind, "api-equivalent-estimate");
      assert.equal(first.internalGeneration.summary.invocationCount, 1);
      assert.equal(first.internalGeneration.summary.successCount, 1);
      assert.equal(first.internalGeneration.summary.inputTokens, null);
      assert.equal(first.internalGeneration.byOperation[0]?.key, "title");

      const second = yield* repository.query({
        from: "2026-08-01T00:00:00.000Z",
        to: "2026-08-02T00:00:00.000Z",
        bucket: "hour",
        cursor: first.nextCursor ?? undefined,
        limit: 1,
      });
      assert.equal(second.turns.length, 1);
      assert.equal(second.nextCursor, null);
    }),
  );
});
