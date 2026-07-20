import {
  type AutomationDefinition,
  type AutomationFileNode,
  type AutomationValidationIssue,
  validateAutomationDefinition,
} from "./Definition.ts";
import { digestAutomationDefinition, type AutomationDefinitionDigest } from "./Digest.ts";
import { analyzeAutomationGraph } from "./Graph.ts";

export interface AutomationExecutionState {
  readonly completedNodeIds?: ReadonlyArray<string>;
  readonly inFlightNodeIds?: ReadonlyArray<string>;
}

export interface BlockedAutomationNode {
  readonly node: AutomationFileNode;
  readonly waitingForNodeIds: ReadonlyArray<string>;
}

export interface AutomationExecutionPlan {
  readonly definition: AutomationDefinition;
  readonly definitionDigest: AutomationDefinitionDigest;
  readonly orderedNodes: ReadonlyArray<AutomationFileNode>;
  readonly stages: ReadonlyArray<ReadonlyArray<AutomationFileNode>>;
  readonly readyNodes: ReadonlyArray<AutomationFileNode>;
  readonly blockedNodes: ReadonlyArray<BlockedAutomationNode>;
  readonly complete: boolean;
}

export type AutomationPlanningResult =
  | { readonly ok: true; readonly plan: AutomationExecutionPlan }
  | { readonly ok: false; readonly issues: ReadonlyArray<AutomationValidationIssue> };

export function planAutomationExecution(
  input: unknown,
  state: AutomationExecutionState = {},
): AutomationPlanningResult {
  const validated = validateAutomationDefinition(input);
  if (!validated.ok) return validated;

  const definition = validated.definition;
  const analysis = analyzeAutomationGraph(definition);
  const nodesById = new Map<string, AutomationFileNode>(
    definition.nodes.map((node) => [node.id, node] as const),
  );
  const completed = new Set(state.completedNodeIds ?? []);
  const inFlight = new Set(state.inFlightNodeIds ?? []);
  const unknownStateNodeIds = [...new Set([...completed, ...inFlight])]
    .filter((nodeId) => !nodesById.has(nodeId))
    .sort();

  if (unknownStateNodeIds.length > 0) {
    return {
      ok: false,
      issues: [
        {
          code: "state.unknown-node",
          message: `Execution state references unknown nodes: ${unknownStateNodeIds.join(", ")}.`,
          path: [],
          nodeIds: unknownStateNodeIds,
        },
      ],
    };
  }

  const orderedNodes = analysis.orderedNodeIds.map((nodeId) => nodesById.get(nodeId)!);
  const stages = analysis.stages.map((stage) => stage.map((nodeId) => nodesById.get(nodeId)!));
  const readyNodes: AutomationFileNode[] = [];
  const blockedNodes: BlockedAutomationNode[] = [];

  for (const node of orderedNodes) {
    if (completed.has(node.id) || inFlight.has(node.id)) continue;
    const waitingForNodeIds = (analysis.predecessorIds[node.id] ?? []).filter(
      (nodeId) => !completed.has(nodeId),
    );
    if (waitingForNodeIds.length === 0) readyNodes.push(node);
    else blockedNodes.push({ node, waitingForNodeIds });
  }

  return {
    ok: true,
    plan: {
      definition,
      definitionDigest: digestAutomationDefinition(definition),
      orderedNodes,
      stages,
      readyNodes,
      blockedNodes,
      complete: completed.size === definition.nodes.length,
    },
  };
}
