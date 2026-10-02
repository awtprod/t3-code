import {
  Automation,
  type Automation as AutomationType,
  type AutomationNode as AutomationNodeType,
} from "@command-center/core";
import * as NodeCrypto from "node:crypto";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { canonicalJson } from "./Digest.ts";
import {
  type AutomationDefinition,
  type AutomationFileNode,
  AUTOMATION_DEFINITION_SCHEMA_VERSION,
} from "./Definition.ts";
import { planAutomationExecution } from "./Planner.ts";

export const AutomationRuntimeExecutionState = Schema.Literals([
  "queued",
  "running",
  "waiting_retry",
  "waiting_delay",
  "waiting_external",
  "waiting_approval",
  "succeeded",
  "failed",
  "canceled",
]);
export type AutomationRuntimeExecutionState = typeof AutomationRuntimeExecutionState.Type;

export const AutomationCheckpointState = Schema.Literals([
  "pending",
  "running",
  "waiting_retry",
  "waiting_delay",
  "waiting_external",
  "waiting_approval",
  "succeeded",
  "failed",
  "skipped",
]);
export type AutomationCheckpointState = typeof AutomationCheckpointState.Type;

export const AutomationRuntimeErrorCode = Schema.Literals([
  "automation-not-found",
  "automation-disabled",
  "automation-paused",
  "automation-uncommitted",
  "definition-mismatch",
  "definition-invalid",
  "execution-not-found",
  "idempotency-conflict",
  "admission-conflict",
  "lease-denied",
  "lease-lost",
  "invalid-state",
  "signal-mismatch",
]);
export type AutomationRuntimeErrorCode = typeof AutomationRuntimeErrorCode.Type;

export class AutomationRuntimeError extends Schema.TaggedErrorClass<AutomationRuntimeError>()(
  "AutomationRuntimeError",
  {
    code: AutomationRuntimeErrorCode,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface AutomationExecutionLease {
  readonly executionId: string;
  readonly owner: string;
  readonly token: string;
  readonly generation: number;
  readonly expiresAt: string;
}

export interface AutomationNodeCheckpoint {
  readonly nodeId: string;
  readonly nodeKind: string;
  readonly state: AutomationCheckpointState;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly executorIdempotencyKey: string | null;
  readonly scopedShellPolicyDigest: string | null;
  readonly waitingUntil: string | null;
  readonly resumeKey: string | null;
  readonly resolutionKey: string | null;
  readonly output: Schema.Json | null;
  readonly error: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly updatedAt: string;
}

export interface AutomationExecutionSnapshot {
  readonly id: string;
  readonly automationId: string;
  readonly idempotencyKey: string;
  readonly workIdentity: string;
  readonly spaceId: string;
  readonly configCommitSha: string;
  readonly definitionDigest: string;
  readonly state: AutomationRuntimeExecutionState;
  readonly input: Readonly<Record<string, Schema.Json>>;
  readonly lease: AutomationExecutionLease | null;
  readonly checkpoints: ReadonlyArray<AutomationNodeCheckpoint>;
  readonly output: Schema.Json | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
}

export interface AutomationCanonicalFailure {
  readonly canonicalCode: string;
  readonly resource: string;
  readonly subject: string;
}

export interface AutomationFailureResolutionScope {
  readonly resource: string;
  readonly subject: string;
}

export type AutomationNodeExecutionOutcome =
  | {
      readonly type: "succeeded";
      readonly output?: Schema.Json;
      readonly resolvedFailureScopes?: ReadonlyArray<AutomationFailureResolutionScope>;
    }
  | {
      readonly type: "failed";
      readonly error: string;
      readonly output?: Schema.Json;
      readonly failure?: AutomationCanonicalFailure;
    }
  | {
      readonly type: "retry";
      readonly error: string;
      readonly retryAfterMs?: number;
      readonly failure?: AutomationCanonicalFailure;
    }
  | {
      readonly type: "wait";
      readonly resumeKey: string;
      readonly output?: Schema.Json;
    }
  | {
      readonly type: "approval";
      readonly approvalKey: string;
      readonly output?: Schema.Json;
    };

export interface AutomationNodeExecutionContext {
  readonly executionId: string;
  readonly automationId: string;
  readonly spaceId: string;
  readonly configCommitSha: string;
  readonly definitionDigest: string;
  readonly node: AutomationFileNode;
  readonly attempt: number;
  readonly idempotencyKey: string;
  readonly runInput: Readonly<Record<string, Schema.Json>>;
  readonly predecessorOutputs: Readonly<Record<string, Schema.Json | null>>;
}

export type AutomationNodeExecutor = (
  context: AutomationNodeExecutionContext,
) => Effect.Effect<AutomationNodeExecutionOutcome, string>;

export interface AutomationRuntimeDependencies {
  readonly executeNode: AutomationNodeExecutor;
  readonly now: Effect.Effect<string>;
  readonly randomUUID: Effect.Effect<string>;
  readonly defaultMaxAttempts?: number;
  readonly defaultRetryDelayMs?: number;
  /** Lease length callers acquire with; a running step renews it at a third. */
  readonly leaseTtlMs?: number;
}

export interface StartAutomationExecutionInput {
  readonly automationId: string;
  readonly expectedSpaceId?: string;
  readonly idempotencyKey: string;
  readonly expectedConfigCommitSha: string;
  readonly expectedDefinitionDigest: string;
  readonly input?: Readonly<Record<string, Schema.Json>>;
  /**
   * "same-input": refuse, instead of joining, an active execution whose run
   * input differs; nothing is written. Default joins any active execution.
   */
  readonly coalesce?: "any" | "same-input";
}

export interface AcquireAutomationLeaseInput {
  readonly executionId: string;
  readonly owner: string;
  readonly ttlMs: number;
}

export interface AutomationLeaseCommandInput {
  readonly executionId: string;
  readonly owner: string;
  readonly token: string;
}

export interface ResumeAutomationWaitInput {
  readonly executionId: string;
  readonly nodeId: string;
  readonly resumeKey: string;
  readonly resolutionKey: string;
  readonly output?: Schema.Json;
}

export interface ResolveAutomationWaitInput extends ResumeAutomationWaitInput {
  readonly outcome: "succeeded" | "failed" | "canceled";
  readonly error?: string;
}

export interface ResolveAutomationApprovalInput {
  readonly executionId: string;
  readonly nodeId: string;
  readonly approvalKey: string;
  readonly resolutionKey: string;
  readonly approved: boolean;
  readonly output?: Schema.Json;
}

type RuntimeFailure = AutomationRuntimeError | SqlError;

export interface AutomationRuntimeShape {
  readonly start: (
    input: StartAutomationExecutionInput,
  ) => Effect.Effect<AutomationExecutionSnapshot, RuntimeFailure>;
  /** The runtime's clock: the same source as execution timestamps. */
  readonly now: Effect.Effect<string>;
  readonly get: (executionId: string) => Effect.Effect<AutomationExecutionSnapshot, RuntimeFailure>;
  readonly listRecoverable: (input?: {
    readonly limit?: number;
    /** Only executions created at or after this time (recovery hold). */
    readonly createdAtOrAfter?: string;
  }) => Effect.Effect<ReadonlyArray<AutomationExecutionSnapshot>, RuntimeFailure>;
  readonly listWaitingExternal: (input?: {
    readonly limit?: number;
    /** Only executions created at or after this time (recovery hold). */
    readonly createdAtOrAfter?: string;
  }) => Effect.Effect<ReadonlyArray<AutomationExecutionSnapshot>, RuntimeFailure>;
  readonly reconcileActiveSlots: (input?: {
    readonly limit?: number;
  }) => Effect.Effect<number, RuntimeFailure>;
  readonly acquireLease: (
    input: AcquireAutomationLeaseInput,
  ) => Effect.Effect<AutomationExecutionLease, RuntimeFailure>;
  readonly renewLease: (
    input: AutomationLeaseCommandInput & { readonly ttlMs: number },
  ) => Effect.Effect<AutomationExecutionLease, RuntimeFailure>;
  readonly releaseLease: (
    input: AutomationLeaseCommandInput,
  ) => Effect.Effect<void, RuntimeFailure>;
  readonly advance: (
    input: AutomationLeaseCommandInput,
  ) => Effect.Effect<AutomationExecutionSnapshot, RuntimeFailure>;
  readonly resumeWait: (
    input: ResumeAutomationWaitInput,
  ) => Effect.Effect<AutomationExecutionSnapshot, RuntimeFailure>;
  readonly resolveWait: (
    input: ResolveAutomationWaitInput,
  ) => Effect.Effect<AutomationExecutionSnapshot, RuntimeFailure>;
  readonly resolveApproval: (
    input: ResolveAutomationApprovalInput,
  ) => Effect.Effect<AutomationExecutionSnapshot, RuntimeFailure>;
}

export class AutomationRuntime extends Context.Service<AutomationRuntime, AutomationRuntimeShape>()(
  "@awtprod/command-center/command-center/automation/Runtime/AutomationRuntime",
) {}

interface StoredAutomationRow {
  readonly id: string;
  readonly spaceId: string;
  readonly enabled: number;
  readonly commitSha: string;
  readonly definitionDigest: string;
  readonly definitionJson: string;
}

interface AdmissionRow {
  readonly executionId: string;
  readonly automationId: string;
  readonly spaceId: string;
  readonly configCommitSha: string;
  readonly definitionDigest: string;
  readonly inputJson: string;
}

interface ExecutionRow {
  readonly id: string;
  readonly automationId: string;
  readonly idempotencyKey: string;
  readonly workIdentity: string | null;
  readonly spaceId: string;
  readonly configCommitSha: string;
  readonly definitionDigest: string;
  readonly definitionJson: string;
  readonly inputJson: string;
  readonly state: AutomationRuntimeExecutionState;
  readonly leaseOwner: string | null;
  readonly leaseToken: string | null;
  readonly leaseGeneration: number;
  readonly leaseAcquiredAt: string | null;
  readonly leaseExpiresAt: string | null;
  readonly outputJson: string | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
}

interface CheckpointRow {
  readonly executionId: string;
  readonly nodeId: string;
  readonly nodeKind: string;
  readonly state: AutomationCheckpointState;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly executorIdempotencyKey: string | null;
  readonly scopedShellPolicyDigest: string | null;
  readonly leaseToken: string | null;
  readonly waitingUntil: string | null;
  readonly resumeKey: string | null;
  readonly resolutionKey: string | null;
  readonly inputJson: string | null;
  readonly outputJson: string | null;
  readonly error: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly updatedAt: string;
}

const COMMIT_SHA_PATTERN = /^[a-f0-9]{40,64}$/u;
const DEFINITION_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const BOUNDED_RUNTIME_ID_PATTERN = /^[\P{Cc}]{1,500}$/u;
const CANONICAL_FAILURE_CODE_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const BoundedFailureIdentity = Schema.String.check(
  Schema.isPattern(BOUNDED_RUNTIME_ID_PATTERN),
  Schema.isMaxLength(200),
);
const CanonicalFailure = Schema.Struct({
  canonicalCode: Schema.String.check(Schema.isPattern(CANONICAL_FAILURE_CODE_PATTERN)),
  resource: BoundedFailureIdentity,
  subject: BoundedFailureIdentity,
});
const FailureResolutionScope = Schema.Struct({
  resource: BoundedFailureIdentity,
  subject: BoundedFailureIdentity,
});
const StartAutomationExecution = Schema.Struct({
  coalesce: Schema.optionalKey(Schema.Literals(["any", "same-input"])),
  automationId: Schema.String.check(
    Schema.isPattern(BOUNDED_RUNTIME_ID_PATTERN),
    Schema.isMaxLength(200),
  ),
  expectedSpaceId: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(BOUNDED_RUNTIME_ID_PATTERN), Schema.isMaxLength(200)),
  ),
  idempotencyKey: Schema.String.check(Schema.isPattern(BOUNDED_RUNTIME_ID_PATTERN)),
  expectedConfigCommitSha: Schema.String.check(
    Schema.isPattern(BOUNDED_RUNTIME_ID_PATTERN),
    Schema.isMaxLength(128),
  ),
  expectedDefinitionDigest: Schema.String.check(
    Schema.isPattern(BOUNDED_RUNTIME_ID_PATTERN),
    Schema.isMaxLength(128),
  ),
  input: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});
const TERMINAL_EXECUTION_STATES = new Set<AutomationRuntimeExecutionState>([
  "succeeded",
  "failed",
  "canceled",
]);
const decodeUnknownJsonString = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeAutomation = Schema.decodeUnknownEffect(Automation);
const decodeStartAutomationExecution = Schema.decodeUnknownEffect(StartAutomationExecution);
const isCanonicalFailure = Schema.is(CanonicalFailure);
const isFailureResolutionScope = Schema.is(FailureResolutionScope);

/**
 * Operator hold for automation recovery (default off). While set, executions
 * created before this process started are not resumed by any path: recovery
 * ticks, new admissions that coalesce onto them, or approval application.
 * See docs/operations/automation-recovery-hold.md.
 */
export const AUTOMATION_RECOVERY_HOLD_ENV = "COMMAND_CENTER_AUTOMATION_RECOVERY_HOLD";

/** Unset or false-like means not held; any other value holds (fails closed). */
export const readAutomationRecoveryHold = Effect.gen(function* () {
  const raw = yield* Config.string(AUTOMATION_RECOVERY_HOLD_ENV).pipe(
    Config.withDefault(""),
    Effect.orElseSucceed(() => "true"),
  );
  const value = raw.trim().toLowerCase();
  return value !== "" && !["0", "false", "no", "off", "n"].includes(value);
});

/** Backoff between attempts after a transient lease-renewal error. */
const LEASE_RENEW_RETRY_MS = 1_000;

/** Lease length for one automation drive; renewed while a step executes. */
export const AUTOMATION_LEASE_TTL_MS = 30_000;

/**
 * Node kinds whose step may run again after its executor was interrupted
 * (worker killed, or stalled past its lease) without risking a second external
 * effect: pure steps, reads, and executors keyed by the durable per-attempt
 * idempotency key or a deterministic command id. Anything else is failed
 * closed with an "outcome is unknown" error for a human to reconcile; the
 * runtime cannot fence an effect that already left the process.
 */
const REEXECUTION_SAFE_NODE_KINDS: ReadonlySet<string> = new Set([
  "condition",
  "transform",
  "foreach",
  "connector.read",
  "item.mutate",
  "agent.run",
  "repository.checks",
]);

const isReexecutionSafe = (node: { readonly kind: string; readonly config: unknown }) =>
  REEXECUTION_SAFE_NODE_KINDS.has(node.kind) ||
  // The Inbox Gmail draft executor claims its receipt before calling Gmail and
  // refuses a claimed or uncertain receipt, so a re-run cannot draft twice.
  (node.kind === "connector.write" &&
    typeof node.config === "object" &&
    node.config !== null &&
    (node.config as { readonly source?: unknown }).source === "inbox.accepted");

const runtimeError = (code: AutomationRuntimeErrorCode, detail: string) =>
  new AutomationRuntimeError({ code, detail });

const parseJson = Effect.fn("AutomationRuntime.parseJson")(function* (source: string) {
  return yield* decodeUnknownJsonString(source).pipe(
    Effect.mapError(() => runtimeError("definition-invalid", "Stored runtime JSON is invalid.")),
  );
});

function stringifyJson(value: Schema.Json): string {
  return canonicalJson(value);
}

function responsibilityWorkIdentity(spaceId: string, automationId: string): string {
  return `responsibility:v1:${spaceId}:${automationId}`;
}

export function sanitizeIncidentError(error: string): string {
  const withoutControls = Array.from(error, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || (codePoint >= 127 && codePoint <= 159) ? " " : character;
  }).join("");
  const sanitized = withoutControls.replace(/\s+/gu, " ").trim().slice(0, 500);
  return sanitized.length === 0 ? "Automation execution failed." : sanitized;
}

export function responsibilityIncidentId(input: {
  readonly spaceId: string;
  readonly automationId: string;
  readonly canonicalCode: string;
  readonly resource: string;
  readonly subject: string;
}): string {
  return `responsibility-incident:${NodeCrypto.createHash("sha256")
    .update(
      `${input.spaceId}\n${input.automationId}\n${input.canonicalCode}\n${input.resource}\n${input.subject}`,
    )
    .digest("hex")}`;
}

function fallbackCanonicalFailure(error: string, transient: boolean): AutomationCanonicalFailure {
  const bounded = sanitizeIncidentError(error).toLowerCase();
  const category = /credential|token|auth(?:entication|orization)?|permission|forbidden/u.test(
    bounded,
  )
    ? "credential"
    : /malformed|invalid|schema|parse|required|unsupported/u.test(bounded)
      ? "invalid-input"
      : /timeout|timed out|deadline/u.test(bounded)
        ? "timeout"
        : /unavailable|connection|network|provider/u.test(bounded)
          ? "unavailable"
          : "unknown";
  const template = bounded
    .replace(/https?:\/\/\S+/gu, "<url>")
    .replace(/[\w.+-]+@[\w.-]+/gu, "<email>")
    .replace(/[a-z0-9_./:+-]{16,}/gu, "<value>")
    .replace(/\b\d+\b/gu, "#")
    .slice(0, 160);
  const fingerprint = NodeCrypto.createHash("sha256").update(template).digest("hex").slice(0, 12);
  return {
    canonicalCode: `node-${transient ? "transient" : "failed"}-${category}:${fingerprint}`,
    resource: "automation-node",
    subject: "unknown",
  };
}

function addMilliseconds(iso: string, milliseconds: number): string {
  return DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(iso), { milliseconds }));
}

function positiveBoundedInteger(value: unknown, fallback: number, maximum: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback;
}

function nonNegativeBoundedNumber(value: unknown, fallback: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(value, maximum)
    : fallback;
}

function toExecutionDefinition(automation: AutomationType): AutomationDefinition {
  const trigger =
    automation.trigger.type === "manual"
      ? ({ kind: "manual" } as const)
      : automation.trigger.type === "schedule"
        ? ({
            kind: "schedule",
            expression: automation.trigger.expression,
            timezone: automation.trigger.timezone,
          } as const)
        : ({ kind: "webhook", route: automation.trigger.route } as const);

  return {
    schemaVersion: AUTOMATION_DEFINITION_SCHEMA_VERSION,
    id: automation.id,
    name: automation.name,
    spaceId: automation.spaceId,
    enabled: automation.enabled,
    trigger,
    nodes: automation.nodes.map((node) => ({
      id: node.id,
      kind: node.kind === "agent" ? "agent.run" : node.kind,
      config: node.config as Readonly<Record<string, Schema.Json>>,
    })),
    edges: automation.edges.map((edge) => ({
      from: edge.sourceNodeId,
      to: edge.targetNodeId,
    })),
    layout: {
      positions: Object.fromEntries(
        automation.nodes.map((node) => [node.id, node.position] as const),
      ),
    },
    policy: {},
  };
}

function checkpointMaxAttempts(node: AutomationNodeType, fallback: number): number {
  if (node.kind === "delay" || node.kind === "approval" || node.kind === "agent") {
    return 1;
  }
  return positiveBoundedInteger(
    node.config.maxAttempts,
    positiveBoundedInteger(node.config.retries, fallback - 1, 19) + 1,
    20,
  );
}

function executorInput(
  execution: ExecutionRow,
  definition: AutomationDefinition,
  node: AutomationFileNode,
  checkpoint: CheckpointRow,
  checkpoints: ReadonlyArray<CheckpointRow>,
  runInput: Readonly<Record<string, Schema.Json>>,
): AutomationNodeExecutionContext {
  const predecessorIds = definition.edges
    .filter((edge) => edge.to === node.id)
    .map((edge) => edge.from)
    .sort();
  const checkpointsById = new Map(checkpoints.map((current) => [current.nodeId, current]));
  const predecessorOutputs = Object.fromEntries(
    predecessorIds.map((nodeId) => {
      const output = checkpointsById.get(nodeId)?.outputJson;
      return [nodeId, output === null || output === undefined ? null : output] as const;
    }),
  );

  return {
    executionId: execution.id,
    automationId: execution.automationId,
    spaceId: execution.spaceId,
    configCommitSha: execution.configCommitSha,
    definitionDigest: execution.definitionDigest,
    node,
    attempt: checkpoint.attemptCount,
    idempotencyKey: checkpoint.executorIdempotencyKey!,
    runInput,
    predecessorOutputs: predecessorOutputs as Readonly<Record<string, Schema.Json | null>>,
  };
}

export const make = Effect.fn("AutomationRuntime.make")(function* (
  dependencies: AutomationRuntimeDependencies,
) {
  const sql = yield* SqlClient.SqlClient;
  const defaultMaxAttempts = positiveBoundedInteger(dependencies.defaultMaxAttempts, 3, 20);
  const defaultRetryDelayMs = nonNegativeBoundedNumber(
    dependencies.defaultRetryDelayMs,
    1_000,
    86_400_000,
  );
  const leaseTtlMs = positiveBoundedInteger(
    dependencies.leaseTtlMs,
    AUTOMATION_LEASE_TTL_MS,
    3_600_000,
  );
  const leaseRenewEveryMs = Math.max(1_000, Math.floor(leaseTtlMs / 3));

  const readExecutionRow = Effect.fn("AutomationRuntime.readExecutionRow")(function* (
    executionId: string,
  ) {
    const rows = yield* sql<ExecutionRow>`
      SELECT id, automation_id AS "automationId", idempotency_key AS "idempotencyKey",
        work_identity AS "workIdentity",
        space_id AS "spaceId", config_commit_sha AS "configCommitSha",
        definition_digest AS "definitionDigest", definition_json AS "definitionJson",
        input_json AS "inputJson", state, lease_owner AS "leaseOwner",
        lease_token AS "leaseToken", lease_generation AS "leaseGeneration",
        lease_acquired_at AS "leaseAcquiredAt", lease_expires_at AS "leaseExpiresAt",
        output_json AS "outputJson", error, created_at AS "createdAt",
        updated_at AS "updatedAt", finished_at AS "finishedAt"
      FROM command_center_automation_executions
      WHERE id = ${executionId}
      LIMIT 1
    `;
    const row = rows[0];
    if (row === undefined) {
      return yield* runtimeError(
        "execution-not-found",
        `Automation execution '${executionId}' was not found.`,
      );
    }
    return row;
  });

  const readCheckpointRows = Effect.fn("AutomationRuntime.readCheckpointRows")(function* (
    executionId: string,
  ) {
    return yield* sql<CheckpointRow>`
      SELECT execution_id AS "executionId", node_id AS "nodeId", node_kind AS "nodeKind",
        state, attempt_count AS "attemptCount", max_attempts AS "maxAttempts",
        executor_idempotency_key AS "executorIdempotencyKey", lease_token AS "leaseToken",
        scoped_shell_policy_digest AS "scopedShellPolicyDigest",
        waiting_until AS "waitingUntil", resume_key AS "resumeKey",
        resolution_key AS "resolutionKey", input_json AS "inputJson",
        output_json AS "outputJson", error, started_at AS "startedAt",
        finished_at AS "finishedAt", updated_at AS "updatedAt"
      FROM command_center_automation_node_checkpoints
      WHERE execution_id = ${executionId}
      ORDER BY node_id
    `;
  });

  const decodeJsonOrNull = Effect.fn("AutomationRuntime.decodeJsonOrNull")(function* (
    source: string | null,
  ) {
    return source === null ? null : ((yield* parseJson(source)) as Schema.Json);
  });

  const snapshotFromRows = Effect.fn("AutomationRuntime.snapshotFromRows")(function* (
    row: ExecutionRow,
    checkpointRows: ReadonlyArray<CheckpointRow>,
  ) {
    const input = (yield* parseJson(row.inputJson)) as Readonly<Record<string, Schema.Json>>;
    const output = yield* decodeJsonOrNull(row.outputJson);
    const checkpoints = yield* Effect.forEach(checkpointRows, (checkpoint) =>
      Effect.map(decodeJsonOrNull(checkpoint.outputJson), (checkpointOutput) => ({
        nodeId: checkpoint.nodeId,
        nodeKind: checkpoint.nodeKind,
        state: checkpoint.state,
        attemptCount: checkpoint.attemptCount,
        maxAttempts: checkpoint.maxAttempts,
        executorIdempotencyKey: checkpoint.executorIdempotencyKey,
        scopedShellPolicyDigest: checkpoint.scopedShellPolicyDigest,
        waitingUntil: checkpoint.waitingUntil,
        resumeKey: checkpoint.resumeKey,
        resolutionKey: checkpoint.resolutionKey,
        output: checkpointOutput,
        error: checkpoint.error,
        startedAt: checkpoint.startedAt,
        finishedAt: checkpoint.finishedAt,
        updatedAt: checkpoint.updatedAt,
      })),
    );
    const lease =
      row.leaseOwner !== null && row.leaseToken !== null && row.leaseExpiresAt !== null
        ? {
            executionId: row.id,
            owner: row.leaseOwner,
            token: row.leaseToken,
            generation: row.leaseGeneration,
            expiresAt: row.leaseExpiresAt,
          }
        : null;
    return {
      id: row.id,
      automationId: row.automationId,
      idempotencyKey: row.idempotencyKey,
      workIdentity: row.workIdentity ?? responsibilityWorkIdentity(row.spaceId, row.automationId),
      spaceId: row.spaceId,
      configCommitSha: row.configCommitSha,
      definitionDigest: row.definitionDigest,
      state: row.state,
      input,
      lease,
      checkpoints,
      output,
      error: row.error,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      finishedAt: row.finishedAt,
    } satisfies AutomationExecutionSnapshot;
  });

  const get = Effect.fn("AutomationRuntime.get")(function* (executionId: string) {
    // One transaction so the execution row and its checkpoints describe the
    // same moment; a torn read could pair a waiting execution with an
    // already-resolved checkpoint.
    const [row, checkpoints] = yield* sql.withTransaction(
      Effect.all([readExecutionRow(executionId), readCheckpointRows(executionId)]),
    );
    return yield* snapshotFromRows(row, checkpoints);
  });

  const listRecoverable = Effect.fn("AutomationRuntime.listRecoverable")(function* (
    input: { readonly limit?: number; readonly createdAtOrAfter?: string } = {},
  ) {
    const now = yield* dependencies.now;
    const limit = positiveBoundedInteger(input.limit, 50, 500);
    const rows = yield* sql<{ readonly id: string }>`
      SELECT execution.id
      FROM command_center_automation_executions execution
      WHERE
        (execution.lease_token IS NULL OR execution.lease_expires_at IS NULL
          OR execution.lease_expires_at <= ${now})
        AND execution.created_at >= ${input.createdAtOrAfter ?? ""}
        AND (
          execution.state IN ('queued', 'running')
          OR (
            execution.state IN ('waiting_retry', 'waiting_delay')
            AND EXISTS (
              SELECT 1
              FROM command_center_automation_node_checkpoints checkpoint
              WHERE checkpoint.execution_id = execution.id
                AND checkpoint.state = execution.state
                AND checkpoint.waiting_until IS NOT NULL
                AND checkpoint.waiting_until <= ${now}
            )
          )
        )
      ORDER BY execution.updated_at, execution.id
      LIMIT ${limit}
    `;
    return yield* Effect.forEach(rows, (row) => get(row.id));
  });

  const listWaitingExternal = Effect.fn("AutomationRuntime.listWaitingExternal")(function* (
    input: { readonly limit?: number; readonly createdAtOrAfter?: string } = {},
  ) {
    const limit = positiveBoundedInteger(input.limit, 50, 500);
    const rows = yield* sql<{ readonly id: string }>`
      SELECT execution.id
      FROM command_center_automation_executions execution
      WHERE execution.state = 'waiting_external'
        AND execution.created_at >= ${input.createdAtOrAfter ?? ""}
        AND EXISTS (
          SELECT 1
          FROM command_center_automation_node_checkpoints checkpoint
          WHERE checkpoint.execution_id = execution.id
            AND checkpoint.state = 'waiting_external'
            AND checkpoint.node_kind = 'agent'
        )
      ORDER BY execution.updated_at, execution.id
      LIMIT ${limit}
    `;
    return yield* Effect.forEach(rows, (row) => get(row.id));
  });

  const reconcileActiveSlots = Effect.fn("AutomationRuntime.reconcileActiveSlots")(function* (
    input: { readonly limit?: number } = {},
  ) {
    const limit = positiveBoundedInteger(input.limit, 50, 500);
    const stale = yield* sql<{ readonly automationId: string }>`
      SELECT slot.automation_id AS "automationId"
      FROM command_center_responsibility_active_slots slot
      LEFT JOIN command_center_automation_executions execution ON execution.id = slot.execution_id
      WHERE execution.id IS NULL OR execution.state IN ('succeeded', 'failed', 'canceled')
      ORDER BY slot.claimed_at, slot.automation_id
      LIMIT ${limit}
    `;
    for (const row of stale) {
      yield* sql`
        DELETE FROM command_center_responsibility_active_slots
        WHERE automation_id = ${row.automationId}
      `;
    }
    const missing = yield* sql<{
      readonly automationId: string;
      readonly spaceId: string;
      readonly workIdentity: string | null;
      readonly executionId: string;
      readonly claimedAt: string;
    }>`
      SELECT execution.automation_id AS "automationId", execution.space_id AS "spaceId",
        execution.work_identity AS "workIdentity", execution.id AS "executionId",
        execution.created_at AS "claimedAt"
      FROM command_center_automation_executions execution
      LEFT JOIN command_center_responsibility_active_slots slot
        ON slot.automation_id = execution.automation_id
      WHERE execution.state NOT IN ('succeeded', 'failed', 'canceled')
        AND slot.automation_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM command_center_automation_executions newer
          WHERE newer.automation_id = execution.automation_id
            AND newer.state NOT IN ('succeeded', 'failed', 'canceled')
            AND (newer.created_at > execution.created_at
              OR (newer.created_at = execution.created_at AND newer.id > execution.id))
        )
      ORDER BY execution.created_at, execution.id
      LIMIT ${limit}
    `;
    for (const row of missing) {
      yield* sql`
        INSERT OR IGNORE INTO command_center_responsibility_active_slots (
          automation_id, space_id, work_identity, execution_id, claimed_at
        ) VALUES (
          ${row.automationId}, ${row.spaceId},
          ${row.workIdentity ?? responsibilityWorkIdentity(row.spaceId, row.automationId)},
          ${row.executionId}, ${row.claimedAt}
        )
      `;
    }
    return stale.length + missing.length;
  });

  const readDefinition = Effect.fn("AutomationRuntime.readDefinition")(function* (source: string) {
    const parsed = yield* parseJson(source);
    const automation = yield* decodeAutomation(parsed).pipe(
      Effect.mapError(() =>
        runtimeError("definition-invalid", "The pinned automation definition is invalid."),
      ),
    );
    const definition = toExecutionDefinition(automation);
    const plan = planAutomationExecution(definition);
    if (!plan.ok) {
      return yield* runtimeError(
        "definition-invalid",
        `The pinned automation graph is invalid: ${plan.issues.map((issue) => issue.message).join("; ")}`,
      );
    }
    return { automation, definition };
  });

  const start = Effect.fn("AutomationRuntime.start")(function* (
    rawInput: StartAutomationExecutionInput,
  ) {
    const input = yield* decodeStartAutomationExecution(rawInput).pipe(
      Effect.mapError(() =>
        runtimeError("definition-invalid", "The automation start request is invalid."),
      ),
    );
    const runInput = input.input ?? {};
    const inputJson = stringifyJson(runInput);
    const executionId = yield* dependencies.randomUUID;
    const now = yield* dependencies.now;
    const admitted = yield* sql.withTransaction(
      Effect.gen(function* () {
        const existing = yield* sql<AdmissionRow>`
          SELECT execution_id AS "executionId", automation_id AS "automationId",
            space_id AS "spaceId", config_commit_sha AS "configCommitSha",
            definition_digest AS "definitionDigest", input_json AS "inputJson"
          FROM command_center_responsibility_admissions
          WHERE idempotency_key = ${input.idempotencyKey}
          LIMIT 1
        `;
        if (existing[0] !== undefined) {
          const row = existing[0];
          if (
            row.automationId !== input.automationId ||
            (input.expectedSpaceId !== undefined && row.spaceId !== input.expectedSpaceId) ||
            row.configCommitSha !== input.expectedConfigCommitSha ||
            row.definitionDigest !== input.expectedDefinitionDigest ||
            row.inputJson !== inputJson
          ) {
            return yield* runtimeError(
              "idempotency-conflict",
              `Idempotency key '${input.idempotencyKey}' is already bound to another execution request.`,
            );
          }
          return { kind: "existing" as const, executionId: row.executionId };
        }

        const rows = yield* sql<StoredAutomationRow>`
          SELECT id, space_id AS "spaceId", enabled, commit_sha AS "commitSha",
            definition_digest AS "definitionDigest", definition_json AS "definitionJson"
          FROM command_center_automations
          WHERE id = ${input.automationId}
          LIMIT 1
        `;
        const stored = rows[0];
        if (
          stored === undefined ||
          (input.expectedSpaceId !== undefined && stored.spaceId !== input.expectedSpaceId)
        ) {
          return yield* runtimeError(
            "automation-not-found",
            `Automation '${input.automationId}' was not found in the requested Space.`,
          );
        }
        if (stored.enabled !== 1) {
          return yield* runtimeError(
            "automation-disabled",
            `Automation '${input.automationId}' is disabled.`,
          );
        }
        if (
          !COMMIT_SHA_PATTERN.test(stored.commitSha) ||
          !DEFINITION_DIGEST_PATTERN.test(stored.definitionDigest)
        ) {
          return yield* runtimeError(
            "automation-uncommitted",
            `Automation '${input.automationId}' is not pinned to a committed definition.`,
          );
        }
        if (
          stored.commitSha !== input.expectedConfigCommitSha ||
          stored.definitionDigest !== input.expectedDefinitionDigest
        ) {
          return yield* runtimeError(
            "definition-mismatch",
            `Automation '${input.automationId}' changed after it was selected.`,
          );
        }

        const { automation, definition } = yield* readDefinition(stored.definitionJson);
        if (
          automation.id !== stored.id ||
          automation.spaceId !== stored.spaceId ||
          automation.enabled !== true ||
          automation.configCommit !== stored.commitSha ||
          automation.definitionDigest !== stored.definitionDigest ||
          definition.nodes.length !== automation.nodes.length
        ) {
          return yield* runtimeError(
            "definition-mismatch",
            `Automation '${input.automationId}' metadata does not match its pinned definition.`,
          );
        }

        const controls = yield* sql<{ readonly paused: number }>`
          SELECT paused
          FROM command_center_responsibility_controls
          WHERE space_id = ${stored.spaceId} AND automation_id = ${stored.id}
          LIMIT 1
        `;
        if (controls[0]?.paused === 1) {
          yield* sql`
            INSERT INTO command_center_responsibility_status (
              space_id, automation_id, last_admission_attempt_at,
              last_admission_status, updated_at
            ) VALUES (${stored.spaceId}, ${stored.id}, ${now}, 'paused', ${now})
            ON CONFLICT(space_id, automation_id) DO UPDATE SET
              last_admission_attempt_at = excluded.last_admission_attempt_at,
              last_admission_status = excluded.last_admission_status,
              updated_at = excluded.updated_at
          `;
          return { kind: "paused" as const, automationId: stored.id };
        }

        const slots = yield* sql<{
          readonly executionId: string;
          readonly state: string;
          readonly inputJson: string;
        }>`
          SELECT slot.execution_id AS "executionId", execution.state,
            execution.input_json AS "inputJson"
          FROM command_center_responsibility_active_slots slot
          JOIN command_center_automation_executions execution ON execution.id = slot.execution_id
          WHERE slot.automation_id = ${stored.id} AND slot.space_id = ${stored.spaceId}
          LIMIT 1
        `;
        const active = slots[0];
        if (
          active !== undefined &&
          !TERMINAL_EXECUTION_STATES.has(active.state as AutomationRuntimeExecutionState)
        ) {
          // Checked in the admission transaction itself, so no concurrent
          // admission can slip between a caller's check and this join.
          if (input.coalesce === "same-input" && active.inputJson !== inputJson) {
            return yield* runtimeError(
              "admission-conflict",
              `Automation '${stored.id}' is busy with execution '${active.executionId}' for different input.`,
            );
          }
          yield* sql`
            INSERT INTO command_center_responsibility_admissions (
              idempotency_key, execution_id, automation_id, space_id, config_commit_sha,
              definition_digest, input_json, accepted_at
            ) VALUES (
              ${input.idempotencyKey}, ${active.executionId}, ${stored.id}, ${stored.spaceId},
              ${stored.commitSha}, ${stored.definitionDigest}, ${inputJson}, ${now}
            )
          `;
          yield* sql`
            INSERT INTO command_center_responsibility_status (
              space_id, automation_id, last_admission_attempt_at, last_admission_status,
              last_attempted_execution_id, current_execution_id, updated_at
            ) VALUES (
              ${stored.spaceId}, ${stored.id}, ${now}, 'admitted',
              ${active.executionId}, ${active.executionId}, ${now}
            )
            ON CONFLICT(space_id, automation_id) DO UPDATE SET
              last_admission_attempt_at = excluded.last_admission_attempt_at,
              last_admission_status = excluded.last_admission_status,
              last_attempted_execution_id = excluded.last_attempted_execution_id,
              current_execution_id = excluded.current_execution_id,
              updated_at = excluded.updated_at
          `;
          return { kind: "existing" as const, executionId: active.executionId };
        }
        if (active !== undefined) {
          yield* sql`
            DELETE FROM command_center_responsibility_active_slots
            WHERE automation_id = ${stored.id} AND execution_id = ${active.executionId}
          `;
        }

        const workIdentity = responsibilityWorkIdentity(stored.spaceId, stored.id);
        yield* sql`
          INSERT INTO command_center_automation_executions (
            id, automation_id, idempotency_key, work_identity, space_id, config_commit_sha,
            definition_digest, definition_json, input_json, state, created_at, updated_at
          ) VALUES (
            ${executionId}, ${automation.id}, ${input.idempotencyKey}, ${workIdentity}, ${automation.spaceId},
            ${stored.commitSha}, ${stored.definitionDigest}, ${stored.definitionJson}, ${inputJson},
            'queued', ${now}, ${now}
          )
        `;
        yield* sql`
          INSERT INTO command_center_responsibility_active_slots (
            automation_id, space_id, work_identity, execution_id, claimed_at
          ) VALUES (${automation.id}, ${automation.spaceId}, ${workIdentity}, ${executionId}, ${now})
        `;
        yield* sql`
          INSERT INTO command_center_responsibility_admissions (
            idempotency_key, execution_id, automation_id, space_id, config_commit_sha,
            definition_digest, input_json, accepted_at
          ) VALUES (
            ${input.idempotencyKey}, ${executionId}, ${automation.id}, ${automation.spaceId},
            ${stored.commitSha}, ${stored.definitionDigest}, ${inputJson}, ${now}
          )
        `;
        yield* sql`
          INSERT INTO command_center_responsibility_status (
            space_id, automation_id, last_admission_attempt_at, last_admission_status,
            last_attempted_execution_id, current_execution_id, updated_at
          ) VALUES (
            ${automation.spaceId}, ${automation.id}, ${now}, 'admitted',
            ${executionId}, ${executionId}, ${now}
          )
          ON CONFLICT(space_id, automation_id) DO UPDATE SET
            last_admission_attempt_at = excluded.last_admission_attempt_at,
            last_admission_status = excluded.last_admission_status,
            last_attempted_execution_id = excluded.last_attempted_execution_id,
            current_execution_id = excluded.current_execution_id,
            updated_at = excluded.updated_at
        `;
        for (const node of automation.nodes) {
          yield* sql`
            INSERT INTO command_center_automation_node_checkpoints (
              execution_id, node_id, node_kind, state, max_attempts, updated_at
            ) VALUES (
              ${executionId}, ${node.id}, ${node.kind}, 'pending',
              ${checkpointMaxAttempts(node, defaultMaxAttempts)}, ${now}
            )
          `;
        }
        return { kind: "created" as const, executionId };
      }),
    );
    if (admitted.kind === "paused") {
      return yield* runtimeError(
        "automation-paused",
        `Automation '${admitted.automationId}' is paused.`,
      );
    }
    return yield* get(admitted.executionId);
  });

  const acquireLease = Effect.fn("AutomationRuntime.acquireLease")(function* (
    input: AcquireAutomationLeaseInput,
  ) {
    const ttlMs = positiveBoundedInteger(input.ttlMs, 30_000, 3_600_000);
    const now = yield* dependencies.now;
    const current = yield* readExecutionRow(input.executionId);
    if (TERMINAL_EXECUTION_STATES.has(current.state)) {
      return yield* runtimeError(
        "invalid-state",
        `Automation execution '${input.executionId}' is already ${current.state}.`,
      );
    }
    // A live lease is exclusive, even for a caller using the same owner name:
    // two fibers resuming one approval share that name, and handing both the
    // same token would let both run the step.
    const token = yield* dependencies.randomUUID;
    const expiresAt = addMilliseconds(now, ttlMs);
    const claimed = yield* sql<{
      readonly generation: number;
      readonly expiresAt: string;
    }>`
      UPDATE command_center_automation_executions
      SET lease_owner = ${input.owner}, lease_token = ${token},
        lease_generation = lease_generation + 1, lease_acquired_at = ${now},
        lease_expires_at = ${expiresAt}, updated_at = ${now}
      WHERE id = ${input.executionId}
        AND state NOT IN ('succeeded', 'failed', 'canceled')
        AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ${now})
      RETURNING lease_generation AS "generation", lease_expires_at AS "expiresAt"
    `;
    const lease = claimed[0];
    if (lease === undefined) {
      return yield* runtimeError(
        "lease-denied",
        `Automation execution '${input.executionId}' is leased by another worker.`,
      );
    }
    return {
      executionId: input.executionId,
      owner: input.owner,
      token,
      generation: lease.generation,
      expiresAt: lease.expiresAt,
    };
  });

  const renewLease = Effect.fn("AutomationRuntime.renewLease")(function* (
    input: AutomationLeaseCommandInput & { readonly ttlMs: number },
  ) {
    const ttlMs = positiveBoundedInteger(input.ttlMs, 30_000, 3_600_000);
    const now = yield* dependencies.now;
    const expiresAt = addMilliseconds(now, ttlMs);
    const renewed = yield* sql<{ readonly generation: number }>`
      UPDATE command_center_automation_executions
      SET lease_expires_at = ${expiresAt}
      WHERE id = ${input.executionId} AND lease_owner = ${input.owner}
        AND lease_token = ${input.token} AND lease_expires_at > ${now}
        AND state NOT IN ('succeeded', 'failed', 'canceled')
      RETURNING lease_generation AS "generation"
    `;
    const lease = renewed[0];
    if (lease === undefined) {
      return yield* runtimeError("lease-lost", "The automation execution lease was lost.");
    }
    return {
      executionId: input.executionId,
      owner: input.owner,
      token: input.token,
      generation: lease.generation,
      expiresAt,
    };
  });

  const releaseLease = Effect.fn("AutomationRuntime.releaseLease")(function* (
    input: AutomationLeaseCommandInput,
  ) {
    const now = yield* dependencies.now;
    const released = yield* sql<{ readonly id: string }>`
      UPDATE command_center_automation_executions
      SET lease_owner = NULL, lease_token = NULL, lease_acquired_at = NULL,
        lease_expires_at = NULL, updated_at = ${now}
      WHERE id = ${input.executionId} AND lease_owner = ${input.owner}
        AND lease_token = ${input.token}
      RETURNING id
    `;
    if (released.length === 0) {
      return yield* runtimeError("lease-lost", "The automation execution lease was lost.");
    }
  });

  const assertLease = Effect.fn("AutomationRuntime.assertLease")(function* (
    row: ExecutionRow,
    input: AutomationLeaseCommandInput,
    now: string,
  ) {
    if (
      row.leaseOwner !== input.owner ||
      row.leaseToken !== input.token ||
      row.leaseExpiresAt === null ||
      row.leaseExpiresAt <= now
    ) {
      return yield* runtimeError("lease-lost", "The automation execution lease was lost.");
    }
  });

  const failureIdentity = (
    outcome: Extract<AutomationNodeExecutionOutcome, { readonly type: "failed" | "retry" }>,
    checkpoint: CheckpointRow,
    nodeId: string,
  ): AutomationCanonicalFailure => {
    if (outcome.failure !== undefined && isCanonicalFailure(outcome.failure)) {
      return outcome.failure;
    }
    const fallback = fallbackCanonicalFailure(outcome.error, outcome.type === "retry");
    return { ...fallback, resource: checkpoint.nodeKind, subject: nodeId };
  };

  const recordIncident = Effect.fn("AutomationRuntime.recordIncident")(function* (input: {
    readonly execution: ExecutionRow;
    readonly failure: AutomationCanonicalFailure;
    readonly error: string;
    readonly state: "transient" | "blocked";
    readonly retryAt?: string | null;
    readonly now: string;
  }) {
    const id = responsibilityIncidentId({
      spaceId: input.execution.spaceId,
      automationId: input.execution.automationId,
      ...input.failure,
    });
    const displayError = sanitizeIncidentError(input.error);
    const recoveryInstruction =
      input.state === "transient"
        ? "The existing bounded retry will run when it is due."
        : input.failure.canonicalCode === "node-outcome-unknown"
          ? "Check the external system for this step's effect and reconcile it by hand before running the Responsibility again."
          : "Correct the configured capability or input, then run the Responsibility again.";
    yield* sql`
      INSERT INTO command_center_responsibility_incidents (
        id, space_id, automation_id, canonical_code, resource, subject, state,
        first_seen_at, last_seen_at, occurrence_count, latest_execution_id,
        retry_at, recovery_instruction, display_error, resolved_at
      ) VALUES (
        ${id}, ${input.execution.spaceId}, ${input.execution.automationId},
        ${input.failure.canonicalCode}, ${input.failure.resource}, ${input.failure.subject}, ${input.state},
        ${input.now}, ${input.now}, 1, ${input.execution.id}, ${input.retryAt ?? null},
        ${recoveryInstruction}, ${displayError}, NULL
      )
      ON CONFLICT(space_id, automation_id, canonical_code, resource, subject) DO UPDATE SET
        state = excluded.state, last_seen_at = excluded.last_seen_at,
        occurrence_count = command_center_responsibility_incidents.occurrence_count + 1,
        latest_execution_id = excluded.latest_execution_id, retry_at = excluded.retry_at,
        recovery_instruction = excluded.recovery_instruction,
        display_error = excluded.display_error, resolved_at = NULL
    `;
    yield* sql`
      INSERT INTO command_center_responsibility_status (
        space_id, automation_id, last_checked_at, last_check_status,
        last_attempted_execution_id, current_execution_id, updated_at
      ) VALUES (
        ${input.execution.spaceId}, ${input.execution.automationId}, ${input.now},
        ${input.state === "transient" ? "transient-error" : "blocked"},
        ${input.execution.id},
        ${input.state === "transient" ? input.execution.id : null}, ${input.now}
      )
      ON CONFLICT(space_id, automation_id) DO UPDATE SET
        last_checked_at = excluded.last_checked_at,
        last_check_status = excluded.last_check_status,
        last_attempted_execution_id = excluded.last_attempted_execution_id,
        current_execution_id = excluded.current_execution_id,
        updated_at = excluded.updated_at
    `;
    if (input.state === "blocked") {
      const itemSource = stringifyJson({
        kind: "automation",
        sourceRef: id,
        capturedAt: input.now,
      });
      const itemMetadata = stringifyJson({
        incidentId: id,
        automationId: input.execution.automationId,
        executionId: input.execution.id,
        canonicalCode: input.failure.canonicalCode,
        resource: input.failure.resource,
        subject: input.failure.subject,
      });
      yield* sql`
        INSERT INTO command_center_items (
          id, space_id, kind, status, title, body, priority,
          source_json, metadata_json, created_at, updated_at
        ) VALUES (
          ${id}, ${input.execution.spaceId}, 'alert', 'ready',
          'Responsibility needs attention', ${displayError}, 'high',
          ${itemSource}, ${itemMetadata}, ${input.now}, ${input.now}
        )
        ON CONFLICT(id) DO UPDATE SET
          status = 'ready', body = excluded.body, metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
      `;
    }
  });

  const resolveIncidents = Effect.fn("AutomationRuntime.resolveIncidents")(function* (input: {
    readonly execution: ExecutionRow;
    readonly scopes: ReadonlyArray<AutomationFailureResolutionScope>;
    readonly now: string;
  }) {
    for (const scope of input.scopes.filter(isFailureResolutionScope)) {
      yield* sql`
        UPDATE command_center_responsibility_incidents
        SET state = 'resolved', resolved_at = ${input.now}, retry_at = NULL
        WHERE space_id = ${input.execution.spaceId}
          AND automation_id = ${input.execution.automationId}
          AND resource = ${scope.resource} AND subject = ${scope.subject}
          AND state != 'resolved'
          AND canonical_code != 'node-outcome-unknown'
      `;
      yield* sql`
        UPDATE command_center_items
        SET status = 'done', updated_at = ${input.now}
        WHERE id IN (
          SELECT id FROM command_center_responsibility_incidents
          WHERE space_id = ${input.execution.spaceId}
            AND automation_id = ${input.execution.automationId}
            AND resource = ${scope.resource} AND subject = ${scope.subject}
            AND state = 'resolved'
        )
      `;
    }
  });

  const recordCheckAttempt = Effect.fn("AutomationRuntime.recordCheckAttempt")(function* (input: {
    readonly execution: ExecutionRow;
    readonly now: string;
  }) {
    yield* sql`
      INSERT INTO command_center_responsibility_status (
        space_id, automation_id, last_checked_at, last_attempted_execution_id,
        current_execution_id, updated_at
      ) VALUES (
        ${input.execution.spaceId}, ${input.execution.automationId}, ${input.now},
        ${input.execution.id}, ${input.execution.id}, ${input.now}
      )
      ON CONFLICT(space_id, automation_id) DO UPDATE SET
        last_checked_at = excluded.last_checked_at,
        last_attempted_execution_id = excluded.last_attempted_execution_id,
        current_execution_id = excluded.current_execution_id,
        updated_at = excluded.updated_at
    `;
  });

  const guardedCheckpointUpdate = Effect.fn("AutomationRuntime.guardedCheckpointUpdate")(
    function* (input: {
      readonly execution: ExecutionRow;
      readonly lease: AutomationLeaseCommandInput;
      readonly nodeId: string;
      readonly now: string;
      readonly state: AutomationCheckpointState;
      readonly waitingUntil?: string | null;
      readonly resumeKey?: string | null;
      readonly output?: Schema.Json | null;
      readonly error?: string | null;
      readonly finished?: boolean;
    }) {
      const outputJson =
        input.output === undefined || input.output === null ? null : stringifyJson(input.output);
      const updated = yield* sql<{ readonly nodeId: string }>`
        UPDATE command_center_automation_node_checkpoints
        SET state = ${input.state}, waiting_until = ${input.waitingUntil ?? null},
          resume_key = ${input.resumeKey ?? null}, output_json = ${outputJson},
          error = ${input.error ?? null},
          finished_at = ${input.finished === true ? input.now : null}, updated_at = ${input.now}
        WHERE execution_id = ${input.execution.id} AND node_id = ${input.nodeId}
          AND EXISTS (
            SELECT 1 FROM command_center_automation_executions execution
            WHERE execution.id = ${input.execution.id}
              AND execution.lease_owner = ${input.lease.owner}
              AND execution.lease_token = ${input.lease.token}
              AND execution.lease_expires_at > ${input.now}
          )
        RETURNING node_id AS "nodeId"
      `;
      if (updated.length === 0) {
        return yield* runtimeError("lease-lost", "The automation execution lease was lost.");
      }
    },
  );

  const updateExecutionState = Effect.fn("AutomationRuntime.updateExecutionState")(
    function* (input: {
      readonly executionId: string;
      readonly lease: AutomationLeaseCommandInput;
      readonly now: string;
      readonly state: AutomationRuntimeExecutionState;
      readonly output?: Schema.Json | null;
      readonly error?: string | null;
      readonly finished?: boolean;
    }) {
      const outputJson =
        input.output === undefined || input.output === null ? null : stringifyJson(input.output);
      const updated = yield* sql<{
        readonly id: string;
        readonly automationId: string;
        readonly spaceId: string;
      }>`
      UPDATE command_center_automation_executions
      SET state = ${input.state}, output_json = ${outputJson}, error = ${input.error ?? null},
        updated_at = ${input.now}, finished_at = ${input.finished === true ? input.now : null}
      WHERE id = ${input.executionId} AND lease_owner = ${input.lease.owner}
        AND lease_token = ${input.lease.token} AND lease_expires_at > ${input.now}
      RETURNING id, automation_id AS "automationId", space_id AS "spaceId"
    `;
      const row = updated[0];
      if (row === undefined) {
        return yield* runtimeError("lease-lost", "The automation execution lease was lost.");
      }
      if (TERMINAL_EXECUTION_STATES.has(input.state)) {
        yield* sql`
          DELETE FROM command_center_responsibility_active_slots
          WHERE automation_id = ${row.automationId} AND execution_id = ${row.id}
        `;
        yield* sql`
          INSERT INTO command_center_responsibility_status (
            space_id, automation_id, last_checked_at, last_check_status,
            last_successful_at, last_attempted_execution_id, current_execution_id, updated_at
          ) VALUES (
            ${row.spaceId}, ${row.automationId}, ${input.now},
            ${input.state === "succeeded" ? "ok" : input.state === "failed" ? "blocked" : null},
            ${input.state === "succeeded" ? input.now : null}, ${row.id}, NULL, ${input.now}
          )
          ON CONFLICT(space_id, automation_id) DO UPDATE SET
            last_checked_at = excluded.last_checked_at,
            last_check_status = COALESCE(excluded.last_check_status,
              command_center_responsibility_status.last_check_status),
            last_successful_at = COALESCE(excluded.last_successful_at,
              command_center_responsibility_status.last_successful_at),
            last_attempted_execution_id = excluded.last_attempted_execution_id,
            current_execution_id = NULL, updated_at = excluded.updated_at
        `;
      }
    },
  );

  const aggregateOutput = Effect.fn("AutomationRuntime.aggregateOutput")(function* (
    checkpoints: ReadonlyArray<CheckpointRow>,
  ) {
    const pairs = yield* Effect.forEach(
      checkpoints.filter((checkpoint) => checkpoint.state === "succeeded"),
      (checkpoint) =>
        Effect.map(
          decodeJsonOrNull(checkpoint.outputJson),
          (output) => [checkpoint.nodeId, output] as const,
        ),
    );
    return Object.fromEntries(pairs) as Schema.Json;
  });

  const finishWhenComplete = Effect.fn("AutomationRuntime.finishWhenComplete")(function* (
    execution: ExecutionRow,
    lease: AutomationLeaseCommandInput,
    now: string,
  ) {
    const checkpoints = yield* readCheckpointRows(execution.id);
    if (
      checkpoints.length > 0 &&
      checkpoints.every(
        (checkpoint) => checkpoint.state === "succeeded" || checkpoint.state === "skipped",
      )
    ) {
      yield* updateExecutionState({
        executionId: execution.id,
        lease,
        now,
        state: "succeeded",
        output: yield* aggregateOutput(checkpoints),
        finished: true,
      });
    }
  });

  const advance = Effect.fn("AutomationRuntime.advance")(function* (
    input: AutomationLeaseCommandInput,
  ) {
    let now = yield* dependencies.now;
    const execution = yield* readExecutionRow(input.executionId);
    yield* assertLease(execution, input, now);
    if (TERMINAL_EXECUTION_STATES.has(execution.state)) return yield* get(execution.id);

    let checkpoints = yield* readCheckpointRows(execution.id);
    const waiting = checkpoints.find((checkpoint) =>
      ["waiting_retry", "waiting_delay", "waiting_external", "waiting_approval"].includes(
        checkpoint.state,
      ),
    );
    if (waiting !== undefined) {
      if (waiting.state === "waiting_external" || waiting.state === "waiting_approval") {
        return yield* get(execution.id);
      }
      if (waiting.waitingUntil !== null && waiting.waitingUntil > now) {
        return yield* get(execution.id);
      }
      if (waiting.state === "waiting_delay") {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* guardedCheckpointUpdate({
              execution,
              lease: input,
              nodeId: waiting.nodeId,
              now,
              state: "succeeded",
              output: { resumedAt: now },
              finished: true,
            });
            yield* finishWhenComplete(execution, input, now);
            const afterDelay = yield* readExecutionRow(execution.id);
            if (!TERMINAL_EXECUTION_STATES.has(afterDelay.state)) {
              yield* updateExecutionState({
                executionId: execution.id,
                lease: input,
                now,
                state: "running",
              });
            }
          }),
        );
        return yield* get(execution.id);
      }
      const retried = yield* sql<{ readonly nodeId: string }>`
        UPDATE command_center_automation_node_checkpoints
        SET state = 'pending', waiting_until = NULL, error = NULL, updated_at = ${now}
        WHERE execution_id = ${execution.id} AND node_id = ${waiting.nodeId}
          AND EXISTS (
            SELECT 1 FROM command_center_automation_executions current_execution
            WHERE current_execution.id = ${execution.id}
              AND current_execution.lease_owner = ${input.owner}
              AND current_execution.lease_token = ${input.token}
              AND current_execution.lease_expires_at > ${now}
          )
        RETURNING node_id AS "nodeId"
      `;
      if (retried.length === 0) {
        return yield* runtimeError("lease-lost", "The automation execution lease was lost.");
      }
      checkpoints = yield* readCheckpointRows(execution.id);
    }

    const { definition } = yield* readDefinition(execution.definitionJson);
    const completedNodeIds = checkpoints
      .filter((checkpoint) => checkpoint.state === "succeeded" || checkpoint.state === "skipped")
      .map((checkpoint) => checkpoint.nodeId);
    const plan = planAutomationExecution(definition, { completedNodeIds });
    if (!plan.ok) {
      return yield* runtimeError(
        "definition-invalid",
        `The pinned automation graph is invalid: ${plan.issues.map((issue) => issue.message).join("; ")}`,
      );
    }
    if (plan.plan.complete) {
      yield* sql.withTransaction(finishWhenComplete(execution, input, now));
      return yield* get(execution.id);
    }

    const orphanedRunning = checkpoints.find((checkpoint) => checkpoint.state === "running");
    const node =
      orphanedRunning === undefined
        ? plan.plan.readyNodes[0]
        : definition.nodes.find((candidate) => candidate.id === orphanedRunning.nodeId);
    if (node === undefined) {
      return yield* runtimeError(
        "invalid-state",
        `Automation execution '${execution.id}' has no runnable node.`,
      );
    }
    let checkpoint = checkpoints.find((candidate) => candidate.nodeId === node.id);
    if (checkpoint === undefined) {
      return yield* runtimeError(
        "invalid-state",
        `Automation node '${node.id}' has no durable checkpoint.`,
      );
    }

    if (checkpoint.state !== "running") {
      const attempt = checkpoint.attemptCount + 1;
      const executorIdempotencyKey = `${execution.id}:${node.id}:${attempt}`;
      const predecessorOutput = Object.fromEntries(
        checkpoints
          .filter((candidate) =>
            definition.edges.some((edge) => edge.from === candidate.nodeId && edge.to === node.id),
          )
          .map((candidate) => [candidate.nodeId, candidate.outputJson] as const),
      );
      const nodeInputJson = stringifyJson({
        run: (yield* parseJson(execution.inputJson)) as Schema.Json,
        predecessors: predecessorOutput,
      });
      const started = yield* sql<CheckpointRow>`
        UPDATE command_center_automation_node_checkpoints
        SET state = 'running', attempt_count = ${attempt},
          executor_idempotency_key = ${executorIdempotencyKey}, lease_token = ${input.token},
          input_json = ${nodeInputJson}, waiting_until = NULL, resume_key = NULL,
          resolution_key = NULL, output_json = NULL, error = NULL,
          started_at = COALESCE(started_at, ${now}), finished_at = NULL, updated_at = ${now}
        WHERE execution_id = ${execution.id} AND node_id = ${node.id}
          AND state = 'pending'
        RETURNING execution_id AS "executionId", node_id AS "nodeId", node_kind AS "nodeKind",
          state, attempt_count AS "attemptCount", max_attempts AS "maxAttempts",
          executor_idempotency_key AS "executorIdempotencyKey", lease_token AS "leaseToken",
          scoped_shell_policy_digest AS "scopedShellPolicyDigest",
          waiting_until AS "waitingUntil", resume_key AS "resumeKey",
          resolution_key AS "resolutionKey", input_json AS "inputJson",
          output_json AS "outputJson", error, started_at AS "startedAt",
          finished_at AS "finishedAt", updated_at AS "updatedAt"
      `;
      checkpoint = started[0];
      if (checkpoint === undefined) {
        return yield* runtimeError(
          "invalid-state",
          `Automation node '${node.id}' is no longer ready.`,
        );
      }
    }

    yield* updateExecutionState({
      executionId: execution.id,
      lease: input,
      now,
      state: "running",
    });
    const runInput = (yield* parseJson(execution.inputJson)) as Readonly<
      Record<string, Schema.Json>
    >;

    let outcome: AutomationNodeExecutionOutcome;
    if (node.kind === "delay") {
      const configuredUntil = node.config.until;
      const configuredDuration = nonNegativeBoundedNumber(
        node.config.durationMs,
        0,
        31_536_000_000,
      );
      const parsedUntil =
        typeof configuredUntil === "string" ? DateTime.make(configuredUntil) : Option.none();
      const waitingUntil = Option.match(parsedUntil, {
        onNone: () => addMilliseconds(now, configuredDuration),
        onSome: DateTime.formatIso,
      });
      if (waitingUntil <= now) {
        outcome = { type: "succeeded", output: { resumedAt: now } };
      } else {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* guardedCheckpointUpdate({
              execution,
              lease: input,
              nodeId: node.id,
              now,
              state: "waiting_delay",
              waitingUntil,
            });
            yield* updateExecutionState({
              executionId: execution.id,
              lease: input,
              now,
              state: "waiting_delay",
            });
          }),
        );
        return yield* get(execution.id);
      }
    } else if (node.kind === "approval") {
      const configuredApprovalKey =
        typeof node.config.approvalKey === "string" && node.config.approvalKey.length > 0
          ? node.config.approvalKey
          : "decision";
      // The full committed definition (including the proposed action payload)
      // is covered by definitionDigest. Binding it into the resume key prevents
      // an approval captured for one revision from authorizing another.
      const approvalKey = `${execution.id}:${node.id}:${execution.definitionDigest}:${configuredApprovalKey}`;
      outcome = { type: "approval", approvalKey };
    } else if (orphanedRunning !== undefined && !isReexecutionSafe(node)) {
      // The previous executor of this step lost its lease mid-run. Its effect
      // may or may not have happened; do not risk running it twice.
      outcome = {
        type: "failed",
        error:
          `Step '${node.id}' (${node.kind}) was interrupted while running and its outcome is unknown; ` +
          "it was not run again. Reconcile it manually before retrying.",
        // Only a human can resolve this: a later success of the same step does
        // not prove what happened to the interrupted one.
        failure: {
          canonicalCode: "node-outcome-unknown",
          resource: checkpoint.nodeKind,
          subject: node.id,
        },
      };
    } else {
      const context = executorInput(execution, definition, node, checkpoint, checkpoints, runInput);
      const decodedPredecessors = yield* Effect.forEach(
        Object.entries(context.predecessorOutputs),
        ([key, value]) =>
          typeof value === "string"
            ? Effect.map(parseJson(value), (decoded) => [key, decoded as Schema.Json] as const)
            : Effect.succeed([key, value] as const),
      );
      const execute = dependencies
        .executeNode({ ...context, predecessorOutputs: Object.fromEntries(decodedPredecessors) })
        .pipe(
          Effect.catch((error) =>
            Effect.succeed({ type: "retry", error } satisfies AutomationNodeExecutionOutcome),
          ),
        );
      // Keep the lease while the step runs so recovery does not start a second
      // copy. If renewal fails the lease is gone: stop the step and commit
      // nothing (every commit is fenced by the lease token anyway).
      // A transient renewal error (e.g. a busy database) is retried while the
      // lease is still valid; only a lost lease, or reaching its expiry, stops
      // the step.
      const heartbeat = Effect.gen(function* () {
        let expiresAt = execution.leaseExpiresAt ?? now;
        while (true) {
          yield* Effect.sleep(Duration.millis(leaseRenewEveryMs));
          while (true) {
            const renewed = yield* renewLease({ ...input, ttlMs: leaseTtlMs }).pipe(
              Effect.map((lease) => lease.expiresAt),
              Effect.catch((error) =>
                error._tag === "AutomationRuntimeError" && error.code === "lease-lost"
                  ? Effect.fail(error)
                  : Effect.logWarning("command-center.automation.lease-renew-retry", {
                      executionId: input.executionId,
                      cause: error,
                    }).pipe(Effect.as(null)),
              ),
            );
            if (renewed !== null) {
              expiresAt = renewed;
              break;
            }
            // Retry quickly, but stop before the lease can lapse under us.
            const current = yield* dependencies.now;
            if (addMilliseconds(current, LEASE_RENEW_RETRY_MS * 2) >= expiresAt) {
              return yield* runtimeError(
                "lease-lost",
                "The automation execution lease could not be renewed before it expired.",
              );
            }
            yield* Effect.sleep(Duration.millis(LEASE_RENEW_RETRY_MS));
          }
        }
      });
      outcome = yield* Effect.raceFirst(execute, heartbeat);
      // Commit with the time the step finished, not when it started.
      now = yield* dependencies.now;
    }

    switch (outcome.type) {
      case "succeeded": {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* guardedCheckpointUpdate({
              execution,
              lease: input,
              nodeId: node.id,
              now,
              state: "succeeded",
              output: outcome.output ?? null,
              finished: true,
            });
            yield* recordCheckAttempt({ execution, now });
            yield* resolveIncidents({
              execution,
              scopes: [
                { resource: checkpoint.nodeKind, subject: node.id },
                ...(outcome.resolvedFailureScopes ?? []),
              ],
              now,
            });
            yield* finishWhenComplete(execution, input, now);
          }),
        );
        return yield* get(execution.id);
      }
      case "retry": {
        const failure = failureIdentity(outcome, checkpoint, node.id);
        if (checkpoint.attemptCount >= checkpoint.maxAttempts) {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* guardedCheckpointUpdate({
                execution,
                lease: input,
                nodeId: node.id,
                now,
                state: "failed",
                error: outcome.error,
                finished: true,
              });
              yield* updateExecutionState({
                executionId: execution.id,
                lease: input,
                now,
                state: "failed",
                error: outcome.error,
                finished: true,
              });
              yield* recordIncident({
                execution,
                failure,
                error: outcome.error,
                state: "blocked",
                now,
              });
            }),
          );
          return yield* get(execution.id);
        }
        const waitingUntil = addMilliseconds(
          now,
          nonNegativeBoundedNumber(outcome.retryAfterMs, defaultRetryDelayMs, 86_400_000),
        );
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* guardedCheckpointUpdate({
              execution,
              lease: input,
              nodeId: node.id,
              now,
              state: "waiting_retry",
              waitingUntil,
              error: outcome.error,
            });
            yield* updateExecutionState({
              executionId: execution.id,
              lease: input,
              now,
              state: "waiting_retry",
            });
            yield* recordIncident({
              execution,
              failure,
              error: outcome.error,
              state: "transient",
              retryAt: waitingUntil,
              now,
            });
          }),
        );
        return yield* get(execution.id);
      }
      case "failed": {
        const failure = failureIdentity(outcome, checkpoint, node.id);
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* guardedCheckpointUpdate({
              execution,
              lease: input,
              nodeId: node.id,
              now,
              state: "failed",
              output: outcome.output ?? null,
              error: outcome.error,
              finished: true,
            });
            yield* updateExecutionState({
              executionId: execution.id,
              lease: input,
              now,
              state: "failed",
              output: outcome.output ?? null,
              error: outcome.error,
              finished: true,
            });
            yield* recordIncident({
              execution,
              failure,
              error: outcome.error,
              state: "blocked",
              now,
            });
          }),
        );
        return yield* get(execution.id);
      }
      case "wait": {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* guardedCheckpointUpdate({
              execution,
              lease: input,
              nodeId: node.id,
              now,
              state: "waiting_external",
              resumeKey: outcome.resumeKey,
              output: outcome.output ?? null,
            });
            yield* updateExecutionState({
              executionId: execution.id,
              lease: input,
              now,
              state: "waiting_external",
            });
            yield* recordCheckAttempt({ execution, now });
          }),
        );
        return yield* get(execution.id);
      }
      case "approval": {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* guardedCheckpointUpdate({
              execution,
              lease: input,
              nodeId: node.id,
              now,
              state: "waiting_approval",
              resumeKey: outcome.approvalKey,
              output: outcome.output ?? null,
            });
            yield* updateExecutionState({
              executionId: execution.id,
              lease: input,
              now,
              state: "waiting_approval",
            });
          }),
        );
        return yield* get(execution.id);
      }
    }
  });

  const resolveWait = Effect.fn("AutomationRuntime.resolveWait")(function* (
    input: ResolveAutomationWaitInput,
  ) {
    const now = yield* dependencies.now;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const execution = yield* readExecutionRow(input.executionId);
        const checkpoints = yield* readCheckpointRows(input.executionId);
        const checkpoint = checkpoints.find((candidate) => candidate.nodeId === input.nodeId);
        if (checkpoint === undefined) {
          return yield* runtimeError(
            "invalid-state",
            `Automation node '${input.nodeId}' was not found.`,
          );
        }
        if (
          (checkpoint.state === "succeeded" || checkpoint.state === "failed") &&
          checkpoint.resolutionKey === input.resolutionKey
        ) {
          return yield* get(input.executionId);
        }
        if (checkpoint.state !== "waiting_external" || checkpoint.resumeKey !== input.resumeKey) {
          return yield* runtimeError("signal-mismatch", "The wait resume signal does not match.");
        }
        const outputJson =
          input.output === undefined ? checkpoint.outputJson : stringifyJson(input.output);
        const checkpointState = input.outcome === "succeeded" ? "succeeded" : "failed";
        const error =
          input.outcome === "succeeded" ? null : (input.error ?? "External work failed.");
        const updated = yield* sql<{ readonly nodeId: string }>`
          UPDATE command_center_automation_node_checkpoints
          SET state = ${checkpointState}, resolution_key = ${input.resolutionKey},
            output_json = ${outputJson}, error = ${error}, finished_at = ${now}, updated_at = ${now}
          WHERE execution_id = ${input.executionId} AND node_id = ${input.nodeId}
            AND state = 'waiting_external' AND resume_key = ${input.resumeKey}
            AND resolution_key IS NULL
          RETURNING node_id AS "nodeId"
        `;
        if (updated.length === 0) {
          const latest = yield* get(input.executionId);
          const latestCheckpoint = latest.checkpoints.find(
            (candidate) => candidate.nodeId === input.nodeId,
          );
          if (latestCheckpoint?.resolutionKey === input.resolutionKey) return latest;
          return yield* runtimeError(
            "signal-mismatch",
            "The wait was already resolved differently.",
          );
        }
        if (!TERMINAL_EXECUTION_STATES.has(execution.state)) {
          const executionState = input.outcome === "succeeded" ? "queued" : input.outcome;
          yield* sql`
            UPDATE command_center_automation_executions
            SET state = ${executionState}, error = ${error}, updated_at = ${now},
              finished_at = ${input.outcome === "succeeded" ? null : now}
            WHERE id = ${input.executionId} AND state = 'waiting_external'
          `;
          if (input.outcome === "succeeded") {
            yield* recordCheckAttempt({ execution, now });
            yield* resolveIncidents({
              execution,
              scopes: [{ resource: checkpoint.nodeKind, subject: checkpoint.nodeId }],
              now,
            });
          } else {
            yield* sql`
              DELETE FROM command_center_responsibility_active_slots
              WHERE automation_id = ${execution.automationId}
                AND execution_id = ${execution.id}
            `;
            yield* recordCheckAttempt({ execution, now });
            if (input.outcome === "failed") {
              const failure = failureIdentity(
                { type: "failed", error: error ?? "External work failed." },
                checkpoint,
                checkpoint.nodeId,
              );
              yield* recordIncident({
                execution,
                failure,
                error: error ?? "External work failed.",
                state: "blocked",
                now,
              });
            } else {
              yield* sql`
                UPDATE command_center_responsibility_status
                SET current_execution_id = NULL, updated_at = ${now}
                WHERE space_id = ${execution.spaceId}
                  AND automation_id = ${execution.automationId}
              `;
            }
          }
        }
        return yield* get(input.executionId);
      }),
    );
  });

  const resumeWait = (input: ResumeAutomationWaitInput) =>
    resolveWait({ ...input, outcome: "succeeded" });

  const resolveApproval = Effect.fn("AutomationRuntime.resolveApproval")(function* (
    input: ResolveAutomationApprovalInput,
  ) {
    const now = yield* dependencies.now;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const checkpointRows = yield* readCheckpointRows(input.executionId);
        const checkpoint = checkpointRows.find((candidate) => candidate.nodeId === input.nodeId);
        if (checkpoint === undefined) {
          return yield* runtimeError(
            "invalid-state",
            `Automation node '${input.nodeId}' was not found.`,
          );
        }
        if (
          (checkpoint.state === "succeeded" || checkpoint.state === "failed") &&
          checkpoint.resolutionKey === input.resolutionKey
        ) {
          return yield* get(input.executionId);
        }
        if (checkpoint.state !== "waiting_approval" || checkpoint.resumeKey !== input.approvalKey) {
          return yield* runtimeError("signal-mismatch", "The approval decision does not match.");
        }
        const output = input.output ?? { approved: input.approved };
        const nextCheckpointState = input.approved ? "succeeded" : "failed";
        const nextExecutionState = input.approved ? "queued" : "canceled";
        const error = input.approved ? null : "Approval was declined.";
        const updated = yield* sql<{ readonly nodeId: string }>`
          UPDATE command_center_automation_node_checkpoints
          SET state = ${nextCheckpointState}, resolution_key = ${input.resolutionKey},
            output_json = ${stringifyJson(output)}, error = ${error},
            finished_at = ${now}, updated_at = ${now}
          WHERE execution_id = ${input.executionId} AND node_id = ${input.nodeId}
            AND state = 'waiting_approval' AND resume_key = ${input.approvalKey}
            AND resolution_key IS NULL
          RETURNING node_id AS "nodeId"
        `;
        if (updated.length === 0) {
          const latest = yield* get(input.executionId);
          const latestCheckpoint = latest.checkpoints.find(
            (candidate) => candidate.nodeId === input.nodeId,
          );
          if (latestCheckpoint?.resolutionKey === input.resolutionKey) return latest;
          return yield* runtimeError(
            "signal-mismatch",
            "The approval was already resolved differently.",
          );
        }
        yield* sql`
          UPDATE command_center_automation_executions
          SET state = ${nextExecutionState}, error = ${error}, updated_at = ${now},
            finished_at = ${input.approved ? null : now}
          WHERE id = ${input.executionId} AND state = 'waiting_approval'
        `;
        if (!input.approved) {
          yield* sql`
            DELETE FROM command_center_responsibility_active_slots
            WHERE automation_id = (
              SELECT automation_id FROM command_center_automation_executions
              WHERE id = ${input.executionId}
            ) AND execution_id = ${input.executionId}
          `;
          yield* sql`
            UPDATE command_center_responsibility_status
            SET current_execution_id = NULL, updated_at = ${now}
            WHERE current_execution_id = ${input.executionId}
          `;
        }
        return yield* get(input.executionId);
      }),
    );
  });

  return AutomationRuntime.of({
    now: dependencies.now,
    start,
    get,
    listRecoverable,
    listWaitingExternal,
    reconcileActiveSlots,
    acquireLease,
    renewLease,
    releaseLease,
    advance,
    resumeWait,
    resolveWait,
    resolveApproval,
  });
});

export const layer = (dependencies: AutomationRuntimeDependencies) =>
  Layer.effect(AutomationRuntime, make(dependencies));

export const makeDefaultDependencies = (executeNode: AutomationNodeExecutor) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const now = Effect.map(DateTime.now, DateTime.formatIso);
    return {
      executeNode,
      now,
      randomUUID: crypto.randomUUIDv4.pipe(Effect.orDie),
    };
  });
