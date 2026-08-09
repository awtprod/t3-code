import {
  AUTOMATION_EDITOR_NODE_KINDS,
  type AutomationEditorDefinition,
  type AutomationEditorEdge,
  type AutomationEditorJson,
  type AutomationEditorNodeKind,
  type AutomationEditorPosition,
  type AutomationEditorValidationIssue,
} from "./types";
import {
  isValidAutomationTimeZone,
  parseAutomationCronExpression,
} from "@t3tools/shared/automationSchedule";

export const AUTOMATION_NODE_WIDTH = 280;
export const AUTOMATION_NODE_HEIGHT = 112;
export const AUTOMATION_CANVAS_PADDING = 48;

const DEFAULT_COLUMN_GAP = 80;
const DEFAULT_ROW_GAP = 48;
const DEFAULT_COLUMN_COUNT = 3;
const SCOPED_SHELL_ALLOWLIST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SENSITIVE_CONFIG_KEY =
  /(?:^|[._-])(api[_-]?key|cookie|credential|password|secret|token)(?:$|[._-])/iu;
const ABSOLUTE_HOST_PATH = /^(?:\/(?:home|Users|root|etc|var|opt|srv)\/|[A-Za-z]:[\\/])/u;

function configIsSafeForGit(value: unknown): boolean {
  if (typeof value === "string") return !ABSOLUTE_HOST_PATH.test(value);
  if (Array.isArray(value)) return value.every(configIsSafeForGit);
  if (value === null || typeof value !== "object") return true;
  return Object.entries(value).every(
    ([key, child]) => !SENSITIVE_CONFIG_KEY.test(key) && configIsSafeForGit(child),
  );
}

const isJsonObject = (
  value: AutomationEditorJson | undefined,
): value is Readonly<Record<string, AutomationEditorJson>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isFiniteNumber = (value: AutomationEditorJson | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

function defaultNodePosition(index: number): AutomationEditorPosition {
  const column = index % DEFAULT_COLUMN_COUNT;
  const row = Math.floor(index / DEFAULT_COLUMN_COUNT);
  return {
    x: AUTOMATION_CANVAS_PADDING + column * (AUTOMATION_NODE_WIDTH + DEFAULT_COLUMN_GAP),
    y: AUTOMATION_CANVAS_PADDING + row * (AUTOMATION_NODE_HEIGHT + DEFAULT_ROW_GAP),
  };
}

export function readAutomationNodePosition(
  definition: AutomationEditorDefinition,
  nodeId: string,
  nodeIndex = definition.nodes.findIndex((node) => node.id === nodeId),
): AutomationEditorPosition {
  const nodes = definition.layout.nodes;
  const rawPosition = isJsonObject(nodes) ? nodes[nodeId] : undefined;
  if (isJsonObject(rawPosition) && isFiniteNumber(rawPosition.x) && isFiniteNumber(rawPosition.y)) {
    return { x: rawPosition.x, y: rawPosition.y };
  }
  return defaultNodePosition(Math.max(0, nodeIndex));
}

function positionIsValid(definition: AutomationEditorDefinition, nodeId: string): boolean {
  const nodes = definition.layout.nodes;
  const rawPosition = isJsonObject(nodes) ? nodes[nodeId] : undefined;
  return (
    isJsonObject(rawPosition) && isFiniteNumber(rawPosition.x) && isFiniteNumber(rawPosition.y)
  );
}

function nodePositionMap(
  definition: AutomationEditorDefinition,
): Readonly<Record<string, AutomationEditorJson>> {
  const value = definition.layout.nodes;
  return isJsonObject(value) ? value : {};
}

const jsonPosition = (
  position: AutomationEditorPosition,
): Readonly<Record<string, AutomationEditorJson>> => ({
  x: position.x,
  y: position.y,
});

export function reconcileAutomationNodePosition(
  currentPosition: AutomationEditorPosition,
  previousPersistedPosition: AutomationEditorPosition | undefined,
  nextPersistedPosition: AutomationEditorPosition,
  definitionChanged: boolean,
): AutomationEditorPosition {
  const persistedPositionChanged =
    previousPersistedPosition === undefined ||
    previousPersistedPosition.x !== nextPersistedPosition.x ||
    previousPersistedPosition.y !== nextPersistedPosition.y;
  return definitionChanged || persistedPositionChanged ? nextPersistedPosition : currentPosition;
}

export function moveAutomationNode(
  definition: AutomationEditorDefinition,
  nodeId: string,
  delta: AutomationEditorPosition,
): AutomationEditorDefinition {
  const nodeIndex = definition.nodes.findIndex((node) => node.id === nodeId);
  if (nodeIndex < 0 || !Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return definition;

  const current = readAutomationNodePosition(definition, nodeId, nodeIndex);
  return setAutomationNodePosition(definition, nodeId, {
    x: current.x + delta.x,
    y: current.y + delta.y,
  });
}

export function setAutomationNodePosition(
  definition: AutomationEditorDefinition,
  nodeId: string,
  position: AutomationEditorPosition,
): AutomationEditorDefinition {
  if (
    !definition.nodes.some((node) => node.id === nodeId) ||
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y)
  ) {
    return definition;
  }

  const nextPosition: AutomationEditorPosition = {
    x: Math.round(position.x),
    y: Math.round(position.y),
  };

  return {
    ...definition,
    layout: {
      ...definition.layout,
      nodes: {
        ...nodePositionMap(definition),
        [nodeId]: jsonPosition(nextPosition),
      },
    },
  };
}

const NODE_ID_STEMS: Record<AutomationEditorNodeKind, string> = {
  "agent.run": "agent",
  "connector.read": "connector",
  "connector.write": "connector-write",
  "item.mutate": "item",
  approval: "approval",
  condition: "condition",
  delay: "delay",
  foreach: "foreach",
  "sales.action": "sales",
  "shell.scoped": "shell",
  transform: "transform",
};

const NODE_DEFAULT_CONFIG: Partial<
  Record<AutomationEditorNodeKind, Readonly<Record<string, AutomationEditorJson>>>
> = {
  "agent.run": { prompt: "Describe the scoped agent task" },
  "connector.read": { operation: "gmail.search", query: "" },
  "connector.write": {
    operation: "gmail.draft.create",
    to: [],
    subject: "",
    body: "",
  },
  "item.mutate": { operation: "create", title: "", kind: "task", priority: "normal" },
  condition: { leftPath: "", operator: "truthy" },
  transform: { template: "" },
  foreach: { sourcePath: "", template: "{{item}}" },
  delay: { durationMs: 300_000 },
  approval: { approvalKey: "decision" },
  "shell.scoped": { allowlistId: "configured-command-id" },
  "sales.action": { operation: "prospects.list", minimumScore: 75, limit: 15 },
};

const nonEmptyString = (value: AutomationEditorJson | undefined): value is string =>
  typeof value === "string" && value.trim().length > 0;

const supportedConditionOperators = new Set([
  "truthy",
  "falsy",
  "equals",
  "notEquals",
  "contains",
  "greaterThan",
  "greaterThanOrEqual",
  "lessThan",
  "lessThanOrEqual",
]);

function guidedConfigProblem(
  definition: AutomationEditorDefinition,
  node: AutomationEditorDefinition["nodes"][number],
): string | undefined {
  const config = node.config;
  switch (node.kind) {
    case "agent.run":
    case "shell.scoped":
      return undefined;
    case "connector.read": {
      if (!nonEmptyString(config.connectionId)) return "Choose a connection.";
      const operation = config.operation;
      if (!nonEmptyString(operation)) return "Choose what this step should read.";
      if (["gmail.search", "drive.search"].includes(operation) && !nonEmptyString(config.query)) {
        return "Enter a search query.";
      }
      if (operation === "gmail.get" && !nonEmptyString(config.messageId))
        return "Enter a Gmail message ID.";
      if (operation === "gmail.thread.get" && !nonEmptyString(config.threadId))
        return "Enter a Gmail thread ID.";
      if (operation === "drive.get" && !nonEmptyString(config.fileId))
        return "Enter a Drive file ID.";
      if (
        ["calendar.events", "calendar.freebusy"].includes(operation) &&
        (!nonEmptyString(config.from) || !nonEmptyString(config.to))
      ) {
        return "Enter the start and end of the calendar window.";
      }
      if (
        operation === "calendar.freebusy" &&
        (!Array.isArray(config.calendarIds) || config.calendarIds.length === 0)
      ) {
        return "Choose at least one calendar.";
      }
      if (
        ![
          "gmail.search",
          "gmail.get",
          "gmail.thread.get",
          "calendar.events",
          "calendar.freebusy",
          "drive.search",
          "drive.list",
          "drive.get",
        ].includes(operation)
      ) {
        return "Choose a supported Gmail, Calendar, or Drive read action.";
      }
      if (
        config.limit !== undefined &&
        (!isFiniteNumber(config.limit) ||
          !Number.isInteger(config.limit) ||
          config.limit < 1 ||
          config.limit > 50)
      ) {
        return "Maximum results must be a whole number from 1 to 50.";
      }
      return undefined;
    }
    case "connector.write": {
      if (!nonEmptyString(config.connectionId)) return "Choose a Gmail connection.";
      if (config.operation !== "gmail.draft.create")
        return "Only Gmail draft creation is supported.";
      if (!Array.isArray(config.to) || config.to.length === 0 || !config.to.every(nonEmptyString))
        return "Add at least one recipient.";
      if (!nonEmptyString(config.subject)) return "Enter a draft subject.";
      if (!nonEmptyString(config.body) && !nonEmptyString(config.bodyHtml))
        return "Enter a draft body.";
      const hasApproval = definition.edges.some(
        (edge) =>
          edge.to === node.id &&
          definition.nodes.some(
            (candidate) => candidate.id === edge.from && candidate.kind === "approval",
          ),
      );
      return hasApproval ? undefined : "Connect an Approval step directly before this draft.";
    }
    case "item.mutate":
      return !nonEmptyString(config.title)
        ? "Enter an item title."
        : !["create", "capture", undefined].includes(config.operation as string | undefined)
          ? "Choose create or capture."
          : !["idea", "task", "decision", "alert", "approval", undefined].includes(
                config.kind as string | undefined,
              )
            ? "Choose a supported item type."
            : !["low", "normal", "high", "urgent", undefined].includes(
                  config.priority as string | undefined,
                )
              ? "Choose a supported priority."
              : undefined;
    case "condition": {
      const operator = nonEmptyString(config.operator) ? config.operator : "truthy";
      if (!supportedConditionOperators.has(operator)) return "Choose a supported comparison.";
      if (
        !nonEmptyString(config.leftPath) &&
        config.left === undefined &&
        !nonEmptyString(config.valuePath) &&
        config.value === undefined
      )
        return "Choose the incoming value to compare.";
      return undefined;
    }
    case "transform":
      return config.template === undefined &&
        config.output === undefined &&
        config.value === undefined
        ? "Enter an output template."
        : undefined;
    case "foreach":
      return !nonEmptyString(config.sourcePath) &&
        !nonEmptyString(config.itemsPath) &&
        config.source === undefined &&
        config.items === undefined
        ? "Choose the array to repeat over."
        : undefined;
    case "delay": {
      if (nonEmptyString(config.until))
        return Number.isNaN(Date.parse(config.until)) ? "Enter a valid date and time." : undefined;
      return isFiniteNumber(config.durationMs) &&
        config.durationMs >= 0 &&
        config.durationMs <= 31_536_000_000
        ? undefined
        : "Enter a duration between zero minutes and one year.";
    }
    case "approval":
      return config.approvalKey === undefined || nonEmptyString(config.approvalKey)
        ? undefined
        : "Enter a decision key.";
    case "sales.action": {
      const operation = config.operation;
      if (
        !["prospector.cycle", "prospects.list", "gmail.drafts.create", "gmail.reconcile"].includes(
          typeof operation === "string" ? operation : "",
        )
      ) {
        return "Choose a supported sales action.";
      }
      if (operation === "gmail.reconcile" && !nonEmptyString(config.connectionId))
        return "Enter the Gmail read connection ID.";
      if (
        operation === "gmail.drafts.create" &&
        (config.drafts === undefined || !nonEmptyString(config.campaignVersion))
      ) {
        return "Connect structured draft output and set a campaign version.";
      }
      return undefined;
    }
  }
}

export function addAutomationNode(
  definition: AutomationEditorDefinition,
  kind: AutomationEditorNodeKind,
  requestedPosition?: AutomationEditorPosition,
): AutomationEditorDefinition {
  if (!AUTOMATION_EDITOR_NODE_KINDS.includes(kind)) {
    return definition;
  }

  const usedIds = new Set(definition.nodes.map((node) => node.id));
  const stem = NODE_ID_STEMS[kind];
  let candidate = stem;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${stem}-${suffix}`;
    suffix += 1;
  }

  const position = requestedPosition ?? defaultNodePosition(definition.nodes.length);
  return {
    ...definition,
    nodes: [...definition.nodes, { id: candidate, kind, config: NODE_DEFAULT_CONFIG[kind] ?? {} }],
    layout: {
      ...definition.layout,
      nodes: {
        ...nodePositionMap(definition),
        [candidate]: jsonPosition(position),
      },
    },
  };
}

export function updateAutomationNode(
  definition: AutomationEditorDefinition,
  nodeId: string,
  patch: Partial<Pick<AutomationEditorDefinition["nodes"][number], "kind" | "config">>,
): AutomationEditorDefinition {
  if (!definition.nodes.some((node) => node.id === nodeId)) return definition;
  return {
    ...definition,
    nodes: definition.nodes.map((node) => (node.id === nodeId ? { ...node, ...patch } : node)),
  };
}

export function renameAutomationNode(
  definition: AutomationEditorDefinition,
  nodeId: string,
  nextNodeId: string,
): AutomationEditorDefinition {
  const normalized = nextNodeId.trim();
  if (
    normalized.length === 0 ||
    !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(normalized) ||
    definition.nodes.some((node) => node.id === normalized && node.id !== nodeId)
  ) {
    return definition;
  }
  if (nodeId === normalized || !definition.nodes.some((node) => node.id === nodeId)) {
    return definition;
  }
  const positions = nodePositionMap(definition);
  const currentPosition = positions[nodeId];
  const { [nodeId]: _removedPosition, ...remainingPositions } = positions;
  return {
    ...definition,
    nodes: definition.nodes.map((node) =>
      node.id === nodeId ? { ...node, id: normalized } : node,
    ),
    edges: definition.edges.map((edge) => ({
      from: edge.from === nodeId ? normalized : edge.from,
      to: edge.to === nodeId ? normalized : edge.to,
    })),
    layout: {
      ...definition.layout,
      nodes: {
        ...remainingPositions,
        ...(currentPosition === undefined ? {} : { [normalized]: currentPosition }),
      },
    },
  };
}

export function removeAutomationNode(
  definition: AutomationEditorDefinition,
  nodeId: string,
): AutomationEditorDefinition {
  if (!definition.nodes.some((node) => node.id === nodeId)) return definition;
  const positions = nodePositionMap(definition);
  const { [nodeId]: _removedPosition, ...remainingPositions } = positions;
  return {
    ...definition,
    nodes: definition.nodes.filter((node) => node.id !== nodeId),
    edges: definition.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId),
    layout: { ...definition.layout, nodes: remainingPositions },
  };
}

export function automationEdgeProblem(
  definition: AutomationEditorDefinition,
  edge: AutomationEditorEdge,
): string | undefined {
  if (edge.from === edge.to) return "A step cannot connect to itself.";
  if (
    !definition.nodes.some((node) => node.id === edge.from) ||
    !definition.nodes.some((node) => node.id === edge.to)
  ) {
    return "That step is no longer available.";
  }
  if (
    definition.edges.some((candidate) => candidate.from === edge.from && candidate.to === edge.to)
  ) {
    return "Those steps are already connected.";
  }

  const successors = new Map<string, string[]>();
  for (const candidate of definition.edges) {
    const current = successors.get(candidate.from) ?? [];
    current.push(candidate.to);
    successors.set(candidate.from, current);
  }
  const pending = [edge.to];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const nodeId = pending.pop();
    if (nodeId === undefined || visited.has(nodeId)) continue;
    if (nodeId === edge.from) return "That connection would create a loop.";
    visited.add(nodeId);
    pending.push(...(successors.get(nodeId) ?? []));
  }
  return undefined;
}

export function addAutomationEdge(
  definition: AutomationEditorDefinition,
  edge: AutomationEditorEdge,
): AutomationEditorDefinition {
  return automationEdgeProblem(definition, edge) === undefined
    ? { ...definition, edges: [...definition.edges, edge] }
    : definition;
}

export function setAutomationEdgeDirection(
  definition: AutomationEditorDefinition,
  edge: AutomationEditorEdge,
): AutomationEditorDefinition {
  if (
    definition.edges.some((candidate) => candidate.from === edge.from && candidate.to === edge.to)
  ) {
    return definition;
  }

  const withoutReverse = removeAutomationEdge(definition, {
    from: edge.to,
    to: edge.from,
  });
  return automationEdgeProblem(withoutReverse, edge) === undefined
    ? { ...withoutReverse, edges: [...withoutReverse.edges, edge] }
    : definition;
}

export function removeAutomationEdge(
  definition: AutomationEditorDefinition,
  edge: AutomationEditorEdge,
): AutomationEditorDefinition {
  return {
    ...definition,
    edges: definition.edges.filter(
      (candidate) => candidate.from !== edge.from || candidate.to !== edge.to,
    ),
  };
}

const edgeKey = (edge: AutomationEditorEdge): string =>
  `${edge.from.length}:${edge.from}${edge.to.length}:${edge.to}`;

function findCycleNodeIds(
  nodeIds: ReadonlySet<string>,
  successors: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyArray<string> {
  const visited = new Set<string>();
  const active = new Set<string>();
  const path: string[] = [];

  const visit = (nodeId: string): ReadonlyArray<string> | null => {
    visited.add(nodeId);
    active.add(nodeId);
    path.push(nodeId);

    for (const successor of successors.get(nodeId) ?? []) {
      if (active.has(successor)) return path.slice(path.indexOf(successor)).sort();
      if (!visited.has(successor)) {
        const cycle = visit(successor);
        if (cycle) return cycle;
      }
    }

    path.pop();
    active.delete(nodeId);
    return null;
  };

  for (const nodeId of [...nodeIds].sort()) {
    if (visited.has(nodeId)) continue;
    const cycle = visit(nodeId);
    if (cycle) return cycle;
  }
  return [];
}

export function validateAutomationEditorDefinition(
  definition: AutomationEditorDefinition,
): ReadonlyArray<AutomationEditorValidationIssue> {
  const issues: AutomationEditorValidationIssue[] = [];
  const nodeIds = new Set<string>();

  if (definition.nodes.length === 0) {
    issues.push({
      code: "graph.empty",
      message: "Add at least one node before saving this automation.",
      path: ["nodes"],
      severity: "error",
    });
  }

  if (definition.trigger.kind === "schedule") {
    if (
      parseAutomationCronExpression(definition.trigger.expression) === undefined ||
      !isValidAutomationTimeZone(definition.trigger.timezone)
    ) {
      issues.push({
        code: "trigger.invalid",
        message: "Schedule triggers require a five-field expression and a valid timezone.",
        path: ["trigger"],
        severity: "error",
      });
    }
  }

  if (
    definition.trigger.kind === "webhook" &&
    (!/^\/[A-Za-z0-9][A-Za-z0-9/_-]{0,126}$/u.test(definition.trigger.route) ||
      definition.trigger.route.includes("..") ||
      definition.trigger.route.endsWith("/"))
  ) {
    issues.push({
      code: "trigger.invalid",
      message: "Webhook triggers require a normalized local route such as /hooks/weekly.",
      path: ["trigger", "route"],
      severity: "error",
    });
  }

  for (const [index, node] of definition.nodes.entries()) {
    if (nodeIds.has(node.id)) {
      issues.push({
        code: "graph.duplicate-node",
        message: `Node ID '${node.id}' is used more than once.`,
        nodeIds: [node.id],
        path: ["nodes", index, "id"],
        severity: "error",
      });
    }
    nodeIds.add(node.id);
    if (!configIsSafeForGit(node.config)) {
      issues.push({
        code: "node.config.private-data",
        message: `Node '${node.id}' contains a host path or credential-shaped field that cannot be stored in Git.`,
        nodeIds: [node.id],
        path: ["nodes", index, "config"],
        severity: "error",
      });
    }
    if (node.kind === "agent.run") {
      const allowedKeys = new Set(["prompt", "repositoryId", "projectId", "providerId", "modelId"]);
      const extraKey = Object.keys(node.config)
        .filter((key) => !allowedKeys.has(key))
        .sort()[0];
      if (
        extraKey !== undefined ||
        typeof node.config.prompt !== "string" ||
        node.config.prompt.trim().length === 0 ||
        (node.config.projectId !== undefined && node.config.repositoryId === undefined)
      ) {
        issues.push({
          code: "node.config.invalid",
          message: `Agent node '${node.id}' requires a prompt and only committed routing selections.`,
          nodeIds: [node.id],
          path: ["nodes", index, "config"],
          severity: "error",
        });
      }
    }
    if (node.kind === "shell.scoped") {
      const keys = Object.keys(node.config);
      const allowlistId = node.config.allowlistId;
      if (
        keys.length !== 1 ||
        keys[0] !== "allowlistId" ||
        typeof allowlistId !== "string" ||
        allowlistId !== allowlistId.trim() ||
        !SCOPED_SHELL_ALLOWLIST_ID_PATTERN.test(allowlistId)
      ) {
        issues.push({
          code: "node.config.invalid",
          message: `Scoped shell node '${node.id}' may contain only a runtime allowlistId.`,
          nodeIds: [node.id],
          path: ["nodes", index, "config"],
          severity: "error",
        });
      }
    }
    const guidedProblem = guidedConfigProblem(definition, node);
    if (guidedProblem !== undefined) {
      issues.push({
        code: "node.config.invalid",
        message: `${node.id}: ${guidedProblem}`,
        nodeIds: [node.id],
        path: ["nodes", index, "config"],
        severity: "error",
      });
    }
    if (node.config.waitForExternalSignal === true) {
      issues.push({
        code: "v1.unsupported-external-wait",
        message:
          "External signal waits are unavailable in v1 because no authenticated resume API is enabled.",
        nodeIds: [node.id],
        path: ["nodes", index, "config"],
        severity: "error",
      });
    }
    if (!positionIsValid(definition, node.id)) {
      issues.push({
        code: "layout.invalid-position",
        message: `Node '${node.id}' is using a generated canvas position. Move it to save a position.`,
        nodeIds: [node.id],
        path: ["layout", "nodes", node.id],
        severity: "warning",
      });
    }
  }

  const edgeKeys = new Set<string>();
  let graphHasStructuralError = false;
  for (const [index, edge] of definition.edges.entries()) {
    const key = edgeKey(edge);
    if (edgeKeys.has(key)) {
      graphHasStructuralError = true;
      issues.push({
        code: "graph.duplicate-edge",
        message: `The edge from '${edge.from}' to '${edge.to}' is duplicated.`,
        nodeIds: [edge.from, edge.to],
        path: ["edges", index],
        severity: "error",
      });
    }
    edgeKeys.add(key);

    if (!nodeIds.has(edge.from)) {
      graphHasStructuralError = true;
      issues.push({
        code: "graph.unknown-edge-source",
        message: `Edge source '${edge.from}' does not reference a node.`,
        nodeIds: [edge.from],
        path: ["edges", index, "from"],
        severity: "error",
      });
    }
    if (!nodeIds.has(edge.to)) {
      graphHasStructuralError = true;
      issues.push({
        code: "graph.unknown-edge-target",
        message: `Edge target '${edge.to}' does not reference a node.`,
        nodeIds: [edge.to],
        path: ["edges", index, "to"],
        severity: "error",
      });
    }
  }

  if (!graphHasStructuralError && nodeIds.size > 0) {
    const successors = new Map<string, Set<string>>();
    for (const nodeId of nodeIds) successors.set(nodeId, new Set());
    for (const edge of definition.edges) successors.get(edge.from)?.add(edge.to);
    const cycleNodeIds = findCycleNodeIds(nodeIds, successors);
    if (cycleNodeIds.length > 0) {
      issues.push({
        code: "graph.cycle",
        message: `Remove the cycle involving ${cycleNodeIds.join(", ")}.`,
        nodeIds: cycleNodeIds,
        path: ["edges"],
        severity: "error",
      });
    }
  }

  return issues;
}

export function mergeAutomationValidationIssues(
  localIssues: ReadonlyArray<AutomationEditorValidationIssue>,
  remoteIssues: ReadonlyArray<AutomationEditorValidationIssue> = [],
): ReadonlyArray<AutomationEditorValidationIssue> {
  const merged: AutomationEditorValidationIssue[] = [];
  const seen = new Set<string>();
  for (const issue of [...remoteIssues, ...localIssues]) {
    const key = `${issue.code}:${issue.path?.join(".") ?? ""}:${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(issue);
  }
  return merged;
}

export function automationEdgePath(
  source: AutomationEditorPosition,
  target: AutomationEditorPosition,
): string {
  const startX = source.x + AUTOMATION_NODE_WIDTH;
  const startY = source.y + AUTOMATION_NODE_HEIGHT / 2;
  const endX = target.x;
  const endY = target.y + AUTOMATION_NODE_HEIGHT / 2;
  const bend = Math.max(48, Math.abs(endX - startX) / 2);
  return `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`;
}

export function automationCanvasSize(definition: AutomationEditorDefinition): {
  readonly width: number;
  readonly height: number;
} {
  const positions = definition.nodes.map((node, index) =>
    readAutomationNodePosition(definition, node.id, index),
  );
  return {
    width: Math.max(
      960,
      ...positions.map(
        (position) => position.x + AUTOMATION_NODE_WIDTH + AUTOMATION_CANVAS_PADDING,
      ),
    ),
    height: Math.max(
      520,
      ...positions.map(
        (position) => position.y + AUTOMATION_NODE_HEIGHT + AUTOMATION_CANVAS_PADDING,
      ),
    ),
  };
}

/** Produces a detached JSON value before it crosses the editor boundary. */
export function toSerializableAutomationDefinition(
  definition: AutomationEditorDefinition,
): AutomationEditorDefinition {
  return JSON.parse(JSON.stringify(definition)) as AutomationEditorDefinition;
}
