import type {
  Automation,
  AutomationNodeKind,
  AutomationTrigger,
  Run,
  Space,
} from "@command-center/core";
import type {
  EnvironmentId,
  ExecutionEnvironmentPlatformOs,
  ScheduledTask,
} from "@t3tools/contracts";
import { describeAutomationSchedule } from "@t3tools/shared/automationSchedule";

import type {
  AutomationEditorDefinition,
  AutomationEditorJson,
  AutomationEditorNodeKind,
} from "./types";

export type AutomationsScreenStatus =
  | "loading"
  | "disconnected"
  | "unavailable"
  | "config-unavailable"
  | "ready";

export interface ResolveAutomationsScreenStatusInput {
  readonly connected: boolean;
  readonly isPending: boolean;
  readonly hasData: boolean;
  readonly hasError: boolean;
  readonly configStatus?: "loaded" | "missing" | "invalid";
}

export interface AutomationEnvironmentCandidate {
  readonly id: EnvironmentId;
  readonly isPrimary?: boolean;
  readonly platformOs?: ExecutionEnvironmentPlatformOs;
}

export interface AutomationEditorDraft {
  readonly definition: AutomationEditorDefinition;
  readonly baseDigest: string;
  readonly configCommitSha: string;
  readonly dirty: boolean;
  readonly revision: number;
}

export function reconcileAutomationDraftAfterSave(input: {
  readonly currentDraft: AutomationEditorDraft | undefined;
  readonly submittedRevision: number;
  readonly savedDefinition: AutomationEditorDefinition;
  readonly savedDefinitionDigest: string;
  readonly savedConfigCommitSha: string;
}): AutomationEditorDraft {
  if (input.currentDraft && input.currentDraft.revision > input.submittedRevision) {
    return {
      ...input.currentDraft,
      baseDigest: input.savedDefinitionDigest,
      configCommitSha: input.savedConfigCommitSha,
      dirty: true,
    };
  }
  return {
    definition: input.savedDefinition,
    baseDigest: input.savedDefinitionDigest,
    configCommitSha: input.savedConfigCommitSha,
    dirty: false,
    revision: input.submittedRevision,
  };
}

export function shouldAutosaveAutomationDraft(input: {
  readonly dirty: boolean;
  readonly isSaving: boolean;
  readonly hasSaveError: boolean;
  readonly authoringUnavailable: boolean;
}): boolean {
  return input.dirty && !input.isSaving && !input.hasSaveError && !input.authoringUnavailable;
}

const PREFERRED_AUTOMATION_ENVIRONMENT_KEY = "t3code:automations:environment";

export function readPreferredAutomationEnvironmentId(): EnvironmentId | null {
  try {
    const stored = localStorage.getItem(PREFERRED_AUTOMATION_ENVIRONMENT_KEY)?.trim();
    return stored ? (stored as EnvironmentId) : null;
  } catch {
    return null;
  }
}

export function rememberPreferredAutomationEnvironmentId(environmentId: EnvironmentId): void {
  try {
    localStorage.setItem(PREFERRED_AUTOMATION_ENVIRONMENT_KEY, environmentId);
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}

export function resolveAutomationEnvironmentId(input: {
  readonly requestedEnvironmentId: EnvironmentId | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly environments: ReadonlyArray<AutomationEnvironmentCandidate>;
}): EnvironmentId | null {
  const requested = input.environments.find(({ id }) => id === input.requestedEnvironmentId);
  const remoteLinux = input.environments.find(
    ({ isPrimary, platformOs }) => isPrimary === false && platformOs === "linux",
  );
  const remote = remoteLinux ?? input.environments.find(({ isPrimary }) => isPrimary === false);

  if (requested !== undefined) {
    return requested.id;
  }
  if (remote !== undefined) {
    return remote.id;
  }
  if (
    input.primaryEnvironmentId !== null &&
    input.environments.some(({ id }) => id === input.primaryEnvironmentId)
  ) {
    return input.primaryEnvironmentId;
  }
  return input.environments[0]?.id ?? null;
}

export function resolveAutomationsScreenStatus({
  connected,
  isPending,
  hasData,
  hasError,
  configStatus,
}: ResolveAutomationsScreenStatusInput): AutomationsScreenStatus {
  if (!connected) return "disconnected";
  if (!hasData && isPending) return "loading";
  if (!hasData || hasError) return "unavailable";
  return configStatus === "loaded" ? "ready" : "config-unavailable";
}

function editorNodeKind(kind: AutomationNodeKind): AutomationEditorNodeKind {
  return kind === "agent" ? "agent.run" : kind;
}

function toEditorJson(value: unknown): AutomationEditorJson | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const children = value.map(toEditorJson);
    return children.every((child) => child !== undefined)
      ? (children as ReadonlyArray<AutomationEditorJson>)
      : undefined;
  }
  if (typeof value === "object" && value !== null) {
    const result: Record<string, AutomationEditorJson> = {};
    for (const [key, child] of Object.entries(value)) {
      const jsonChild = toEditorJson(child);
      if (jsonChild !== undefined) result[key] = jsonChild;
    }
    return result;
  }
  return undefined;
}

function sanitizeConfig(
  config: Readonly<Record<string, unknown>>,
): Readonly<Record<string, AutomationEditorJson>> {
  const sanitized: Record<string, AutomationEditorJson> = {};
  for (const [key, value] of Object.entries(config)) {
    const jsonValue = toEditorJson(value);
    if (jsonValue !== undefined) sanitized[key] = jsonValue;
  }
  return sanitized;
}

export function projectAutomationForEditor(automation: Automation): AutomationEditorDefinition {
  const trigger =
    automation.trigger.type === "schedule"
      ? {
          kind: "schedule" as const,
          expression: automation.trigger.expression,
          timezone: automation.trigger.timezone,
        }
      : automation.trigger.type === "webhook"
        ? { kind: "webhook" as const, route: automation.trigger.route }
        : { kind: "manual" as const };

  return {
    schemaVersion: 1,
    id: automation.id,
    name: automation.name,
    spaceId: automation.spaceId,
    enabled: automation.enabled,
    trigger,
    nodes: automation.nodes.map((node) => ({
      id: node.id,
      kind: editorNodeKind(node.kind),
      config: sanitizeConfig(node.config),
    })),
    edges: automation.edges.map((edge) => ({
      from: edge.sourceNodeId,
      to: edge.targetNodeId,
    })),
    layout: {
      nodes: Object.fromEntries(
        automation.nodes.map((node) => [node.id, { x: node.position.x, y: node.position.y }]),
      ),
    },
    // Policy stays server-owned in this read-only entity projection. It must
    // come from the private definition before editing is enabled.
    policy: {},
  };
}

export function automationSpaceName(automation: Automation, spaces: ReadonlyArray<Space>): string {
  return spaces.find((space) => space.id === automation.spaceId)?.displayName ?? "Unknown Space";
}

/** What the Automations page is showing on the right: one scheduled task or one committed automation. */
export type AutomationsSelection =
  | { readonly kind: "scheduled-task"; readonly id: string }
  | { readonly kind: "automation"; readonly id: string };

/** How much a recurring task needs the user, most urgent first. */
export type RecurringHealth = "failing" | "running" | "ok" | "idle" | "paused";

const HEALTH_RANK: Record<RecurringHealth, number> = {
  failing: 0,
  running: 1,
  ok: 2,
  idle: 3,
  paused: 4,
};

export function scheduledTaskHealth(
  task: Pick<ScheduledTask, "enabled" | "lastRunStatus">,
): RecurringHealth {
  if (!task.enabled) return "paused";
  switch (task.lastRunStatus) {
    case "failed":
      return "failing";
    case "running":
      return "running";
    case "succeeded":
      return "ok";
    case "never":
      return "idle";
  }
}

/** The most recent run of a committed automation, by creation time. */
export function latestAutomationRun(
  automation: Pick<Automation, "id">,
  runs: ReadonlyArray<Run>,
): Run | undefined {
  let latest: Run | undefined;
  for (const run of runs) {
    if (run.automationId !== automation.id) continue;
    if (latest === undefined || new Date(run.createdAt) > new Date(latest.createdAt)) latest = run;
  }
  return latest;
}

export function automationHealth(
  automation: Pick<Automation, "id" | "enabled">,
  runs: ReadonlyArray<Run>,
): RecurringHealth {
  if (!automation.enabled) return "paused";
  const latest = latestAutomationRun(automation, runs);
  if (latest === undefined) return "idle";
  switch (latest.status) {
    case "failed":
      return "failing";
    case "queued":
    case "running":
    case "waiting_approval":
    case "waiting":
      return "running";
    case "succeeded":
      return "ok";
    case "canceled":
      return "idle";
  }
}

/** Most urgent first; items of equal health keep their incoming order. */
export function sortByHealth<T>(
  items: ReadonlyArray<T>,
  health: (item: T) => RecurringHealth,
): ReadonlyArray<T> {
  return items
    .map((item, index) => ({ item, index, rank: HEALTH_RANK[health(item)] }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ item }) => item);
}

export interface RecurringTasksInput {
  readonly tasks: ReadonlyArray<ScheduledTask>;
  readonly automations: ReadonlyArray<Automation>;
  readonly runs: ReadonlyArray<Run>;
}

export interface RecurringHealthSummary {
  readonly total: number;
  readonly failing: number;
  readonly running: number;
  readonly paused: number;
}

export function summarizeRecurringHealth(input: RecurringTasksInput): RecurringHealthSummary {
  const healths = [
    ...input.tasks.map(scheduledTaskHealth),
    ...input.automations.map((automation) => automationHealth(automation, input.runs)),
  ];
  const count = (health: RecurringHealth) => healths.filter((value) => value === health).length;
  return {
    total: healths.length,
    failing: count("failing"),
    running: count("running"),
    paused: count("paused"),
  };
}

/** Enabled recurring tasks whose last run failed: the number the sidebar shows. */
export function countFailingRecurringTasks(input: RecurringTasksInput): number {
  return summarizeRecurringHealth(input).failing;
}

/**
 * Keeps the user's pick while it still exists, otherwise opens whatever needs
 * them most: the first failing task, then running, then the rest. Scheduled
 * tasks come before committed automations of the same health.
 */
export function resolveAutomationsSelection(
  selection: AutomationsSelection | undefined,
  input: RecurringTasksInput,
): AutomationsSelection | undefined {
  if (selection !== undefined) {
    const exists =
      selection.kind === "scheduled-task"
        ? input.tasks.some((task) => task.id === selection.id)
        : input.automations.some((automation) => automation.id === selection.id);
    if (exists) return selection;
  }
  const candidates: ReadonlyArray<{
    readonly selection: AutomationsSelection;
    readonly health: RecurringHealth;
  }> = [
    ...input.tasks.map((task) => ({
      selection: { kind: "scheduled-task" as const, id: task.id },
      health: scheduledTaskHealth(task),
    })),
    ...input.automations.map((automation) => ({
      selection: { kind: "automation" as const, id: automation.id },
      health: automationHealth(automation, input.runs),
    })),
  ];
  return sortByHealth(candidates, (candidate) => candidate.health)[0]?.selection;
}

export function describeAutomationTrigger(trigger: AutomationTrigger): string {
  switch (trigger.type) {
    case "manual":
      return "Manual";
    case "schedule":
      return describeAutomationSchedule(trigger.expression);
    case "webhook":
      return "On webhook";
  }
}
