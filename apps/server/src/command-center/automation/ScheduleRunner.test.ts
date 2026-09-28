import { Automation, AutomationId, AutomationNodeId } from "@command-center/core";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import migration072 from "../../persistence/Migrations/072_CommandCenterResponsibilities.ts";
import { CommandCenterService, type CommandCenterServiceShape } from "../Service.ts";
import { canonicalJson } from "./Digest.ts";
import {
  AutomationScheduleRunner,
  AutomationScheduleRunnerError,
  layer,
  make,
} from "./ScheduleRunner.ts";
import {
  AutomationTriggerCoordinator,
  AutomationTriggerError,
  type AutomationTriggerCoordinatorShape,
} from "./TriggerCoordinator.ts";

const now = "2026-07-20T12:00:00.000Z";
const commit = "1234567890abcdef1234567890abcdef12345678";
const digest = `sha256:${"a".repeat(64)}`;
const decodeAutomation = Schema.decodeUnknownSync(Automation);

function automation(input: {
  readonly id: string;
  readonly enabled?: boolean;
  readonly committed?: boolean;
  readonly trigger?:
    | { readonly type: "schedule"; readonly expression: string; readonly timezone: string }
    | { readonly type: "webhook"; readonly route: string };
}) {
  return decodeAutomation({
    id: input.id,
    spaceId: "space-a",
    name: input.id,
    version: 1,
    enabled: input.enabled ?? true,
    trigger: input.trigger ?? { type: "schedule", expression: "* * * * *", timezone: "UTC" },
    nodes: [
      {
        id: AutomationNodeId.make("transform"),
        kind: "transform",
        config: { output: true },
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
    definitionDigest: digest,
    ...(input.committed === false ? {} : { configCommit: commit }),
    createdAt: now,
    updatedAt: now,
  });
}

function testLayer(input: {
  readonly automations: ReadonlyArray<Automation>;
  readonly admissions: Array<{ readonly automationId: string; readonly scheduledFor: string }>;
  readonly queries: Array<unknown>;
  readonly failAutomationId?: string;
  readonly blockedAutomationId?: string;
  readonly blockedClassification?: "paused" | "permanent";
  readonly shouldBlock?: () => boolean;
}) {
  const commandCenter = CommandCenterService.of({
    queryAutomations: (query: Parameters<CommandCenterServiceShape["queryAutomations"]>[0]) => {
      input.queries.push(query);
      return Effect.succeed({ automations: input.automations });
    },
  } as unknown as CommandCenterServiceShape);
  const coordinator = AutomationTriggerCoordinator.of({
    admitSchedule: (request) => {
      input.admissions.push({
        automationId: request.automationId,
        scheduledFor: request.scheduledFor,
      });
      if (request.automationId === input.failAutomationId) {
        return Effect.fail(
          new AutomationTriggerError({
            reason: "start-failed",
            message: "temporary admission failure",
          }),
        );
      }
      if (
        request.automationId === input.blockedAutomationId &&
        (input.shouldBlock === undefined || input.shouldBlock())
      ) {
        return Effect.fail(
          new AutomationTriggerError({
            reason: "admission-blocked",
            message: "automation is paused",
            admissionFailure: {
              classification: input.blockedClassification ?? "paused",
              canonicalCode:
                input.blockedClassification === "permanent"
                  ? "connector-capability-unavailable"
                  : "automation-paused",
              resource: "schedule-admission",
              subject: request.automationId,
            },
          }),
        );
      }
      const configured = input.automations.find(
        (candidate) => candidate.id === request.automationId,
      );
      if (configured?.configCommit === undefined) {
        return Effect.fail(
          new AutomationTriggerError({
            reason: "admission-blocked",
            message: "automation has no committed revision",
            admissionFailure: {
              classification: "permanent",
              canonicalCode: "automation-uncommitted",
              resource: "schedule-admission",
              subject: request.automationId,
            },
          }),
        );
      }
      return Effect.succeed({ id: `execution-${input.admissions.length}` } as never);
    },
    admitWebhook: () => Effect.die("unused"),
  } satisfies AutomationTriggerCoordinatorShape);
  const persistence = Layer.effectDiscard(
    Effect.gen(function* () {
      yield* migration072;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO command_center_spaces (
          id, owner_id, slug, name, kind, created_at, updated_at
        ) VALUES ('space-a', 'andrew', 'space-a', 'Space A', 'business', ${now}, ${now})
      `;
      for (const configured of input.automations) {
        yield* sql`
          INSERT INTO command_center_automations (
            id, space_id, name, enabled, commit_sha, definition_digest,
            definition_json, last_loaded_at
          ) VALUES (
            ${configured.id}, ${configured.spaceId}, ${configured.name},
            ${configured.enabled ? 1 : 0}, ${configured.configCommit ?? "uncommitted"},
            ${configured.definitionDigest},
            ${canonicalJson(configured as unknown as Schema.Json)}, ${now}
          )
        `;
      }
    }),
  ).pipe(Layer.provideMerge(SqlitePersistenceMemory));
  return layer.pipe(
    Layer.provideMerge(Layer.succeed(CommandCenterService, commandCenter)),
    Layer.provideMerge(Layer.succeed(AutomationTriggerCoordinator, coordinator)),
    Layer.provideMerge(persistence),
  );
}

it.effect("records uncommitted due schedules and suppresses duplicate in-process minutes", () => {
  const admissions: Array<{ readonly automationId: string; readonly scheduledFor: string }> = [];
  const queries: Array<unknown> = [];
  const runnerLayer = testLayer({
    automations: [
      automation({ id: "due" }),
      automation({ id: "disabled", enabled: false }),
      automation({ id: "draft", committed: false }),
      automation({
        id: "later",
        trigger: { type: "schedule", expression: "1 * * * *", timezone: "UTC" },
      }),
      automation({ id: "hook", trigger: { type: "webhook", route: "/hooks/weekly" } }),
    ],
    admissions,
    queries,
  });

  return Effect.gen(function* () {
    const runner = yield* AutomationScheduleRunner;
    const first = yield* runner.tick("2026-07-20T12:00:42.000Z");
    const duplicate = yield* runner.tick("2026-07-20T12:00:58.000Z");

    expect(first).toEqual(
      expect.objectContaining({
        scheduledFor: "2026-07-20T12:00:00.000Z",
        scanned: 5,
        due: 2,
        admitted: 1,
        skippedDuplicate: false,
        failures: [
          {
            automationId: AutomationId.make("draft"),
            message: "automation has no committed revision",
          },
        ],
      }),
    );
    expect(duplicate).toEqual(
      expect.objectContaining({
        scheduledFor: "2026-07-20T12:00:00.000Z",
        admitted: 0,
        skippedDuplicate: true,
      }),
    );
    expect(queries).toEqual([{ enabled: true }, { enabled: true }]);
    expect(admissions).toEqual([
      { automationId: "due", scheduledFor: "2026-07-20T12:00:00.000Z" },
      { automationId: "draft", scheduledFor: "2026-07-20T12:00:00.000Z" },
    ]);
  }).pipe(Effect.provide(runnerLayer));
});

it.effect("catches up persisted due minutes after restart without duplicating the cursor", () => {
  const admissions: Array<{ readonly automationId: string; readonly scheduledFor: string }> = [];
  const queries: Array<unknown> = [];
  const runnerLayer = testLayer({
    automations: [automation({ id: "catch-up" })],
    admissions,
    queries,
  });

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO command_center_automation_schedule_cursors (
        automation_id, last_checked_minute, updated_at
      ) VALUES (
        'catch-up', '2026-07-20T11:57:00.000Z', '2026-07-20T11:57:00.000Z'
      )
    `;
    const runner = yield* AutomationScheduleRunner;
    const report = yield* runner.tick("2026-07-20T12:00:05.000Z");
    const restartedRunner = yield* make;
    const duplicate = yield* restartedRunner.tick("2026-07-20T12:00:40.000Z");

    expect(report).toMatchObject({ due: 3, admitted: 3, skippedDuplicate: false });
    expect(admissions.map((admission) => admission.scheduledFor)).toEqual([
      "2026-07-20T11:58:00.000Z",
      "2026-07-20T11:59:00.000Z",
      "2026-07-20T12:00:00.000Z",
    ]);
    expect(duplicate).toMatchObject({ due: 0, admitted: 0, skippedDuplicate: true });
  }).pipe(Effect.provide(runnerLayer));
});

it.effect("bounds schedule catch-up to the most recent sixty minutes", () => {
  const admissions: Array<{ readonly automationId: string; readonly scheduledFor: string }> = [];
  const queries: Array<unknown> = [];
  const runnerLayer = testLayer({
    automations: [automation({ id: "bounded-catch-up" })],
    admissions,
    queries,
  });

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO command_center_automation_schedule_cursors (
        automation_id, last_checked_minute, updated_at
      ) VALUES (
        'bounded-catch-up', '2026-07-20T09:00:00.000Z', '2026-07-20T09:00:00.000Z'
      )
    `;
    const runner = yield* AutomationScheduleRunner;
    const report = yield* runner.tick("2026-07-20T12:00:05.000Z");

    expect(report).toMatchObject({ due: 60, admitted: 60 });
    expect(admissions).toHaveLength(60);
    expect(admissions[0]?.scheduledFor).toBe("2026-07-20T11:01:00.000Z");
    expect(admissions.at(-1)?.scheduledFor).toBe("2026-07-20T12:00:00.000Z");
  }).pipe(Effect.provide(runnerLayer));
});

it.effect(
  "retries a minute when admission fails without duplicating successful runtime work",
  () => {
    const admissions: Array<{ readonly automationId: string; readonly scheduledFor: string }> = [];
    const queries: Array<unknown> = [];
    const runnerLayer = testLayer({
      automations: [automation({ id: "retry" })],
      admissions,
      queries,
      failAutomationId: "retry",
    });

    return Effect.gen(function* () {
      const runner = yield* AutomationScheduleRunner;
      const first = yield* runner.tick("2026-07-20T12:00:01.000Z");
      const retry = yield* runner.tick("2026-07-20T12:00:30.000Z");

      expect(first.failures).toEqual([
        { automationId: AutomationId.make("retry"), message: "temporary admission failure" },
      ]);
      expect(retry.skippedDuplicate).toBe(false);
      expect(admissions).toHaveLength(2);
      expect(queries).toHaveLength(2);
    }).pipe(Effect.provide(runnerLayer));
  },
);

it.effect("consumes a paused occurrence without creating a fault alert", () => {
  const admissions: Array<{ readonly automationId: string; readonly scheduledFor: string }> = [];
  const queries: Array<unknown> = [];
  const runnerLayer = testLayer({
    automations: [automation({ id: "paused" })],
    admissions,
    queries,
    blockedAutomationId: "paused",
  });

  return Effect.gen(function* () {
    const runner = yield* AutomationScheduleRunner;
    const blocked = yield* runner.tick("2026-07-20T12:00:01.000Z");
    const noReplay = yield* runner.tick("2026-07-20T12:00:30.000Z");

    expect(blocked).toMatchObject({
      due: 1,
      admitted: 0,
      failures: [],
    });
    expect(noReplay).toMatchObject({ due: 0, admitted: 0, skippedDuplicate: true });
    expect(admissions).toHaveLength(1);
    const sql = yield* SqlClient.SqlClient;
    expect(
      yield* sql<{ readonly status: string; readonly checkedAt: string | null }>`
        SELECT last_admission_status AS status, last_checked_at AS "checkedAt"
        FROM command_center_responsibility_status
        WHERE automation_id = 'paused'
      `,
    ).toEqual([{ status: "paused", checkedAt: null }]);
    expect(
      yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM command_center_responsibility_incidents
      `,
    ).toEqual([{ count: 0 }]);
  }).pipe(Effect.provide(runnerLayer));
});

it.effect("groups permanent admission faults and resolves them after healthy admission", () => {
  const admissions: Array<{ readonly automationId: string; readonly scheduledFor: string }> = [];
  const queries: Array<unknown> = [];
  let blocked = true;
  const runnerLayer = testLayer({
    automations: [automation({ id: "capability" })],
    admissions,
    queries,
    blockedAutomationId: "capability",
    blockedClassification: "permanent",
    shouldBlock: () => blocked,
  });

  return Effect.gen(function* () {
    const runner = yield* AutomationScheduleRunner;
    yield* runner.tick("2026-07-20T12:00:01.000Z");
    yield* runner.tick("2026-07-20T12:01:01.000Z");
    const sql = yield* SqlClient.SqlClient;
    expect(
      yield* sql<{
        readonly state: string;
        readonly count: number;
        readonly executionId: string | null;
      }>`
        SELECT state, occurrence_count AS count, latest_execution_id AS "executionId"
        FROM command_center_responsibility_incidents
      `,
    ).toEqual([{ state: "blocked", count: 2, executionId: null }]);
    expect(
      yield* sql<{
        readonly admission: string;
        readonly checkedAt: string | null;
      }>`
        SELECT last_admission_status AS admission, last_checked_at AS "checkedAt"
        FROM command_center_responsibility_status
        WHERE automation_id = 'capability'
      `,
    ).toEqual([{ admission: "blocked", checkedAt: null }]);

    blocked = false;
    yield* runner.tick("2026-07-20T12:02:01.000Z");
    expect(
      yield* sql<{ readonly state: string }>`
        SELECT state FROM command_center_responsibility_incidents
      `,
    ).toEqual([{ state: "resolved" }]);
    expect(
      yield* sql<{ readonly status: string }>`
        SELECT status FROM command_center_items
        WHERE id LIKE 'responsibility-incident:%'
      `,
    ).toEqual([{ status: "done" }]);
  }).pipe(Effect.provide(runnerLayer));
});

it.effect("does not advance the cursor when permanent incident persistence fails", () => {
  const admissions: Array<{ readonly automationId: string; readonly scheduledFor: string }> = [];
  const queries: Array<unknown> = [];
  const runnerLayer = testLayer({
    automations: [automation({ id: "persist-fault" })],
    admissions,
    queries,
    blockedAutomationId: "persist-fault",
    blockedClassification: "permanent",
  });

  return Effect.gen(function* () {
    const runner = yield* AutomationScheduleRunner;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TRIGGER fail_responsibility_incident_insert
      BEFORE INSERT ON command_center_responsibility_incidents
      BEGIN
        SELECT RAISE(ABORT, 'forced incident insert failure');
      END
    `;
    expect(yield* runner.tick("2026-07-20T12:00:01.000Z").pipe(Effect.flip)).toMatchObject({
      reason: "persistence",
    });
    expect(
      yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM command_center_automation_schedule_cursors
        WHERE automation_id = 'persist-fault'
      `,
    ).toEqual([{ count: 0 }]);

    yield* sql`DROP TRIGGER fail_responsibility_incident_insert`;
    yield* runner.tick("2026-07-20T12:00:30.000Z");
    expect(admissions).toHaveLength(2);
    expect(
      yield* sql<{ readonly minute: string }>`
        SELECT last_checked_minute AS minute
        FROM command_center_automation_schedule_cursors
        WHERE automation_id = 'persist-fault'
      `,
    ).toEqual([{ minute: "2026-07-20T12:00:00.000Z" }]);
  }).pipe(Effect.provide(runnerLayer));
});

it.effect("rejects invalid tick timestamps before querying definitions", () => {
  const admissions: Array<{ readonly automationId: string; readonly scheduledFor: string }> = [];
  const queries: Array<unknown> = [];
  const runnerLayer = testLayer({ automations: [], admissions, queries });

  return Effect.gen(function* () {
    const runner = yield* AutomationScheduleRunner;
    const failure = yield* Effect.flip(runner.tick("not-a-timestamp"));
    expect(failure).toBeInstanceOf(AutomationScheduleRunnerError);
    expect(queries).toEqual([]);
  }).pipe(Effect.provide(runnerLayer));
});
