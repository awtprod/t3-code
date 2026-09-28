import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  CommandCenterSprintPlanApplyImportInput,
  CommandCenterSprintPlanGetOriginalInput,
  CommandCenterSprintPlanGetOriginalResult,
  CommandCenterSprintPlanListInput,
  CommandCenterSprintPlanListResult,
  CommandCenterSprintPlanListHistoryResult,
  CommandCenterSprintPlanPatchTaskInput,
  CommandCenterSprintPlanPreviewImportInput,
  CommandCenterSprintPlanPreviewImportResult,
  CommandCenterSprintPlanResolveDateConflictInput,
  CommandCenterSprintPlanSnapshot,
} from "./commandCenterSprintPlan.ts";

const source = () => ({
  version: 2,
  updated: "2026-09-27T19:40:38.746Z",
  campaign: { channel: "live", flags: ["keep", "lossless"] },
  score: [
    {
      id: "reach",
      label: "Reach",
      start: "10",
      now: "12",
      target: "20",
      unit: "views",
    },
  ],
  weeks: [
    {
      id: "week-one",
      num: 1,
      start: "2026-10-26",
      end: "2026-11-01",
      range: "Oct 26 – Nov 1",
      tue: "Tuesday lineup",
      fri: "Friday lineup",
      editorial: { theme: "launch" },
      tasks: [
        {
          id: "publish-recap",
          text: "Publish recap Fri 10/30",
          owner: "Production",
          day: "Fri 10/30",
          note: "",
          done: false,
          sourceMetadata: { order: [1, 2] },
        },
      ],
    },
  ],
});

const normalized = () => ({
  sourceVersion: 2,
  sourceUpdatedAt: "2026-09-27T19:40:38.746Z",
  scores: source().score,
  weeks: [
    {
      id: "week-one",
      num: 1,
      start: "2026-10-26",
      end: "2026-11-01",
      range: "Oct 26 – Nov 1",
      tue: "Tuesday lineup",
      fri: "Friday lineup",
      tasks: [
        {
          id: "publish-recap",
          text: "Publish recap Fri 10/30",
          owner: "Production",
          day: "Fri 10/30",
          note: "",
          sourceChecked: false,
          scheduledDate: "2026-10-30",
        },
      ],
    },
  ],
  dateConflicts: [],
});

const snapshot = () => {
  const plan = source();
  return {
    id: "fall-plan",
    spaceId: "charlotte-comedy",
    version: 3,
    sourceVersion: 2,
    sourceUpdatedAt: "2026-09-27T19:40:38.746Z",
    sourceSha256: "a".repeat(64),
    sourceJson: JSON.stringify(plan),
    provenance: { sourceRef: "artifact:sprint-plan", originalFileName: "sprint-plan.json" },
    baseline: plan,
    baselineNormalized: normalized(),
    current: plan,
    dateResolutions: [],
    createdAt: "2026-09-27T20:00:00.000Z",
    updatedAt: "2026-09-28T01:00:00.000Z",
  };
};

describe("Command Center sprint-plan wire outputs", () => {
  it("accepts preview hashes and complete snapshots without dropping optional source metadata", () => {
    const preview = Schema.decodeUnknownSync(CommandCenterSprintPlanPreviewImportResult)({
      planId: "fall-plan",
      sourceSha256: "b".repeat(64),
      sourceVersion: 2,
      sourceUpdatedAt: "2026-09-27T19:40:38.746Z",
      taskCount: 1,
      existingVersion: null,
      unchangedSource: false,
      conflicts: [],
      sourceDateConflicts: [],
    });
    expect(preview.sourceSha256).toBe("b".repeat(64));

    const decoded = Schema.decodeUnknownSync(CommandCenterSprintPlanSnapshot)(snapshot());
    expect(decoded.baseline.campaign).toEqual({
      channel: "live",
      flags: ["keep", "lossless"],
    });
    expect(decoded.current.weeks[0]?.editorial).toEqual({ theme: "launch" });
    expect(decoded.current.weeks[0]?.tasks[0]?.sourceMetadata).toEqual({ order: [1, 2] });
    expect(decoded.baselineNormalized.scores[0]?.unit).toBe("views");
  });

  it("validates the standalone immutable original without adding it to snapshots", () => {
    const originalSource = source();
    const decoded = Schema.decodeUnknownSync(CommandCenterSprintPlanGetOriginalResult)({
      planId: "fall-plan",
      spaceId: "charlotte-comedy",
      sourceVersion: 2,
      sourceUpdatedAt: "2026-09-27T19:40:38.746Z",
      sourceSha256: "c".repeat(64),
      sourceJson: JSON.stringify(originalSource),
      provenance: { sourceRef: "artifact:first-import", originalFileName: "original.json" },
      original: originalSource,
      originalNormalized: normalized(),
      importedAt: "2026-09-27T20:00:00.000Z",
    });
    expect(decoded.sourceJson).toBe(JSON.stringify(originalSource));
    expect(decoded.originalNormalized.dateConflicts).toEqual([]);
    expect(
      Schema.decodeUnknownSync(CommandCenterSprintPlanSnapshot)(snapshot()),
    ).not.toHaveProperty("original");
  });

  it("rejects malformed hashes, dates, and oversized optional metadata", () => {
    expect(() =>
      Schema.decodeUnknownSync(CommandCenterSprintPlanPreviewImportResult)({
        planId: "fall-plan",
        sourceSha256: "latest",
        sourceVersion: 2,
        sourceUpdatedAt: "2026-09-27T19:40:38.746Z",
        taskCount: 1,
        existingVersion: null,
        unchangedSource: false,
        conflicts: [],
        sourceDateConflicts: [],
      }),
    ).toThrow();

    const invalidDate = snapshot();
    invalidDate.current.weeks[0]!.start = "2026-02-30";
    expect(() => Schema.decodeUnknownSync(CommandCenterSprintPlanSnapshot)(invalidDate)).toThrow();

    const oversizedMetadata = snapshot();
    const metadataTask = oversizedMetadata.current.weeks[0]!.tasks[0]! as unknown as {
      sourceMetadata: { order: Array<string | number> };
    };
    metadataTask.sourceMetadata = {
      order: ["x".repeat(8_193), 2],
    };
    expect(() =>
      Schema.decodeUnknownSync(CommandCenterSprintPlanSnapshot)(oversizedMetadata),
    ).toThrow();
  });

  it("bounds history pages and validates their full actor/provenance payload", () => {
    const decode = Schema.decodeUnknownSync(CommandCenterSprintPlanListHistoryResult);
    expect(
      decode({
        entries: [
          {
            sequence: 4,
            mutationId: "mutation-four",
            planId: "fall-plan",
            spaceId: "charlotte-comedy",
            planVersion: 3,
            operation: "task-patch",
            taskId: "publish-recap",
            field: "note",
            before: "",
            after: "Approved caption",
            actor: { id: "andrew", kind: "user" },
            provenance: { kind: "manual" },
            occurredAt: "2026-09-28T01:00:00.000Z",
          },
        ],
      }).entries[0],
    ).toMatchObject({ field: "note", actor: { kind: "user" } });

    expect(() =>
      decode({
        entries: Array.from({ length: 101 }, (_, index) => ({
          sequence: index + 1,
          mutationId: `mutation-${index}`,
          planId: "fall-plan",
          spaceId: "charlotte-comedy",
          planVersion: 3,
          operation: "import",
          actor: { id: "system", kind: "system" },
          provenance: { kind: "import", sourceRef: "artifact:sprint-plan" },
          occurredAt: "2026-09-28T01:00:00.000Z",
        })),
      }),
    ).toThrow();
  });

  it("keeps plan discovery bounded and summary-only", () => {
    const decoded = Schema.decodeUnknownSync(CommandCenterSprintPlanListResult)({
      plans: [
        {
          id: "fall-plan",
          spaceId: "charlotte-comedy",
          version: 3,
          sourceVersion: 2,
          sourceUpdatedAt: "2026-09-27T19:40:38.746Z",
          sourceSha256: "d".repeat(64),
          sourceJson: JSON.stringify(source()),
          current: source(),
          createdAt: "2026-09-27T20:00:00.000Z",
          updatedAt: "2026-09-28T01:00:00.000Z",
        },
      ],
      nextCursor: {
        updatedAt: "2026-09-28T01:00:00.000Z",
        planId: "fall-plan",
      },
    });
    expect(decoded.plans[0]).not.toHaveProperty("sourceJson");
    expect(decoded.plans[0]).not.toHaveProperty("current");
    expect(() =>
      Schema.decodeUnknownSync(CommandCenterSprintPlanListResult)({
        plans: Array.from({ length: 101 }, () => decoded.plans[0]),
      }),
    ).toThrow();
  });
});

describe("Command Center sprint-plan wire inputs", () => {
  it("requires a bounded Space-scoped keyset cursor for list discovery", () => {
    expect(
      Schema.decodeUnknownSync(CommandCenterSprintPlanListInput)({
        spaceId: "charlotte-comedy",
        cursor: { updatedAt: "2026-09-28T01:00:00.000Z", planId: "fall-plan" },
        limit: 25,
      }),
    ).toEqual({
      spaceId: "charlotte-comedy",
      cursor: { updatedAt: "2026-09-28T01:00:00.000Z", planId: "fall-plan" },
      limit: 25,
    });
    expect(() =>
      Schema.decodeUnknownSync(CommandCenterSprintPlanListInput)({
        spaceId: "charlotte-comedy",
        cursor: { updatedAt: "not-a-date", planId: "fall-plan" },
        limit: 101,
      }),
    ).toThrow();
  });

  it("keeps getOriginal Space-scoped and strips forged public authority", () => {
    const decoded = Schema.decodeUnknownSync(CommandCenterSprintPlanGetOriginalInput)({
      planId: "fall-plan",
      spaceId: "charlotte-comedy",
      actor: { id: "forged", kind: "system" },
      provenance: { kind: "approved-adjustment" },
    });
    expect(decoded).toEqual({ planId: "fall-plan", spaceId: "charlotte-comedy" });
  });

  it("keeps actors server-owned and source provenance reference-only", () => {
    const apply = Schema.decodeUnknownSync(CommandCenterSprintPlanApplyImportInput)({
      planId: "fall-plan",
      spaceId: "charlotte-comedy",
      sourceJson: JSON.stringify(source()),
      provenance: { sourceRef: "artifact:sprint-plan", originalFileName: "sprint-plan.json" },
      expectedVersion: 0,
      mutationId: "import-one",
      actor: { id: "forged", kind: "system" },
    });
    expect(apply).not.toHaveProperty("actor");
    expect(() =>
      Schema.decodeUnknownSync(CommandCenterSprintPlanApplyImportInput)({
        ...apply,
        provenance: { sourceRef: "artifact:sprint-plan", originalFileName: "../plan.json" },
      }),
    ).toThrow();
  });

  it("enforces byte limits before import and exact field patch value types", () => {
    expect(() =>
      Schema.decodeUnknownSync(CommandCenterSprintPlanPreviewImportInput)({
        planId: "fall-plan",
        spaceId: "charlotte-comedy",
        sourceJson: "x".repeat(1_048_577),
      }),
    ).toThrow();

    const common = {
      planId: "fall-plan",
      spaceId: "charlotte-comedy",
      taskId: "publish-recap",
      expectedVersion: 3,
      mutationId: "patch-one",
      provenance: { kind: "manual" },
    } as const;
    expect(
      Schema.decodeUnknownSync(CommandCenterSprintPlanPatchTaskInput)({
        ...common,
        field: "done",
        before: false,
        after: true,
      }),
    ).toMatchObject({ field: "done", after: true });
    expect(() =>
      Schema.decodeUnknownSync(CommandCenterSprintPlanPatchTaskInput)({
        ...common,
        field: "done",
        before: "false",
        after: "true",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(CommandCenterSprintPlanPatchTaskInput)({
        ...common,
        field: "owner",
        before: "Production",
        after: "Andrew",
      }),
    ).toThrow();
  });

  it("rejects client-forged approved adjustments for patches and date resolutions", () => {
    expect(() =>
      Schema.decodeUnknownSync(CommandCenterSprintPlanPatchTaskInput)({
        planId: "fall-plan",
        spaceId: "charlotte-comedy",
        taskId: "publish-recap",
        field: "note",
        before: "",
        after: "Forged approval",
        expectedVersion: 3,
        mutationId: "patch-forged",
        provenance: { kind: "approved-adjustment", evidenceRef: "approval:missing" },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(CommandCenterSprintPlanResolveDateConflictInput)({
        planId: "fall-plan",
        spaceId: "charlotte-comedy",
        taskId: "publish-recap",
        resolvedDate: "2026-10-30",
        reason: "Source text confirms Friday",
        expectedVersion: 3,
        mutationId: "resolution-forged",
        provenance: { kind: "approved-adjustment" },
      }),
    ).toThrow();
  });
});
