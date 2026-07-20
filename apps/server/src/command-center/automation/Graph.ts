import type { AutomationDefinition, AutomationValidationIssue } from "./Definition.ts";

export interface AutomationGraphAnalysis {
  readonly issues: ReadonlyArray<AutomationValidationIssue>;
  readonly orderedNodeIds: ReadonlyArray<string>;
  readonly stages: ReadonlyArray<ReadonlyArray<string>>;
  readonly predecessorIds: Readonly<Record<string, ReadonlyArray<string>>>;
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const edgeKey = (from: string, to: string): string => `${from.length}:${from}${to}`;

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

    for (const childId of [...(successors.get(nodeId) ?? [])].sort(compareText)) {
      if (active.has(childId)) return path.slice(path.indexOf(childId));
      if (!visited.has(childId)) {
        const cycle = visit(childId);
        if (cycle !== null) return cycle;
      }
    }

    path.pop();
    active.delete(nodeId);
    return null;
  };

  for (const nodeId of [...nodeIds].sort(compareText)) {
    if (visited.has(nodeId)) continue;
    const cycle = visit(nodeId);
    if (cycle !== null) return [...cycle].sort(compareText);
  }
  return [];
}

export function analyzeAutomationGraph(definition: AutomationDefinition): AutomationGraphAnalysis {
  const issues: AutomationValidationIssue[] = [];
  const nodeIds = new Set<string>();

  if (definition.nodes.length === 0) {
    issues.push({
      code: "graph.empty",
      message: "An automation must contain at least one node.",
      path: ["nodes"],
    });
  }

  for (const [index, node] of definition.nodes.entries()) {
    if (nodeIds.has(node.id)) {
      issues.push({
        code: "graph.duplicate-node",
        message: `Node id '${node.id}' is used more than once.`,
        path: ["nodes", index, "id"],
        nodeIds: [node.id],
      });
    }
    nodeIds.add(node.id);
  }

  const edgeKeys = new Set<string>();
  for (const [index, edge] of definition.edges.entries()) {
    const key = edgeKey(edge.from, edge.to);
    if (edgeKeys.has(key)) {
      issues.push({
        code: "graph.duplicate-edge",
        message: `Edge '${edge.from}' to '${edge.to}' is declared more than once.`,
        path: ["edges", index],
        nodeIds: [edge.from, edge.to],
      });
    }
    edgeKeys.add(key);

    if (!nodeIds.has(edge.from)) {
      issues.push({
        code: "graph.unknown-edge-source",
        message: `Edge source '${edge.from}' does not reference a node.`,
        path: ["edges", index, "from"],
        nodeIds: [edge.from],
      });
    }
    if (!nodeIds.has(edge.to)) {
      issues.push({
        code: "graph.unknown-edge-target",
        message: `Edge target '${edge.to}' does not reference a node.`,
        path: ["edges", index, "to"],
        nodeIds: [edge.to],
      });
    }
  }

  if (issues.some((issue) => issue.code !== "graph.empty")) {
    return { issues, orderedNodeIds: [], stages: [], predecessorIds: {} };
  }

  const indegree = new Map<string, number>();
  const successors = new Map<string, Set<string>>();
  const predecessors = new Map<string, Set<string>>();
  for (const nodeId of nodeIds) {
    indegree.set(nodeId, 0);
    successors.set(nodeId, new Set());
    predecessors.set(nodeId, new Set());
  }
  for (const edge of definition.edges) {
    successors.get(edge.from)?.add(edge.to);
    predecessors.get(edge.to)?.add(edge.from);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  let ready = [...nodeIds].filter((nodeId) => indegree.get(nodeId) === 0).sort(compareText);
  const stages: Array<ReadonlyArray<string>> = [];
  const orderedNodeIds: string[] = [];

  while (ready.length > 0) {
    const stage = ready;
    stages.push(stage);
    orderedNodeIds.push(...stage);
    const nextReady = new Set<string>();

    for (const nodeId of stage) {
      const children = [...(successors.get(nodeId) ?? [])].sort(compareText);
      for (const childId of children) {
        const nextIndegree = (indegree.get(childId) ?? 0) - 1;
        indegree.set(childId, nextIndegree);
        if (nextIndegree === 0) nextReady.add(childId);
      }
    }
    ready = [...nextReady].sort(compareText);
  }

  if (orderedNodeIds.length !== nodeIds.size) {
    const cyclicNodeIds = findCycleNodeIds(nodeIds, successors);
    issues.push({
      code: "graph.cycle",
      message: `Automation graph contains a cycle involving: ${cyclicNodeIds.join(", ")}.`,
      path: ["edges"],
      nodeIds: cyclicNodeIds,
    });
  }

  const predecessorIds = Object.fromEntries(
    [...predecessors.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([nodeId, values]) => [nodeId, [...values].sort(compareText)]),
  );

  return { issues, orderedNodeIds, stages, predecessorIds };
}

export function validateAutomationGraph(
  definition: AutomationDefinition,
): ReadonlyArray<AutomationValidationIssue> {
  return analyzeAutomationGraph(definition).issues;
}
