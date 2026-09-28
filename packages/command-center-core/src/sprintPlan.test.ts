import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  SPRINT_PLAN_IMPORT_LIMITS,
  SprintPlanValidationError,
  parseSprintPlanSource,
} from "./sprintPlan.ts";

const fixture = () => ({
  version: 2,
  updated: "2026-09-27T19:40:38.746Z",
  sourceLabel: "synthetic fixture",
  score: [
    {
      id: "apv",
      label: "Average viewed",
      start: "",
      now: "",
      target: "Set at launch",
      unit: "percent",
    },
  ],
  weeks: [
    {
      id: "w1",
      num: 1,
      start: "2026-10-26",
      end: "2026-11-01",
      range: "Oct 26 – Nov 1",
      tue: "Tuesday lineup",
      fri: "Friday lineup",
      focus: "Optional week metadata",
      tasks: [
        {
          id: "task-a",
          text: "Post Sat 10/31",
          owner: "Production",
          day: "Wed 10/28",
          note: "Synthetic note",
          done: false,
          sourceTag: { order: ["first", "second"] },
        },
        {
          id: "task-b",
          text: "Prepare a synthetic follow-up",
          owner: "Both",
          day: "Thu 10/29",
          note: "",
          done: true,
        },
      ],
    },
  ],
});

it.effect("preserves the exact source JSON, ordering, metadata, and unknown score strings", () =>
  Effect.gen(function* () {
    const sourceJson = JSON.stringify(fixture(), null, 2);
    const parsed = yield* parseSprintPlanSource(sourceJson);

    expect(parsed.sourceJson).toBe(sourceJson);
    expect(JSON.parse(parsed.sourceJson)).toEqual(fixture());
    expect(parsed.source.score[0]?.now).toBe("");
    expect(parsed.source.score[0]?.target).toBe("Set at launch");
    expect(parsed.source.weeks[0]?.focus).toBe("Optional week metadata");
    expect(parsed.source.weeks[0]?.tasks[0]?.sourceTag).toEqual({
      order: ["first", "second"],
    });
    expect(Object.isFrozen(parsed.source)).toBe(true);
    expect(Object.isFrozen(parsed.source.weeks[0]?.tasks[0])).toBe(true);
    expect(parsed.normalized.dateConflicts).toEqual([
      expect.objectContaining({
        taskId: "task-a",
        dayDate: "2026-10-28",
        textDate: "2026-10-31",
        reason: "different-dates",
      }),
    ]);
    expect(parsed.normalized.weeks[0]?.tasks[1]).toMatchObject({
      sourceChecked: true,
      scheduledDate: "2026-10-29",
    });
  }),
);

it.effect("rejects malformed dates, ranges, done values, and duplicate IDs", () =>
  Effect.gen(function* () {
    const malformedDate = fixture();
    malformedDate.weeks[0]!.start = "2026-02-30";
    expect((yield* parseSprintPlanSource(malformedDate).pipe(Effect.flip)).message).toContain(
      "Invalid calendar date",
    );

    const malformedRange = fixture();
    malformedRange.weeks[0]!.range = "later";
    expect((yield* parseSprintPlanSource(malformedRange).pipe(Effect.flip)).message).toContain(
      "malformed date range",
    );

    const wrongDone = fixture() as unknown as {
      weeks: Array<{ tasks: Array<{ done: unknown }> }>;
    };
    wrongDone.weeks[0]!.tasks[0]!.done = "yes";
    expect(yield* parseSprintPlanSource(wrongDone).pipe(Effect.flip)).toBeInstanceOf(
      SprintPlanValidationError,
    );

    const duplicateTask = fixture();
    duplicateTask.weeks[0]!.tasks[1]!.id = "task-a";
    expect((yield* parseSprintPlanSource(duplicateTask).pipe(Effect.flip)).message).toContain(
      "Duplicate sprint plan task ID",
    );

    const duplicateWeek = fixture();
    duplicateWeek.weeks.push({ ...duplicateWeek.weeks[0]!, tasks: [] });
    expect((yield* parseSprintPlanSource(duplicateWeek).pipe(Effect.flip)).message).toContain(
      "Duplicate sprint plan week ID",
    );
  }),
);

it.effect("rejects oversized collections and strings before returning source data", () =>
  Effect.gen(function* () {
    const tooManyTasks = fixture();
    tooManyTasks.weeks[0]!.tasks = Array.from(
      { length: SPRINT_PLAN_IMPORT_LIMITS.tasksPerWeek + 1 },
      (_, index) => ({
        id: `task-${index}`,
        text: "Synthetic task",
        owner: "Production",
        day: "Thu 10/29",
        note: "",
        done: false,
        sourceTag: { order: [] },
      }),
    );
    expect(yield* parseSprintPlanSource(tooManyTasks).pipe(Effect.flip)).toBeInstanceOf(
      SprintPlanValidationError,
    );

    const oversized = fixture();
    oversized.weeks[0]!.tasks[0]!.note = "x".repeat(SPRINT_PLAN_IMPORT_LIMITS.stringLength + 1);
    expect((yield* parseSprintPlanSource(oversized).pipe(Effect.flip)).message).toContain(
      "oversized string",
    );

    const oversizedJson = " ".repeat(SPRINT_PLAN_IMPORT_LIMITS.bytes + 1);
    expect((yield* parseSprintPlanSource(oversizedJson).pipe(Effect.flip)).message).toContain(
      "byte limit",
    );
  }),
);

it.effect("rejects cyclic in-process inputs", () =>
  Effect.gen(function* () {
    const cyclic: Record<string, unknown> = fixture();
    cyclic.self = cyclic;
    const error = yield* parseSprintPlanSource(cyclic).pipe(Effect.flip);
    expect(error.message).toContain("cycle");
  }),
);

it.effect("resolves textual dates against the candidate year inside a New Year week", () =>
  Effect.gen(function* () {
    const source = fixture();
    source.weeks[0] = {
      ...source.weeks[0]!,
      id: "new-year-week",
      start: "2026-12-28",
      end: "2027-01-03",
      range: "Dec 28 – Jan 3",
      tasks: [
        {
          id: "matching-new-year-date",
          text: "Publish the recap Fri 1/1",
          owner: "Production",
          day: "Fri 1/1",
          note: "",
          done: false,
        },
        {
          id: "real-cross-year-conflict",
          text: "Publish the follow-up Sat 1/2",
          owner: "Production",
          day: "Fri 1/1",
          note: "",
          done: false,
        },
      ],
    };

    const parsed = yield* parseSprintPlanSource(source);
    expect(parsed.normalized.weeks[0]?.tasks[0]).toMatchObject({
      scheduledDate: "2027-01-01",
    });
    expect(parsed.normalized.weeks[0]?.tasks[0]).not.toHaveProperty("dateConflict");
    expect(parsed.normalized.weeks[0]?.tasks[1]?.dateConflict).toMatchObject({
      dayDate: "2027-01-01",
      textDate: "2027-01-02",
      reason: "different-dates",
    });
  }),
);

it.effect("continues to resolve Thanksgiving Day against the week year", () =>
  Effect.gen(function* () {
    const source = fixture();
    source.weeks[0] = {
      ...source.weeks[0]!,
      id: "thanksgiving-week",
      start: "2026-11-23",
      end: "2026-11-29",
      range: "Nov 23 – Nov 29",
      tasks: [
        {
          id: "thanksgiving-release",
          text: "Publish the Thanksgiving Day release",
          owner: "Production",
          day: "Thu 11/26",
          note: "",
          done: false,
        },
      ],
    };

    const parsed = yield* parseSprintPlanSource(source);
    expect(parsed.normalized.weeks[0]?.tasks[0]).toMatchObject({
      scheduledDate: "2026-11-26",
    });
    expect(parsed.normalized.dateConflicts).toEqual([]);
  }),
);
