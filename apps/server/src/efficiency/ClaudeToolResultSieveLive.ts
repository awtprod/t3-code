/**
 * Live layer for {@link ClaudeToolResultSieve}: the efficiency Judge, the live
 * sieve settings, and the thread's latest user message from the V2 message
 * projection. Provided by `server.ts`.
 *
 * @module ClaudeToolResultSieveLive
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerSettingsService } from "../serverSettings.ts";
import { ClaudeToolResultSieve, makeClaudeToolResultSieveHooks } from "./ClaudeToolResultSieve.ts";
import { Judge } from "./Judge.ts";

export const layer = Layer.effect(
  ClaudeToolResultSieve,
  Effect.gen(function* () {
    const judge = yield* Judge;
    const settingsService = yield* ServerSettingsService;
    const sql = yield* SqlClient.SqlClient;
    const holder = { efficiency: (yield* settingsService.getSettings).efficiency };
    // Keep the mode live without a settings read per opened query.
    yield* settingsService.streamChanges.pipe(
      Stream.runForEach((settings) =>
        Effect.sync(() => {
          holder.efficiency = settings.efficiency;
        }),
      ),
      Effect.catchCause(() => Effect.void),
      Effect.forkScoped,
    );
    const sdkHooks = makeClaudeToolResultSieveHooks({
      judge,
      currentSettings: () => holder.efficiency,
      latestUserRequest: (threadId) =>
        sql<{ readonly text: string | null }>`
          SELECT json_extract(payload_json, '$.text') AS text
          FROM orchestration_v2_projection_messages
          WHERE thread_id = ${threadId} AND role = 'user'
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1
        `.pipe(
          Effect.map((rows) => rows[0]?.text ?? undefined),
          Effect.catchCause(() => Effect.succeed(undefined)),
        ),
      onOutcome: (outcome) =>
        outcome.decision === undefined
          ? Effect.void
          : Effect.logDebug("tool-result sieve decision", {
              tool: outcome.decision.tool,
              mode: outcome.decision.mode,
              rewritten: outcome.decision.rewritten,
              blockCount: outcome.decision.blockCount,
              hiddenBlockIds: outcome.decision.hiddenBlockIds,
              charsBefore: outcome.decision.charsBefore,
              charsAfter: outcome.decision.charsAfter,
              prunedRatio: outcome.decision.prunedRatio,
              latencyMs: outcome.decision.latencyMs,
            }),
    });
    return ClaudeToolResultSieve.of({ sdkHooks });
  }),
);
