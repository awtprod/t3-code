import type { Connection, Space } from "@command-center/core";
import type { CommandCenterAutomationScheduleInterpretResult } from "@t3tools/contracts";

export const AUTOMATION_EDITOR_NODE_KINDS = [
  "agent.run",
  "connector.read",
  "connector.write",
  "item.mutate",
  "condition",
  "transform",
  "foreach",
  "delay",
  "approval",
  "shell.scoped",
] as const;

export type AutomationEditorNodeKind = (typeof AUTOMATION_EDITOR_NODE_KINDS)[number];

export const AUTOMATION_EDITOR_ADDABLE_NODE_KINDS = [
  "agent.run",
  "connector.read",
  "connector.write",
  "item.mutate",
  "condition",
  "transform",
  "foreach",
  "delay",
  "approval",
  "shell.scoped",
] as const satisfies ReadonlyArray<AutomationEditorNodeKind>;

export type AutomationEditorJson =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<AutomationEditorJson>
  | { readonly [key: string]: AutomationEditorJson };

export interface AutomationEditorPosition {
  readonly x: number;
  readonly y: number;
}

export type AutomationEditorTrigger =
  | { readonly kind: "manual" }
  | {
      readonly kind: "schedule";
      readonly expression: string;
      readonly timezone: string;
    }
  | { readonly kind: "webhook"; readonly route: string };

export interface AutomationEditorNode {
  readonly id: string;
  readonly kind: AutomationEditorNodeKind;
  readonly config: Readonly<Record<string, AutomationEditorJson>>;
}

export interface AutomationEditorEdge {
  readonly from: string;
  readonly to: string;
}

/**
 * JSON-compatible draft of the private automation file format. The editor only
 * changes public structure and layout; credentials and runtime state have no
 * representation here.
 */
export interface AutomationEditorDefinition {
  readonly $schema?: string;
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly spaceId: string;
  readonly enabled: boolean;
  readonly trigger: AutomationEditorTrigger;
  readonly nodes: ReadonlyArray<AutomationEditorNode>;
  readonly edges: ReadonlyArray<AutomationEditorEdge>;
  readonly layout: Readonly<Record<string, AutomationEditorJson>>;
  readonly policy: Readonly<Record<string, AutomationEditorJson>>;
}

export type AutomationEditorValidationIssueCode =
  | "graph.empty"
  | "graph.duplicate-node"
  | "graph.duplicate-edge"
  | "graph.unknown-edge-source"
  | "graph.unknown-edge-target"
  | "graph.cycle"
  | "layout.invalid-position"
  | "node.config.invalid"
  | "trigger.invalid"
  | "v1.unsupported-node"
  | "v1.unsupported-external-wait";

export interface AutomationEditorValidationIssue {
  readonly code: AutomationEditorValidationIssueCode | (string & {});
  readonly message: string;
  readonly nodeIds?: ReadonlyArray<string>;
  readonly path?: ReadonlyArray<string | number>;
  readonly severity?: "error" | "warning";
}

export interface AutomationEditorProps {
  readonly definition: AutomationEditorDefinition;
  readonly onDefinitionChange: (definition: AutomationEditorDefinition) => void;
  /** Validation returned by the committed-definition API, merged with local graph checks. */
  readonly validationIssues?: ReadonlyArray<AutomationEditorValidationIssue>;
  readonly readOnly?: boolean;
  readonly className?: string;
  readonly selectedSpace?: Space | undefined;
  readonly connections?: ReadonlyArray<Connection> | undefined;
  readonly environmentTimezone?: string | null | undefined;
  readonly onInterpretSchedule?:
    | ((input: {
        readonly text: string;
        readonly timezone: string;
      }) => Promise<CommandCenterAutomationScheduleInterpretResult>)
    | undefined;
}
