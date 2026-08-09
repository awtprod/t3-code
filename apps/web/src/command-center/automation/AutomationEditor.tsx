"use client";

import type { Connection, Space } from "@command-center/core";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection as FlowConnection,
  type Edge,
  type Node,
  type NodeProps,
  type OnConnectEnd,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  automationSchedulePresetExpression,
  describeAutomationSchedule,
  nextAutomationScheduleOccurrences,
  type AutomationSchedulePreset,
} from "@t3tools/shared/automationSchedule";
import {
  AlertTriangleIcon,
  BotIcon,
  BracesIcon,
  CableIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleDotIcon,
  Clock3Icon,
  Maximize2Icon,
  GitBranchIcon,
  ExternalLinkIcon,
  ListTodoIcon,
  LoaderCircleIcon,
  MailIcon,
  PencilIcon,
  PlusIcon,
  Repeat2Icon,
  SearchIcon,
  ShieldCheckIcon,
  SparklesIcon,
  TerminalIcon,
  Trash2Icon,
  UploadIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";

import {
  AUTOMATION_NODE_HEIGHT,
  AUTOMATION_NODE_WIDTH,
  addAutomationEdge,
  addAutomationNode,
  automationEdgeProblem,
  mergeAutomationValidationIssues,
  readAutomationNodePosition,
  reconcileAutomationNodePosition,
  removeAutomationEdge,
  removeAutomationNode,
  renameAutomationNode,
  setAutomationNodePosition,
  toSerializableAutomationDefinition,
  updateAutomationNode,
  validateAutomationEditorDefinition,
} from "./logic";
import {
  AUTOMATION_EDITOR_ADDABLE_NODE_KINDS,
  type AutomationEditorDefinition,
  type AutomationEditorEdge,
  type AutomationEditorJson,
  type AutomationEditorNode,
  type AutomationEditorNodeKind,
  type AutomationEditorPosition,
  type AutomationEditorProps,
  type AutomationEditorValidationIssue,
} from "./types";

interface NodePresentation {
  readonly label: string;
  readonly description: string;
  readonly category: "Actions" | "Data" | "Flow";
  readonly icon: LucideIcon;
  readonly accentClassName: string;
}

const NODE_PRESENTATION: Record<AutomationEditorNodeKind, NodePresentation> = {
  "agent.run": {
    label: "Agent",
    description: "Ask an agent to complete scoped work",
    category: "Actions",
    icon: BotIcon,
    accentClassName: "bg-primary/10 text-primary",
  },
  "connector.read": {
    label: "Read from app",
    description: "Read Gmail, Calendar, or Drive data",
    category: "Data",
    icon: CableIcon,
    accentClassName: "bg-info/10 text-info-foreground",
  },
  "connector.write": {
    label: "Create draft",
    description: "Create an approval-gated Gmail draft",
    category: "Actions",
    icon: CableIcon,
    accentClassName: "bg-warning/10 text-warning-foreground",
  },
  "item.mutate": {
    label: "Create item",
    description: "Capture a task, idea, decision, or alert",
    category: "Actions",
    icon: ListTodoIcon,
    accentClassName: "bg-success/10 text-success-foreground",
  },
  condition: {
    label: "Condition",
    description: "Continue based on incoming data",
    category: "Flow",
    icon: GitBranchIcon,
    accentClassName: "bg-warning/10 text-warning-foreground",
  },
  transform: {
    label: "Transform",
    description: "Reshape data from previous steps",
    category: "Data",
    icon: BracesIcon,
    accentClassName: "bg-secondary text-secondary-foreground",
  },
  foreach: {
    label: "For each",
    description: "Repeat a transform for every item",
    category: "Flow",
    icon: Repeat2Icon,
    accentClassName: "bg-secondary text-secondary-foreground",
  },
  delay: {
    label: "Wait",
    description: "Pause before continuing",
    category: "Flow",
    icon: Clock3Icon,
    accentClassName: "bg-secondary text-secondary-foreground",
  },
  approval: {
    label: "Approval",
    description: "Pause for a human decision",
    category: "Flow",
    icon: ShieldCheckIcon,
    accentClassName: "bg-warning/10 text-warning-foreground",
  },
  "shell.scoped": {
    label: "Scoped command",
    description: "Run an owner-approved local command",
    category: "Actions",
    icon: TerminalIcon,
    accentClassName: "bg-destructive/8 text-destructive-foreground",
  },
};

const EMPTY_ISSUES: ReadonlyArray<AutomationEditorValidationIssue> = [];
const EMPTY_CONNECTIONS: ReadonlyArray<Connection> = [];

function humanizeId(value: string): string {
  const words = value.replaceAll(/[-_]+/gu, " ").trim();
  return words.length === 0 ? "Untitled step" : words[0]!.toUpperCase() + words.slice(1);
}

function slugifyId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 128);
}

function stringValue(value: AutomationEditorJson | undefined): string {
  return typeof value === "string" ? value : "";
}

function nodeSummary(node: AutomationEditorNode): string {
  const config = node.config;
  switch (node.kind) {
    case "agent.run":
      return stringValue(config.prompt) || "Prompt needs setup";
    case "connector.read":
      return stringValue(config.operation).replaceAll(".", " ") || "Choose what to read";
    case "connector.write":
      return stringValue(config.subject) || "Gmail draft needs setup";
    case "item.mutate":
      return stringValue(config.title) || "Item details need setup";
    case "condition":
      return `${stringValue(config.leftPath) || "Incoming value"} · ${stringValue(config.operator) || "truthy"}`;
    case "transform":
      return stringValue(config.template) || "Configure the output template";
    case "foreach":
      return `Items from ${stringValue(config.sourcePath) || stringValue(config.itemsPath) || "incoming data"}`;
    case "delay": {
      if (typeof config.until === "string") return `Wait until ${config.until}`;
      if (typeof config.durationMs === "number")
        return `Wait ${Math.max(0, Math.round(config.durationMs / 60_000))} minutes`;
      return "Choose how long to wait";
    }
    case "approval":
      return `Decision: ${stringValue(config.approvalKey) || "decision"}`;
    case "shell.scoped":
      return stringValue(config.allowlistId) || "Choose an approved command";
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

interface AutomationFlowNodeData extends Record<string, unknown> {
  readonly node: AutomationEditorNode;
  readonly issues: ReadonlyArray<AutomationEditorValidationIssue>;
  readonly readOnly: boolean;
  readonly onEdit: (nodeId: string) => void;
  readonly onRemove: (nodeId: string) => void;
}

type AutomationFlowNode = Node<AutomationFlowNodeData, "automation-step">;
type AutomationFlowEdge = Edge;

const AutomationNodeCard = memo(function AutomationNodeCard({
  data,
  selected,
}: NodeProps<AutomationFlowNode>) {
  const { node, issues, readOnly, onEdit, onRemove } = data;
  const presentation = NODE_PRESENTATION[node.kind];
  const Icon = presentation.icon;
  const severity = nodeIssueSeverity(node.id, issues);
  return (
    <article
      aria-label={`${presentation.label} step ${humanizeId(node.id)}`}
      className={cn(
        "group relative flex h-full w-full flex-col rounded-2xl border bg-card px-4 py-3 text-card-foreground shadow-sm transition-[border-color,box-shadow]",
        selected && "border-primary shadow-md ring-2 ring-primary/15",
        severity === "error" && "border-destructive/60",
        severity === "warning" && "border-warning/60",
      )}
      data-kind={node.kind}
      data-node-id={node.id}
      data-slot="automation-node"
    >
      <Handle
        className="!size-4 !border-[3px] !border-card !bg-muted-foreground transition-transform hover:!scale-125"
        isConnectable={!readOnly}
        position={Position.Left}
        type="target"
      />
      <div className="flex min-w-0 items-start gap-3">
        <span
          aria-hidden="true"
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-xl",
            presentation.accentClassName,
          )}
        >
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <h3 className="line-clamp-2 flex-1 text-sm font-semibold leading-5">
              {humanizeId(node.id)}
            </h3>
            {severity ? (
              <AlertTriangleIcon
                aria-label={`${severity} on ${node.id}`}
                className={cn(
                  "mt-0.5 size-4 shrink-0",
                  severity === "error" ? "text-destructive" : "text-warning-foreground",
                )}
              />
            ) : null}
          </div>
          <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
            {presentation.label}
          </p>
        </div>
      </div>
      <p className="mt-2 line-clamp-2 text-xs leading-4 text-muted-foreground">
        {nodeSummary(node)}
      </p>
      <div
        className={cn(
          "nodrag nopan absolute -top-3 right-3 flex items-center gap-0.5 rounded-lg border bg-card p-0.5 shadow-sm transition-opacity",
          selected
            ? "opacity-100"
            : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
        )}
      >
        <button
          aria-label={`Edit ${node.id}`}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => onEdit(node.id)}
          type="button"
        >
          <PencilIcon className="size-3.5" />
        </button>
        <button
          aria-label={`Delete ${node.id}`}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:pointer-events-none disabled:opacity-40"
          disabled={readOnly}
          onClick={() => onRemove(node.id)}
          type="button"
        >
          <Trash2Icon className="size-3.5" />
        </button>
      </div>
      <Handle
        className="!size-4 !border-[3px] !border-card !bg-primary transition-transform hover:!scale-125"
        isConnectable={!readOnly}
        position={Position.Right}
        type="source"
      />
    </article>
  );
});

const NODE_TYPES = { "automation-step": AutomationNodeCard };

function edgeId(edge: AutomationEditorEdge): string {
  return `automation-edge:${encodeURIComponent(edge.from)}:${encodeURIComponent(edge.to)}`;
}

function automationFlowEdge(
  edge: AutomationEditorEdge,
  readOnly: boolean,
  selectedEdgeId: string | undefined,
): AutomationFlowEdge {
  const id = edgeId(edge);
  return {
    id,
    source: edge.from,
    target: edge.to,
    type: "smoothstep",
    selected: id === selectedEdgeId,
    reconnectable: !readOnly,
    style: { strokeWidth: 2 },
  };
}

function selectClassName(): string {
  return "mt-1 h-9 w-full rounded-lg border border-input bg-background px-2 text-sm";
}

function Field({
  label,
  children,
  help,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly help?: string | undefined;
}) {
  return (
    <label className="block text-xs font-medium">
      {label}
      {children}
      {help ? (
        <span className="mt-1 block font-normal leading-relaxed text-muted-foreground">{help}</span>
      ) : null}
    </label>
  );
}

function ConfigJsonEditor({
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
        setError("Configuration must be a JSON object.");
        return;
      }
      onChange(parsed as AutomationEditorNode["config"]);
      setError(undefined);
    } catch {
      setError("Fix the JSON before applying advanced configuration.");
    }
  };
  return (
    <details className="rounded-xl border bg-muted/20 p-3">
      <summary className="cursor-pointer text-xs font-medium">Advanced configuration</summary>
      <Textarea
        aria-label={`Advanced configuration for ${node.id}`}
        className="mt-3 font-mono text-xs"
        disabled={readOnly}
        onBlur={apply}
        onChange={(event) => setDraft(event.currentTarget.value)}
        rows={10}
        value={draft}
      />
      {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
      <p className="mt-2 text-[0.6875rem] leading-relaxed text-muted-foreground">
        Use this only for settings that do not have a guided field. Unknown keys are preserved.
      </p>
    </details>
  );
}

const CONNECTOR_KEYS = [
  "operation",
  "query",
  "limit",
  "messageId",
  "threadId",
  "calendarId",
  "calendarIds",
  "from",
  "to",
  "parentId",
  "fileId",
  "cc",
  "bcc",
  "subject",
  "body",
  "bodyHtml",
  "replyToMessageId",
  "attachmentArtifactIds",
] as const;

function patchConfig(
  config: AutomationEditorNode["config"],
  patch: Readonly<Record<string, AutomationEditorJson | undefined>>,
  removeKeys: ReadonlyArray<string> = [],
): AutomationEditorNode["config"] {
  const next: Record<string, AutomationEditorJson> = { ...config };
  for (const key of removeKeys) delete next[key];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === "") delete next[key];
    else next[key] = value;
  }
  return next;
}

function StringInput({
  label,
  value,
  onChange,
  readOnly,
  placeholder,
  help,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly readOnly: boolean;
  readonly placeholder?: string | undefined;
  readonly help?: string | undefined;
}) {
  return (
    <Field help={help} label={label}>
      <Input
        aria-label={label}
        className="mt-1"
        disabled={readOnly}
        nativeInput
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={placeholder}
        size="sm"
        value={value}
      />
    </Field>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  readOnly,
  placeholder,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly readOnly: boolean;
  readonly placeholder?: string;
}) {
  return (
    <Field label={label}>
      <Textarea
        className="mt-1 text-sm"
        disabled={readOnly}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={placeholder}
        rows={5}
        value={value}
      />
    </Field>
  );
}

function ConnectionSelect({
  config,
  connections,
  label = "Email account",
  readOnly,
  onConfigChange,
  onRemoveConnection,
  onRequestSetup,
}: {
  readonly config: AutomationEditorNode["config"];
  readonly connections: ReadonlyArray<Connection>;
  readonly label?: string;
  readonly readOnly: boolean;
  readonly onConfigChange: (config: AutomationEditorNode["config"]) => void;
  readonly onRemoveConnection?: ((connectionId: Connection["id"]) => Promise<void>) | undefined;
  readonly onRequestSetup?: (() => void) | undefined;
}) {
  const value = stringValue(config.connectionId);
  const googleConnections = connections.filter((connection) => connection.kind === "google");
  const selectedConnection = googleConnections.find((connection) => connection.id === value);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string>();
  const remove = async () => {
    if (!selectedConnection || !onRemoveConnection) return;
    if (!window.confirm(`Remove ${selectedConnection.label} from this Space?`)) return;
    setRemoving(true);
    setRemoveError(undefined);
    try {
      await onRemoveConnection(selectedConnection.id);
      onConfigChange(patchConfig(config, { connectionId: "" }));
    } catch (cause) {
      setRemoveError(cause instanceof Error ? cause.message : "The account could not be removed.");
    } finally {
      setRemoving(false);
    }
  };
  return (
    <Field label={label}>
      <div className="mt-1 space-y-2">
        <select
          className={selectClassName()}
          disabled={readOnly}
          onChange={(event) =>
            onConfigChange(patchConfig(config, { connectionId: event.currentTarget.value }))
          }
          value={value}
        >
          <option value="">
            {googleConnections.length === 0 ? "No Google account connected" : "Choose an account"}
          </option>
          {value && !googleConnections.some((connection) => connection.id === value) ? (
            <option value={value}>{value}</option>
          ) : null}
          {googleConnections.map((connection) => (
            <option key={connection.id} value={connection.id}>
              {connection.label}
              {connection.health === "connected" ? "" : ` · ${connection.health}`}
            </option>
          ))}
        </select>
        {!readOnly && onRequestSetup ? (
          <Button className="w-full" onClick={onRequestSetup} size="sm" variant="outline">
            <MailIcon />
            Connect Gmail account
          </Button>
        ) : null}
        {!readOnly && selectedConnection && onRemoveConnection ? (
          <Button
            className="w-full"
            disabled={removing}
            onClick={() => void remove()}
            size="sm"
            variant="ghost"
          >
            {removing ? (
              <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
            ) : (
              <Trash2Icon />
            )}
            {removing ? "Removing account" : "Remove account from Space"}
          </Button>
        ) : null}
        {removeError ? (
          <p className="text-xs text-destructive" role="alert">
            {removeError}
          </p>
        ) : null}
        {googleConnections.length === 0 ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Connect the Google account this step should use. It will be available only in this Space
            on the selected environment.
          </p>
        ) : null}
      </div>
    </Field>
  );
}

function ConnectorReadFields({
  node,
  connections,
  readOnly,
  onChange,
  onRemoveGoogleConnection,
  onRequestGoogleSetup,
}: GuidedFieldsProps & {
  readonly connections: ReadonlyArray<Connection>;
  readonly onRemoveGoogleConnection?:
    | ((connectionId: Connection["id"]) => Promise<void>)
    | undefined;
  readonly onRequestGoogleSetup?: (() => void) | undefined;
}) {
  const config = node.config;
  const operation = stringValue(config.operation) || "gmail.search";
  const set = (patch: Readonly<Record<string, AutomationEditorJson | undefined>>) =>
    onChange(patchConfig(config, patch));
  const changeOperation = (nextOperation: string) =>
    onChange(patchConfig(config, { operation: nextOperation }, CONNECTOR_KEYS));
  return (
    <>
      <ConnectionSelect
        config={config}
        connections={connections}
        label={operation.startsWith("gmail.") ? "Email account" : "Google connection"}
        onConfigChange={onChange}
        onRemoveConnection={onRemoveGoogleConnection}
        onRequestSetup={operation.startsWith("gmail.") ? onRequestGoogleSetup : undefined}
        readOnly={readOnly}
      />
      <Field label="Read">
        <select
          className={selectClassName()}
          disabled={readOnly}
          onChange={(event) => changeOperation(event.currentTarget.value)}
          value={operation}
        >
          <option value="gmail.search">Search Gmail</option>
          <option value="gmail.get">Get Gmail message</option>
          <option value="gmail.thread.get">Get Gmail thread</option>
          <option value="calendar.events">List calendar events</option>
          <option value="calendar.freebusy">Check calendar availability</option>
          <option value="drive.search">Search Drive</option>
          <option value="drive.list">List Drive folder</option>
          <option value="drive.get">Get Drive file</option>
        </select>
      </Field>
      {operation === "gmail.search" || operation === "drive.search" ? (
        <StringInput
          label="Search query"
          onChange={(value) => set({ query: value })}
          placeholder={
            operation === "gmail.search" ? "is:unread newer_than:7d" : "quarterly report"
          }
          readOnly={readOnly}
          value={stringValue(config.query)}
        />
      ) : null}
      {operation === "gmail.get" ? (
        <StringInput
          label="Message ID"
          onChange={(value) => set({ messageId: value })}
          readOnly={readOnly}
          value={stringValue(config.messageId)}
        />
      ) : null}
      {operation === "gmail.thread.get" ? (
        <StringInput
          label="Thread ID"
          onChange={(value) => set({ threadId: value })}
          readOnly={readOnly}
          value={stringValue(config.threadId)}
        />
      ) : null}
      {operation === "drive.get" ? (
        <StringInput
          label="File ID"
          onChange={(value) => set({ fileId: value })}
          readOnly={readOnly}
          value={stringValue(config.fileId)}
        />
      ) : null}
      {operation === "drive.list" ? (
        <StringInput
          help="Leave blank for the root folder."
          label="Parent folder ID"
          onChange={(value) => set({ parentId: value })}
          readOnly={readOnly}
          value={stringValue(config.parentId)}
        />
      ) : null}
      {operation === "calendar.events" || operation === "calendar.freebusy" ? (
        <>
          <StringInput
            label="From"
            onChange={(value) => set({ from: value })}
            placeholder="{{run.from}} or ISO timestamp"
            readOnly={readOnly}
            value={stringValue(config.from)}
          />
          <StringInput
            label="To"
            onChange={(value) => set({ to: value })}
            placeholder="{{run.to}} or ISO timestamp"
            readOnly={readOnly}
            value={stringValue(config.to)}
          />
          {operation === "calendar.events" ? (
            <StringInput
              help="Leave blank to use the primary calendar."
              label="Calendar ID"
              onChange={(value) => set({ calendarId: value })}
              readOnly={readOnly}
              value={stringValue(config.calendarId)}
            />
          ) : (
            <StringInput
              label="Calendar IDs"
              onChange={(value) =>
                set({
                  calendarIds: value
                    .split(",")
                    .map((part) => part.trim())
                    .filter(Boolean),
                })
              }
              placeholder="primary, teammate@example.com"
              readOnly={readOnly}
              value={Array.isArray(config.calendarIds) ? config.calendarIds.join(", ") : ""}
            />
          )}
        </>
      ) : null}
      {["gmail.search", "calendar.events", "drive.search", "drive.list"].includes(operation) ? (
        <StringInput
          label="Maximum results"
          onChange={(value) => set({ limit: value ? Number(value) : undefined })}
          placeholder="25"
          readOnly={readOnly}
          value={typeof config.limit === "number" ? String(config.limit) : ""}
        />
      ) : null}
    </>
  );
}

function ConnectorWriteFields({
  node,
  connections,
  readOnly,
  onChange,
  onRemoveGoogleConnection,
  onRequestGoogleSetup,
}: GuidedFieldsProps & {
  readonly connections: ReadonlyArray<Connection>;
  readonly onRemoveGoogleConnection?:
    | ((connectionId: Connection["id"]) => Promise<void>)
    | undefined;
  readonly onRequestGoogleSetup?: (() => void) | undefined;
}) {
  const config = node.config;
  const set = (patch: Readonly<Record<string, AutomationEditorJson | undefined>>) =>
    onChange(patchConfig(config, { operation: "gmail.draft.create", ...patch }));
  const list = (key: string) =>
    Array.isArray(config[key])
      ? config[key].filter((value): value is string => typeof value === "string").join(", ")
      : "";
  return (
    <>
      <ConnectionSelect
        config={config}
        connections={connections}
        onConfigChange={onChange}
        onRemoveConnection={onRemoveGoogleConnection}
        onRequestSetup={onRequestGoogleSetup}
        readOnly={readOnly}
      />
      <StringInput
        label="To"
        onChange={(value) =>
          set({
            to: value
              .split(",")
              .map((part) => part.trim())
              .filter(Boolean),
          })
        }
        placeholder="person@example.com"
        readOnly={readOnly}
        value={list("to")}
      />
      <StringInput
        label="Cc"
        onChange={(value) =>
          set({
            cc: value
              .split(",")
              .map((part) => part.trim())
              .filter(Boolean),
          })
        }
        readOnly={readOnly}
        value={list("cc")}
      />
      <StringInput
        label="Subject"
        onChange={(value) => set({ subject: value })}
        readOnly={readOnly}
        value={stringValue(config.subject)}
      />
      <TextAreaField
        label="Draft body"
        onChange={(value) => set({ body: value })}
        placeholder="Use {{predecessors.step.field}} to insert prior output"
        readOnly={readOnly}
        value={stringValue(config.body)}
      />
      <StringInput
        help="Optional: create the draft as a reply."
        label="Reply to message ID"
        onChange={(value) => set({ replyToMessageId: value })}
        readOnly={readOnly}
        value={stringValue(config.replyToMessageId)}
      />
    </>
  );
}

interface GuidedFieldsProps {
  readonly node: AutomationEditorNode;
  readonly readOnly: boolean;
  readonly onChange: (config: AutomationEditorNode["config"]) => void;
}

function GuidedNodeFields({
  node,
  selectedSpace,
  connections,
  readOnly,
  onChange,
  onRemoveGoogleConnection,
  onRequestGoogleSetup,
}: GuidedFieldsProps & {
  readonly selectedSpace?: Space | undefined;
  readonly connections: ReadonlyArray<Connection>;
  readonly onRemoveGoogleConnection?:
    | ((connectionId: Connection["id"]) => Promise<void>)
    | undefined;
  readonly onRequestGoogleSetup?: (() => void) | undefined;
}) {
  const config = node.config;
  const set = (
    patch: Readonly<Record<string, AutomationEditorJson | undefined>>,
    remove: ReadonlyArray<string> = [],
  ) => onChange(patchConfig(config, patch, remove));
  switch (node.kind) {
    case "agent.run":
      return (
        <>
          <TextAreaField
            label="What should the agent do?"
            onChange={(value) => set({ prompt: value })}
            placeholder="Research the incoming item and summarize the result…"
            readOnly={readOnly}
            value={stringValue(config.prompt)}
          />
          <Field help="Leave blank to use the Space default." label="Repository">
            <select
              className={selectClassName()}
              disabled={readOnly}
              onChange={(event) =>
                set({ repositoryId: event.currentTarget.value, projectId: undefined })
              }
              value={stringValue(config.repositoryId)}
            >
              <option value="">Space default</option>
              {stringValue(config.repositoryId) &&
              !selectedSpace?.repositories.some(
                (repository) => repository.id === config.repositoryId,
              ) ? (
                <option value={stringValue(config.repositoryId)}>
                  {stringValue(config.repositoryId)}
                </option>
              ) : null}
              {selectedSpace?.repositories.map((repository) => (
                <option key={repository.id} value={repository.id}>
                  {repository.displayName}
                </option>
              ))}
            </select>
          </Field>
          <StringInput
            help="Optional explicit project binding."
            label="Project ID"
            onChange={(value) => set({ projectId: value })}
            readOnly={readOnly}
            value={stringValue(config.projectId)}
          />
          <StringInput
            help="Optional; otherwise normal routing applies."
            label="Provider ID"
            onChange={(value) => set({ providerId: value })}
            readOnly={readOnly}
            value={stringValue(config.providerId)}
          />
          <StringInput
            label="Model ID"
            onChange={(value) => set({ modelId: value })}
            readOnly={readOnly}
            value={stringValue(config.modelId)}
          />
        </>
      );
    case "connector.read":
      return (
        <ConnectorReadFields
          connections={connections}
          node={node}
          onChange={onChange}
          onRemoveGoogleConnection={onRemoveGoogleConnection}
          onRequestGoogleSetup={onRequestGoogleSetup}
          readOnly={readOnly}
        />
      );
    case "connector.write":
      return (
        <ConnectorWriteFields
          connections={connections}
          node={node}
          onChange={onChange}
          onRemoveGoogleConnection={onRemoveGoogleConnection}
          onRequestGoogleSetup={onRequestGoogleSetup}
          readOnly={readOnly}
        />
      );
    case "item.mutate":
      return (
        <>
          <StringInput
            label="Title"
            onChange={(value) => set({ title: value })}
            placeholder="Follow up on {{predecessors.research.title}}"
            readOnly={readOnly}
            value={stringValue(config.title)}
          />
          <TextAreaField
            label="Description"
            onChange={(value) => set({ description: value })}
            readOnly={readOnly}
            value={stringValue(config.description)}
          />
          <Field label="Item type">
            <select
              className={selectClassName()}
              disabled={readOnly}
              onChange={(event) => set({ kind: event.currentTarget.value })}
              value={stringValue(config.kind) || "task"}
            >
              {["task", "idea", "decision", "alert", "approval"].map((value) => (
                <option key={value} value={value}>
                  {humanizeId(value)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Priority">
            <select
              className={selectClassName()}
              disabled={readOnly}
              onChange={(event) => set({ priority: event.currentTarget.value })}
              value={stringValue(config.priority) || "normal"}
            >
              {["low", "normal", "high", "urgent"].map((value) => (
                <option key={value} value={value}>
                  {humanizeId(value)}
                </option>
              ))}
            </select>
          </Field>
          <StringInput
            help="ISO timestamp or template value."
            label="Due date"
            onChange={(value) => set({ dueAt: value })}
            readOnly={readOnly}
            value={stringValue(config.dueAt)}
          />
        </>
      );
    case "condition":
      return (
        <>
          <StringInput
            help="For example: predecessors.research.count"
            label="Value path"
            onChange={(value) => set({ leftPath: value }, ["left", "value", "valuePath"])}
            readOnly={readOnly}
            value={stringValue(config.leftPath) || stringValue(config.valuePath)}
          />
          <Field label="Condition">
            <select
              className={selectClassName()}
              disabled={readOnly}
              onChange={(event) => set({ operator: event.currentTarget.value })}
              value={stringValue(config.operator) || "truthy"}
            >
              {[
                ["truthy", "Is true"],
                ["falsy", "Is false"],
                ["equals", "Equals"],
                ["notEquals", "Does not equal"],
                ["contains", "Contains"],
                ["greaterThan", "Is greater than"],
                ["lessThan", "Is less than"],
              ].map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          {!["truthy", "falsy"].includes(stringValue(config.operator) || "truthy") ? (
            <StringInput
              label="Compare with"
              onChange={(value) => set({ right: value }, ["expected"])}
              readOnly={readOnly}
              value={typeof config.right === "string" ? config.right : ""}
            />
          ) : null}
          <label className="flex items-start gap-2 text-xs">
            <input
              checked={config.require === true}
              disabled={readOnly}
              onChange={(event) => set({ require: event.currentTarget.checked })}
              type="checkbox"
            />
            <span>
              <span className="font-medium">Stop the run when this does not match</span>
              <span className="mt-0.5 block text-muted-foreground">
                Otherwise the step emits a matched value for later steps.
              </span>
            </span>
          </label>
        </>
      );
    case "transform":
      return (
        <TextAreaField
          label="Output template"
          onChange={(value) => set({ template: value }, ["output", "value"])}
          placeholder="Use {{predecessors.step.field}} to insert data"
          readOnly={readOnly}
          value={stringValue(config.template) || stringValue(config.output)}
        />
      );
    case "foreach":
      return (
        <>
          <StringInput
            label="Array path"
            onChange={(value) => set({ sourcePath: value }, ["source", "items", "itemsPath"])}
            placeholder="predecessors.search.items"
            readOnly={readOnly}
            value={stringValue(config.sourcePath) || stringValue(config.itemsPath)}
          />
          <TextAreaField
            label="Output template for each item"
            onChange={(value) => set({ template: value })}
            placeholder="{{item}}"
            readOnly={readOnly}
            value={stringValue(config.template)}
          />
        </>
      );
    case "delay": {
      const untilMode = typeof config.until === "string";
      return (
        <>
          <Field label="Wait mode">
            <select
              className={selectClassName()}
              disabled={readOnly}
              onChange={(event) =>
                event.currentTarget.value === "until"
                  ? set({ until: new Date(Date.now() + 3_600_000).toISOString() }, ["durationMs"])
                  : set({ durationMs: 300_000 }, ["until"])
              }
              value={untilMode ? "until" : "duration"}
            >
              <option value="duration">For a duration</option>
              <option value="until">Until a date and time</option>
            </select>
          </Field>
          {untilMode ? (
            <StringInput
              label="Resume at"
              onChange={(value) => set({ until: value })}
              placeholder="2026-08-10T15:00:00Z"
              readOnly={readOnly}
              value={stringValue(config.until)}
            />
          ) : (
            <StringInput
              label="Minutes"
              onChange={(value) => set({ durationMs: value ? Number(value) * 60_000 : undefined })}
              readOnly={readOnly}
              value={
                typeof config.durationMs === "number" ? String(config.durationMs / 60_000) : ""
              }
            />
          )}
        </>
      );
    }
    case "approval":
      return (
        <StringInput
          help="Used to identify the decision when the run resumes."
          label="Decision key"
          onChange={(value) => set({ approvalKey: value })}
          readOnly={readOnly}
          value={stringValue(config.approvalKey) || "decision"}
        />
      );
    case "shell.scoped":
      return (
        <StringInput
          help="This must match an owner-configured scoped-shell allowlist entry. Executables and arguments cannot be authored here."
          label="Approved command ID"
          onChange={(value) => set({ allowlistId: value })}
          readOnly={readOnly}
          value={stringValue(config.allowlistId)}
        />
      );
  }
}

type GoogleSetupCapability = "gmail.read" | "gmail.drafts.create";

function googleSetupErrorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message;
  if (typeof cause === "string" && cause.trim().length > 0) return cause;
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string" &&
    cause.message.trim().length > 0
  ) {
    return cause.message;
  }
  return fallback;
}

function GoogleConnectionSetupDialog({
  capabilities,
  onBegin,
  onComplete,
  onConnected,
  onClose,
}: {
  readonly capabilities: ReadonlyArray<GoogleSetupCapability>;
  readonly onBegin: NonNullable<AutomationEditorProps["onBeginGoogleConnectionSetup"]>;
  readonly onComplete: NonNullable<AutomationEditorProps["onCompleteGoogleConnectionSetup"]>;
  readonly onConnected: (connectionId: string) => void;
  readonly onClose: () => void;
}) {
  const [email, setEmail] = useState("");
  const [oauthClientJson, setOauthClientJson] = useState<string>();
  const [oauthClientName, setOauthClientName] = useState<string>();
  const [session, setSession] =
    useState<
      Awaited<ReturnType<NonNullable<AutomationEditorProps["onBeginGoogleConnectionSetup"]>>>
    >();
  const [redirectUrl, setRedirectUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();

  const begin = async () => {
    if (!email.trim()) return;
    setBusy(true);
    setMessage(undefined);
    try {
      setSession(
        await onBegin({
          email: email.trim(),
          capabilities: [...capabilities],
          ...(oauthClientJson === undefined ? {} : { oauthClientJson }),
        }),
      );
    } catch (cause) {
      setMessage(googleSetupErrorMessage(cause, "Google setup could not be started."));
    } finally {
      setBusy(false);
    }
  };

  const complete = async () => {
    if (!session || !redirectUrl.trim()) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await onComplete({
        sessionId: session.sessionId,
        redirectUrl: redirectUrl.trim(),
      });
      onConnected(result.connection.id);
      onClose();
    } catch (cause) {
      setMessage(googleSetupErrorMessage(cause, "Google authorization could not finish."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      aria-label="Connect Gmail account"
      aria-modal="true"
      className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
      role="dialog"
    >
      <div className="max-h-[calc(100%-2rem)] w-full max-w-lg overflow-y-auto rounded-2xl border bg-card shadow-2xl">
        <div className="flex items-center gap-3 border-b px-5 py-4">
          <span className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <MailIcon className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold">Connect Gmail</h2>
            <p className="text-xs text-muted-foreground">
              This account will be available only in the current Space.
            </p>
          </div>
          <Button aria-label="Close Gmail setup" onClick={onClose} size="icon-sm" variant="ghost">
            <XIcon />
          </Button>
        </div>

        {session === undefined ? (
          <div className="space-y-4 p-5">
            <StringInput
              label="Google account email"
              onChange={setEmail}
              placeholder="you@example.com"
              readOnly={busy}
              value={email}
            />
            <div className="rounded-xl border bg-muted/20 p-3 text-xs">
              <p className="font-medium">Command Center will request:</p>
              <ul className="mt-2 list-disc space-y-1 pl-4 text-muted-foreground">
                <li>Read access to Gmail</li>
                {capabilities.includes("gmail.drafts.create") ? (
                  <li>Create Gmail drafts; sending remains blocked</li>
                ) : null}
              </ul>
            </div>
            <details className="rounded-xl border p-3 text-xs">
              <summary className="cursor-pointer font-medium">
                First account on this environment?
              </summary>
              <p className="mt-2 leading-relaxed text-muted-foreground">
                Upload the Desktop OAuth client JSON downloaded from Google Cloud. It is sent only
                to the selected environment and stored with its runtime credentials.
              </p>
              <label className="mt-3 flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed px-3 py-3 font-medium hover:bg-accent">
                <UploadIcon className="size-4" />
                {oauthClientName ?? "Choose OAuth client JSON"}
                <input
                  accept="application/json,.json"
                  className="sr-only"
                  disabled={busy}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    if (!file) return;
                    if (file.size > 64 * 1024) {
                      setMessage("OAuth client JSON must be smaller than 64 KB.");
                      return;
                    }
                    void file.text().then((contents) => {
                      setOauthClientJson(contents);
                      setOauthClientName(file.name);
                      setMessage(undefined);
                    });
                  }}
                  type="file"
                />
              </label>
            </details>
            {message ? (
              <p
                className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive"
                role="alert"
              >
                {message}
              </p>
            ) : null}
            <Button
              className="w-full"
              disabled={busy || !email.trim()}
              onClick={() => void begin()}
            >
              {busy ? (
                <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
              ) : (
                <MailIcon />
              )}
              {busy ? "Preparing Google" : "Continue"}
            </Button>
          </div>
        ) : (
          <div className="space-y-4 p-5">
            <div className="rounded-xl border bg-muted/20 p-4">
              <p className="text-sm font-medium">1. Sign in and approve access</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Google will finish at a local address that may show a page-not-found message. That
                is expected—copy the complete address from the browser afterward.
              </p>
              <Button
                className="mt-3 w-full"
                render={<a href={session.authUrl} rel="noreferrer" target="_blank" />}
                variant="outline"
              >
                <ExternalLinkIcon />
                Open Google authorization
              </Button>
            </div>
            <TextAreaField
              label="2. Paste the final browser address"
              onChange={setRedirectUrl}
              placeholder="http://127.0.0.1:…/oauth2/callback?code=…&state=…"
              readOnly={busy}
              value={redirectUrl}
            />
            {message ? (
              <p
                className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive"
                role="alert"
              >
                {message}
              </p>
            ) : null}
            <div className="flex gap-2">
              <Button disabled={busy} onClick={() => setSession(undefined)} variant="outline">
                Back
              </Button>
              <Button
                className="flex-1"
                disabled={busy || !redirectUrl.trim()}
                onClick={() => void complete()}
              >
                {busy ? (
                  <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
                ) : (
                  <CheckCircle2Icon />
                )}
                {busy ? "Connecting" : "Finish connection"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function NodeInspector({
  node,
  definition,
  selectedSpace,
  connections,
  readOnly,
  onClose,
  onDefinitionChange,
  onNodeIdChange,
  onRemoveGoogleConnection,
  onRequestGoogleSetup,
}: {
  readonly node: AutomationEditorNode;
  readonly definition: AutomationEditorDefinition;
  readonly selectedSpace?: Space | undefined;
  readonly connections: ReadonlyArray<Connection>;
  readonly readOnly: boolean;
  readonly onClose: () => void;
  readonly onDefinitionChange: (definition: AutomationEditorDefinition) => void;
  readonly onNodeIdChange: (nodeId: string) => void;
  readonly onRemoveGoogleConnection?:
    | ((connectionId: Connection["id"]) => Promise<void>)
    | undefined;
  readonly onRequestGoogleSetup?: ((node: AutomationEditorNode) => void) | undefined;
}) {
  const presentation = NODE_PRESENTATION[node.kind];
  const Icon = presentation.icon;
  const [connectTargetId, setConnectTargetId] = useState("");
  const updateConfig = (config: AutomationEditorNode["config"]) =>
    onDefinitionChange(updateAutomationNode(definition, node.id, { config }));
  return (
    <aside
      className="absolute inset-y-0 right-0 z-30 flex w-full max-w-[360px] flex-col border-l bg-card shadow-xl"
      data-slot="automation-inspector"
    >
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <span
          className={cn(
            "flex size-9 items-center justify-center rounded-lg",
            presentation.accentClassName,
          )}
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">{humanizeId(node.id)}</h3>
          <p className="text-xs text-muted-foreground">{presentation.label}</p>
        </div>
        <Button aria-label="Close step settings" onClick={onClose} size="icon-sm" variant="ghost">
          <XIcon />
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <Field help="Used in the graph and when referencing this step's output." label="Step name">
          <Input
            aria-label={`Step name for ${node.id}`}
            className="mt-1"
            defaultValue={humanizeId(node.id)}
            disabled={readOnly}
            key={node.id}
            nativeInput
            onBlur={(event) => {
              const nextId = slugifyId(event.currentTarget.value);
              if (!nextId || nextId === node.id) return;
              const renamed = renameAutomationNode(definition, node.id, nextId);
              if (renamed !== definition) {
                onDefinitionChange(renamed);
                onNodeIdChange(nextId);
              }
            }}
            size="sm"
          />
        </Field>
        <GuidedNodeFields
          connections={connections}
          node={node}
          onChange={updateConfig}
          onRemoveGoogleConnection={onRemoveGoogleConnection}
          onRequestGoogleSetup={onRequestGoogleSetup ? () => onRequestGoogleSetup(node) : undefined}
          readOnly={readOnly}
          selectedSpace={selectedSpace}
        />
        <Field
          help="Keyboard and touch alternative to dragging the output handle."
          label="Connect to…"
        >
          <div className="mt-1 flex gap-2">
            <select
              className="h-9 min-w-0 flex-1 rounded-lg border border-input bg-background px-2 text-sm"
              disabled={readOnly}
              onChange={(event) => setConnectTargetId(event.currentTarget.value)}
              value={connectTargetId}
            >
              <option value="">Choose a later step</option>
              {definition.nodes
                .filter((candidate) => candidate.id !== node.id)
                .map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {humanizeId(candidate.id)}
                  </option>
                ))}
            </select>
            <Button
              disabled={readOnly || connectTargetId.length === 0}
              onClick={() => {
                const next = addAutomationEdge(definition, { from: node.id, to: connectTargetId });
                if (next !== definition) {
                  onDefinitionChange(next);
                  setConnectTargetId("");
                }
              }}
              size="sm"
              variant="outline"
            >
              Connect
            </Button>
          </div>
        </Field>
        <ConfigJsonEditor node={node} onChange={updateConfig} readOnly={readOnly} />
      </div>
      <div className="border-t p-3">
        <Button
          className="w-full"
          disabled={readOnly}
          onClick={() => {
            const connected = definition.edges.some(
              (edge) => edge.from === node.id || edge.to === node.id,
            );
            if (connected && !window.confirm("Delete this step and its connections?")) return;
            onDefinitionChange(removeAutomationNode(definition, node.id));
          }}
          size="sm"
          variant="outline"
        >
          <Trash2Icon />
          Delete step
        </Button>
      </div>
    </aside>
  );
}

function EdgeInspector({
  edge,
  readOnly,
  onClose,
  onRemove,
}: {
  readonly edge: AutomationEditorEdge;
  readonly readOnly: boolean;
  readonly onClose: () => void;
  readonly onRemove: () => void;
}) {
  return (
    <aside
      className="absolute inset-y-0 right-0 z-30 w-full max-w-[360px] border-l bg-card p-4 shadow-xl"
      data-slot="automation-edge-inspector"
    >
      <div className="flex items-center">
        <div className="flex-1">
          <h3 className="text-sm font-semibold">Connection</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {humanizeId(edge.from)} → {humanizeId(edge.to)}
          </p>
        </div>
        <Button
          aria-label="Close connection settings"
          onClick={onClose}
          size="icon-sm"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </div>
      <p className="mt-5 text-xs leading-relaxed text-muted-foreground">
        When {humanizeId(edge.from)} finishes, its output becomes available to {humanizeId(edge.to)}
        .
      </p>
      <Button
        className="mt-5 w-full"
        disabled={readOnly}
        onClick={onRemove}
        size="sm"
        variant="outline"
      >
        <Trash2Icon />
        Delete connection
      </Button>
    </aside>
  );
}

function StepPicker({
  onAdd,
  onClose,
}: {
  readonly onAdd: (kind: AutomationEditorNodeKind) => void;
  readonly onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const grouped = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return (["Actions", "Data", "Flow"] as const)
      .map((category) => ({
        category,
        kinds: AUTOMATION_EDITOR_ADDABLE_NODE_KINDS.filter((kind) => {
          const item = NODE_PRESENTATION[kind];
          return (
            item.category === category &&
            (!normalized || `${item.label} ${item.description}`.toLowerCase().includes(normalized))
          );
        }),
      }))
      .filter((group) => group.kinds.length > 0);
  }, [query]);
  return (
    <div
      aria-label="Add automation step"
      className="absolute left-4 top-4 z-40 w-[min(22rem,calc(100%-2rem))] rounded-2xl border bg-popover p-3 text-popover-foreground shadow-xl"
    >
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            className="pl-8"
            nativeInput
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search steps…"
            size="sm"
            value={query}
          />
        </div>
        <Button aria-label="Close step picker" onClick={onClose} size="icon-sm" variant="ghost">
          <XIcon />
        </Button>
      </div>
      <div className="mt-3 max-h-[26rem] space-y-3 overflow-y-auto">
        {grouped.map((group) => (
          <section key={group.category}>
            <h3 className="px-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
              {group.category}
            </h3>
            <div className="mt-1 space-y-1">
              {group.kinds.map((kind) => {
                const item = NODE_PRESENTATION[kind];
                const Icon = item.icon;
                return (
                  <button
                    className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-accent"
                    key={kind}
                    onClick={() => onAdd(kind)}
                    type="button"
                  >
                    <span
                      className={cn(
                        "flex size-9 shrink-0 items-center justify-center rounded-lg",
                        item.accentClassName,
                      )}
                    >
                      <Icon className="size-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{item.label}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {item.description}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
        {grouped.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No steps match that search.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function timezoneValues(current: string): ReadonlyArray<string> {
  const supported =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : ["UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"];
  return supported.includes(current) ? supported : [current, ...supported];
}

function ScheduleEditor({
  definition,
  defaultTimezone,
  readOnly,
  onChange,
  onInterpret,
}: {
  readonly definition: AutomationEditorDefinition;
  readonly defaultTimezone: string;
  readonly readOnly: boolean;
  readonly onChange: (definition: AutomationEditorDefinition) => void;
  readonly onInterpret: AutomationEditorProps["onInterpretSchedule"];
}) {
  const trigger =
    definition.trigger.kind === "schedule"
      ? definition.trigger
      : { kind: "schedule" as const, expression: "0 9 * * 1-5", timezone: defaultTimezone };
  const [phrase, setPhrase] = useState("");
  const [timezone, setTimezone] = useState(trigger.timezone || defaultTimezone);
  const [isInterpreting, setIsInterpreting] = useState(false);
  const [interpretation, setInterpretation] =
    useState<
      Extract<
        Awaited<ReturnType<NonNullable<AutomationEditorProps["onInterpretSchedule"]>>>,
        { status: "interpreted" }
      >
    >();
  const [message, setMessage] = useState<string>();
  const [showPresets, setShowPresets] = useState(false);
  const [frequency, setFrequency] = useState<AutomationSchedulePreset["frequency"]>("weekdays");
  const [interval, setInterval] = useState(1);
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(0);
  const [weekday, setWeekday] = useState(1);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  useEffect(() => {
    if (definition.trigger.kind === "schedule") setTimezone(definition.trigger.timezone);
  }, [definition.trigger]);
  const currentOccurrences = useMemo(
    () => nextAutomationScheduleOccurrences(trigger.expression, trigger.timezone, { count: 3 }),
    [trigger.expression, trigger.timezone],
  );
  const interpret = async () => {
    if (!onInterpret || !phrase.trim()) return;
    setIsInterpreting(true);
    setMessage(undefined);
    setInterpretation(undefined);
    try {
      const result = await onInterpret({ text: phrase.trim(), timezone });
      if (result.status === "interpreted") setInterpretation(result);
      else setMessage(result.message);
    } catch (cause) {
      setMessage(
        cause instanceof Error
          ? cause.message
          : "Schedule interpretation is unavailable. Choose a schedule manually below.",
      );
      setShowPresets(true);
    } finally {
      setIsInterpreting(false);
    }
  };
  const manualPreset = (): AutomationSchedulePreset => {
    switch (frequency) {
      case "minutes":
        return { frequency, interval };
      case "hours":
        return { frequency, interval, minute };
      case "daily":
      case "weekdays":
        return { frequency, hour, minute };
      case "weekly":
        return { frequency, weekdays: [weekday], hour, minute };
      case "monthly":
        return { frequency, dayOfMonth, hour, minute };
    }
  };
  const applyPreset = () => {
    const expression = automationSchedulePresetExpression(manualPreset());
    onChange({ ...definition, trigger: { kind: "schedule", expression, timezone } });
    setShowPresets(false);
  };
  return (
    <div className="rounded-xl border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Clock3Icon className="size-4 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold">{describeAutomationSchedule(trigger.expression)}</p>
          <p className="truncate text-[0.6875rem] text-muted-foreground">{trigger.timezone}</p>
        </div>
        {currentOccurrences.length > 0 ? (
          <span className="text-[0.6875rem] text-muted-foreground">
            Next: {new Date(currentOccurrences[0]!).toLocaleString()}
          </span>
        ) : null}
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-[minmax(14rem,1fr)_minmax(12rem,16rem)_auto]">
        <Field label="When should this run?">
          <Input
            aria-label="When should this run?"
            className="mt-1"
            disabled={readOnly || isInterpreting}
            nativeInput
            onChange={(event) => setPhrase(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void interpret();
            }}
            placeholder="Every weekday at 8 AM"
            size="sm"
            value={phrase}
          />
        </Field>
        <Field label="Timezone">
          <Input
            aria-label="Schedule timezone"
            className="mt-1"
            disabled={readOnly}
            list="automation-timezones"
            nativeInput
            onChange={(event) => setTimezone(event.currentTarget.value)}
            size="sm"
            value={timezone}
          />
          <datalist id="automation-timezones">
            {timezoneValues(timezone).map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
        </Field>
        <Button
          className="self-end"
          disabled={readOnly || isInterpreting || !phrase.trim() || !onInterpret}
          onClick={() => void interpret()}
          size="sm"
        >
          {isInterpreting ? (
            <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
          ) : (
            <SparklesIcon />
          )}
          {isInterpreting ? "Interpreting" : "Interpret"}
        </Button>
      </div>
      {interpretation ? (
        <div className="mt-3 rounded-xl border border-success/30 bg-success/5 p-3">
          <div className="flex items-start gap-2">
            <CheckCircle2Icon className="mt-0.5 size-4 text-success" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold">{interpretation.summary}</p>
              <ul className="mt-1 text-[0.6875rem] text-muted-foreground">
                {interpretation.nextOccurrences.map((value) => (
                  <li key={value}>
                    {new Date(value).toLocaleString(undefined, {
                      timeZone: interpretation.trigger.timezone,
                    })}
                  </li>
                ))}
              </ul>
            </div>
            <Button
              disabled={readOnly}
              onClick={() => {
                onChange({ ...definition, trigger: interpretation.trigger });
                setInterpretation(undefined);
                setPhrase("");
              }}
              size="xs"
            >
              Use schedule
            </Button>
          </div>
        </div>
      ) : null}
      {message ? (
        <p className="mt-2 text-xs text-warning-foreground" role="status">
          {message}
        </p>
      ) : null}
      <button
        className="mt-2 flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        onClick={() => setShowPresets((value) => !value)}
        type="button"
      >
        <ChevronDownIcon
          className={cn("size-3.5 transition-transform", showPresets && "rotate-180")}
        />
        Choose manually
      </button>
      {showPresets ? (
        <div className="mt-3 grid gap-2 border-t pt-3 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="Repeats">
            <select
              className={selectClassName()}
              disabled={readOnly}
              onChange={(event) =>
                setFrequency(event.currentTarget.value as AutomationSchedulePreset["frequency"])
              }
              value={frequency}
            >
              <option value="minutes">Every few minutes</option>
              <option value="hours">Every few hours</option>
              <option value="daily">Daily</option>
              <option value="weekdays">Weekdays</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </Field>
          {frequency === "minutes" || frequency === "hours" ? (
            <StringInput
              label={frequency === "minutes" ? "Minutes apart" : "Hours apart"}
              onChange={(value) => setInterval(Number(value) || 1)}
              readOnly={readOnly}
              value={String(interval)}
            />
          ) : null}
          {frequency === "weekly" ? (
            <Field label="Day">
              <select
                className={selectClassName()}
                disabled={readOnly}
                onChange={(event) => setWeekday(Number(event.currentTarget.value))}
                value={weekday}
              >
                {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map(
                  (label, index) => (
                    <option key={label} value={index}>
                      {label}
                    </option>
                  ),
                )}
              </select>
            </Field>
          ) : null}
          {frequency === "monthly" ? (
            <StringInput
              label="Day of month"
              onChange={(value) => setDayOfMonth(Number(value) || 1)}
              readOnly={readOnly}
              value={String(dayOfMonth)}
            />
          ) : null}
          {frequency !== "minutes" ? (
            <>
              <Field label="Hour">
                <select
                  className={selectClassName()}
                  disabled={readOnly}
                  onChange={(event) => setHour(Number(event.currentTarget.value))}
                  value={hour}
                >
                  {Array.from({ length: 24 }, (_, value) => (
                    <option key={value} value={value}>
                      {new Date(Date.UTC(2020, 0, 1, value)).toLocaleTimeString(undefined, {
                        hour: "numeric",
                        timeZone: "UTC",
                      })}
                    </option>
                  ))}
                </select>
              </Field>
              <StringInput
                label="Minute"
                onChange={(value) => setMinute(Number(value) || 0)}
                readOnly={readOnly}
                value={String(minute)}
              />
            </>
          ) : null}
          <Button
            className="self-end"
            disabled={readOnly}
            onClick={applyPreset}
            size="sm"
            variant="outline"
          >
            Apply manual schedule
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function AutomationCanvas({
  definition,
  issues,
  readOnly,
  selectedNodeId,
  selectedEdgeId,
  onSelectedNodeIdChange,
  onSelectedEdgeIdChange,
  publishEdit,
  showNodePicker,
  onShowNodePickerChange,
}: {
  readonly definition: AutomationEditorDefinition;
  readonly issues: ReadonlyArray<AutomationEditorValidationIssue>;
  readonly readOnly: boolean;
  readonly selectedNodeId?: string | undefined;
  readonly selectedEdgeId?: string | undefined;
  readonly onSelectedNodeIdChange: (nodeId: string | undefined) => void;
  readonly onSelectedEdgeIdChange: (edgeId: string | undefined) => void;
  readonly publishEdit: (definition: AutomationEditorDefinition) => void;
  readonly showNodePicker: boolean;
  readonly onShowNodePickerChange: (show: boolean) => void;
}) {
  const { screenToFlowPosition, fitView, setViewport } = useReactFlow();
  const latestDefinitionRef = useRef(definition);
  useLayoutEffect(() => {
    latestDefinitionRef.current = definition;
  }, [definition]);
  const commitCanvasEdit = useCallback(
    (edit: (current: AutomationEditorDefinition) => AutomationEditorDefinition): boolean => {
      const current = latestDefinitionRef.current;
      const next = edit(current);
      if (next === current) return false;
      latestDefinitionRef.current = next;
      publishEdit(next);
      return true;
    },
    [publishEdit],
  );
  const [pendingPosition, setPendingPosition] = useState<AutomationEditorPosition>();
  const [pendingSourceId, setPendingSourceId] = useState<string>();
  const [connectionMessage, setConnectionMessage] = useState<string>();
  const defaultViewport = useMemo(() => {
    const viewport = definition.layout.viewport;
    if (viewport === null || typeof viewport !== "object" || Array.isArray(viewport)) {
      return { x: 0, y: 0, zoom: 1 };
    }
    const record = viewport as Readonly<Record<string, AutomationEditorJson>>;
    return {
      x: typeof record.x === "number" ? record.x : 0,
      y: typeof record.y === "number" ? record.y : 0,
      zoom: typeof record.zoom === "number" ? record.zoom : 1,
    };
  }, [definition.layout.viewport]);
  const restoredViewportDefinitionIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (restoredViewportDefinitionIdRef.current === definition.id) return;
    restoredViewportDefinitionIdRef.current = definition.id;
    void setViewport(defaultViewport);
  }, [defaultViewport, definition.id, setViewport]);
  const removeNode = useCallback(
    (nodeId: string) => {
      const connected = latestDefinitionRef.current.edges.some(
        (edge) => edge.from === nodeId || edge.to === nodeId,
      );
      if (connected && !window.confirm("Delete this step and its connections?")) return;
      commitCanvasEdit((current) => removeAutomationNode(current, nodeId));
      onSelectedNodeIdChange(undefined);
    },
    [commitCanvasEdit, onSelectedNodeIdChange],
  );
  const flowNodes = useMemo<ReadonlyArray<AutomationFlowNode>>(
    () =>
      definition.nodes.map((node, index) => ({
        id: node.id,
        type: "automation-step",
        position: readAutomationNodePosition(definition, node.id, index),
        width: AUTOMATION_NODE_WIDTH,
        height: AUTOMATION_NODE_HEIGHT,
        selected: node.id === selectedNodeId,
        data: {
          node,
          issues,
          readOnly,
          onEdit: (nodeId: string) => {
            onSelectedNodeIdChange(nodeId);
            onSelectedEdgeIdChange(undefined);
          },
          onRemove: removeNode,
        },
      })),
    [
      definition,
      issues,
      onSelectedEdgeIdChange,
      onSelectedNodeIdChange,
      readOnly,
      removeNode,
      selectedNodeId,
    ],
  );
  const flowEdges = useMemo<ReadonlyArray<AutomationFlowEdge>>(
    () => definition.edges.map((edge) => automationFlowEdge(edge, readOnly, selectedEdgeId)),
    [definition.edges, readOnly, selectedEdgeId],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState<AutomationFlowNode>([...flowNodes]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<AutomationFlowEdge>([...flowEdges]);
  const previousFlowPositionsRef = useRef<
    ReadonlyMap<string, { readonly x: number; readonly y: number }>
  >(new Map(flowNodes.map((node) => [node.id, node.position])));
  const previousDefinitionIdRef = useRef(definition.id);
  useEffect(() => {
    const previousPositions = previousFlowPositionsRef.current;
    const definitionChanged = previousDefinitionIdRef.current !== definition.id;
    setNodes((currentNodes) => {
      const currentById = new Map(currentNodes.map((node) => [node.id, node]));
      return flowNodes.map((nextNode) => {
        const currentNode = currentById.get(nextNode.id);
        const previousPosition = previousPositions.get(nextNode.id);
        return {
          ...nextNode,
          position:
            currentNode === undefined
              ? nextNode.position
              : reconcileAutomationNodePosition(
                  currentNode.position,
                  previousPosition,
                  nextNode.position,
                  definitionChanged,
                ),
        };
      });
    });
    previousFlowPositionsRef.current = new Map(flowNodes.map((node) => [node.id, node.position]));
    previousDefinitionIdRef.current = definition.id;
  }, [definition.id, flowNodes, setNodes]);
  useEffect(() => setEdges([...flowEdges]), [flowEdges, setEdges]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isEditing =
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement;
      if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && !isEditing) {
        event.preventDefault();
        onShowNodePickerChange(true);
        return;
      }
      if (readOnly || isEditing || !["Backspace", "Delete"].includes(event.key)) return;
      if (selectedNodeId) {
        event.preventDefault();
        removeNode(selectedNodeId);
        return;
      }
      if (selectedEdgeId) {
        const selected = latestDefinitionRef.current.edges.find(
          (edge) => edgeId(edge) === selectedEdgeId,
        );
        if (selected) {
          event.preventDefault();
          commitCanvasEdit((current) => removeAutomationEdge(current, selected));
          onSelectedEdgeIdChange(undefined);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    commitCanvasEdit,
    onSelectedEdgeIdChange,
    onShowNodePickerChange,
    readOnly,
    removeNode,
    selectedEdgeId,
    selectedNodeId,
  ]);
  const validConnection = useCallback((connection: FlowConnection | Edge) => {
    if (!connection.source || !connection.target) return false;
    return (
      automationEdgeProblem(latestDefinitionRef.current, {
        from: connection.source,
        to: connection.target,
      }) === undefined
    );
  }, []);
  const onConnect = useCallback(
    (connection: FlowConnection) => {
      if (!connection.source || !connection.target || readOnly) return;
      const edge = {
        from: connection.source,
        to: connection.target,
      };
      const problem = automationEdgeProblem(latestDefinitionRef.current, edge);
      if (problem !== undefined) {
        setConnectionMessage(problem);
      } else {
        commitCanvasEdit((current) => addAutomationEdge(current, edge));
        setEdges((current) =>
          current.some((candidate) => candidate.id === edgeId(edge))
            ? current
            : [...current, automationFlowEdge(edge, readOnly, selectedEdgeId)],
        );
        setConnectionMessage(undefined);
      }
    },
    [commitCanvasEdit, readOnly, selectedEdgeId, setEdges],
  );
  const onConnectEnd: OnConnectEnd = useCallback(
    (event, connectionState) => {
      if (readOnly || connectionState.isValid || !connectionState.fromNode) return;
      if (connectionState.toNode) {
        if (
          connectionState.fromHandle?.type !== "source" ||
          connectionState.toHandle?.type !== "target"
        ) {
          setConnectionMessage("Drag from the blue output to the gray input of another step.");
          return;
        }
        setConnectionMessage(
          automationEdgeProblem(latestDefinitionRef.current, {
            from: connectionState.fromNode.id,
            to: connectionState.toNode.id,
          }) ?? "That connection is not available.",
        );
        return;
      }
      if (connectionState.fromHandle?.type !== "source") {
        setConnectionMessage("Start connections from the blue output on the right of a step.");
        return;
      }
      const point = "changedTouches" in event ? event.changedTouches[0] : event;
      if (!point) return;
      setPendingPosition(screenToFlowPosition({ x: point.clientX, y: point.clientY }));
      setPendingSourceId(connectionState.fromNode.id);
      onShowNodePickerChange(true);
    },
    [onShowNodePickerChange, readOnly, screenToFlowPosition],
  );
  const addStep = (kind: AutomationEditorNodeKind) => {
    const position =
      pendingPosition ??
      screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    let addedId: string | undefined;
    commitCanvasEdit((current) => {
      let next = addAutomationNode(current, kind, position);
      addedId = next.nodes.at(-1)?.id;
      if (pendingSourceId && addedId)
        next = addAutomationEdge(next, { from: pendingSourceId, to: addedId });
      return next;
    });
    onSelectedNodeIdChange(addedId);
    onSelectedEdgeIdChange(undefined);
    setPendingPosition(undefined);
    setPendingSourceId(undefined);
    onShowNodePickerChange(false);
  };
  return (
    <div className="relative min-h-0 flex-1 bg-muted/20" data-slot="automation-canvas">
      <ReactFlow
        connectionRadius={32}
        colorMode="system"
        deleteKeyCode={null}
        edges={edges}
        fitView
        fitViewOptions={{ padding: 0.24, maxZoom: 1 }}
        isValidConnection={validConnection}
        maxZoom={1.5}
        minZoom={0.2}
        nodeTypes={NODE_TYPES}
        nodes={nodes}
        nodesConnectable={!readOnly}
        nodesDraggable={!readOnly}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        onEdgeClick={(_event, edge) => {
          onSelectedEdgeIdChange(edge.id);
          onSelectedNodeIdChange(undefined);
        }}
        onEdgesChange={onEdgesChange}
        onEdgesDelete={(deleted) => {
          if (readOnly) return;
          commitCanvasEdit((current) => {
            let next = current;
            for (const edge of deleted)
              next = removeAutomationEdge(next, { from: edge.source, to: edge.target });
            return next;
          });
          onSelectedEdgeIdChange(undefined);
        }}
        onNodeClick={(_event, node) => {
          onSelectedNodeIdChange(node.id);
          onSelectedEdgeIdChange(undefined);
        }}
        onNodeDragStop={(_event, node) => {
          commitCanvasEdit((current) => setAutomationNodePosition(current, node.id, node.position));
        }}
        onNodesChange={onNodesChange}
        onNodesDelete={(deleted) => {
          if (readOnly) return;
          commitCanvasEdit((current) => {
            let next = current;
            for (const node of deleted) next = removeAutomationNode(next, node.id);
            return next;
          });
          onSelectedNodeIdChange(undefined);
        }}
        onPaneClick={() => {
          onSelectedNodeIdChange(undefined);
          onSelectedEdgeIdChange(undefined);
        }}
        defaultViewport={defaultViewport}
        onMoveEnd={(_event, viewport) => {
          if (readOnly) return;
          commitCanvasEdit((current) => ({
            ...current,
            layout: {
              ...current.layout,
              viewport: { x: viewport.x, y: viewport.y, zoom: viewport.zoom },
            },
          }));
        }}
        onReconnect={(oldEdge, connection) => {
          if (readOnly || !connection.source || !connection.target) return;
          const current = latestDefinitionRef.current;
          const without = removeAutomationEdge(current, {
            from: oldEdge.source,
            to: oldEdge.target,
          });
          const edge = {
            from: connection.source,
            to: connection.target,
          };
          const problem = automationEdgeProblem(without, edge);
          if (problem !== undefined) {
            setConnectionMessage(problem);
            setEdges(
              current.edges.map((candidate) =>
                automationFlowEdge(candidate, readOnly, selectedEdgeId),
              ),
            );
            return;
          }
          const next = addAutomationEdge(without, edge);
          commitCanvasEdit(() => next);
          setEdges(
            next.edges.map((candidate) => automationFlowEdge(candidate, readOnly, selectedEdgeId)),
          );
          setConnectionMessage(undefined);
        }}
        panOnDrag
        selectionOnDrag
        snapGrid={[20, 20]}
        snapToGrid
      >
        <Background
          color="var(--color-border)"
          gap={20}
          size={1}
          variant={BackgroundVariant.Dots}
        />
        <Controls position="bottom-left" showInteractive={false} />
        <div className="absolute left-4 top-4 z-20 flex items-center gap-2">
          <Button disabled={readOnly} onClick={() => onShowNodePickerChange(true)} size="sm">
            <PlusIcon />
            Add step
          </Button>
          <Button
            aria-label="Fit workflow"
            onClick={() => void fitView({ padding: 0.24, maxZoom: 1 })}
            size="icon-sm"
            variant="outline"
          >
            <Maximize2Icon />
          </Button>
        </div>
      </ReactFlow>
      {showNodePicker ? (
        <StepPicker
          onAdd={addStep}
          onClose={() => {
            onShowNodePickerChange(false);
            setPendingPosition(undefined);
            setPendingSourceId(undefined);
          }}
        />
      ) : null}
      {connectionMessage ? (
        <div className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-warning/30 bg-card px-3 py-2 text-xs shadow-lg">
          <AlertTriangleIcon className="size-4 text-warning-foreground" />
          {connectionMessage}
          <button
            aria-label="Dismiss connection message"
            onClick={() => setConnectionMessage(undefined)}
            type="button"
          >
            <XIcon className="size-3.5" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function AutomationEditorInner({
  definition,
  onDefinitionChange,
  validationIssues = EMPTY_ISSUES,
  readOnly = false,
  className,
  selectedSpace,
  connections = EMPTY_CONNECTIONS,
  environmentTimezone,
  onInterpretSchedule,
  onBeginGoogleConnectionSetup,
  onCompleteGoogleConnectionSetup,
  onRemoveGoogleConnection,
}: AutomationEditorProps) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>();
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | undefined>();
  const [showNodePicker, setShowNodePicker] = useState(false);
  const [showIssues, setShowIssues] = useState(false);
  const [googleSetupNodeId, setGoogleSetupNodeId] = useState<string>();
  const localIssues = useMemo(() => validateAutomationEditorDefinition(definition), [definition]);
  const issues = useMemo(
    () => mergeAutomationValidationIssues(localIssues, validationIssues),
    [localIssues, validationIssues],
  );
  const errorCount = issues.filter((issue) => (issue.severity ?? "error") === "error").length;
  const publishEdit = useCallback(
    (next: AutomationEditorDefinition) =>
      onDefinitionChange(toSerializableAutomationDefinition(next)),
    [onDefinitionChange],
  );
  const selectedNode = definition.nodes.find((node) => node.id === selectedNodeId);
  const selectedEdge = definition.edges.find((edge) => edgeId(edge) === selectedEdgeId);
  const googleSetupNode = definition.nodes.find((node) => node.id === googleSetupNodeId);
  useEffect(() => {
    if (selectedNodeId && !definition.nodes.some((node) => node.id === selectedNodeId))
      setSelectedNodeId(undefined);
    if (selectedEdgeId && !definition.edges.some((edge) => edgeId(edge) === selectedEdgeId))
      setSelectedEdgeId(undefined);
  }, [definition.edges, definition.nodes, selectedEdgeId, selectedNodeId]);
  const defaultTimezone =
    definition.trigger.kind === "schedule"
      ? definition.trigger.timezone
      : environmentTimezone || "UTC";
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
          <CircleDotIcon className="size-4 text-primary" />
          <Input
            aria-label="Automation name"
            className="min-w-48 flex-1 font-semibold"
            disabled={readOnly}
            nativeInput
            onChange={(event) => publishEdit({ ...definition, name: event.currentTarget.value })}
            size="sm"
            value={definition.name}
          />
          <Field label="Starts">
            <select
              aria-label="Automation trigger type"
              className="h-9 min-w-36 rounded-lg border border-input bg-background px-2 text-sm"
              disabled={readOnly}
              onChange={(event) => {
                const kind = event.currentTarget.value;
                publishEdit({
                  ...definition,
                  trigger:
                    kind === "schedule"
                      ? { kind: "schedule", expression: "0 9 * * 1-5", timezone: defaultTimezone }
                      : kind === "webhook"
                        ? { kind: "webhook", route: `/hooks/${definition.id}` }
                        : { kind: "manual" },
                });
              }}
              value={definition.trigger.kind}
            >
              <option value="manual">Manually</option>
              <option value="schedule">On a schedule</option>
              <option value="webhook">From a webhook</option>
            </select>
          </Field>
          <label className="flex items-center gap-2 text-xs font-medium">
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
          <Button
            aria-expanded={showIssues}
            onClick={() => setShowIssues((value) => !value)}
            size="sm"
            variant={errorCount > 0 ? "destructive" : "outline"}
          >
            {errorCount > 0 ? <AlertTriangleIcon /> : <CheckCircle2Icon />}
            {errorCount > 0 ? `${errorCount} issue${errorCount === 1 ? "" : "s"}` : "Ready"}
          </Button>
          {readOnly ? <Badge variant="outline">Read only</Badge> : null}
        </div>
        {definition.trigger.kind === "schedule" ? (
          <div className="mt-3">
            <ScheduleEditor
              defaultTimezone={defaultTimezone}
              definition={definition}
              onChange={publishEdit}
              onInterpret={onInterpretSchedule}
              readOnly={readOnly}
            />
          </div>
        ) : null}
        {definition.trigger.kind === "webhook" ? (
          <div className="mt-3 max-w-xl">
            <StringInput
              help="Authenticated requests to this local route start the automation."
              label="Webhook route"
              onChange={(route) =>
                publishEdit({ ...definition, trigger: { kind: "webhook", route } })
              }
              readOnly={readOnly}
              value={definition.trigger.route}
            />
          </div>
        ) : null}
        {definition.trigger.kind === "manual" ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Start this automation manually or from a scoped agent.
          </p>
        ) : null}
        {showIssues ? (
          <div className="mt-3 grid gap-2 border-t pt-3 sm:grid-cols-2 lg:grid-cols-3">
            {issues.length === 0 ? (
              <p className="text-xs text-muted-foreground">The workflow is ready to save.</p>
            ) : (
              issues.map((issue) => (
                <button
                  className={cn(
                    "rounded-lg border p-2 text-left text-xs",
                    (issue.severity ?? "error") === "error"
                      ? "border-destructive/30 bg-destructive/5"
                      : "border-warning/30 bg-warning/5",
                  )}
                  data-issue-code={issue.code}
                  key={`${issue.code}:${issue.path?.join(".")}:${issue.message}`}
                  onClick={() => {
                    const nodeId = issue.nodeIds?.find((id) =>
                      definition.nodes.some((node) => node.id === id),
                    );
                    if (nodeId) {
                      setSelectedNodeId(nodeId);
                      setSelectedEdgeId(undefined);
                    }
                  }}
                  type="button"
                >
                  <span className="font-medium">
                    {(issue.severity ?? "error") === "error" ? "Fix required" : "Notice"}
                  </span>
                  <span className="mt-0.5 block text-muted-foreground">{issue.message}</span>
                </button>
              ))
            )}
          </div>
        ) : null}
      </header>
      <div className="relative flex min-h-0 flex-1">
        <AutomationCanvas
          definition={definition}
          issues={issues}
          onSelectedEdgeIdChange={setSelectedEdgeId}
          onSelectedNodeIdChange={setSelectedNodeId}
          onShowNodePickerChange={setShowNodePicker}
          publishEdit={publishEdit}
          readOnly={readOnly}
          selectedEdgeId={selectedEdgeId}
          selectedNodeId={selectedNodeId}
          showNodePicker={showNodePicker}
        />
        {selectedNode ? (
          <NodeInspector
            connections={connections.filter(
              (connection) => !selectedSpace || connection.spaceId === selectedSpace.id,
            )}
            definition={definition}
            node={selectedNode}
            onClose={() => setSelectedNodeId(undefined)}
            onDefinitionChange={publishEdit}
            onNodeIdChange={setSelectedNodeId}
            onRemoveGoogleConnection={
              onRemoveGoogleConnection
                ? async (connectionId) => {
                    await onRemoveGoogleConnection({ connectionId });
                  }
                : undefined
            }
            onRequestGoogleSetup={
              onBeginGoogleConnectionSetup && onCompleteGoogleConnectionSetup
                ? (node) => setGoogleSetupNodeId(node.id)
                : undefined
            }
            readOnly={readOnly}
            selectedSpace={selectedSpace}
          />
        ) : null}
        {selectedEdge ? (
          <EdgeInspector
            edge={selectedEdge}
            onClose={() => setSelectedEdgeId(undefined)}
            onRemove={() => {
              publishEdit(removeAutomationEdge(definition, selectedEdge));
              setSelectedEdgeId(undefined);
            }}
            readOnly={readOnly}
          />
        ) : null}
        {googleSetupNode && onBeginGoogleConnectionSetup && onCompleteGoogleConnectionSetup ? (
          <GoogleConnectionSetupDialog
            capabilities={
              googleSetupNode.kind === "connector.write"
                ? ["gmail.read", "gmail.drafts.create"]
                : ["gmail.read"]
            }
            onBegin={onBeginGoogleConnectionSetup}
            onClose={() => setGoogleSetupNodeId(undefined)}
            onComplete={onCompleteGoogleConnectionSetup}
            onConnected={(connectionId) => {
              const current = definition.nodes.find((node) => node.id === googleSetupNode.id);
              if (!current) return;
              publishEdit(
                updateAutomationNode(definition, current.id, {
                  config: patchConfig(current.config, { connectionId }),
                }),
              );
            }}
          />
        ) : null}
      </div>
    </section>
  );
}

export function AutomationEditor(props: AutomationEditorProps) {
  return (
    <ReactFlowProvider>
      <AutomationEditorInner {...props} />
    </ReactFlowProvider>
  );
}
