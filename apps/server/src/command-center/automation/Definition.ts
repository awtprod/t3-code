import {
  AutomationId,
  AutomationNodeId,
  ModelId,
  ProjectId,
  ProviderId,
  RepositoryId,
  SpaceId,
  TrimmedNonEmptyString,
} from "@command-center/core/domain";
import { CommandCenterWebhookRoute } from "@t3tools/contracts";
import { formatSchemaError } from "@t3tools/shared/schemaJson";
import {
  isValidAutomationTimeZone,
  parseAutomationCronExpression,
} from "@t3tools/shared/automationSchedule";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { analyzeAutomationGraph } from "./Graph.ts";

export const AutomationFileTriggerKind = Schema.Literals(["manual", "schedule", "webhook"]);
export type AutomationFileTriggerKind = typeof AutomationFileTriggerKind.Type;

export const AutomationFileNodeKind = Schema.Literals([
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
]);
export type AutomationFileNodeKind = typeof AutomationFileNodeKind.Type;

const JsonObject = Schema.Record(Schema.String, Schema.Json);
export const AUTOMATION_DEFINITION_SCHEMA_VERSION = 1 as const;

/**
 * Static routing inputs for an automation-owned agent Run. The Space is
 * intentionally absent: it always comes from the committed Automation and is
 * rebound by the executor at runtime. Prompts may contain runtime templates,
 * but routing identifiers remain committed literals.
 */
export const AutomationAgentRunNodeConfig = Schema.Struct({
  prompt: TrimmedNonEmptyString,
  repositoryId: Schema.optional(RepositoryId),
  projectId: Schema.optional(ProjectId),
  providerId: Schema.optional(ProviderId),
  modelId: Schema.optional(ModelId),
});
export type AutomationAgentRunNodeConfig = typeof AutomationAgentRunNodeConfig.Type;

const AGENT_RUN_CONFIG_KEYS = new Set([
  "prompt",
  "repositoryId",
  "projectId",
  "providerId",
  "modelId",
]);
const decodeAutomationAgentRunNodeConfig = Schema.decodeUnknownExit(AutomationAgentRunNodeConfig);

export type AutomationAgentRunNodeConfigResult =
  | { readonly ok: true; readonly config: AutomationAgentRunNodeConfig }
  | { readonly ok: false; readonly message: string };

/** Parse with an explicit key allowlist so scope-like fields cannot be ignored. */
export function parseAutomationAgentRunNodeConfig(
  input: unknown,
): AutomationAgentRunNodeConfigResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, message: "Agent node config must be an object." };
  }
  const unknownKeys = Object.keys(input).filter((key) => !AGENT_RUN_CONFIG_KEYS.has(key));
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      message: `Agent node config contains unsupported field '${unknownKeys.sort()[0]}'.`,
    };
  }
  const decoded = decodeAutomationAgentRunNodeConfig(input);
  if (Exit.isFailure(decoded)) {
    return { ok: false, message: formatSchemaError(decoded.cause) };
  }
  if (decoded.value.projectId !== undefined && decoded.value.repositoryId === undefined) {
    return {
      ok: false,
      message: "Agent node projectId requires an exact repositoryId binding.",
    };
  }
  return { ok: true, config: decoded.value };
}

/**
 * Automation definitions name a server-owned policy entry and nothing else.
 * Executable, argv, cwd, roots, access, and retry authority never enter Git.
 */
export const AutomationScopedShellNodeConfig = Schema.Struct({
  allowlistId: TrimmedNonEmptyString,
});
export type AutomationScopedShellNodeConfig = typeof AutomationScopedShellNodeConfig.Type;

const SCOPED_SHELL_CONFIG_KEYS = new Set(["allowlistId"]);
const SCOPED_SHELL_ALLOWLIST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const decodeAutomationScopedShellNodeConfig = Schema.decodeUnknownExit(
  AutomationScopedShellNodeConfig,
);

export type AutomationScopedShellNodeConfigResult =
  | { readonly ok: true; readonly config: AutomationScopedShellNodeConfig }
  | { readonly ok: false; readonly message: string };

export function parseAutomationScopedShellNodeConfig(
  input: unknown,
): AutomationScopedShellNodeConfigResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, message: "Scoped shell node config must be an object." };
  }
  const unknownKeys = Object.keys(input).filter((key) => !SCOPED_SHELL_CONFIG_KEYS.has(key));
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      message: `Scoped shell node config contains unsupported field '${unknownKeys.sort()[0]}'.`,
    };
  }
  const rawAllowlistId = (input as Readonly<Record<string, unknown>>).allowlistId;
  if (
    typeof rawAllowlistId !== "string" ||
    rawAllowlistId !== rawAllowlistId.trim() ||
    !SCOPED_SHELL_ALLOWLIST_ID_PATTERN.test(rawAllowlistId)
  ) {
    return { ok: false, message: "Scoped shell node allowlistId is malformed." };
  }
  const decoded = decodeAutomationScopedShellNodeConfig(input);
  if (Exit.isFailure(decoded)) {
    return { ok: false, message: formatSchemaError(decoded.cause) };
  }
  return { ok: true, config: decoded.value };
}

export const AutomationFileTrigger = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("manual") }),
  Schema.Struct({
    kind: Schema.Literal("schedule"),
    expression: TrimmedNonEmptyString,
    timezone: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("webhook"),
    route: CommandCenterWebhookRoute,
  }),
]);
export type AutomationFileTrigger = typeof AutomationFileTrigger.Type;

export const AutomationFileNode = Schema.Struct({
  id: AutomationNodeId,
  kind: AutomationFileNodeKind,
  config: JsonObject,
});
export type AutomationFileNode = typeof AutomationFileNode.Type;

export const AutomationFileEdge = Schema.Struct({
  from: AutomationNodeId,
  to: AutomationNodeId,
});
export type AutomationFileEdge = typeof AutomationFileEdge.Type;

/**
 * Source-of-truth format stored in the private configuration repository.
 * Secrets and runtime state are intentionally absent from this schema.
 */
export const AutomationDefinition = Schema.Struct({
  schemaVersion: Schema.Literal(AUTOMATION_DEFINITION_SCHEMA_VERSION),
  id: AutomationId,
  name: TrimmedNonEmptyString,
  spaceId: SpaceId,
  enabled: Schema.Boolean,
  trigger: AutomationFileTrigger,
  nodes: Schema.Array(AutomationFileNode),
  edges: Schema.Array(AutomationFileEdge),
  layout: JsonObject,
  policy: JsonObject,
});
export type AutomationDefinition = typeof AutomationDefinition.Type;

export const AutomationValidationIssueCode = Schema.Literals([
  "schema.invalid",
  "graph.empty",
  "graph.duplicate-node",
  "graph.duplicate-edge",
  "graph.unknown-edge-source",
  "graph.unknown-edge-target",
  "graph.cycle",
  "trigger.invalid",
  "state.unknown-node",
  "node.config.invalid",
  "node.config.private-data",
  "node.approval.required",
  "v1.unsupported-node",
  "v1.unsupported-external-wait",
]);
export type AutomationValidationIssueCode = typeof AutomationValidationIssueCode.Type;

export interface AutomationValidationIssue {
  readonly code: AutomationValidationIssueCode;
  readonly message: string;
  readonly path: ReadonlyArray<string | number>;
  readonly nodeIds?: ReadonlyArray<string>;
}

export type AutomationValidationResult =
  | {
      readonly ok: true;
      readonly definition: AutomationDefinition;
    }
  | {
      readonly ok: false;
      readonly issues: ReadonlyArray<AutomationValidationIssue>;
    };

const decodeAutomationDefinition = Schema.decodeUnknownExit(AutomationDefinition);
const SENSITIVE_CONFIG_KEY =
  /(?:^|[._-])(api[_-]?key|cookie|credential|password|secret|token)(?:$|[._-])/iu;
const ABSOLUTE_HOST_PATH = /^(?:\/(?:home|Users|root|etc|var|opt|srv)\/|[A-Za-z]:[\\/])/u;

/** Git-managed definitions may contain references, never host paths or credentials. */
export function automationConfigIsSafeForGit(value: unknown): boolean {
  if (typeof value === "string") return !ABSOLUTE_HOST_PATH.test(value);
  if (Array.isArray(value)) return value.every(automationConfigIsSafeForGit);
  if (value === null || typeof value !== "object") return true;
  return Object.entries(value).every(
    ([key, child]) => !SENSITIVE_CONFIG_KEY.test(key) && automationConfigIsSafeForGit(child),
  );
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export function normalizeJson(value: Schema.Json): Schema.Json {
  if (Array.isArray(value)) {
    return value.map(normalizeJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, child]) => [key, normalizeJson(child)]),
    );
  }
  return value;
}

const normalizeJsonObject = (
  value: Readonly<Record<string, Schema.Json>>,
): Readonly<Record<string, Schema.Json>> =>
  normalizeJson(value) as Readonly<Record<string, Schema.Json>>;

export function normalizeAutomationDefinition(
  definition: AutomationDefinition,
): AutomationDefinition {
  const nodes = definition.nodes
    .map((node) => ({ ...node, config: normalizeJsonObject(node.config) }))
    .sort((left, right) => compareText(left.id, right.id));
  const edges = [...definition.edges].sort(
    (left, right) => compareText(left.from, right.from) || compareText(left.to, right.to),
  );

  return {
    ...definition,
    nodes,
    edges,
    layout: normalizeJsonObject(definition.layout),
    policy: normalizeJsonObject(definition.policy),
  };
}

export function validateAutomationDefinition(input: unknown): AutomationValidationResult {
  const decoded = decodeAutomationDefinition(input);
  if (Exit.isFailure(decoded)) {
    return {
      ok: false,
      issues: [
        {
          code: "schema.invalid",
          message: formatSchemaError(decoded.cause),
          path: [],
        },
      ],
    };
  }

  const graph = analyzeAutomationGraph(decoded.value);
  const issues: AutomationValidationIssue[] = [...graph.issues];
  if (
    decoded.value.trigger.kind === "schedule" &&
    (parseAutomationCronExpression(decoded.value.trigger.expression) === undefined ||
      !isValidAutomationTimeZone(decoded.value.trigger.timezone))
  ) {
    issues.push({
      code: "trigger.invalid",
      message: "The recurring schedule or timezone is invalid.",
      path: ["trigger"],
    });
  }
  decoded.value.nodes.forEach((node, index) => {
    if (!automationConfigIsSafeForGit(node.config)) {
      issues.push({
        code: "node.config.private-data",
        message: `Node '${node.id}' contains a host path or credential-shaped field that cannot be stored in Git.`,
        path: ["nodes", index, "config"],
        nodeIds: [node.id],
      });
    }
    if (node.kind === "agent.run") {
      const config = parseAutomationAgentRunNodeConfig(node.config);
      if (!config.ok) {
        issues.push({
          code: "node.config.invalid",
          message: config.message,
          path: ["nodes", index, "config"],
          nodeIds: [node.id],
        });
      }
    }
    if (node.kind === "shell.scoped") {
      const config = parseAutomationScopedShellNodeConfig(node.config);
      if (!config.ok) {
        issues.push({
          code: "node.config.invalid",
          message: config.message,
          path: ["nodes", index, "config"],
          nodeIds: [node.id],
        });
      }
    }
    if (node.kind === "connector.write" && node.config.operation === "gmail.draft.create") {
      const predecessors = graph.predecessorIds[node.id] ?? [];
      const approved = predecessors.some(
        (predecessorId) =>
          decoded.value.nodes.find((candidate) => candidate.id === predecessorId)?.kind ===
          "approval",
      );
      if (!approved) {
        issues.push({
          code: "node.approval.required",
          message: `Gmail draft node '${node.id}' requires an immediately preceding Approval node.`,
          path: ["nodes", index],
          nodeIds: [node.id],
        });
      }
    }
    if (node.config.waitForExternalSignal === true) {
      issues.push({
        code: "v1.unsupported-external-wait",
        message:
          "External signal waits are unavailable in v1 because no authenticated resume API is enabled.",
        path: ["nodes", index, "config"],
        nodeIds: [node.id],
      });
    }
  });
  return issues.length === 0
    ? { ok: true, definition: normalizeAutomationDefinition(decoded.value) }
    : { ok: false, issues };
}
