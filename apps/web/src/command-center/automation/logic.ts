import {
  AUTOMATION_EDITOR_NODE_KINDS,
  type AutomationEditorDefinition,
  type AutomationEditorEdge,
  type AutomationEditorJson,
  type AutomationEditorNodeKind,
  type AutomationEditorPosition,
  type AutomationEditorValidationIssue,
} from "./types";

export const AUTOMATION_NODE_WIDTH = 216;
export const AUTOMATION_NODE_HEIGHT = 88;
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

export function moveAutomationNode(
  definition: AutomationEditorDefinition,
  nodeId: string,
  delta: AutomationEditorPosition,
): AutomationEditorDefinition {
  const nodeIndex = definition.nodes.findIndex((node) => node.id === nodeId);
  if (nodeIndex < 0 || !Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return definition;

  const current = readAutomationNodePosition(definition, nodeId, nodeIndex);
  const nextPosition: AutomationEditorPosition = {
    x: Math.max(AUTOMATION_CANVAS_PADDING / 2, Math.round(current.x + delta.x)),
    y: Math.max(AUTOMATION_CANVAS_PADDING / 2, Math.round(current.y + delta.y)),
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
  "shell.scoped": "shell",
  transform: "transform",
};

const NODE_DEFAULT_CONFIG: Partial<
  Record<AutomationEditorNodeKind, Readonly<Record<string, AutomationEditorJson>>>
> = {
  "agent.run": { prompt: "Describe the scoped agent task" },
  "shell.scoped": { allowlistId: "configured-command-id" },
};

export function addAutomationNode(
  definition: AutomationEditorDefinition,
  kind: AutomationEditorNodeKind,
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

  const position = defaultNodePosition(definition.nodes.length);
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

export function addAutomationEdge(
  definition: AutomationEditorDefinition,
  edge: AutomationEditorEdge,
): AutomationEditorDefinition {
  if (
    edge.from === edge.to ||
    !definition.nodes.some((node) => node.id === edge.from) ||
    !definition.nodes.some((node) => node.id === edge.to) ||
    definition.edges.some((candidate) => candidate.from === edge.from && candidate.to === edge.to)
  ) {
    return definition;
  }
  const next = { ...definition, edges: [...definition.edges, edge] };
  return validateAutomationEditorDefinition(next).some((issue) => issue.code === "graph.cycle")
    ? definition
    : next;
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
    const fields = definition.trigger.expression.trim().split(/\s+/u);
    let timezoneValid = true;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: definition.trigger.timezone }).format();
    } catch {
      timezoneValid = false;
    }
    if (fields.length !== 5 || fields.some((field) => field.length === 0) || !timezoneValid) {
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
