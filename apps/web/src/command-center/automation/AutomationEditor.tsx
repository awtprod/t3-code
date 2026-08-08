"use client";

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToParentElement } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import {
  AlertTriangleIcon,
  BotIcon,
  BracesIcon,
  CableIcon,
  CheckCircle2Icon,
  CircleDotIcon,
  Clock3Icon,
  GitBranchIcon,
  GripVerticalIcon,
  ListTodoIcon,
  Link2Icon,
  PencilIcon,
  PlusIcon,
  Repeat2Icon,
  ShieldCheckIcon,
  TerminalIcon,
  Trash2Icon,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState, type CSSProperties } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";

import {
  AUTOMATION_NODE_HEIGHT,
  AUTOMATION_NODE_WIDTH,
  addAutomationNode,
  addAutomationEdge,
  automationCanvasSize,
  automationEdgePath,
  mergeAutomationValidationIssues,
  moveAutomationNode,
  readAutomationNodePosition,
  removeAutomationEdge,
  removeAutomationNode,
  renameAutomationNode,
  toSerializableAutomationDefinition,
  validateAutomationEditorDefinition,
  updateAutomationNode,
} from "./logic";
import {
  AUTOMATION_EDITOR_ADDABLE_NODE_KINDS,
  type AutomationEditorDefinition,
  type AutomationEditorNode,
  type AutomationEditorNodeKind,
  type AutomationEditorPosition,
  type AutomationEditorProps,
  type AutomationEditorValidationIssue,
} from "./types";

interface NodePresentation {
  readonly label: string;
  readonly description: string;
  readonly icon: LucideIcon;
  readonly accentClassName: string;
}

const NODE_PRESENTATION: Record<AutomationEditorNodeKind, NodePresentation> = {
  "agent.run": {
    label: "Agent",
    description: "Run scoped agent work",
    icon: BotIcon,
    accentClassName: "bg-primary/10 text-primary",
  },
  "connector.read": {
    label: "Connector read",
    description: "Read from an allowed connection",
    icon: CableIcon,
    accentClassName: "bg-info/10 text-info-foreground",
  },
  "item.mutate": {
    label: "Item change",
    description: "Create or update an Item",
    icon: ListTodoIcon,
    accentClassName: "bg-success/10 text-success-foreground",
  },
  condition: {
    label: "Condition",
    description: "Choose a path from data",
    icon: GitBranchIcon,
    accentClassName: "bg-warning/10 text-warning-foreground",
  },
  transform: {
    label: "Transform",
    description: "Reshape prior output",
    icon: BracesIcon,
    accentClassName: "bg-secondary text-secondary-foreground",
  },
  foreach: {
    label: "For each",
    description: "Repeat over a collection",
    icon: Repeat2Icon,
    accentClassName: "bg-secondary text-secondary-foreground",
  },
  delay: {
    label: "Delay",
    description: "Wait without blocking a worker",
    icon: Clock3Icon,
    accentClassName: "bg-secondary text-secondary-foreground",
  },
  approval: {
    label: "Approval",
    description: "Pause for a digest-bound decision",
    icon: ShieldCheckIcon,
    accentClassName: "bg-warning/10 text-warning-foreground",
  },
  "shell.scoped": {
    label: "Scoped shell",
    description: "Run an allowlisted local command",
    icon: TerminalIcon,
    accentClassName: "bg-destructive/8 text-destructive-foreground",
  },
};

const EMPTY_VALIDATION_ISSUES: ReadonlyArray<AutomationEditorValidationIssue> = [];
const CANVAS_DND_MODIFIERS = [restrictToParentElement];

function triggerLabel(definition: AutomationEditorDefinition): string {
  switch (definition.trigger.kind) {
    case "manual":
      return "Manual trigger";
    case "schedule":
      return `Schedule · ${definition.trigger.expression}`;
    case "webhook":
      return "Webhook trigger";
  }
}

function nodeIssueSeverity(
  nodeId: string,
  issues: ReadonlyArray<AutomationEditorValidationIssue>,
): "error" | "warning" | null {
  const related = issues.filter((issue) => issue.nodeIds?.includes(nodeId));
  if (related.some((issue) => (issue.severity ?? "error") === "error")) return "error";
  return related.length > 0 ? "warning" : null;
}

interface AutomationNodeCardProps {
  readonly node: AutomationEditorNode;
  readonly position: AutomationEditorPosition;
  readonly issues: ReadonlyArray<AutomationEditorValidationIssue>;
  readonly readOnly: boolean;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}

function AutomationNodeCard({
  node,
  position,
  issues,
  readOnly,
  onEdit,
  onRemove,
}: AutomationNodeCardProps) {
  const presentation = NODE_PRESENTATION[node.kind];
  const Icon = presentation.icon;
  const issueSeverity = nodeIssueSeverity(node.id, issues);
  const configKeyCount = Object.keys(node.config).length;
  const { attributes, isDragging, listeners, setActivatorNodeRef, setNodeRef, transform } =
    useDraggable({
      id: node.id,
      data: { kind: node.kind },
      disabled: readOnly,
    });

  const style: CSSProperties = {
    height: AUTOMATION_NODE_HEIGHT,
    left: position.x,
    top: position.y,
    transform: CSS.Translate.toString(transform),
    width: AUTOMATION_NODE_WIDTH,
  };

  return (
    <article
      aria-label={`${presentation.label} node ${node.id}`}
      className={cn(
        "absolute z-10 rounded-xl border bg-card text-card-foreground shadow-sm transition-[box-shadow,opacity]",
        isDragging && "z-20 opacity-90 shadow-lg ring-2 ring-primary/30",
        issueSeverity === "error" && "border-destructive/60",
        issueSeverity === "warning" && "border-warning/60",
      )}
      data-kind={node.kind}
      data-node-id={node.id}
      data-slot="automation-node"
      ref={setNodeRef}
      style={style}
    >
      <div className="flex h-full items-center gap-3 px-3">
        <span
          aria-hidden="true"
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-lg",
            presentation.accentClassName,
          )}
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold">{node.id}</span>
            {issueSeverity ? (
              <AlertTriangleIcon
                aria-label={`${issueSeverity} on ${node.id}`}
                className={cn(
                  "size-3.5 shrink-0",
                  issueSeverity === "error" ? "text-destructive" : "text-warning-foreground",
                )}
              />
            ) : null}
          </div>
          <div className="mt-0.5 truncate text-[0.6875rem] text-muted-foreground">
            {presentation.label} · {configKeyCount} setting{configKeyCount === 1 ? "" : "s"}
          </div>
        </div>
        <button
          aria-label={`Edit ${node.id}`}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onEdit}
          type="button"
        >
          <PencilIcon className="size-3.5" />
        </button>
        <button
          {...attributes}
          {...listeners}
          aria-label={`Move ${node.id}`}
          className="flex size-7 shrink-0 touch-none items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          disabled={readOnly}
          ref={setActivatorNodeRef}
          type="button"
        >
          <GripVerticalIcon className="size-4" />
        </button>
        <button
          aria-label={`Delete ${node.id}`}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-destructive/10 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          disabled={readOnly}
          onClick={onRemove}
          type="button"
        >
          <Trash2Icon className="size-3.5" />
        </button>
      </div>
      <span
        aria-hidden="true"
        className="absolute -left-1.5 top-1/2 size-3 -translate-y-1/2 rounded-full border-2 border-card bg-muted-foreground"
      />
      <span
        aria-hidden="true"
        className="absolute -right-1.5 top-1/2 size-3 -translate-y-1/2 rounded-full border-2 border-card bg-primary"
      />
    </article>
  );
}

interface AutomationEdgesProps {
  readonly definition: AutomationEditorDefinition;
  readonly positions: ReadonlyMap<string, AutomationEditorPosition>;
  readonly markerId: string;
}

function AutomationEdges({ definition, positions, markerId }: AutomationEdgesProps) {
  const seenEdgeKeys = new Set<string>();
  const visibleEdges = definition.edges.filter((edge) => {
    const key = `${edge.from}:${edge.to}`;
    if (seenEdgeKeys.has(key)) return false;
    seenEdgeKeys.add(key);
    return true;
  });

  return (
    <svg
      aria-label="Automation connections"
      className="pointer-events-none absolute inset-0 size-full overflow-visible"
      data-slot="automation-edges"
      role="img"
    >
      <defs>
        <marker
          id={markerId}
          markerHeight="8"
          markerWidth="8"
          orient="auto"
          refX="7"
          refY="4"
          viewBox="0 0 8 8"
        >
          <path className="fill-muted-foreground" d="M 0 0 L 8 4 L 0 8 z" />
        </marker>
      </defs>
      {visibleEdges.map((edge) => {
        const source = positions.get(edge.from);
        const target = positions.get(edge.to);
        if (!source || !target) return null;
        return (
          <path
            className="fill-none stroke-muted-foreground/60"
            d={automationEdgePath(source, target)}
            data-edge={`${edge.from}:${edge.to}`}
            key={`${edge.from}:${edge.to}`}
            markerEnd={`url(#${markerId})`}
            strokeWidth="2"
          >
            <title>{`${edge.from} to ${edge.to}`}</title>
          </path>
        );
      })}
    </svg>
  );
}

function ConfigEditor({
  node,
  readOnly,
  onChange,
}: {
  readonly node: AutomationEditorNode;
  readonly readOnly: boolean;
  readonly onChange: (config: AutomationEditorNode["config"]) => void;
}) {
  const serialized = useMemo(() => JSON.stringify(node.config, null, 2), [node.config]);
  const [draft, setDraft] = useState(serialized);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setDraft(serialized);
    setError(undefined);
  }, [node.id, serialized]);

  const apply = () => {
    try {
      const parsed: unknown = JSON.parse(draft);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        setError("Config must be a JSON object.");
        return;
      }
      onChange(parsed as AutomationEditorNode["config"]);
      setError(undefined);
    } catch {
      setError("Config must contain valid JSON before it can be saved.");
    }
  };

  return (
    <label className="block text-xs font-medium">
      Config JSON
      <Textarea
        aria-label={`Config for ${node.id}`}
        className="mt-1 font-mono text-xs"
        disabled={readOnly}
        onBlur={apply}
        onChange={(event) => setDraft(event.currentTarget.value)}
        rows={7}
        value={draft}
      />
      {error ? (
        <span className="mt-1 block text-destructive" role="alert">
          {error}
        </span>
      ) : null}
    </label>
  );
}

function AutomationInspector({
  definition,
  selectedNodeId,
  readOnly,
  onDefinitionChange,
  onSelectedNodeIdChange,
}: {
  readonly definition: AutomationEditorDefinition;
  readonly selectedNodeId: string | undefined;
  readonly readOnly: boolean;
  readonly onDefinitionChange: (definition: AutomationEditorDefinition) => void;
  readonly onSelectedNodeIdChange: (nodeId: string | undefined) => void;
}) {
  const selectedNode = definition.nodes.find((node) => node.id === selectedNodeId);
  const [sourceNodeId, setSourceNodeId] = useState("");
  const [targetNodeId, setTargetNodeId] = useState("");

  const renameNode = (nextNodeId: string) => {
    if (!selectedNode) return;
    const renamed = renameAutomationNode(definition, selectedNode.id, nextNodeId);
    if (renamed !== definition) {
      onDefinitionChange(renamed);
      onSelectedNodeIdChange(nextNodeId.trim());
    }
  };

  return (
    <aside
      aria-label="Automation authoring controls"
      className="w-full shrink-0 border-t bg-card p-4 @[80rem]/automation:w-80 @[80rem]/automation:border-l @[80rem]/automation:border-t-0"
      data-slot="automation-inspector"
    >
      <h3 className="text-sm font-semibold">Node editor</h3>
      {selectedNode ? (
        <div className="mt-3 space-y-3">
          <label className="block text-xs font-medium">
            Node ID
            <Input
              aria-label={`Node ID for ${selectedNode.id}`}
              className="mt-1"
              defaultValue={selectedNode.id}
              disabled={readOnly}
              key={selectedNode.id}
              nativeInput
              onBlur={(event) => renameNode(event.currentTarget.value)}
              size="sm"
            />
          </label>
          <label className="block text-xs font-medium">
            Node type
            <select
              aria-label={`Node type for ${selectedNode.id}`}
              className="mt-1 h-8 w-full rounded-lg border border-input bg-background px-2 text-xs"
              disabled={readOnly}
              onChange={(event) =>
                onDefinitionChange(
                  updateAutomationNode(definition, selectedNode.id, {
                    kind: event.currentTarget.value as AutomationEditorNodeKind,
                  }),
                )
              }
              value={selectedNode.kind}
            >
              {AUTOMATION_EDITOR_ADDABLE_NODE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {NODE_PRESENTATION[kind].label}
                </option>
              ))}
            </select>
          </label>
          <ConfigEditor
            node={selectedNode}
            onChange={(config) =>
              onDefinitionChange(updateAutomationNode(definition, selectedNode.id, { config }))
            }
            readOnly={readOnly}
          />
          <Button
            className="w-full"
            disabled={readOnly}
            onClick={() => {
              onDefinitionChange(removeAutomationNode(definition, selectedNode.id));
              onSelectedNodeIdChange(undefined);
            }}
            size="sm"
            variant="outline"
          >
            <Trash2Icon />
            Delete node
          </Button>
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          Select a node on the canvas to edit its ID, type, and config.
        </p>
      )}

      <div className="mt-5 border-t pt-4">
        <div className="flex items-center gap-2">
          <Link2Icon className="size-4 text-primary" />
          <h3 className="text-sm font-semibold">Connections</h3>
        </div>
        <div className="mt-3 grid grid-cols-[1fr_auto_1fr] items-center gap-1.5">
          <select
            aria-label="Connection source node"
            className="h-8 min-w-0 rounded-lg border border-input bg-background px-2 text-xs"
            disabled={readOnly}
            onChange={(event) => setSourceNodeId(event.currentTarget.value)}
            value={sourceNodeId}
          >
            <option value="">From</option>
            {definition.nodes.map((node) => (
              <option key={node.id} value={node.id}>
                {node.id}
              </option>
            ))}
          </select>
          <span aria-hidden="true" className="text-xs text-muted-foreground">
            →
          </span>
          <select
            aria-label="Connection target node"
            className="h-8 min-w-0 rounded-lg border border-input bg-background px-2 text-xs"
            disabled={readOnly}
            onChange={(event) => setTargetNodeId(event.currentTarget.value)}
            value={targetNodeId}
          >
            <option value="">To</option>
            {definition.nodes.map((node) => (
              <option key={node.id} value={node.id}>
                {node.id}
              </option>
            ))}
          </select>
        </div>
        <Button
          className="mt-2 w-full"
          disabled={readOnly || sourceNodeId.length === 0 || targetNodeId.length === 0}
          onClick={() =>
            onDefinitionChange(
              addAutomationEdge(definition, { from: sourceNodeId, to: targetNodeId }),
            )
          }
          size="sm"
          variant="outline"
        >
          <PlusIcon />
          Add connection
        </Button>
        {definition.edges.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">No connections yet.</p>
        ) : (
          <ul className="mt-2 space-y-1" aria-label="Existing automation connections">
            {definition.edges.map((edge) => (
              <li
                className="flex items-center gap-2 rounded-md border px-2 py-1 text-xs"
                key={`${edge.from}:${edge.to}`}
              >
                <span className="min-w-0 flex-1 truncate">
                  {edge.from} → {edge.to}
                </span>
                <Button
                  aria-label={`Remove connection ${edge.from} to ${edge.to}`}
                  disabled={readOnly}
                  onClick={() => onDefinitionChange(removeAutomationEdge(definition, edge))}
                  size="icon-xs"
                  variant="ghost"
                >
                  <Trash2Icon />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

function ValidationPanel({
  issues,
}: {
  readonly issues: ReadonlyArray<AutomationEditorValidationIssue>;
}) {
  const errors = issues.filter((issue) => (issue.severity ?? "error") === "error");

  return (
    <aside
      aria-label="Automation validation"
      className="w-full shrink-0 border-t bg-card p-4 @[80rem]/automation:w-72 @[80rem]/automation:border-l @[80rem]/automation:border-t-0"
      data-slot="automation-validation"
    >
      <div className="flex items-center gap-2">
        {errors.length > 0 ? (
          <AlertTriangleIcon className="size-4 text-destructive" />
        ) : (
          <CheckCircle2Icon className="size-4 text-success" />
        )}
        <h3 className="text-sm font-semibold">Validation</h3>
        <Badge className="ml-auto" variant={errors.length > 0 ? "error" : "success"}>
          {errors.length > 0 ? `${errors.length} blocking` : "Ready"}
        </Badge>
      </div>

      {issues.length === 0 ? (
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          The graph has valid nodes and connections. Saving still runs server-side validation.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {issues.map((issue) => (
            <li
              className={cn(
                "rounded-lg border px-3 py-2 text-xs leading-relaxed",
                (issue.severity ?? "error") === "error"
                  ? "border-destructive/30 bg-destructive/5 text-destructive-foreground"
                  : "border-warning/30 bg-warning/5 text-foreground",
              )}
              data-issue-code={issue.code}
              key={`${issue.code}:${issue.path?.join(".") ?? ""}:${issue.message}`}
            >
              <div className="font-medium">
                {(issue.severity ?? "error") === "error" ? "Fix required" : "Layout notice"}
              </div>
              <div className="mt-0.5 text-muted-foreground">{issue.message}</div>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

export function AutomationEditor({
  definition,
  onDefinitionChange,
  validationIssues = EMPTY_VALIDATION_ISSUES,
  readOnly = false,
  className,
}: AutomationEditorProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  );
  const markerId = `automation-arrow-${useId().replaceAll(":", "")}`;
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>(definition.nodes[0]?.id);
  const localIssues = useMemo(() => validateAutomationEditorDefinition(definition), [definition]);
  const issues = useMemo(
    () => mergeAutomationValidationIssues(localIssues, validationIssues),
    [localIssues, validationIssues],
  );
  const positions = useMemo(
    () =>
      new Map(
        definition.nodes.map((node, index) => [
          node.id,
          readAutomationNodePosition(definition, node.id, index),
        ]),
      ),
    [definition],
  );
  const canvasSize = useMemo(() => automationCanvasSize(definition), [definition]);
  const visibleNodes = useMemo(() => {
    const seenNodeIds = new Set<string>();
    return definition.nodes.filter((node) => {
      if (seenNodeIds.has(node.id)) return false;
      seenNodeIds.add(node.id);
      return true;
    });
  }, [definition.nodes]);
  const errorCount = issues.filter((issue) => (issue.severity ?? "error") === "error").length;

  const publishEdit = useCallback(
    (nextDefinition: AutomationEditorDefinition) => {
      onDefinitionChange(toSerializableAutomationDefinition(nextDefinition));
    },
    [onDefinitionChange],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (readOnly || (event.delta.x === 0 && event.delta.y === 0)) return;
      publishEdit(
        moveAutomationNode(definition, String(event.active.id), {
          x: event.delta.x,
          y: event.delta.y,
        }),
      );
    },
    [definition, publishEdit, readOnly],
  );

  const handleAddNode = useCallback(
    (kind: AutomationEditorNodeKind) => {
      if (!readOnly) {
        const next = addAutomationNode(definition, kind);
        publishEdit(next);
        setSelectedNodeId(next.nodes.at(-1)?.id);
      }
    },
    [definition, publishEdit, readOnly],
  );

  return (
    <section
      aria-label={`${definition.name} automation editor`}
      className={cn(
        "@container/automation flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border bg-background",
        className,
      )}
      data-slot="automation-editor"
    >
      <header className="shrink-0 border-b bg-card px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <CircleDotIcon className="size-4 text-primary" />
              <h2 className="truncate text-sm font-semibold">{definition.name}</h2>
              {!definition.enabled ? <Badge variant="secondary">Disabled</Badge> : null}
            </div>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {triggerLabel(definition)} · {definition.nodes.length} node
              {definition.nodes.length === 1 ? "" : "s"} · {definition.edges.length} connection
              {definition.edges.length === 1 ? "" : "s"}
            </p>
          </div>
          <Badge variant={errorCount > 0 ? "error" : "success"}>
            {errorCount > 0 ? `${errorCount} issue${errorCount === 1 ? "" : "s"}` : "Valid graph"}
          </Badge>
          {readOnly ? <Badge variant="outline">Read only</Badge> : null}
        </div>

        <div className="mt-3 grid gap-2 @[36rem]/automation:grid-cols-2 @[56rem]/automation:grid-cols-[minmax(10rem,1fr)_10rem_minmax(12rem,1fr)_auto]">
          <label className="text-xs font-medium">
            Name
            <Input
              aria-label="Automation name"
              className="mt-1"
              disabled={readOnly}
              nativeInput
              onChange={(event) => publishEdit({ ...definition, name: event.currentTarget.value })}
              size="sm"
              value={definition.name}
            />
          </label>
          <label className="text-xs font-medium">
            Trigger
            <select
              aria-label="Automation trigger type"
              className="mt-1 h-8 w-full rounded-lg border border-input bg-background px-2 text-xs"
              disabled={readOnly}
              onChange={(event) => {
                const kind = event.currentTarget.value;
                publishEdit({
                  ...definition,
                  trigger:
                    kind === "schedule"
                      ? { kind: "schedule", expression: "0 9 * * 1", timezone: "UTC" }
                      : kind === "webhook"
                        ? { kind: "webhook", route: `/hooks/${definition.id}` }
                        : { kind: "manual" },
                });
              }}
              value={definition.trigger.kind}
            >
              <option value="manual">Manual</option>
              <option value="schedule">Schedule</option>
              <option value="webhook">Webhook</option>
            </select>
          </label>
          {definition.trigger.kind === "schedule" ? (
            <div className="grid grid-cols-1 gap-2 @[32rem]/automation:grid-cols-2">
              <label className="text-xs font-medium">
                Expression
                <Input
                  aria-label="Schedule expression"
                  className="mt-1"
                  disabled={readOnly}
                  nativeInput
                  onChange={(event) =>
                    publishEdit({
                      ...definition,
                      trigger: {
                        kind: "schedule",
                        expression: event.currentTarget.value,
                        timezone:
                          definition.trigger.kind === "schedule"
                            ? definition.trigger.timezone
                            : "UTC",
                      },
                    })
                  }
                  size="sm"
                  value={definition.trigger.expression}
                />
              </label>
              <label className="text-xs font-medium">
                Timezone
                <Input
                  aria-label="Schedule timezone"
                  className="mt-1"
                  disabled={readOnly}
                  nativeInput
                  onChange={(event) =>
                    publishEdit({
                      ...definition,
                      trigger: {
                        kind: "schedule",
                        expression:
                          definition.trigger.kind === "schedule"
                            ? definition.trigger.expression
                            : "0 9 * * 1",
                        timezone: event.currentTarget.value,
                      },
                    })
                  }
                  size="sm"
                  value={definition.trigger.timezone}
                />
              </label>
            </div>
          ) : definition.trigger.kind === "webhook" ? (
            <label className="text-xs font-medium">
              Local route
              <Input
                aria-label="Webhook route"
                className="mt-1"
                disabled={readOnly}
                nativeInput
                onChange={(event) =>
                  publishEdit({
                    ...definition,
                    trigger: { kind: "webhook", route: event.currentTarget.value },
                  })
                }
                size="sm"
                value={definition.trigger.route}
              />
            </label>
          ) : (
            <p className="self-end pb-2 text-xs text-muted-foreground">
              Started manually or by a scoped agent.
            </p>
          )}
          <label className="flex items-end gap-2 pb-2 text-xs font-medium">
            <input
              checked={definition.enabled}
              disabled={readOnly}
              onChange={(event) =>
                publishEdit({ ...definition, enabled: event.currentTarget.checked })
              }
              type="checkbox"
            />
            Enabled
          </label>
        </div>

        <div aria-label="Add automation node" className="mt-3 flex gap-1.5 overflow-x-auto pb-1">
          {AUTOMATION_EDITOR_ADDABLE_NODE_KINDS.map((kind) => {
            const presentation = NODE_PRESENTATION[kind];
            const Icon = presentation.icon;
            return (
              <Button
                aria-label={`Add ${presentation.label} node`}
                className="shrink-0"
                disabled={readOnly}
                key={kind}
                onClick={() => handleAddNode(kind)}
                size="xs"
                title={presentation.description}
                variant="outline"
              >
                <PlusIcon />
                <Icon />
                {presentation.label}
              </Button>
            );
          })}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto @[80rem]/automation:flex-row @[80rem]/automation:overflow-hidden">
        <div className="min-h-[28rem] min-w-0 shrink-0 overflow-auto bg-muted/20 @[80rem]/automation:min-h-0 @[80rem]/automation:flex-1">
          <DndContext modifiers={CANVAS_DND_MODIFIERS} onDragEnd={handleDragEnd} sensors={sensors}>
            <div
              aria-label="Automation canvas"
              className="relative bg-[radial-gradient(circle_at_center,var(--color-border)_1px,transparent_1px)] bg-[length:20px_20px]"
              data-slot="automation-canvas"
              role="application"
              style={{ height: canvasSize.height, width: canvasSize.width }}
            >
              <AutomationEdges definition={definition} markerId={markerId} positions={positions} />
              {visibleNodes.map((node) => (
                <AutomationNodeCard
                  issues={issues}
                  key={node.id}
                  node={node}
                  onEdit={() => setSelectedNodeId(node.id)}
                  onRemove={() => {
                    publishEdit(removeAutomationNode(definition, node.id));
                    if (selectedNodeId === node.id) setSelectedNodeId(undefined);
                  }}
                  position={readAutomationNodePosition(definition, node.id)}
                  readOnly={readOnly}
                />
              ))}
            </div>
          </DndContext>
        </div>
        <AutomationInspector
          definition={definition}
          onDefinitionChange={publishEdit}
          onSelectedNodeIdChange={setSelectedNodeId}
          readOnly={readOnly}
          selectedNodeId={selectedNodeId}
        />
        <ValidationPanel issues={issues} />
      </div>
    </section>
  );
}
