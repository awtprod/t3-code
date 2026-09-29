import type {
  CommandCenterSprintPlanConflictDecision,
  CommandCenterSprintPlanImportConflict,
  CommandCenterSprintPlanSource,
} from "@t3tools/contracts";

export function conflictDecisionKey(taskId: string, field: string): string {
  return JSON.stringify([taskId, field]);
}

export function completeImportDecisions(
  conflicts: readonly CommandCenterSprintPlanImportConflict[],
  selected: Readonly<Record<string, CommandCenterSprintPlanConflictDecision["decision"]>>,
): readonly CommandCenterSprintPlanConflictDecision[] | null {
  const decisions: CommandCenterSprintPlanConflictDecision[] = [];
  for (const conflict of conflicts) {
    const decision = selected[conflictDecisionKey(conflict.taskId, conflict.field)];
    if (
      decision === undefined ||
      (decision === "keep-current" && conflict.reason === "locally-edited-task-removed")
    )
      return null;
    decisions.push({ taskId: conflict.taskId, field: conflict.field, decision });
  }
  return decisions;
}

export type Task = CommandCenterSprintPlanSource["weeks"][number]["tasks"][number];
export type Week = CommandCenterSprintPlanSource["weeks"][number];

export interface VisibleTask {
  readonly task: Task;
  readonly week: Week;
}

export function planOwners(source: CommandCenterSprintPlanSource): readonly string[] {
  return [...new Set(source.weeks.flatMap((week) => week.tasks.map((task) => task.owner)))].sort(
    (left, right) => left.localeCompare(right),
  );
}

export function visiblePlanTasks(
  source: CommandCenterSprintPlanSource,
  weekId: string,
  owner: string,
): readonly VisibleTask[] {
  return source.weeks.flatMap((week) =>
    weekId !== "all" && week.id !== weekId
      ? []
      : week.tasks
          .filter((task) => owner === "all" || task.owner === owner)
          .map((task) => ({ task, week })),
  );
}

export function planProgress(source: CommandCenterSprintPlanSource): {
  readonly done: number;
  readonly total: number;
} {
  const tasks = source.weeks.flatMap((week) => week.tasks);
  return { done: tasks.filter((task) => task.done).length, total: tasks.length };
}

export function planCarryovers(
  source: CommandCenterSprintPlanSource,
  today: string,
): readonly VisibleTask[] {
  return source.weeks.flatMap((week) =>
    week.end >= today
      ? []
      : week.tasks.filter((task) => !task.done).map((task) => ({ task, week })),
  );
}

export function nextPlanWeeks(
  source: CommandCenterSprintPlanSource,
  today: string,
): readonly Week[] {
  return source.weeks.filter((week) => week.end >= today).slice(0, 2);
}

export function taskAnchor(id: string): string {
  return `task-${encodeURIComponent(id)}`;
}
