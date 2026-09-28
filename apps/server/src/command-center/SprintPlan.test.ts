import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { SprintPlanSource } from "@command-center/core";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import Migration071 from "../persistence/Migrations/071_CommandCenterSprintPlans.ts";
import {
  SprintPlanServiceError,
  makeSprintPlanService,
  type SprintPlanActor,
} from "./SprintPlan.ts";

const testLayer = Layer.mergeAll(SqlitePersistenceMemory, NodeServices.layer);
const actor: SprintPlanActor = { id: "andrew", kind: "user" };

const sourceFixture = (overrides?: {
  readonly firstNote?: string;
  readonly secondText?: string;
  readonly updated?: string;
}) =>
  JSON.stringify(
    {
      version: 2,
      updated: overrides?.updated ?? "2026-09-27T19:40:38.746Z",
      fixtureMetadata: { retained: true },
      score: [
        {
          id: "apv",
          label: "Average viewed",
          start: "",
          now: "",
          target: "Set at launch",
        },
      ],
      weeks: [
        {
          id: "w1",
          num: 1,
          start: "2026-10-26",
          end: "2026-11-01",
          range: "Oct 26 – Nov 1",
          tue: "Synthetic Tuesday",
          fri: "Synthetic Friday",
          optionalMetadata: ["kept", "in-order"],
          tasks: [
            {
              id: "task-a",
              text: "Post Saturday 31 October",
              owner: "Production",
              day: "Wed 10/28",
              note: overrides?.firstNote ?? "Original note",
              done: false,
            },
            {
              id: "task-b",
              text: overrides?.secondText ?? "Prepare the follow-up",
              owner: "Both",
              day: "Thu 10/29",
              note: "",
              done: true,
            },
          ],
        },
      ],
    },
    null,
    2,
  );

const setup = Effect.fn("SprintPlanTest.setup")(function* (suffix: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* Migration071;
  yield* sql`
    INSERT INTO command_center_spaces (id, slug, name, kind, created_at, updated_at)
    VALUES (
      ${`space-${suffix}`}, ${`space-${suffix}`}, ${`Space ${suffix}`}, 'business',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    )
  `;
  yield* sql`
    INSERT INTO command_center_spaces (id, slug, name, kind, created_at, updated_at)
    VALUES (
      ${`other-${suffix}`}, ${`other-${suffix}`}, ${`Other ${suffix}`}, 'business',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    )
  `;
  return yield* makeSprintPlanService();
});

it.effect("keeps the exact baseline immutable and isolates one task field edit", () =>
  Effect.gen(function* () {
    const service = yield* setup("isolation");
    const sourceJson = sourceFixture();
    const imported = yield* service.applyImport(
      {
        planId: "plan-isolation",
        spaceId: "space-isolation",
        sourceJson,
        provenance: { sourceRef: "fixture://synthetic-plan", originalFileName: "plan.json" },
        expectedVersion: 0,
        mutationId: "import-isolation",
      },
      actor,
    );
    const edited = yield* service.patchTask(
      {
        planId: imported.id,
        spaceId: imported.spaceId,
        taskId: "task-a",
        field: "note",
        before: "Original note",
        after: "Andrew's corrected note",
        reason: "Use the reviewed wording",
        expectedVersion: 1,
        mutationId: "patch-isolation",
        provenance: { kind: "manual", sourceRef: "inbox:item-1" },
      },
      actor,
    );

    expect(edited.sourceJson).toBe(sourceJson);
    expect(edited.sourceSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(edited.provenance).toEqual({
      sourceRef: "fixture://synthetic-plan",
      originalFileName: "plan.json",
    });
    expect(edited.baseline.weeks[0]?.tasks[0]?.note).toBe("Original note");
    expect(edited.current.weeks[0]?.tasks[0]?.note).toBe("Andrew's corrected note");
    expect(edited.current.weeks[0]?.tasks[1]).toEqual(edited.baseline.weeks[0]?.tasks[1]);
    expect(edited.current.score[0]).toEqual({
      id: "apv",
      label: "Average viewed",
      start: "",
      now: "",
      target: "Set at launch",
    });
    expect(edited.current.fixtureMetadata).toEqual({ retained: true });
    expect(edited.baselineNormalized.dateConflicts).toHaveLength(1);

    const history = yield* service.listHistory({
      planId: edited.id,
      spaceId: edited.spaceId,
      limit: 1,
    });
    expect(history.entries).toEqual([
      expect.objectContaining({
        operation: "task-patch",
        taskId: "task-a",
        field: "note",
        before: "Original note",
        after: "Andrew's corrected note",
        reason: "Use the reviewed wording",
        actor,
      }),
    ]);
    expect(history.nextBeforeSequence).toBeDefined();
  }).pipe(Effect.provide(testLayer)),
);

it.effect("lists only Space-scoped summaries with stable keyset pagination", () =>
  Effect.gen(function* () {
    const service = yield* setup("list");
    for (const planId of ["plan-a", "plan-b", "plan-c"]) {
      yield* service.applyImport(
        {
          planId,
          spaceId: "space-list",
          sourceJson: sourceFixture(),
          provenance: { sourceRef: `fixture://${planId}` },
          expectedVersion: 0,
          mutationId: `import-${planId}`,
        },
        actor,
      );
    }
    yield* service.applyImport(
      {
        planId: "other-plan",
        spaceId: "other-list",
        sourceJson: sourceFixture(),
        provenance: { sourceRef: "fixture://other-plan" },
        expectedVersion: 0,
        mutationId: "import-other-plan",
      },
      actor,
    );

    const first = yield* service.list({ spaceId: "space-list", limit: 2 });
    expect(first.plans.map((plan) => plan.id)).toEqual(["plan-c", "plan-b"]);
    expect(first.plans[0]).toMatchObject({
      spaceId: "space-list",
      version: 1,
      sourceVersion: 2,
    });
    expect(first.plans[0]).not.toHaveProperty("sourceJson");
    expect(first.plans[0]).not.toHaveProperty("current");
    expect(first.nextCursor).toEqual({
      updatedAt: first.plans[1]!.updatedAt,
      planId: "plan-b",
    });
    if (first.nextCursor === undefined) {
      return;
    }

    const second = yield* service.list({
      spaceId: "space-list",
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second).toEqual({ plans: [expect.objectContaining({ id: "plan-a" })] });
    expect((yield* service.list({ spaceId: "other-list" })).plans).toEqual([
      expect.objectContaining({ id: "other-plan", spaceId: "other-list" }),
    ]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("requires reasons, exact before values, current versions, and matching Space", () =>
  Effect.gen(function* () {
    const service = yield* setup("guards");
    yield* service.applyImport(
      {
        planId: "plan-guards",
        spaceId: "space-guards",
        sourceJson: sourceFixture(),
        provenance: { sourceRef: "fixture://guards" },
        expectedVersion: 0,
        mutationId: "import-guards",
      },
      actor,
    );

    const noReason = yield* service
      .patchTask(
        {
          planId: "plan-guards",
          spaceId: "space-guards",
          taskId: "task-a",
          field: "owner",
          before: "Production",
          after: "Both",
          expectedVersion: 1,
          mutationId: "patch-no-reason",
          provenance: { kind: "manual" },
        },
        actor,
      )
      .pipe(Effect.flip);
    expect(noReason).toMatchObject({ reason: "validation" });

    const wrongBefore = yield* service
      .patchTask(
        {
          planId: "plan-guards",
          spaceId: "space-guards",
          taskId: "task-a",
          field: "owner",
          before: "PJ",
          after: "Both",
          reason: "Reassign",
          expectedVersion: 1,
          mutationId: "patch-wrong-before",
          provenance: { kind: "manual" },
        },
        actor,
      )
      .pipe(Effect.flip);
    expect(wrongBefore).toMatchObject({ reason: "conflict" });

    const stale = yield* service
      .patchTask(
        {
          planId: "plan-guards",
          spaceId: "space-guards",
          taskId: "task-a",
          field: "owner",
          before: "Production",
          after: "Both",
          reason: "Reassign",
          expectedVersion: 0,
          mutationId: "patch-stale",
          provenance: { kind: "manual" },
        },
        actor,
      )
      .pipe(Effect.flip);
    expect(stale).toMatchObject({ reason: "conflict" });

    const wrongSpace = yield* service
      .get({ planId: "plan-guards", spaceId: "other-guards" })
      .pipe(Effect.flip);
    expect(wrongSpace).toMatchObject({ reason: "conflict" });
    const wrongOriginalSpace = yield* service
      .getOriginal({ planId: "plan-guards", spaceId: "other-guards" })
      .pipe(Effect.flip);
    expect(wrongOriginalSpace).toMatchObject({ reason: "conflict" });
  }).pipe(Effect.provide(testLayer)),
);

it.effect("makes mutations idempotent and rejects mutation ID reuse with different content", () =>
  Effect.gen(function* () {
    const service = yield* setup("idempotency");
    yield* service.applyImport(
      {
        planId: "plan-idempotency",
        spaceId: "space-idempotency",
        sourceJson: sourceFixture(),
        provenance: { sourceRef: "fixture://idempotency" },
        expectedVersion: 0,
        mutationId: "import-idempotency",
      },
      actor,
    );
    const noOpImport = {
      planId: "plan-idempotency",
      spaceId: "space-idempotency",
      sourceJson: sourceFixture(),
      provenance: { sourceRef: "fixture://idempotency" },
      expectedVersion: 1,
      mutationId: "noop-import-idempotency",
    } as const;
    expect((yield* service.applyImport(noOpImport, actor)).version).toBe(1);
    const reboundNoOp = yield* service
      .applyImport(
        {
          ...noOpImport,
          sourceJson: sourceFixture({ updated: "2026-09-28T00:00:00.000Z" }),
        },
        actor,
      )
      .pipe(Effect.flip);
    expect(reboundNoOp).toMatchObject({ reason: "conflict" });
    const patch = {
      planId: "plan-idempotency",
      spaceId: "space-idempotency",
      taskId: "task-a",
      field: "text" as const,
      before: "Post Saturday 31 October",
      after: "Post the reviewed synthetic clip",
      reason: "Accept reviewed copy",
      expectedVersion: 1,
      mutationId: "patch-idempotency",
      provenance: { kind: "approved-adjustment" as const, evidenceRef: "evidence-1" },
    };
    const first = yield* service.patchTask(patch, actor);
    const replay = yield* service.patchTask(patch, actor);
    expect(first.version).toBe(2);
    expect(replay.version).toBe(2);

    const mismatch = yield* service
      .patchTask({ ...patch, after: "Different content" }, actor)
      .pipe(Effect.flip);
    expect(mismatch).toMatchObject({ reason: "conflict" });

    const history = yield* service.listHistory({
      planId: patch.planId,
      spaceId: patch.spaceId,
      limit: 100,
    });
    expect(history.entries.filter((entry) => entry.mutationId === patch.mutationId)).toHaveLength(
      1,
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("records reversible manual completion without changing the imported check", () =>
  Effect.gen(function* () {
    const service = yield* setup("completion");
    yield* service.applyImport(
      {
        planId: "plan-completion",
        spaceId: "space-completion",
        sourceJson: sourceFixture(),
        provenance: { sourceRef: "fixture://completion" },
        expectedVersion: 0,
        mutationId: "import-completion",
      },
      actor,
    );
    yield* service.patchTask(
      {
        planId: "plan-completion",
        spaceId: "space-completion",
        taskId: "task-b",
        field: "done",
        before: true,
        after: false,
        expectedVersion: 1,
        mutationId: "completion-off",
        provenance: { kind: "manual", sourceRef: "plan-view" },
      },
      actor,
    );
    const reversed = yield* service.patchTask(
      {
        planId: "plan-completion",
        spaceId: "space-completion",
        taskId: "task-b",
        field: "done",
        before: false,
        after: true,
        expectedVersion: 2,
        mutationId: "completion-on",
        provenance: { kind: "manual", sourceRef: "plan-view" },
      },
      actor,
    );
    expect(reversed.baseline.weeks[0]?.tasks[1]?.done).toBe(true);
    expect(reversed.current.weeks[0]?.tasks[1]?.done).toBe(true);
    const history = yield* service.listHistory({
      planId: reversed.id,
      spaceId: reversed.spaceId,
      limit: 10,
    });
    expect(
      history.entries
        .filter((entry) => entry.field === "done")
        .map((entry) => [entry.before, entry.after, entry.actor, entry.provenance]),
    ).toEqual([
      [false, true, actor, { kind: "manual", sourceRef: "plan-view" }],
      [true, false, actor, { kind: "manual", sourceRef: "plan-view" }],
    ]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("previews import conflicts and preserves local edits instead of overwriting", () =>
  Effect.gen(function* () {
    const service = yield* setup("conflict");
    const originalSourceJson = sourceFixture();
    const originalImport = yield* service.applyImport(
      {
        planId: "plan-conflict",
        spaceId: "space-conflict",
        sourceJson: originalSourceJson,
        provenance: { sourceRef: "fixture://conflict-v1", originalFileName: "plan-a.json" },
        expectedVersion: 0,
        mutationId: "import-conflict-v1",
      },
      actor,
    );
    yield* service.patchTask(
      {
        planId: "plan-conflict",
        spaceId: "space-conflict",
        taskId: "task-a",
        field: "note",
        before: "Original note",
        after: "Local edit",
        reason: "Keep local reviewed wording",
        expectedVersion: 1,
        mutationId: "patch-conflict-local",
        provenance: { kind: "manual" },
      },
      actor,
    );
    const conflictingSource = sourceFixture({
      firstNote: "Incoming edit",
      updated: "2026-09-28T00:00:00.000Z",
    });
    const preview = yield* service.previewImport({
      planId: "plan-conflict",
      spaceId: "space-conflict",
      sourceJson: conflictingSource,
    });
    expect(preview.conflicts).toEqual([
      {
        taskId: "task-a",
        field: "note",
        baseline: "Original note",
        current: "Local edit",
        incoming: "Incoming edit",
        reason: "both-changed",
      },
    ]);
    const rejected = yield* service
      .applyImport(
        {
          planId: "plan-conflict",
          spaceId: "space-conflict",
          sourceJson: conflictingSource,
          provenance: { sourceRef: "fixture://conflict-v2" },
          expectedVersion: 2,
          mutationId: "import-conflict-v2",
        },
        actor,
      )
      .pipe(Effect.flip);
    expect(rejected).toMatchObject({ reason: "conflict" });
    const preserved = yield* service.get({
      planId: "plan-conflict",
      spaceId: "space-conflict",
    });
    expect(preserved.version).toBe(2);
    expect(preserved.current.weeks[0]?.tasks[0]?.note).toBe("Local edit");
    expect(preserved.baseline.weeks[0]?.tasks[0]?.note).toBe("Original note");

    const compatibleSource = sourceFixture({
      secondText: "Updated source follow-up",
      updated: "2026-09-29T00:00:00.000Z",
    });
    const applied = yield* service.applyImport(
      {
        planId: "plan-conflict",
        spaceId: "space-conflict",
        sourceJson: compatibleSource,
        provenance: { sourceRef: "fixture://compatible-v2" },
        expectedVersion: 2,
        mutationId: "import-compatible-v2",
      },
      actor,
    );
    expect(applied.version).toBe(3);
    expect(applied.baseline.weeks[0]?.tasks[0]?.note).toBe("Original note");
    expect(applied.current.weeks[0]?.tasks[0]?.note).toBe("Local edit");
    expect(applied.current.weeks[0]?.tasks[1]?.text).toBe("Updated source follow-up");

    const original = yield* service.getOriginal({
      planId: "plan-conflict",
      spaceId: "space-conflict",
    });
    expect(original.sourceJson).toBe(originalSourceJson);
    expect(original.sourceSha256).toBe(originalImport.sourceSha256);
    expect(original.provenance).toEqual({
      sourceRef: "fixture://conflict-v1",
      originalFileName: "plan-a.json",
    });
    expect(original.original.weeks[0]?.tasks[0]?.note).toBe("Original note");
    expect(original.originalNormalized.weeks[0]?.tasks[1]?.sourceChecked).toBe(true);
    expect(original.originalNormalized.dateConflicts).toHaveLength(1);

    const current = yield* service.get({
      planId: "plan-conflict",
      spaceId: "space-conflict",
    });
    expect(current.sourceJson).toBe(compatibleSource);
    expect(current.baseline.weeks[0]?.tasks[1]?.text).toBe("Updated source follow-up");
    expect(current.current.weeks[0]?.tasks[0]?.note).toBe("Local edit");
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "applies exact Keep current and Use incoming decisions without changing either source",
  () =>
    Effect.gen(function* () {
      const service = yield* setup("decisions");
      const originalJson = sourceFixture();
      const incomingJson = sourceFixture({
        firstNote: "Incoming note",
        updated: "2026-09-28T00:00:00.000Z",
      });
      for (const [suffix, decision, expectedNote] of [
        ["keep", "keep-current", "Local note"],
        ["incoming", "use-incoming", "Incoming note"],
      ] as const) {
        const planId = `plan-decisions-${suffix}`;
        yield* service.applyImport(
          {
            planId,
            spaceId: "space-decisions",
            sourceJson: originalJson,
            provenance: { sourceRef: `fixture://${suffix}-a` },
            expectedVersion: 0,
            mutationId: `import-${suffix}-a`,
          },
          actor,
        );
        yield* service.patchTask(
          {
            planId,
            spaceId: "space-decisions",
            taskId: "task-a",
            field: "note",
            before: "Original note",
            after: "Local note",
            reason: "Reviewed local note",
            expectedVersion: 1,
            mutationId: `patch-${suffix}`,
            provenance: { kind: "manual" },
          },
          actor,
        );
        const input = {
          planId,
          spaceId: "space-decisions",
          sourceJson: incomingJson,
          provenance: { sourceRef: `fixture://${suffix}-b` },
          expectedVersion: 2,
          mutationId: `import-${suffix}-b`,
          conflictDecisions: [{ taskId: "task-a", field: "note" as const, decision }],
        };
        const applied = yield* service.applyImport(input, actor);
        expect(applied.version).toBe(3);
        expect(applied.current.weeks[0]?.tasks[0]?.note).toBe(expectedNote);
        expect(applied.baseline.weeks[0]?.tasks[0]?.note).toBe("Incoming note");
        expect(applied.sourceJson).toBe(incomingJson);
        expect(
          (yield* service.getOriginal({ planId, spaceId: "space-decisions" })).sourceJson,
        ).toBe(originalJson);
        expect((yield* service.applyImport(input, actor)).version).toBe(3);
        const changedChoice = yield* service
          .applyImport(
            {
              ...input,
              conflictDecisions: [
                {
                  taskId: "task-a",
                  field: "note",
                  decision:
                    decision === "keep-current"
                      ? ("use-incoming" as const)
                      : ("keep-current" as const),
                },
              ],
            },
            actor,
          )
          .pipe(Effect.flip);
        expect(changedChoice).toMatchObject({ reason: "conflict" });
        const history = yield* service.listHistory({ planId, spaceId: "space-decisions" });
        expect(
          history.entries.filter((entry) => entry.mutationId === input.mutationId),
        ).toHaveLength(1);
        expect(history.entries[0]?.after).toMatchObject({
          decisionCount: 1,
          decisions: input.conflictDecisions,
        });
        const sql = yield* SqlClient.SqlClient;
        const auditRows = yield* sql<{ readonly payloadJson: string }>`
        SELECT payload_json AS "payloadJson" FROM command_center_audit_events
        WHERE event_id = ${`sprint-plan:${input.mutationId}`} LIMIT 1
      `;
        expect(JSON.parse(auditRows[0]!.payloadJson)).toMatchObject({
          conflictDecisions: input.conflictDecisions,
        });
      }
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "rejects missing, extra, stale, duplicate and unsupported removal decisions atomically",
  () =>
    Effect.gen(function* () {
      const service = yield* setup("decision-guards");
      yield* service.applyImport(
        {
          planId: "plan-decision-guards",
          spaceId: "space-decision-guards",
          sourceJson: sourceFixture(),
          provenance: { sourceRef: "fixture://guards-a" },
          expectedVersion: 0,
          mutationId: "guards-import-a",
        },
        actor,
      );
      yield* service.patchTask(
        {
          planId: "plan-decision-guards",
          spaceId: "space-decision-guards",
          taskId: "task-a",
          field: "note",
          before: "Original note",
          after: "Local note",
          reason: "Local review",
          expectedVersion: 1,
          mutationId: "guards-patch",
          provenance: { kind: "manual" },
        },
        actor,
      );
      const incoming = sourceFixture({
        firstNote: "Incoming note",
        updated: "2026-09-28T00:00:00.000Z",
      });
      const base = {
        planId: "plan-decision-guards",
        spaceId: "space-decision-guards",
        sourceJson: incoming,
        provenance: { sourceRef: "fixture://guards-b" },
        expectedVersion: 2,
      } as const;
      for (const [mutationId, choices] of [
        ["missing", []],
        [
          "extra",
          [
            { taskId: "task-a", field: "note", decision: "keep-current" },
            { taskId: "task-b", field: "note", decision: "use-incoming" },
          ],
        ],
        [
          "duplicate",
          [
            { taskId: "task-a", field: "note", decision: "keep-current" },
            { taskId: "task-a", field: "note", decision: "keep-current" },
          ],
        ],
      ] as const) {
        const rejected = yield* service
          .applyImport({ ...base, mutationId, conflictDecisions: choices }, actor)
          .pipe(Effect.flip);
        expect(rejected.reason).toMatch(/conflict|validation/u);
        expect((yield* service.get({ planId: base.planId, spaceId: base.spaceId })).version).toBe(
          2,
        );
      }
      const stale = yield* service
        .applyImport(
          {
            ...base,
            expectedVersion: 1,
            mutationId: "stale",
            conflictDecisions: [{ taskId: "task-a", field: "note", decision: "keep-current" }],
          },
          actor,
        )
        .pipe(Effect.flip);
      expect(stale).toMatchObject({ reason: "conflict" });

      const removed = JSON.parse(incoming) as { weeks: Array<{ tasks: Array<{ id: string }> }> };
      removed.weeks[0]!.tasks = removed.weeks[0]!.tasks.filter((task) => task.id !== "task-a");
      const removedJson = JSON.stringify(removed);
      const preview = yield* service.previewImport({
        planId: base.planId,
        spaceId: base.spaceId,
        sourceJson: removedJson,
      });
      expect(preview.conflicts[0]?.reason).toBe("locally-edited-task-removed");
      const unsupported = yield* service
        .applyImport(
          {
            ...base,
            sourceJson: removedJson,
            mutationId: "removed-keep",
            conflictDecisions: [{ taskId: "task-a", field: "note", decision: "keep-current" }],
          },
          actor,
        )
        .pipe(Effect.flip);
      expect(unsupported).toMatchObject({
        reason: "conflict",
        message: expect.stringContaining("correcting the source"),
      });
      const applied = yield* service.applyImport(
        {
          ...base,
          sourceJson: removedJson,
          mutationId: "removed-incoming",
          conflictDecisions: [{ taskId: "task-a", field: "note", decision: "use-incoming" }],
        },
        actor,
      );
      expect(applied.current.weeks[0]?.tasks.some((task) => task.id === "task-a")).toBe(false);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("keeps 217 unrelated tasks identical when resolving one conflict", () =>
  Effect.gen(function* () {
    const service = yield* setup("many-tasks");
    const original = JSON.parse(sourceFixture()) as {
      weeks: Array<{ tasks: Array<Record<string, unknown>> }>;
      updated: string;
    };
    const extras = Array.from({ length: 217 }, (_, index) => ({
      id: `extra-${index}`,
      text: `Synthetic task ${index}`,
      owner: "Both",
      day: "Mon",
      note: `Note ${index}`,
      done: index % 2 === 0,
    }));
    original.weeks[0]!.tasks.push(...extras);
    const originalJson = JSON.stringify(original);
    yield* service.applyImport(
      {
        planId: "plan-many",
        spaceId: "space-many-tasks",
        sourceJson: originalJson,
        provenance: { sourceRef: "fixture://many-a" },
        expectedVersion: 0,
        mutationId: "many-import-a",
      },
      actor,
    );
    yield* service.patchTask(
      {
        planId: "plan-many",
        spaceId: "space-many-tasks",
        taskId: "task-a",
        field: "note",
        before: "Original note",
        after: "Local note",
        reason: "Reviewed",
        expectedVersion: 1,
        mutationId: "many-patch",
        provenance: { kind: "manual" },
      },
      actor,
    );
    const incoming = structuredClone(original);
    incoming.updated = "2026-09-28T00:00:00.000Z";
    incoming.weeks[0]!.tasks[0]!.note = "Incoming note";
    const incomingJson = JSON.stringify(incoming);
    const applied = yield* service.applyImport(
      {
        planId: "plan-many",
        spaceId: "space-many-tasks",
        sourceJson: incomingJson,
        provenance: { sourceRef: "fixture://many-b" },
        expectedVersion: 2,
        mutationId: "many-import-b",
        conflictDecisions: [{ taskId: "task-a", field: "note", decision: "keep-current" }],
      },
      actor,
    );
    expect(applied.current.weeks[0]?.tasks.slice(2)).toEqual(extras);
    expect(applied.current.weeks[0]?.tasks[0]?.note).toBe("Local note");
    expect(applied.sourceJson).toBe(incomingJson);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("resolves source date conflicts separately with a reason and exact history", () =>
  Effect.gen(function* () {
    const service = yield* setup("date-resolution");
    yield* service.applyImport(
      {
        planId: "plan-date-resolution",
        spaceId: "space-date-resolution",
        sourceJson: sourceFixture(),
        provenance: { sourceRef: "fixture://date-resolution" },
        expectedVersion: 0,
        mutationId: "import-date-resolution",
      },
      actor,
    );
    const resolved = yield* service.resolveDateConflict(
      {
        planId: "plan-date-resolution",
        spaceId: "space-date-resolution",
        taskId: "task-a",
        resolvedDate: "2026-10-31",
        reason: "The text date is authoritative",
        expectedVersion: 1,
        mutationId: "resolve-date-resolution",
        provenance: { kind: "manual", sourceRef: "clarification-1" },
      },
      actor,
    );
    expect(resolved.current.weeks[0]?.tasks[0]?.day).toBe("Wed 10/28");
    expect(resolved.dateResolutions).toEqual([
      expect.objectContaining({
        taskId: "task-a",
        resolvedDate: "2026-10-31",
        reason: "The text date is authoritative",
        actor,
      }),
    ]);
    const history = yield* service.listHistory({
      planId: resolved.id,
      spaceId: resolved.spaceId,
      limit: 10,
    });
    expect(history.entries[0]).toMatchObject({
      operation: "date-resolution",
      field: "dateResolution",
      after: "2026-10-31",
      reason: "The text date is authoritative",
    });
    expect(history.entries[0]).not.toHaveProperty("before");

    const clarified = yield* service.patchTask(
      {
        planId: resolved.id,
        spaceId: resolved.spaceId,
        taskId: "task-a",
        field: "day",
        before: "Wed 10/28",
        after: "Sat 10/31",
        reason: "Apply the recorded clarification to the current plan",
        expectedVersion: 2,
        mutationId: "patch-date-resolution",
        provenance: { kind: "manual", sourceRef: "clarification-1" },
      },
      actor,
    );
    expect(clarified.baseline.weeks[0]?.tasks[0]?.day).toBe("Wed 10/28");
    expect(clarified.current.weeks[0]?.tasks[0]?.day).toBe("Sat 10/31");
    expect(clarified.dateResolutions).toEqual([]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rejects malformed service imports without persisting a plan", () =>
  Effect.gen(function* () {
    const service = yield* setup("malformed");
    const malformed = JSON.parse(sourceFixture()) as SprintPlanSource;
    const mutable = malformed as unknown as { weeks: Array<{ tasks: Array<{ done: unknown }> }> };
    mutable.weeks[0]!.tasks[0]!.done = "yes";
    const error = yield* service
      .applyImport(
        {
          planId: "plan-malformed",
          spaceId: "space-malformed",
          sourceJson: JSON.stringify(malformed),
          provenance: { sourceRef: "fixture://malformed" },
          expectedVersion: 0,
          mutationId: "import-malformed",
        },
        actor,
      )
      .pipe(Effect.flip);
    expect(error).toBeInstanceOf(SprintPlanServiceError);
    expect(error).toMatchObject({ reason: "validation" });
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM command_center_sprint_plans WHERE id = 'plan-malformed'
    `;
    expect(rows).toEqual([{ count: 0 }]);
  }).pipe(Effect.provide(testLayer)),
);
