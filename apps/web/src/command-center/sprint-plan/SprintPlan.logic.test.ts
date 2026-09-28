import { describe, expect, it } from "vite-plus/test";

import type { CommandCenterSprintPlanSource } from "@t3tools/contracts";

import {
  completeImportDecisions,
  conflictDecisionKey,
  nextPlanWeeks,
  planCarryovers,
  planOwners,
  planProgress,
  visiblePlanTasks,
} from "./SprintPlan.logic";

const source: CommandCenterSprintPlanSource = {
  version: 1,
  updated: "2026-09-27T00:00:00.000Z",
  score: [],
  weeks: [
    {
      id: "w1",
      num: 1,
      start: "2026-09-21",
      end: "2026-09-27",
      range: "Sep 21 – Sep 27",
      tue: "",
      fri: "",
      tasks: [
        { id: "a", text: "Prepare", owner: "Production", day: "Tue", note: "", done: false },
        { id: "b", text: "Review", owner: "Both", day: "Fri", note: "", done: true },
      ],
    },
    {
      id: "w2",
      num: 2,
      start: "2026-09-28",
      end: "2026-10-04",
      range: "Sep 28 – Oct 4",
      tue: "",
      fri: "",
      tasks: [{ id: "c", text: "Publish", owner: "Production", day: "Tue", note: "", done: false }],
    },
  ],
};

describe("sprint plan task selection", () => {
  it("keeps unfinished past work open while filtering by week and owner", () => {
    expect(planCarryovers(source, "2026-09-28").map(({ task }) => task.id)).toEqual(["a"]);
    expect(visiblePlanTasks(source, "w1", "Production").map(({ task }) => task.id)).toEqual(["a"]);
    expect(visiblePlanTasks(source, "all", "Production").map(({ task }) => task.id)).toEqual([
      "a",
      "c",
    ]);
    expect(nextPlanWeeks(source, "2026-09-28").map((week) => week.id)).toEqual(["w2"]);
    expect(planOwners(source)).toEqual(["Both", "Production"]);
    expect(planProgress(source)).toEqual({ done: 1, total: 3 });
  });
});

describe("import decisions", () => {
  it("requires one safe explicit choice per previewed conflict", () => {
    const conflicts = [
      {
        taskId: "a",
        field: "note",
        baseline: "A",
        current: "B",
        incoming: "C",
        reason: "both-changed",
      },
      {
        taskId: "b",
        field: "day",
        baseline: "Mon",
        current: "Tue",
        reason: "locally-edited-task-removed",
      },
    ] as const;
    expect(completeImportDecisions(conflicts, {})).toBeNull();
    expect(
      completeImportDecisions(conflicts, {
        [conflictDecisionKey("a", "note")]: "keep-current",
        [conflictDecisionKey("b", "day")]: "keep-current",
      }),
    ).toBeNull();
    expect(
      completeImportDecisions(conflicts, {
        [conflictDecisionKey("a", "note")]: "keep-current",
        [conflictDecisionKey("b", "day")]: "use-incoming",
      }),
    ).toEqual([
      { taskId: "a", field: "note", decision: "keep-current" },
      { taskId: "b", field: "day", decision: "use-incoming" },
    ]);
  });
});
