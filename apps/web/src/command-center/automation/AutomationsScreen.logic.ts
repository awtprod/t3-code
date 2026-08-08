import type { Automation, AutomationNodeKind, Space } from "@command-center/core";
import type { EnvironmentId, ExecutionEnvironmentPlatformOs } from "@t3tools/contracts";

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
