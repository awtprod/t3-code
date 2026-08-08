import { SpaceId, type ItemKind, type ItemPriority } from "@command-center/core";
import {
  GoogleReadRequest,
  GoogleDraftCreateRequest,
  type GoogleReadRequest as GoogleReadRequestType,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type {
  AutomationAgentRunFailure,
  AutomationAgentRunLinkedResult,
  AutomationAgentRunRequest,
} from "./AgentRunAdapter.ts";
import { automationAgentRunResumeKey } from "./AgentRunAdapter.ts";
import type {
  AutomationScopedShellError,
  AutomationScopedShellRequest,
  AutomationScopedShellResult,
} from "./AutomationScopedShell.ts";
import {
  parseAutomationAgentRunNodeConfig,
  parseAutomationScopedShellNodeConfig,
} from "./Definition.ts";
import type { AutomationNodeExecutionContext, AutomationNodeExecutionOutcome } from "./Runtime.ts";

const decodeGoogleReadRequest = Schema.decodeUnknownEffect(GoogleReadRequest);
const decodeGoogleDraftCreateRequest = Schema.decodeUnknownEffect(GoogleDraftCreateRequest);

const ITEM_KINDS = new Set<ItemKind>(["idea", "task", "decision", "alert", "approval"]);
const ITEM_PRIORITIES = new Set<ItemPriority>(["low", "normal", "high", "urgent"]);
const UNSAFE_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const TEMPLATE_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/gu;
const EXACT_TEMPLATE_PATTERN = /^\{\{\s*([^{}]+?)\s*\}\}$/u;
const MAX_FOREACH_ITEMS = 500;

type JsonObject = Readonly<Record<string, Schema.Json>>;
type AutomationGoogleReadRequest = Exclude<
  GoogleReadRequestType,
  { readonly operation: "drive.export" }
>;

export interface AutomationItemCreateRequest {
  readonly requestId: string;
  readonly spaceId: ReturnType<typeof SpaceId.make>;
  readonly kind: ItemKind;
  readonly priority: ItemPriority;
  readonly title: string;
  readonly description?: string;
  readonly dueAt?: string;
}

export interface AutomationNodeExecutorDependencies {
  readonly startAgentRun: (
    input: AutomationAgentRunRequest,
  ) => Effect.Effect<AutomationAgentRunLinkedResult, AutomationAgentRunFailure>;
  readonly createItem: (input: AutomationItemCreateRequest) => Effect.Effect<Schema.Json, string>;
  readonly googleRead: (
    input: AutomationGoogleReadRequest,
  ) => Effect.Effect<
    { readonly operation: string; readonly contentTrust: string; readonly data: unknown },
    string
  >;
  readonly googleDraft?: (input: import("@t3tools/contracts").GoogleDraftCreateRequest) => Effect.Effect<Schema.Json, string>;
  readonly runScopedShell: (
    input: AutomationScopedShellRequest,
  ) => Effect.Effect<AutomationScopedShellResult, AutomationScopedShellError>;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function permanentFailure(message: string): AutomationNodeExecutionOutcome {
  return { type: "failed", error: message };
}

function runtimeRoots(context: AutomationNodeExecutionContext): JsonObject {
  return {
    run: context.runInput,
    predecessors: context.predecessorOutputs,
  };
}

function readPath(roots: JsonObject, source: string): Schema.Json | undefined {
  const path = source.trim().replace(/^\$\.?/u, "");
  if (path.length === 0) return roots;
  const segments = path.split(".").filter((segment) => segment.length > 0);
  if (segments.some((segment) => UNSAFE_PATH_SEGMENTS.has(segment))) return undefined;

  let current: Schema.Json | undefined = roots;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^\d+$/u.test(segment)) return undefined;
      current = current[Number(segment)];
      continue;
    }
    if (!isJsonObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function displayJson(value: Schema.Json | undefined): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function renderTemplate(value: Schema.Json, roots: JsonObject): Schema.Json {
  if (Array.isArray(value)) return value.map((child) => renderTemplate(child, roots));
  if (isJsonObject(value)) {
    if (Object.keys(value).length === 1 && typeof value.$path === "string") {
      return readPath(roots, value.$path) ?? null;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, renderTemplate(child, roots)]),
    );
  }
  if (typeof value !== "string") return value;

  const exact = EXACT_TEMPLATE_PATTERN.exec(value);
  if (exact !== null) return readPath(roots, exact[1] ?? "") ?? null;
  return value.replace(TEMPLATE_PATTERN, (_match, path: string) =>
    displayJson(readPath(roots, path)),
  );
}

function configuredValue(
  config: JsonObject,
  roots: JsonObject,
  key: string,
): Schema.Json | undefined {
  const value = config[key];
  if (value !== undefined) return renderTemplate(value, roots);
  const path = config[`${key}Path`];
  return typeof path === "string" ? readPath(roots, path) : undefined;
}

function compareValues(
  operator: string,
  left: Schema.Json | undefined,
  right: Schema.Json | undefined,
) {
  switch (operator) {
    case "truthy":
      return Boolean(left);
    case "falsy":
      return !left;
    case "equals":
      return JSON.stringify(left) === JSON.stringify(right);
    case "notEquals":
      return JSON.stringify(left) !== JSON.stringify(right);
    case "contains":
      return typeof left === "string"
        ? left.includes(displayJson(right))
        : Array.isArray(left) &&
            left.some((value) => JSON.stringify(value) === JSON.stringify(right));
    case "greaterThan":
      return typeof left === "number" && typeof right === "number" && left > right;
    case "greaterThanOrEqual":
      return typeof left === "number" && typeof right === "number" && left >= right;
    case "lessThan":
      return typeof left === "number" && typeof right === "number" && left < right;
    case "lessThanOrEqual":
      return typeof left === "number" && typeof right === "number" && left <= right;
    default:
      return undefined;
  }
}

function executeCondition(context: AutomationNodeExecutionContext): AutomationNodeExecutionOutcome {
  const config = context.node.config;
  const roots = runtimeRoots(context);
  const left = configuredValue(config, roots, "left") ?? configuredValue(config, roots, "value");
  const right =
    configuredValue(config, roots, "right") ?? configuredValue(config, roots, "expected");
  const operator = typeof config.operator === "string" ? config.operator : "truthy";
  const matched = compareValues(operator, left, right);
  if (matched === undefined) {
    return permanentFailure(
      `Condition node '${context.node.id}' has unsupported operator '${operator}'.`,
    );
  }
  if (!matched && config.require === true) {
    return permanentFailure(`Condition node '${context.node.id}' did not match.`);
  }
  return { type: "succeeded", output: { matched, value: left ?? null } };
}

function executeTransform(context: AutomationNodeExecutionContext): AutomationNodeExecutionOutcome {
  const config = context.node.config;
  const roots = runtimeRoots(context);
  const selected = config.output ?? config.value ?? config.template;
  const output = renderTemplate(selected ?? config, roots);
  return { type: "succeeded", output };
}

function executeForeach(context: AutomationNodeExecutionContext): AutomationNodeExecutionOutcome {
  const config = context.node.config;
  const roots = runtimeRoots(context);
  const source =
    configuredValue(config, roots, "items") ?? configuredValue(config, roots, "source");
  if (!Array.isArray(source)) {
    return permanentFailure(`Foreach node '${context.node.id}' requires an array source.`);
  }
  if (source.length > MAX_FOREACH_ITEMS) {
    return permanentFailure(
      `Foreach node '${context.node.id}' exceeds the ${MAX_FOREACH_ITEMS}-item safety limit.`,
    );
  }
  const template = config.template;
  const items = source.map((item, index) =>
    template === undefined ? item : renderTemplate(template, { ...roots, item, index }),
  );
  return { type: "succeeded", output: { count: items.length, items } };
}

function requiredRenderedString(
  config: JsonObject,
  roots: JsonObject,
  key: string,
): string | undefined {
  const value = configuredValue(config, roots, key);
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

const executeItemMutation = Effect.fn("AutomationNodeExecutor.itemMutation")(function* (
  context: AutomationNodeExecutionContext,
  dependencies: AutomationNodeExecutorDependencies,
) {
  const config = context.node.config;
  const operation = typeof config.operation === "string" ? config.operation : "create";
  if (operation !== "create" && operation !== "capture") {
    return permanentFailure(
      `Item node '${context.node.id}' only supports reversible create/capture operations.`,
    );
  }
  const roots = runtimeRoots(context);
  const title = requiredRenderedString(config, roots, "title");
  const kind = typeof config.kind === "string" ? config.kind : "task";
  const priority = typeof config.priority === "string" ? config.priority : "normal";
  if (
    title === undefined ||
    !ITEM_KINDS.has(kind as ItemKind) ||
    !ITEM_PRIORITIES.has(priority as ItemPriority)
  ) {
    return permanentFailure(
      `Item node '${context.node.id}' has an invalid title, kind, or priority.`,
    );
  }
  const description = requiredRenderedString(config, roots, "description");
  const dueAt = requiredRenderedString(config, roots, "dueAt");
  const item = yield* dependencies
    .createItem({
      requestId: context.idempotencyKey,
      spaceId: SpaceId.make(context.spaceId),
      kind: kind as ItemKind,
      priority: priority as ItemPriority,
      title,
      ...(description === undefined ? {} : { description }),
      ...(dueAt === undefined ? {} : { dueAt }),
    })
    .pipe(
      Effect.match({
        onFailure: (error) => ({ _tag: "Left" as const, left: error }),
        onSuccess: (value) => ({ _tag: "Right" as const, right: value }),
      }),
    );
  return item._tag === "Left"
    ? ({ type: "retry", error: item.left } as const)
    : ({ type: "succeeded", output: item.right } as const);
});

function googleRequestConfig(config: JsonObject, spaceId: string, connectionId: string): unknown {
  const request = isJsonObject(config.request) ? config.request : config;
  return Object.fromEntries(
    Object.entries({ ...request, spaceId, connectionId }).filter(
      ([key]) =>
        !["account", "capability", "maxAttempts", "retries", "retryAfterMs", "request"].includes(
          key,
        ),
    ),
  );
}

const executeConnectorRead = Effect.fn("AutomationNodeExecutor.connectorRead")(function* (
  context: AutomationNodeExecutionContext,
  dependencies: AutomationNodeExecutorDependencies,
) {
  const connectionId = context.node.config.connectionId;
  if (typeof connectionId !== "string" || connectionId.trim().length === 0) {
    return permanentFailure(`Connector node '${context.node.id}' requires a connectionId.`);
  }
  const request = yield* decodeGoogleReadRequest(
    googleRequestConfig(context.node.config, context.spaceId, connectionId),
  ).pipe(
    Effect.mapError(
      () => "The connector node does not contain a supported read-only Google request.",
    ),
    Effect.match({
      onFailure: (error) => ({ _tag: "Left" as const, left: error }),
      onSuccess: (value) => ({ _tag: "Right" as const, right: value }),
    }),
  );
  if (request._tag === "Left") return permanentFailure(request.left);
  if (request.right.operation === "drive.export") {
    return permanentFailure(
      "Drive export must use the dedicated artifact-producing connector path.",
    );
  }

  const result = yield* dependencies.googleRead(request.right).pipe(
    Effect.match({
      onFailure: (error) => ({ _tag: "Left" as const, left: error }),
      onSuccess: (value) => ({ _tag: "Right" as const, right: value }),
    }),
  );
  if (result._tag === "Left") return { type: "retry", error: result.left } as const;
  return {
    type: "succeeded",
    output: {
      operation: result.right.operation,
      contentTrust: "untrusted-external",
      data: result.right.data as Schema.Json,
    },
  } as const;
});

const executeConnectorWrite = Effect.fn("AutomationNodeExecutor.connectorWrite")(function* (
  context: AutomationNodeExecutionContext,
  dependencies: AutomationNodeExecutorDependencies,
) {
  const connectionId = context.node.config.connectionId;
  if (typeof connectionId !== "string" || connectionId.trim().length === 0) {
    return permanentFailure(`Connector write node '${context.node.id}' requires a connectionId.`);
  }
  const request = yield* decodeGoogleDraftCreateRequest(
    googleRequestConfig(context.node.config, context.spaceId, connectionId),
  ).pipe(Effect.match({ onFailure: () => ({ _tag: "Left" as const }), onSuccess: (value) => ({ _tag: "Right" as const, value }) }));
  if (request._tag === "Left") return permanentFailure("The connector write node does not contain a valid Gmail draft request.");
  if (dependencies.googleDraft === undefined) {
    return permanentFailure("Gmail draft creation is not configured on this server.");
  }
  const drafted = yield* dependencies.googleDraft(request.value).pipe(
    Effect.match({ onFailure: (error) => ({ _tag: "Left" as const, error }), onSuccess: (value) => ({ _tag: "Right" as const, value }) }),
  );
  return drafted._tag === "Left"
    ? ({ type: "retry", error: drafted.error } as const)
    : ({ type: "succeeded", output: { operation: "gmail.draft.create", data: drafted.value } } as const);
});

const executeAgentRun = Effect.fn("AutomationNodeExecutor.agentRun")(function* (
  context: AutomationNodeExecutionContext,
  dependencies: AutomationNodeExecutorDependencies,
) {
  const parsed = parseAutomationAgentRunNodeConfig(context.node.config);
  if (!parsed.ok) {
    return permanentFailure(
      `Agent node '${context.node.id}' has invalid config: ${parsed.message}`,
    );
  }
  const text = requiredRenderedString(context.node.config, runtimeRoots(context), "prompt");
  if (text === undefined) {
    return permanentFailure(
      `Agent node '${context.node.id}' produced an empty or non-text prompt.`,
    );
  }

  const started = yield* dependencies
    .startAgentRun({
      executionId: context.executionId,
      automationId: context.automationId,
      nodeId: String(context.node.id),
      spaceId: context.spaceId,
      text,
      ...(parsed.config.repositoryId === undefined
        ? {}
        : { repositoryId: String(parsed.config.repositoryId) }),
      ...(parsed.config.projectId === undefined
        ? {}
        : { projectId: String(parsed.config.projectId) }),
      ...(parsed.config.providerId === undefined
        ? {}
        : { providerId: String(parsed.config.providerId) }),
      ...(parsed.config.modelId === undefined ? {} : { modelId: String(parsed.config.modelId) }),
    })
    .pipe(
      Effect.match({
        onFailure: (error) => ({ _tag: "Left" as const, left: error }),
        onSuccess: (value) => ({ _tag: "Right" as const, right: value }),
      }),
    );
  if (started._tag === "Left") {
    return started.left.retryable
      ? ({ type: "retry", error: started.left.message } as const)
      : permanentFailure(started.left.message);
  }

  const output = started.right as unknown as Schema.Json;
  if (
    started.right.routeStatus === "blocked" ||
    started.right.state === "failed" ||
    started.right.state === "canceled"
  ) {
    return {
      type: "failed",
      error:
        started.right.reasons[0] ??
        `Agent node '${context.node.id}' was blocked before provider dispatch.`,
      output,
    } as const;
  }
  if (started.right.state === "succeeded") return { type: "succeeded", output } as const;
  return {
    type: "wait",
    resumeKey: automationAgentRunResumeKey({
      parentExecutionId: started.right.parentExecutionId,
      nodeId: started.right.nodeId,
      commandId: started.right.commandId,
      childRunId: started.right.runId,
      spaceId: started.right.spaceId,
    }),
    output,
  } as const;
});

const executeScopedShell = Effect.fn("AutomationNodeExecutor.scopedShell")(function* (
  context: AutomationNodeExecutionContext,
  dependencies: AutomationNodeExecutorDependencies,
) {
  const parsed = parseAutomationScopedShellNodeConfig(context.node.config);
  if (!parsed.ok) {
    return permanentFailure(
      `Shell node '${context.node.id}' has invalid config: ${parsed.message}`,
    );
  }
  const executed = yield* dependencies
    .runScopedShell({
      executionId: context.executionId,
      nodeId: String(context.node.id),
      spaceId: context.spaceId,
      allowlistId: parsed.config.allowlistId,
    })
    .pipe(
      Effect.match({
        onFailure: (failure) => ({ _tag: "Left" as const, left: failure }),
        onSuccess: (result) => ({ _tag: "Right" as const, right: result }),
      }),
    );
  if (executed._tag === "Left") {
    return executed.left.retryable
      ? ({ type: "retry", error: executed.left.message } as const)
      : permanentFailure(executed.left.message);
  }

  const output = executed.right as unknown as Schema.Json;
  if (executed.right.exitCode !== 0) {
    const stderr = executed.right.stderr.trim().slice(0, 2_000);
    const message =
      stderr.length > 0
        ? `Scoped shell '${executed.right.allowlistId}' exited ${executed.right.exitCode}: ${stderr}`
        : `Scoped shell '${executed.right.allowlistId}' exited ${executed.right.exitCode}.`;
    return executed.right.retryable && executed.right.idempotent
      ? ({ type: "retry", error: message } as const)
      : ({ type: "failed", error: message, output } as const);
  }
  return { type: "succeeded", output } as const;
});

/**
 * V1 executor for deterministic local nodes and explicitly scoped services.
 * Agent work enters the same durable routing, approval, isolation, and Run
 * recovery path as an interactive command. Shell nodes receive authority only
 * from the owner-only runtime allowlist resolved by their exact identifier.
 */
export function makeSafeAutomationNodeExecutor(dependencies: AutomationNodeExecutorDependencies) {
  return (context: AutomationNodeExecutionContext) => {
    switch (context.node.kind) {
      case "condition":
        return Effect.succeed(executeCondition(context));
      case "transform":
        return Effect.succeed(executeTransform(context));
      case "foreach":
        return Effect.succeed(executeForeach(context));
      case "item.mutate":
        return executeItemMutation(context, dependencies);
      case "connector.read":
        return executeConnectorRead(context, dependencies);
      case "connector.write":
        return executeConnectorWrite(context, dependencies);
      case "agent.run":
        return executeAgentRun(context, dependencies);
      case "shell.scoped":
        return executeScopedShell(context, dependencies);
      case "delay":
      case "approval":
        return Effect.succeed(
          permanentFailure(`Node '${context.node.id}' must be handled by the durable runtime.`),
        );
    }
  };
}

export const AUTOMATION_V1_NODE_POLICY = {
  automatic: ["condition", "transform", "foreach", "item.mutate", "connector.read", "shell.scoped"],
  routed: ["agent.run"],
  runtimeManaged: ["delay", "approval"],
  blocked: [],
} as const;
