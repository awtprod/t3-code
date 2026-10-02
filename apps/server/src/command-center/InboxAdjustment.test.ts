import * as NodeServices from "@effect/platform-node/NodeServices";
import { ItemId, SpaceId } from "@command-center/core";
import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { make as makeInbox } from "./Inbox.ts";
import { make as makeObservations } from "./Observations.ts";
import { makeSprintPlanService } from "./SprintPlan.ts";

const testLayer = Layer.mergeAll(SqlitePersistenceMemory, NodeServices.layer);
const spaceId = SpaceId.make("adjustment-space");
const planId = "adjustment-plan";
const itemId = ItemId.make("adjustment-item");
const actor = { subject: "andrew" };
const instant = "2026-09-21T12:00:00.000Z";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const policy = {
  id: "fixture-channel-policy",
  version: 1,
  metricKind: "channel-subscribers",
  contentKind: "channel",
  cohortId: null,
  minimumMaturityMs: 0,
  minimumSampleCount: 1,
  minimumDenominator: null,
  maximumAgeMs: 100 * 365 * 86_400_000,
  maximumReportingLagMs: 86_400_000,
  requiredCompleteness: "complete",
} as const;

const sourceJson = encodeJson({
  version: 2,
  updated: "2026-09-21T12:00:00.000Z",
  fixtureMetadata: { retained: true },
  score: [{ id: "metric-a", label: "Synthetic metric", start: "", now: "", target: "Later" }],
  weeks: [
    {
      id: "week-a",
      num: 1,
      start: "2026-10-26",
      end: "2026-11-01",
      range: "Oct 26 – Nov 1",
      tue: "Synthetic Tuesday",
      fri: "Synthetic Friday",
      tasks: [
        {
          id: "task-a",
          text: "Prepare one",
          owner: "Production",
          day: "Wed 10/28",
          note: "Original note",
          done: false,
        },
        {
          id: "task-b",
          text: "Prepare two",
          owner: "Both",
          day: "Thu 10/29",
          note: "Unrelated",
          done: true,
        },
      ],
    },
  ],
});

const setup = Effect.fn("InboxAdjustmentTest.setup")(function* (withPolicy: boolean) {
  // Evaluate evidence at a time after it was collected, as in production (the
  // TestClock otherwise starts in 1970, before the fixture's observation).
  yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(instant)) + 60_000);
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO command_center_spaces (
      id, slug, name, kind, lifecycle, policy_json, created_at, updated_at
    ) VALUES (
      ${spaceId}, ${spaceId}, 'Adjustment fixture', 'business', 'active',
      ${withPolicy ? encodeJson({ observationEligibility: policy }) : "{}"},
      ${instant}, ${instant}
    )
  `;
  yield* sql`
    INSERT INTO command_center_items (
      id, space_id, kind, status, title, priority, source_json,
      links_json, metadata_json, created_at, updated_at
    ) VALUES (
      ${itemId}, ${spaceId}, 'decision', 'review', 'Review synthetic task change', 'high',
      '{"kind":"user","capturedAt":"2026-09-21T12:00:00.000Z"}', '[]', '{}',
      ${instant}, ${instant}
    )
  `;
  const plan = yield* makeSprintPlanService();
  yield* plan.applyImport(
    {
      planId,
      spaceId,
      sourceJson,
      provenance: { sourceRef: "fixture://plan" },
      expectedVersion: 0,
      mutationId: "fixture-import",
    },
    { id: actor.subject, kind: "user" },
  );
  const observations = yield* makeObservations;
  yield* observations.createManual(
    {
      mutationId: "fixture-observation-create",
      expectedVersion: 0,
      observation: {
        id: "observation-a",
        spaceId,
        planId,
        subjectId: "channel-a",
        channelId: "channel-a",
        contentKind: "channel",
        source: { identity: "fixture-channel", revision: "1" },
        metric: {
          kind: "channel-subscribers",
          unit: "count",
          definition: "Synthetic subscribers.",
        },
        collectionMethod: "manual",
        data: {
          value: 10,
          observedAt: instant,
          collectedAt: instant,
          period: { start: "2026-09-21", end: "2026-09-21", timeZone: "UTC" },
          sampleCount: 1,
          denominator: { kind: "not-applicable", value: null },
          completeness: { status: "complete" },
          reportingLagMs: 0,
          freshThrough: instant,
          metadata: {},
        },
      },
    },
    { id: actor.subject, kind: "user" },
  );
  const evidence = yield* observations.get({ spaceId, observationId: "observation-a" });
  const inbox = yield* makeInbox;
  return { sql, plan, observations, evidence, inbox };
});

const candidate = (
  evidence: { readonly revisionDigest: string },
  operations: ReadonlyArray<{
    readonly taskId: string;
    readonly field: "text" | "note" | "day" | "owner" | "done";
    readonly before: string | boolean;
    readonly after: string | boolean;
  }> = [
    { taskId: "task-a", field: "note" as const, before: "Original note", after: "Reviewed note" },
  ],
) => ({
  spaceId,
  itemId,
  mutationId: "candidate-a",
  expectedVersion: 0,
  source: "direct" as const,
  payload: {
    kind: "sprint-plan-task-patch" as const,
    target: { kind: "sprint-plan" as const, id: planId },
    expectedPlanVersion: 1,
    operations,
    reason: "A reviewer approved the exact task wording.",
    expectedBenefit: "Clearer assignment.",
    uncertainty: "Outcome remains unmeasured.",
    reviewAt: "2026-10-30T00:00:00.000Z",
    preservedConstraints: ["Keep other tasks intact."],
  },
  preview: { summary: "Review one exact synthetic task edit." },
  evidence: {
    source: "observation:observation-a",
    subjectId: "channel-a",
    version: "1",
    digest: evidence.revisionDigest,
    observedAt: instant,
  },
});

it.effect(
  "accepts without editing, then atomically approves one exact note field and deduplicates replay",
  () =>
    Effect.gen(function* () {
      const { sql, plan, evidence, inbox } = yield* setup(true);
      const created = yield* inbox.createCandidate(candidate(evidence), actor);
      const accepted = yield* inbox.acceptCandidate(
        {
          spaceId,
          itemId,
          mutationId: "accept-a",
          expectedVersion: created.detail.state.version,
          candidateRevisionId: created.detail.revisions[0]!.id,
        },
        actor,
      );
      const before = yield* plan.get({ spaceId, planId });
      expect(before.version).toBe(1);
      expect(before.current.weeks[0]?.tasks[0]?.note).toBe("Original note");
      expect(accepted.detail.state.approval).toEqual({
        supported: true,
        eligible: true,
        reason: "ready",
      });
      const duplicateProposal = yield* Effect.flip(
        inbox.createCandidate(
          {
            ...candidate(evidence),
            mutationId: "duplicate-candidate",
            expectedVersion: accepted.detail.state.version,
            payload: {
              ...candidate(evidence).payload,
              reason: "A changed rationale for the same diff.",
            },
          },
          actor,
        ),
      );
      expect(duplicateProposal.reason).toBe("conflict");
      const request = {
        spaceId,
        itemId,
        mutationId: "approve-a",
        currentRevisionId: accepted.detail.currentRevision!.id,
        expectedInboxVersion: accepted.detail.state.version,
        expectedPlanVersion: 1,
      };
      const approved = yield* inbox.approveAdjustment(request, actor);
      expect(approved.duplicate).toBe(false);
      expect(approved.detail.state.approval.reason).toBe("already-applied");
      const after = yield* plan.get({ spaceId, planId });
      expect(after.version).toBe(2);
      expect(after.sourceJson).toBe(sourceJson);
      expect(after.current.weeks[0]?.tasks[0]?.note).toBe("Reviewed note");
      expect(after.current.weeks[0]?.tasks[1]).toEqual(before.current.weeks[0]?.tasks[1]);
      expect(after.current.fixtureMetadata).toEqual(before.current.fixtureMetadata);
      expect((yield* inbox.approveAdjustment(request, actor)).duplicate).toBe(true);
      const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM command_center_sprint_plan_adjustment_approvals
    `;
      expect(rows[0]?.count).toBe(1);
      expect((yield* plan.listHistory({ spaceId, planId })).entries).toHaveLength(2);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("fails closed without a Space evidence policy and preserves both versions", () =>
  Effect.gen(function* () {
    const { plan, evidence, inbox } = yield* setup(false);
    const created = yield* inbox.createCandidate(candidate(evidence), actor);
    const accepted = yield* inbox.acceptCandidate(
      {
        spaceId,
        itemId,
        mutationId: "accept-a",
        expectedVersion: created.detail.state.version,
        candidateRevisionId: created.detail.revisions[0]!.id,
      },
      actor,
    );
    expect(accepted.detail.state.approval.reason).toBe("policy-not-configured");
    const error = yield* Effect.flip(
      inbox.approveAdjustment(
        {
          spaceId,
          itemId,
          mutationId: "approve-a",
          currentRevisionId: accepted.detail.currentRevision!.id,
          expectedInboxVersion: accepted.detail.state.version,
          expectedPlanVersion: 1,
        },
        actor,
      ),
    );
    expect(error.reason).toBe("conflict");
    expect((yield* plan.get({ spaceId, planId })).version).toBe(1);
    expect(
      (yield* inbox.detail({ spaceId: spaceId as never, itemId: itemId as never })).state.version,
    ).toBe(2);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rejects forged and superseded evidence without changing the plan", () =>
  Effect.gen(function* () {
    const { plan, observations, evidence, inbox } = yield* setup(true);
    const created = yield* inbox.createCandidate(
      {
        ...candidate(evidence),
        evidence: { ...candidate(evidence).evidence, digest: `sha256:${"0".repeat(64)}` },
      },
      actor,
    );
    const accepted = yield* inbox.acceptCandidate(
      {
        spaceId,
        itemId,
        mutationId: "accept-a",
        expectedVersion: created.detail.state.version,
        candidateRevisionId: created.detail.revisions[0]!.id,
      },
      actor,
    );
    expect(accepted.detail.state.approval.reason).toBe("evidence-stale");
    const request = {
      spaceId,
      itemId,
      mutationId: "approve-forged",
      currentRevisionId: accepted.detail.currentRevision!.id,
      expectedInboxVersion: accepted.detail.state.version,
      expectedPlanVersion: 1,
    };
    expect((yield* Effect.flip(inbox.approveAdjustment(request, actor))).reason).toBe("conflict");
    const valid = yield* inbox.createCandidate(
      {
        ...candidate(evidence),
        mutationId: "candidate-valid",
        expectedVersion: accepted.detail.state.version,
        evidence: candidate(evidence).evidence,
      },
      actor,
    );
    const acceptedValid = yield* inbox.acceptCandidate(
      {
        spaceId,
        itemId,
        mutationId: "accept-valid",
        expectedVersion: valid.detail.state.version,
        candidateRevisionId: valid.detail.revisions.find(
          (revision) => revision.status === "candidate",
        )!.id,
      },
      actor,
    );
    expect(acceptedValid.detail.state.approval.reason).toBe("ready");
    yield* observations.correct(
      {
        mutationId: "correct-observation",
        spaceId,
        observationId: "observation-a",
        expectedVersion: 1,
        reason: "Correct synthetic count.",
        data: { ...evidence.observation.data, value: 11 },
      },
      { id: actor.subject, kind: "user" },
    );
    const stale = yield* Effect.flip(
      inbox.approveAdjustment(
        {
          spaceId,
          itemId,
          mutationId: "approve-stale-evidence",
          currentRevisionId: acceptedValid.detail.currentRevision!.id,
          expectedInboxVersion: acceptedValid.detail.state.version,
          expectedPlanVersion: 1,
        },
        actor,
      ),
    );
    expect(stale.reason).toBe("conflict");
    expect((yield* plan.get({ spaceId, planId })).version).toBe(1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("applies two fields once and reverses only through a new accepted proposal", () =>
  Effect.gen(function* () {
    const { plan, evidence, inbox } = yield* setup(true);
    const operations = [
      { taskId: "task-a", field: "note" as const, before: "Original note", after: "Reviewed note" },
      { taskId: "task-b", field: "done" as const, before: true, after: false },
    ];
    const created = yield* inbox.createCandidate(candidate(evidence, operations), actor);
    const accepted = yield* inbox.acceptCandidate(
      {
        spaceId,
        itemId,
        mutationId: "accept-a",
        expectedVersion: created.detail.state.version,
        candidateRevisionId: created.detail.revisions[0]!.id,
      },
      actor,
    );
    yield* inbox.approveAdjustment(
      {
        spaceId,
        itemId,
        mutationId: "approve-a",
        currentRevisionId: accepted.detail.currentRevision!.id,
        expectedInboxVersion: accepted.detail.state.version,
        expectedPlanVersion: 1,
      },
      actor,
    );
    const changed = yield* plan.get({ spaceId, planId });
    expect(changed.version).toBe(2);
    expect(changed.current.weeks[0]?.tasks.map((task) => [task.note, task.done])).toEqual([
      ["Reviewed note", false],
      ["Unrelated", false],
    ]);
    const reversal = yield* inbox.createCandidate(
      {
        ...candidate(
          evidence,
          operations.map(({ before, after, ...rest }) => ({
            ...rest,
            before: after,
            after: before,
          })),
        ),
        mutationId: "candidate-reverse",
        expectedVersion: 3,
        payload: {
          ...candidate(evidence, operations).payload,
          expectedPlanVersion: 2,
          operations: operations.map(({ before, after, ...rest }) => ({
            ...rest,
            before: after,
            after: before,
          })),
        },
      },
      actor,
    );
    const acceptedReverse = yield* inbox.acceptCandidate(
      {
        spaceId,
        itemId,
        mutationId: "accept-reverse",
        expectedVersion: reversal.detail.state.version,
        candidateRevisionId: reversal.detail.revisions.find(
          (revision) => revision.status === "candidate",
        )!.id,
      },
      actor,
    );
    expect((yield* plan.get({ spaceId, planId })).version).toBe(2);
    yield* inbox.approveAdjustment(
      {
        spaceId,
        itemId,
        mutationId: "approve-reverse",
        currentRevisionId: acceptedReverse.detail.currentRevision!.id,
        expectedInboxVersion: acceptedReverse.detail.state.version,
        expectedPlanVersion: 2,
      },
      actor,
    );
    const restored = yield* plan.get({ spaceId, planId });
    expect(restored.version).toBe(3);
    expect(restored.current.weeks[0]?.tasks).toEqual(changed.baseline.weeks[0]?.tasks);
    expect(restored.sourceJson).toBe(sourceJson);
    expect((yield* plan.listHistory({ spaceId, planId })).entries).toHaveLength(3);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rejects stale Inbox and plan versions and changed replay ids", () =>
  Effect.gen(function* () {
    const { plan, evidence, inbox } = yield* setup(true);
    const created = yield* inbox.createCandidate(candidate(evidence), actor);
    const accepted = yield* inbox.acceptCandidate(
      {
        spaceId,
        itemId,
        mutationId: "accept-a",
        expectedVersion: created.detail.state.version,
        candidateRevisionId: created.detail.revisions[0]!.id,
      },
      actor,
    );
    const request = {
      spaceId,
      itemId,
      mutationId: "approve-a",
      currentRevisionId: accepted.detail.currentRevision!.id,
      expectedInboxVersion: accepted.detail.state.version,
      expectedPlanVersion: 1,
    };
    expect(
      (yield* Effect.flip(
        inbox.approveAdjustment(
          {
            ...request,
            spaceId: SpaceId.make("other-space"),
          },
          actor,
        ),
      )).reason,
    ).toBe("not_found");
    expect(
      (yield* Effect.flip(
        inbox.approveAdjustment(
          {
            ...request,
            currentRevisionId: "revision:wrong",
          },
          actor,
        ),
      )).reason,
    ).toBe("conflict");
    expect(
      (yield* Effect.flip(inbox.approveAdjustment({ ...request, expectedInboxVersion: 0 }, actor)))
        .reason,
    ).toBe("conflict");
    expect(
      (yield* Effect.flip(inbox.approveAdjustment({ ...request, expectedPlanVersion: 2 }, actor)))
        .reason,
    ).toBe("conflict");
    const prior = yield* plan.get({ spaceId, planId });
    expect(prior.version).toBe(1);
    yield* inbox.approveAdjustment(request, actor);
    expect(
      (yield* Effect.flip(inbox.approveAdjustment({ ...request, expectedPlanVersion: 2 }, actor)))
        .reason,
    ).toBe("conflict");
    expect(
      (yield* Effect.flip(
        inbox.approveAdjustment({ ...request, mutationId: "approve-again" }, actor),
      )).reason,
    ).toBe("conflict");
    expect((yield* plan.get({ spaceId, planId })).version).toBe(2);
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "rejects a wrong field-before value and unresolved review changes without partial writes",
  () =>
    Effect.gen(function* () {
      const { sql, plan, evidence, inbox } = yield* setup(true);
      const wrong = yield* inbox.createCandidate(
        candidate(evidence, [
          {
            taskId: "task-a",
            field: "note",
            before: "Not the current note",
            after: "Reviewed note",
          },
        ]),
        actor,
      );
      const accepted = yield* inbox.acceptCandidate(
        {
          spaceId,
          itemId,
          mutationId: "accept-a",
          expectedVersion: wrong.detail.state.version,
          candidateRevisionId: wrong.detail.revisions[0]!.id,
        },
        actor,
      );
      const attempt = {
        spaceId,
        itemId,
        mutationId: "approve-wrong-before",
        currentRevisionId: accepted.detail.currentRevision!.id,
        expectedInboxVersion: accepted.detail.state.version,
        expectedPlanVersion: 1,
      };
      expect((yield* Effect.flip(inbox.approveAdjustment(attempt, actor))).reason).toBe("conflict");
      expect((yield* plan.get({ spaceId, planId })).version).toBe(1);
      expect(
        (yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM command_center_sprint_plan_adjustment_approvals
    `)[0]?.count,
      ).toBe(0);
      const requested = yield* inbox.requestChanges(
        {
          spaceId,
          itemId,
          mutationId: "request-changes",
          expectedVersion: accepted.detail.state.version,
          text: "Fix the exact before value.",
        },
        actor,
      );
      expect(requested.detail.state.approval.reason).toBe("changes-requested");
      expect(
        (yield* Effect.flip(
          inbox.approveAdjustment(
            {
              ...attempt,
              mutationId: "approve-after-changes",
              expectedInboxVersion: requested.detail.state.version,
            },
            actor,
          ),
        )).reason,
      ).toBe("conflict");
      expect((yield* plan.get({ spaceId, planId })).version).toBe(1);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("approves once a snooze elapses but rejects while it is still snoozed", () =>
  Effect.gen(function* () {
    const { plan, evidence, inbox } = yield* setup(true);
    const created = yield* inbox.createCandidate(candidate(evidence), actor);
    const accepted = yield* inbox.acceptCandidate(
      {
        spaceId,
        itemId,
        mutationId: "accept-a",
        expectedVersion: created.detail.state.version,
        candidateRevisionId: created.detail.revisions[0]!.id,
      },
      actor,
    );
    const wakeAt = DateTime.formatIso(
      DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + 60 * 60 * 1000),
    );
    const snoozed = yield* inbox.snooze(
      {
        spaceId,
        itemId,
        mutationId: "snooze-a",
        expectedVersion: accepted.detail.state.version,
        wakeAt,
      },
      actor,
    );
    expect(snoozed.detail.state.lifecycle).toBe("snoozed");
    const request = {
      spaceId,
      itemId,
      currentRevisionId: accepted.detail.currentRevision!.id,
      expectedInboxVersion: snoozed.detail.state.version,
      expectedPlanVersion: 1,
    };
    const early = yield* Effect.flip(
      inbox.approveAdjustment({ ...request, mutationId: "approve-while-snoozed" }, actor),
    );
    expect(early.reason).toBe("conflict");
    expect((yield* plan.get({ spaceId, planId })).version).toBe(1);

    yield* TestClock.adjust("2 hours");
    const woken = yield* inbox.detail({ spaceId: spaceId as never, itemId: itemId as never });
    expect(woken.state.lifecycle).toBe("open");
    expect(woken.state.version).toBe(snoozed.detail.state.version);
    const approved = yield* inbox.approveAdjustment(
      { ...request, mutationId: "approve-after-wake" },
      actor,
    );
    expect(approved.duplicate).toBe(false);
    expect(approved.detail.state.version).toBe(snoozed.detail.state.version + 1);
    expect((yield* plan.get({ spaceId, planId })).version).toBe(2);
  }).pipe(Effect.provide(testLayer)),
);
