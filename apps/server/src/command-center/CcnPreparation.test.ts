import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { canonicalJson } from "./automation/Digest.ts";
import { makeCcnPreparation } from "./CcnPreparation.ts";
import { makeSprintPlanService } from "./SprintPlan.ts";

const testLayer = Layer.mergeAll(SqlitePersistenceMemory, NodeServices.layer);
const spaceId = "ccn-synthetic";
const planId = "synthetic-plan";
const source = {
  version: 1,
  updated: "2026-09-28T00:00:00.000Z",
  score: [],
  weeks: [
    {
      id: "week-a",
      num: 1,
      start: "2026-09-28",
      end: "2026-10-04",
      range: "Sep 28 – Oct 4",
      tue: "Review",
      fri: "Publish",
      tasks: [
        {
          id: "task-a",
          text: "Prepare a synthetic clip",
          owner: "Performer P",
          day: "Tue 9/29",
          note: "",
          done: false,
        },
      ],
    },
  ],
};

it.effect(
  "records one missing-source item across scans, then changes work identity on a new binding",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
      INSERT INTO command_center_spaces (id, slug, name, kind, created_at, updated_at)
      VALUES (${spaceId}, ${spaceId}, 'Synthetic CCN', 'business',
        '2026-09-28T00:00:00.000Z', '2026-09-28T00:00:00.000Z')
    `;
      const plans = yield* makeSprintPlanService();
      yield* plans.applyImport(
        {
          planId,
          spaceId,
          sourceJson: canonicalJson(source),
          provenance: { sourceRef: "fixture://ccn" },
          expectedVersion: 0,
          mutationId: "fixture-import",
        },
        { id: "tester", kind: "user" },
      );
      const service = yield* makeCcnPreparation({ sourceReady: () => Effect.succeed(true) });
      const scan = {
        spaceId,
        planId,
        responsibilityId: "ccn-weekly",
        candidateKind: "clip",
        taskIds: ["task-a"],
        today: "2026-09-28",
        windowDays: 7,
      } as const;
      const first = yield* service.scan(scan);
      const second = yield* service.scan(scan);
      expect(first.candidates).toEqual([]);
      expect(first.blocked).toHaveLength(1);
      expect(second.blocked[0]?.itemId).toBe(first.blocked[0]?.itemId);
      const blockedCount = yield* sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM command_center_items WHERE space_id = ${spaceId}
    `;
      expect(blockedCount[0]?.count).toBe(1);
      const runCount = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM command_center_runs`;
      expect(runCount[0]?.count).toBe(0);

      const bindingInput = {
        spaceId,
        planId,
        taskId: "task-a",
        candidateKind: "clip",
        expectedPlanVersion: 1,
        expectedBindingVersion: 0,
        performerId: "performer-p",
        performerName: "Performer P",
        recordingId: "recording-a",
        recordingVersion: "v1",
        rootId: "approved-root",
        relativePath: "recording.mp4",
        sourceSha256: "a".repeat(64),
      } as const;
      const binding = yield* service.putBinding(bindingInput);
      expect(binding.version).toBe(1);
      const ready = yield* service.scan(scan);
      expect(ready.blocked).toEqual([]);
      expect(ready.candidates).toHaveLength(1);
      expect((yield* service.scan(scan)).candidates[0]?.workIdentity).toBe(
        ready.candidates[0]?.workIdentity,
      );
      const blockedStatus = yield* sql<{ status: string }>`
      SELECT status FROM command_center_items WHERE id = ${first.blocked[0]!.itemId}
    `;
      expect(blockedStatus[0]?.status).toBe("canceled");

      const replacement = yield* service.putBinding({
        ...bindingInput,
        expectedBindingVersion: 1,
        recordingVersion: "v2",
      });
      expect(replacement.version).toBe(2);
      expect((yield* service.scan(scan)).candidates[0]?.workIdentity).not.toBe(
        ready.candidates[0]?.workIdentity,
      );

      yield* plans.patchTask(
        {
          planId,
          spaceId,
          taskId: "task-a",
          field: "note",
          before: "",
          after: "Reviewed",
          expectedVersion: 1,
          reason: "Synthetic edit",
          mutationId: "fixture-patch",
          provenance: { kind: "manual" },
        },
        { id: "tester", kind: "user" },
      );
      expect((yield* service.scan(scan)).blocked[0]?.cause).toBe("stale-plan-version");
      expect(
        (yield* service
          .putBinding({
            ...bindingInput,
            expectedPlanVersion: 2,
            expectedBindingVersion: 2,
            spaceId: "other-space",
          })
          .pipe(Effect.flip)).reason,
      ).toBe("conflict");
    }).pipe(Effect.provide(testLayer)),
);
