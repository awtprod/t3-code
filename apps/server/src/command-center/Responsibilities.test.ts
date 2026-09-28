import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { canonicalJson } from "./automation/Digest.ts";
import {
  Responsibilities,
  ResponsibilityError,
  layer as responsibilitiesLayer,
  type ResponsibilityDependencies,
} from "./Responsibilities.ts";

const now = "2026-09-28T12:00:00.000Z";
const commitSha = "1234567890abcdef1234567890abcdef12345678";
const definitionDigest = `sha256:${"a".repeat(64)}`;
let configuredEnabled = true;
let configuredAvailable = true;
let configHealthy = true;
let configuredDigest = definitionDigest;

const automation = {
  id: "daily-review",
  spaceId: "space-a",
  name: "Review daily inputs",
  version: 1,
  enabled: true,
  trigger: { type: "schedule", expression: "0 9 * * *", timezone: "UTC" },
  nodes: [
    {
      id: "read",
      kind: "connector.read",
      config: {},
      position: { x: 0, y: 0 },
    },
  ],
  edges: [],
  definitionDigest,
  configCommit: commitSha,
  createdAt: now,
  updatedAt: now,
} as const;

const persistence = SqlitePersistenceMemory;

const dependencies: ResponsibilityDependencies = {
  now: Effect.succeed(now),
  listConfiguredAutomations: () =>
    configHealthy
      ? Effect.succeed(
          configuredAvailable
            ? [
                {
                  automationId: automation.id,
                  spaceId: automation.spaceId,
                  configCommitSha: commitSha,
                  definitionDigest: configuredDigest,
                  enabled: configuredEnabled,
                },
              ]
            : [],
        )
      : Effect.fail(
          new ResponsibilityError({
            code: "config-unavailable",
            message: "The committed configuration is unhealthy.",
          }),
        ),
  validateAutomation: ({ automationId, spaceId }) =>
    !configHealthy
      ? Effect.fail(
          new ResponsibilityError({
            code: "config-unavailable",
            message: "The committed configuration is unhealthy.",
          }),
        )
      : configuredAvailable && automationId === automation.id && spaceId === automation.spaceId
        ? Effect.succeed({
            automationId,
            spaceId,
            configCommitSha: commitSha,
            definitionDigest: configuredDigest,
            enabled: configuredEnabled,
          })
        : Effect.fail(
            new ResponsibilityError({
              code: "not-found",
              message: "The configured Automation was not found.",
            }),
          ),
};

const testLayer = responsibilitiesLayer(dependencies).pipe(
  Layer.provideMerge(persistence),
  Layer.provideMerge(NodeServices.layer),
);

const seed = Effect.fn("ResponsibilitiesTest.seed")(function* () {
  const sql = yield* SqlClient.SqlClient;
  configuredEnabled = true;
  configuredAvailable = true;
  configHealthy = true;
  configuredDigest = definitionDigest;
  yield* sql`
    INSERT INTO command_center_spaces (
      id, owner_id, slug, name, kind, created_at, updated_at
    ) VALUES ('space-a', 'andrew', 'space-a', 'Space A', 'business', ${now}, ${now})
  `;
  yield* sql`
    INSERT INTO command_center_automations (
      id, space_id, name, enabled, commit_sha, definition_digest,
      definition_json, last_loaded_at
    ) VALUES (
      ${automation.id}, ${automation.spaceId}, ${automation.name}, 1, ${commitSha},
      ${definitionDigest}, ${canonicalJson(automation as unknown as Schema.Json)}, ${now}
    )
  `;
});

it.effect(
  "pauses with optimistic versioning, rejects wrong Space, and resumes without enabling config",
  () =>
    Effect.gen(function* () {
      yield* seed();
      const responsibilities = yield* Responsibilities;
      const sql = yield* SqlClient.SqlClient;
      const previousCheck = "2026-09-27T12:00:00.000Z";
      yield* sql`
        INSERT INTO command_center_responsibility_status (
          space_id, automation_id, last_checked_at, last_check_status, updated_at
        ) VALUES ('space-a', ${automation.id}, ${previousCheck}, 'ok', ${previousCheck})
      `;

      const paused = yield* responsibilities.setPause({
        spaceId: "space-a",
        automationId: automation.id,
        paused: true,
        actor: "andrew",
        reason: "Investigating source access",
        expectedVersion: 0,
      });
      expect(paused).toMatchObject({
        paused: true,
        pauseVersion: 1,
        health: "paused",
        lastCheckedAt: previousCheck,
        lastCheckStatus: "ok",
      });

      const stale = yield* responsibilities
        .setPause({
          spaceId: "space-a",
          automationId: automation.id,
          paused: false,
          actor: "andrew",
          expectedVersion: 0,
        })
        .pipe(Effect.flip);
      expect(stale).toMatchObject({ code: "conflict" });

      const wrongSpace = yield* responsibilities
        .get({ spaceId: "space-b", automationId: automation.id })
        .pipe(Effect.flip);
      expect(wrongSpace).toMatchObject({ code: "not-found" });
      const wrongSpacePause = yield* responsibilities
        .setPause({
          spaceId: "space-b",
          automationId: automation.id,
          paused: true,
          actor: "andrew",
          expectedVersion: 0,
        })
        .pipe(Effect.flip);
      expect(wrongSpacePause).toMatchObject({ code: "not-found" });

      yield* sql`UPDATE command_center_automations SET enabled = 0 WHERE id = ${automation.id}`;
      configuredEnabled = false;
      const resumed = yield* responsibilities.setPause({
        spaceId: "space-a",
        automationId: automation.id,
        paused: false,
        actor: "andrew",
        expectedVersion: 1,
      });
      expect(resumed).toMatchObject({ paused: false, enabled: false, pauseVersion: 2 });
      expect(resumed.nextScheduledAt).toBeNull();

      const audit = yield* sql<{ readonly action: string }>`
      SELECT action FROM command_center_audit_events
      WHERE action LIKE 'cc.responsibilities.%'
      ORDER BY sequence
    `;
      expect(audit).toEqual([
        { action: "cc.responsibilities.paused" },
        { action: "cc.responsibilities.resumed" },
      ]);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("keeps a successful empty check separate from an inspectable useful result", () =>
  Effect.gen(function* () {
    yield* seed();
    const responsibilities = yield* Responsibilities;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO command_center_automation_executions (
        id, automation_id, idempotency_key, work_identity, space_id, config_commit_sha,
        definition_digest, definition_json, input_json, state, output_json,
        created_at, updated_at, finished_at
      ) VALUES (
        'execution-1', ${automation.id}, 'empty-check',
        'responsibility:v1:space-a:daily-review', 'space-a', ${commitSha},
        ${definitionDigest}, ${canonicalJson(automation as unknown as Schema.Json)}, '{}',
        'succeeded', '{}', ${now}, ${now}, ${now}
      )
    `;
    yield* sql`
      INSERT INTO command_center_responsibility_status (
        space_id, automation_id, last_checked_at, last_check_status,
        last_successful_at, last_attempted_execution_id, updated_at
      ) VALUES ('space-a', ${automation.id}, ${now}, 'ok', ${now}, 'execution-1', ${now})
    `;

    const empty = yield* responsibilities.get({
      spaceId: "space-a",
      automationId: automation.id,
      historyLimit: 10,
    });
    expect(empty).toMatchObject({
      health: "healthy",
      lastCheckedAt: now,
      lastSuccessfulAt: now,
      lastUsefulResultAt: null,
      lastUsefulResultRef: null,
    });
    expect(empty.history[0]).toMatchObject({ usefulResultRef: null });

    const preparation = {
      kind: "preparation-result",
      source: { id: "source-a", version: "v1", observedAt: now },
      counts: { selected: 1, created: 1, reconciled: 0, skipped: 0, failed: 0 },
      subjects: [{ id: "subject-a", evidence: ["evidence-a"], artifactIds: [] }],
    };
    yield* sql`
      UPDATE command_center_automation_executions
      SET output_json = ${canonicalJson({ read: preparation } as Schema.Json)}
      WHERE id = 'execution-1'
    `;
    const prepared = yield* responsibilities.get({
      spaceId: "space-a",
      automationId: automation.id,
      historyLimit: 10,
    });
    expect(prepared.lastPreparationResult).toEqual(preparation);
    expect(prepared.history[0]?.preparationResult).toEqual(preparation);
    expect(prepared.lastUsefulResultRef).toBeNull();

    yield* sql`
      INSERT INTO command_center_runs (
        id, command_id, space_id, kind, state, route_json, input_json,
        result_json, started_at, finished_at
      ) VALUES (
        'execution-1', 'automation:execution-1', 'space-a', 'automation', 'succeeded',
        '{}', '{}', '{}', ${now}, ${now}
      )
    `;
    yield* sql`
      INSERT INTO command_center_artifacts (
        id, space_id, run_id, kind, title, uri, content_digest, created_at
      ) VALUES (
        'artifact-1', 'space-a', 'execution-1', 'report', 'Daily review',
        'cc-artifact://artifact-1', ${"b".repeat(64)}, ${now}
      )
    `;

    const useful = yield* responsibilities.get({
      spaceId: "space-a",
      automationId: automation.id,
      historyLimit: 10,
    });
    expect(useful.lastUsefulResultRef).toEqual({
      kind: "artifact",
      artifactId: "artifact-1",
      runId: "execution-1",
      executionId: "execution-1",
      spaceId: "space-a",
      automationId: automation.id,
    });
    expect(useful.lastUsefulResultAt).toBe(now);

    const failedAt = "2026-09-28T13:00:00.000Z";
    yield* sql`
      INSERT INTO command_center_automation_executions (
        id, automation_id, idempotency_key, work_identity, space_id, config_commit_sha,
        definition_digest, definition_json, input_json, state, error,
        created_at, updated_at, finished_at
      ) VALUES (
        'execution-2', ${automation.id}, 'failed-check',
        'responsibility:v1:space-a:daily-review', 'space-a', ${commitSha},
        ${definitionDigest}, ${canonicalJson(automation as unknown as Schema.Json)}, '{}',
        'failed', 'preparation failed', ${failedAt}, ${failedAt}, ${failedAt}
      )
    `;
    yield* sql`
      INSERT INTO command_center_runs (
        id, command_id, space_id, kind, state, route_json, input_json,
        error, started_at, finished_at
      ) VALUES (
        'execution-2', 'automation:execution-2', 'space-a', 'automation', 'failed',
        '{}', '{}', 'preparation failed', ${failedAt}, ${failedAt}
      )
    `;
    yield* sql`
      INSERT INTO command_center_artifacts (
        id, space_id, run_id, kind, title, uri, content_digest, created_at
      ) VALUES (
        'artifact-partial', 'space-a', 'execution-2', 'report', 'Partial review',
        'cc-artifact://artifact-partial', ${"c".repeat(64)}, ${failedAt}
      )
    `;

    const afterFailure = yield* responsibilities.get({
      spaceId: "space-a",
      automationId: automation.id,
      historyLimit: 10,
    });
    expect(afterFailure.lastUsefulResultRef?.artifactId).toBe("artifact-1");
    expect(afterFailure.lastUsefulResultAt).toBe(now);
    expect(afterFailure.history[0]).toMatchObject({
      executionId: "execution-2",
      state: "failed",
      usefulResultRef: { artifactId: "artifact-partial" },
    });
  }).pipe(Effect.provide(testLayer)),
);

it.effect("strictly validates raw query bounds", () =>
  Effect.gen(function* () {
    const responsibilities = yield* Responsibilities;
    const error = yield* responsibilities.list({ limit: 101 }).pipe(Effect.flip);
    expect(error).toMatchObject({ code: "validation" });
  }).pipe(Effect.provide(testLayer)),
);

it.effect("hides removed Automations and fails closed on unhealthy committed config", () =>
  Effect.gen(function* () {
    yield* seed();
    const responsibilities = yield* Responsibilities;
    const configured = yield* responsibilities.list({ spaceId: "space-a" });
    expect(configured).toHaveLength(1);
    expect(configured[0]).toMatchObject({
      authority: null,
      limits: null,
      authorityExplanation: "No separate authority is configured for this Automation.",
      limitsExplanation: "No per-Automation limits are configured.",
    });
    configuredAvailable = false;
    expect(yield* responsibilities.list({ spaceId: "space-a" })).toEqual([]);
    expect(
      yield* responsibilities
        .get({ spaceId: "space-a", automationId: automation.id })
        .pipe(Effect.flip),
    ).toMatchObject({ code: "not-found" });
    expect(
      yield* responsibilities
        .setPause({
          spaceId: "space-a",
          automationId: automation.id,
          paused: true,
          actor: "andrew",
          expectedVersion: 0,
        })
        .pipe(Effect.flip),
    ).toMatchObject({ code: "not-found" });
    configuredAvailable = true;
    configuredDigest = `sha256:${"b".repeat(64)}`;
    expect(yield* responsibilities.list({ spaceId: "space-a" })).toEqual([]);
    expect(
      yield* responsibilities
        .get({ spaceId: "space-a", automationId: automation.id })
        .pipe(Effect.flip),
    ).toMatchObject({ code: "config-unavailable" });
    expect(
      yield* responsibilities
        .setPause({
          spaceId: "space-a",
          automationId: automation.id,
          paused: true,
          actor: "andrew",
          expectedVersion: 0,
        })
        .pipe(Effect.flip),
    ).toMatchObject({ code: "conflict" });
    configuredDigest = definitionDigest;
    configHealthy = false;
    expect(yield* responsibilities.list({ spaceId: "space-a" }).pipe(Effect.flip)).toMatchObject({
      code: "config-unavailable",
    });
    expect(
      yield* responsibilities
        .get({ spaceId: "space-a", automationId: automation.id })
        .pipe(Effect.flip),
    ).toMatchObject({ code: "config-unavailable" });
    expect(
      yield* responsibilities
        .setPause({
          spaceId: "space-a",
          automationId: automation.id,
          paused: true,
          actor: "andrew",
          expectedVersion: 0,
        })
        .pipe(Effect.flip),
    ).toMatchObject({ code: "config-unavailable" });
  }).pipe(Effect.provide(testLayer)),
);
