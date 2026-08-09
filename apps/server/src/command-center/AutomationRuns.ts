import {
  CommandCenterAutomationExecution,
  type CommandCenterAutomationExecution as CommandCenterAutomationExecutionType,
  type CommandCenterApprovalDecisionInput,
  type CommandCenterAutomationRunGetInput,
  type CommandCenterAutomationRunStartInput,
  CommandCenterError,
} from "@t3tools/contracts";
import type { Approval as ApprovalType } from "@command-center/core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as CommandCenterService from "./Service.ts";
import { ServerConfig } from "../config.ts";
import * as GoogleReadConnector from "./GoogleReadConnector.ts";
import * as ExternalProspectorConnector from "./ExternalProspectorConnector.ts";
import * as SalesPipeline from "./SalesPipeline.ts";
import * as SalesProspectorRunner from "./SalesProspectorRunner.ts";
import { googleCapabilityForDraft, googleCapabilityForOperation } from "./GoogleCapabilities.ts";
import {
  automationAgentCommandId,
  automationAgentRunResumeKey,
  makeAutomationAgentRunInspector,
  makeLiveAutomationAgentRunAdapter,
  type AutomationAgentRunBinding,
  type AutomationAgentRunFailure,
} from "./automation/AgentRunAdapter.ts";
import * as AutomationScopedShell from "./automation/AutomationScopedShell.ts";
import { makeSafeAutomationNodeExecutor } from "./automation/NodeExecutor.ts";
import { makeSalesAutomationActionExecutor } from "./automation/SalesAutomationActions.ts";
import * as AutomationRuntime from "./automation/Runtime.ts";

const decodeExecution = Schema.decodeUnknownEffect(CommandCenterAutomationExecution);
const isCommandCenterError = Schema.is(CommandCenterError);
const isAutomationRuntimeError = Schema.is(AutomationRuntime.AutomationRuntimeError);
const terminalStates = new Set(["succeeded", "failed", "canceled"]);

type JsonRecord = Readonly<Record<string, Schema.Json>>;

function isJsonRecord(value: Schema.Json | null): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readRequiredString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const toCommandCenterError = (cause: unknown): CommandCenterError => {
  if (isCommandCenterError(cause)) return cause;
  if (isAutomationRuntimeError(cause)) {
    const reason =
      cause.code === "automation-not-found" || cause.code === "execution-not-found"
        ? "not_found"
        : cause.code === "idempotency-conflict" || cause.code === "definition-mismatch"
          ? "conflict"
          : "validation";
    return new CommandCenterError({ reason, message: cause.message, cause });
  }
  return new CommandCenterError({
    reason: "persistence",
    message: "The automation runtime operation failed.",
    cause,
  });
};

export interface AutomationRunsShape {
  readonly start: (
    input: CommandCenterAutomationRunStartInput,
  ) => Effect.Effect<CommandCenterAutomationExecutionType, CommandCenterError>;
  readonly get: (
    input: CommandCenterAutomationRunGetInput,
  ) => Effect.Effect<CommandCenterAutomationExecutionType, CommandCenterError>;
  readonly recoverDue: (input: {
    readonly owner: string;
    readonly limit?: number;
  }) => Effect.Effect<AutomationRecoveryReport, CommandCenterError>;
  readonly decideApproval: (input: CommandCenterApprovalDecisionInput) => Effect.Effect<
    {
      readonly approval: ApprovalType;
      readonly automation: boolean;
      readonly execution?: CommandCenterAutomationExecutionType;
    },
    CommandCenterError
  >;
}

export interface AutomationRecoveryFailure {
  readonly executionId: string;
  readonly message: string;
}

export interface AutomationRecoveryReport {
  readonly scanned: number;
  readonly recovered: number;
  readonly remaining: number;
  readonly failures: ReadonlyArray<AutomationRecoveryFailure>;
}

export class AutomationRuns extends Context.Service<AutomationRuns, AutomationRunsShape>()(
  "@awtprod/command-center/command-center/AutomationRuns",
) {}

export const layer = Layer.effect(
  AutomationRuns,
  Effect.gen(function* () {
    const runtime = yield* AutomationRuntime.AutomationRuntime;
    const commandCenter = yield* CommandCenterService.CommandCenterService;
    const sql = yield* SqlClient.SqlClient;
    const inspectAgentRun = makeAutomationAgentRunInspector(sql);

    const record = Effect.fn("AutomationRuns.record")(function* (
      snapshot: AutomationRuntime.AutomationExecutionSnapshot,
    ) {
      yield* commandCenter.recordAutomationEvent({
        executionId: snapshot.id,
        automationId: snapshot.automationId,
        spaceId: snapshot.spaceId,
        state: snapshot.state,
        configCommitSha: snapshot.configCommitSha,
        definitionDigest: snapshot.definitionDigest,
        input: snapshot.input,
        output: snapshot.output,
        createdAt: snapshot.createdAt,
        finishedAt: snapshot.finishedAt,
        ...(snapshot.error === null ? {} : { error: snapshot.error }),
      });
      if (snapshot.state === "waiting_approval") {
        const waiting = snapshot.checkpoints.filter(
          (checkpoint) => checkpoint.state === "waiting_approval" && checkpoint.resumeKey !== null,
        );
        yield* Effect.forEach(waiting, (checkpoint) =>
          commandCenter.ensureAutomationApproval({
            executionId: snapshot.id,
            automationId: snapshot.automationId,
            spaceId: snapshot.spaceId,
            nodeId: checkpoint.nodeId,
            nodeKind: checkpoint.nodeKind,
            approvalKey: checkpoint.resumeKey!,
            configCommitSha: snapshot.configCommitSha,
            definitionDigest: snapshot.definitionDigest,
          }),
        );
      }
    });

    const driveRecoverable = Effect.fn("AutomationRuns.driveRecoverable")(function* (
      initial: AutomationRuntime.AutomationExecutionSnapshot,
      owner: string,
    ) {
      if (!["queued", "running", "waiting_retry", "waiting_delay"].includes(initial.state)) {
        return initial;
      }
      const lease = yield* runtime.acquireLease({
        executionId: initial.id,
        owner,
        ttlMs: 30_000,
      });
      const command = { executionId: initial.id, owner, token: lease.token };
      yield* Effect.gen(function* () {
        let current = initial;
        for (let step = 0; step < 100; step += 1) {
          if (
            terminalStates.has(current.state) ||
            !["queued", "running", "waiting_retry", "waiting_delay"].includes(current.state)
          ) {
            break;
          }
          const previousState = current.state;
          current = yield* runtime.advance(command);
          if (
            current.state === previousState &&
            (current.state === "waiting_retry" || current.state === "waiting_delay")
          ) {
            break;
          }
        }
      }).pipe(Effect.ensuring(runtime.releaseLease(command).pipe(Effect.ignore)));
      return yield* runtime.get(initial.id);
    });

    const applyAutomationApproval = Effect.fn("AutomationRuns.applyAutomationApproval")(function* (
      current: AutomationRuntime.AutomationExecutionSnapshot,
      binding: CommandCenterService.AutomationApprovalBinding,
      status: ApprovalType["status"],
    ) {
      const checkpoint = current.checkpoints.find(
        (candidate) => candidate.nodeId === binding.nodeId,
      );
      if (
        current.automationId !== binding.automationId ||
        current.spaceId !== binding.spaceId ||
        current.configCommitSha !== binding.configCommitSha ||
        current.definitionDigest !== binding.definitionDigest ||
        checkpoint === undefined ||
        checkpoint.resumeKey !== binding.approvalKey
      ) {
        return yield* new CommandCenterError({
          reason: "conflict",
          message: "The automation checkpoint no longer matches the approved payload.",
        });
      }
      if (status === "requested") return current;

      const resolutionKey = [
        "canonical-approval",
        binding.approvalId,
        binding.payloadDigest,
        status,
      ].join(":");
      let snapshot = yield* runtime.resolveApproval({
        executionId: binding.executionId,
        nodeId: binding.nodeId,
        approvalKey: binding.approvalKey,
        resolutionKey,
        approved: status === "approved",
        output: {
          approvalId: binding.approvalId,
          payloadDigest: binding.payloadDigest,
          decision: status,
        },
      });
      yield* record(snapshot);
      if (snapshot.state === "queued") {
        snapshot = yield* driveRecoverable(snapshot, `approval:${binding.approvalId}`);
        yield* record(snapshot);
      }
      return snapshot;
    });

    const reconcileWaitingApproval = Effect.fn("AutomationRuns.reconcileWaitingApproval")(
      function* (snapshot: AutomationRuntime.AutomationExecutionSnapshot) {
        if (snapshot.state !== "waiting_approval") return snapshot;
        const waiting = snapshot.checkpoints.find(
          (checkpoint) => checkpoint.state === "waiting_approval",
        );
        if (waiting === undefined) return snapshot;
        const binding = yield* commandCenter.getAutomationApprovalBinding(
          `automation-approval:${snapshot.id}:${waiting.nodeId}`,
        );
        return binding !== null && binding.status !== "requested"
          ? yield* applyAutomationApproval(snapshot, binding, binding.status)
          : snapshot;
      },
    );

    const readWaitingAgentBinding = Effect.fn("AutomationRuns.readWaitingAgentBinding")(function* (
      snapshot: AutomationRuntime.AutomationExecutionSnapshot,
      checkpoint: AutomationRuntime.AutomationNodeCheckpoint,
    ) {
      const receipt = checkpoint.output;
      if (
        checkpoint.nodeKind !== "agent" ||
        checkpoint.resumeKey === null ||
        !isJsonRecord(receipt)
      ) {
        return yield* new CommandCenterError({
          reason: "conflict",
          message: "The durable automation agent wait receipt is missing or invalid.",
        });
      }
      const commandId = automationAgentCommandId({
        executionId: snapshot.id,
        nodeId: checkpoint.nodeId,
      });
      const runId = readRequiredString(receipt, "runId");
      if (
        receipt.kind !== "command-center-run" ||
        receipt.relationship !== "automation-child" ||
        receipt.parentExecutionId !== snapshot.id ||
        receipt.automationId !== snapshot.automationId ||
        receipt.nodeId !== checkpoint.nodeId ||
        receipt.commandId !== commandId ||
        receipt.spaceId !== snapshot.spaceId ||
        runId === undefined
      ) {
        return yield* new CommandCenterError({
          reason: "conflict",
          message: "The durable automation agent wait receipt changed scope.",
        });
      }
      const binding = {
        parentExecutionId: snapshot.id,
        nodeId: checkpoint.nodeId,
        commandId,
        childRunId: runId,
        spaceId: snapshot.spaceId,
      } satisfies AutomationAgentRunBinding;
      if (checkpoint.resumeKey !== automationAgentRunResumeKey(binding)) {
        return yield* new CommandCenterError({
          reason: "conflict",
          message: "The durable automation agent wait key does not match its child Run.",
        });
      }
      return binding;
    });

    const inspectionFailure = (cause: AutomationAgentRunFailure): CommandCenterError =>
      new CommandCenterError({
        reason: cause.retryable ? "persistence" : "conflict",
        message: cause.message,
        cause,
      });

    const reconcileWaitingAgent = Effect.fn("AutomationRuns.reconcileWaitingAgent")(function* (
      snapshot: AutomationRuntime.AutomationExecutionSnapshot,
      owner: string,
    ) {
      if (snapshot.state !== "waiting_external") return snapshot;
      const waiting = snapshot.checkpoints.find(
        (checkpoint) => checkpoint.state === "waiting_external" && checkpoint.nodeKind === "agent",
      );
      if (waiting === undefined) return snapshot;
      const binding = yield* readWaitingAgentBinding(snapshot, waiting);
      const child = yield* inspectAgentRun(binding).pipe(Effect.mapError(inspectionFailure));
      if (["queued", "running", "waiting_approval", "waiting"].includes(child.state)) {
        return snapshot;
      }
      const outcome =
        child.state === "succeeded"
          ? ("succeeded" as const)
          : child.state === "canceled"
            ? ("canceled" as const)
            : ("failed" as const);
      const resolutionKey = `${waiting.resumeKey}:${child.state}:${child.finishedAt ?? "terminal"}`;
      let resolved = yield* runtime.resolveWait({
        executionId: snapshot.id,
        nodeId: waiting.nodeId,
        resumeKey: waiting.resumeKey!,
        resolutionKey,
        outcome,
        ...(child.error === null ? {} : { error: child.error }),
        output: {
          ...((isJsonRecord(waiting.output) ? waiting.output : {}) as JsonRecord),
          state: child.state,
          terminal: {
            state: child.state,
            result: child.result,
            error: child.error,
            finishedAt: child.finishedAt,
          },
        },
      });
      yield* record(resolved);
      if (resolved.state === "queued") {
        resolved = yield* driveRecoverable(resolved, `${owner}:agent:${child.runId}`);
        yield* record(resolved);
      }
      return resolved;
    });

    const recoverOne = Effect.fn("AutomationRuns.recoverOne")(function* (
      executionId: string,
      owner: string,
    ) {
      let snapshot = yield* runtime.get(executionId);
      if (snapshot.state === "waiting_approval") {
        yield* record(snapshot);
        snapshot = yield* reconcileWaitingApproval(snapshot);
      }
      if (snapshot.state === "waiting_external") {
        snapshot = yield* reconcileWaitingAgent(snapshot, owner);
      }
      if (["queued", "running", "waiting_retry", "waiting_delay"].includes(snapshot.state)) {
        snapshot = yield* driveRecoverable(snapshot, owner);
        yield* record(snapshot);
      }
      return snapshot;
    });

    const recoverDue = Effect.fn("AutomationRuns.recoverDue")(function* (
      input: Parameters<AutomationRunsShape["recoverDue"]>[0],
    ) {
      const due = yield* runtime.listRecoverable(
        input.limit === undefined ? {} : { limit: input.limit },
      );
      const waitingAgents = yield* runtime.listWaitingExternal(
        input.limit === undefined ? {} : { limit: input.limit },
      );
      // A process can stop after the canonical Approval transaction commits but
      // before its checkpoint is resumed. Reconcile those durable decisions as
      // part of the same recovery pass; requested approvals remain inert.
      const decidedApprovals = yield* commandCenter.queryApprovals({
        statuses: ["approved", "declined", "expired", "canceled"],
        limit: input.limit ?? 50,
      });
      const decidedExecutionIds = decidedApprovals.approvals
        .filter((approval) => approval.actionKind === "automation.run")
        .map((approval) => approval.runId);
      const waitingApprovalIds = yield* Effect.forEach(decidedExecutionIds, (executionId) =>
        runtime.get(executionId).pipe(
          Effect.match({
            onFailure: () => [] as ReadonlyArray<string>,
            onSuccess: (snapshot) => (snapshot.state === "waiting_approval" ? [snapshot.id] : []),
          }),
        ),
      ).pipe(Effect.map((groups) => groups.flat()));
      const executionIds = [
        ...new Set([
          ...due.map((snapshot) => snapshot.id),
          ...waitingAgents.map((snapshot) => snapshot.id),
          ...waitingApprovalIds,
        ]),
      ];
      const results = yield* Effect.forEach(executionIds, (executionId) =>
        recoverOne(executionId, `${input.owner}:${executionId}`).pipe(
          Effect.match({
            onFailure: (cause) => {
              const error = toCommandCenterError(cause);
              return {
                ok: false as const,
                executionId,
                message: error.message,
                leaseDenied: isAutomationRuntimeError(cause) && cause.code === "lease-denied",
              };
            },
            onSuccess: (snapshot) => ({ ok: true as const, snapshot }),
          }),
        ),
      );
      const failures = results.flatMap((result) =>
        !result.ok && !result.leaseDenied
          ? [{ executionId: result.executionId, message: result.message }]
          : [],
      );
      const recovered = results.filter((result) => result.ok).length;
      const remaining = results.filter(
        (result) => result.ok && !terminalStates.has(result.snapshot.state),
      ).length;
      return { scanned: executionIds.length, recovered, remaining, failures };
    }, Effect.mapError(toCommandCenterError));

    const get = Effect.fn("AutomationRuns.get")(function* (
      input: CommandCenterAutomationRunGetInput,
    ) {
      let snapshot = yield* runtime.get(input.executionId);
      if (snapshot.spaceId !== input.spaceId) {
        return yield* new CommandCenterError({
          reason: "not_found",
          message: "The automation execution was not found in the requested Space.",
        });
      }
      if (snapshot.state === "waiting_approval") {
        yield* record(snapshot);
        snapshot = yield* reconcileWaitingApproval(snapshot);
      }
      return yield* decodeExecution(snapshot).pipe(
        Effect.mapError(
          (cause) =>
            new CommandCenterError({
              reason: "persistence",
              message: "The stored automation execution is invalid.",
              cause,
            }),
        ),
      );
    }, Effect.mapError(toCommandCenterError));

    const start = Effect.fn("AutomationRuns.start")(function* (
      input: CommandCenterAutomationRunStartInput,
    ) {
      // Synchronize the committed private config before asking the durable runtime
      // to enforce its enabled/commit/digest checks. This makes manual starts safe
      // after a server restart even when no bootstrap query has run yet.
      yield* commandCenter.queryAutomations({ spaceId: input.spaceId });
      let snapshot = yield* runtime.start({
        automationId: input.automationId,
        expectedSpaceId: input.spaceId,
        idempotencyKey: input.idempotencyKey,
        expectedConfigCommitSha: input.expectedConfigCommitSha,
        expectedDefinitionDigest: input.expectedDefinitionDigest,
        ...(input.input === undefined ? {} : { input: input.input }),
      });
      yield* record(snapshot);

      if (snapshot.state === "queued") {
        snapshot = yield* driveRecoverable(snapshot, `manual:${snapshot.id}`);
        yield* record(snapshot);
      }
      snapshot = yield* reconcileWaitingApproval(snapshot);

      return yield* decodeExecution(snapshot).pipe(
        Effect.mapError(
          (cause) =>
            new CommandCenterError({
              reason: "persistence",
              message: "The automation execution result is invalid.",
              cause,
            }),
        ),
      );
    }, Effect.mapError(toCommandCenterError));

    const decideApproval = Effect.fn("AutomationRuns.decideApproval")(function* (
      input: CommandCenterApprovalDecisionInput,
    ) {
      const binding = yield* commandCenter.getAutomationApprovalBinding(input.approvalId);
      if (binding === null) {
        return {
          approval: yield* commandCenter.decideApproval(input),
          automation: false as const,
        };
      }
      if (binding.payloadDigest !== input.payloadDigest) {
        return yield* new CommandCenterError({
          reason: "conflict",
          message: "The automation Approval binding changed before it could be applied.",
        });
      }

      const current = yield* runtime.get(binding.executionId);
      if (binding.status !== "requested") {
        yield* applyAutomationApproval(current, binding, binding.status);
      }
      const approval = yield* commandCenter.decideApproval(input);
      const snapshot = yield* applyAutomationApproval(current, binding, approval.status);
      return {
        approval,
        automation: true as const,
        execution: yield* decodeExecution(snapshot).pipe(
          Effect.mapError(
            (cause) =>
              new CommandCenterError({
                reason: "persistence",
                message: "The resolved automation execution is invalid.",
                cause,
              }),
          ),
        ),
      };
    }, Effect.mapError(toCommandCenterError));

    return AutomationRuns.of({ start, get, recoverDue, decideApproval });
  }),
);

const failClosedExecutor: AutomationRuntime.AutomationNodeExecutor = (context) =>
  Effect.fail(
    `No v1 executor is enabled for automation node '${context.node.id}' (${context.node.kind}).`,
  );

export const failClosedRuntimeLayer = Layer.unwrap(
  AutomationRuntime.makeDefaultDependencies(failClosedExecutor).pipe(
    Effect.map((dependencies) =>
      AutomationRuntime.layer({ ...dependencies, defaultMaxAttempts: 1 }),
    ),
  ),
);

/**
 * Runtime layer for the deliberately small v1 executor surface. Every external
 * operation is resolved through its Space-scoped service. Agent work uses the
 * durable Run dispatcher, and shell work receives only a server-resolved
 * owner allowlist entry instead of ambient host access.
 */
export const safeRuntimeLayer = Layer.unwrap(
  Effect.gen(function* () {
    const commandCenter = yield* CommandCenterService.CommandCenterService;
    const google = yield* GoogleReadConnector.GoogleReadConnector;
    const sales = yield* SalesPipeline.SalesPipeline;
    const prospector = yield* ExternalProspectorConnector.ExternalProspectorConnector;
    const prospectRunner = yield* SalesProspectorRunner.SalesProspectorRunner;
    const serverConfig = yield* ServerConfig;
    const path = yield* Path.Path;
    const scopedShell = yield* AutomationScopedShell.AutomationScopedShell;
    const startAgentRun = yield* makeLiveAutomationAgentRunAdapter;
    const executeSalesAutomationAction = makeSalesAutomationActionExecutor({
      commandCenter,
      google,
      sales,
      prospector,
      runner: prospectRunner,
    });
    const executeNode = makeSafeAutomationNodeExecutor({
      startAgentRun,
      executeSalesAutomationAction,
      runScopedShell: scopedShell.execute,
      createItem: (input) =>
        commandCenter.createItem(input).pipe(
          Effect.map((item) => JSON.parse(JSON.stringify(item)) as Schema.Json),
          Effect.mapError((cause) => cause.message),
        ),
      googleRead: (input) =>
        Effect.gen(function* () {
          const requiredCapability = googleCapabilityForOperation(input.operation);
          const connections = (yield* commandCenter.queryConnections({
            spaceId: input.spaceId,
          })).connections;
          const connection = connections.find(
            (candidate) =>
              candidate.id === input.connectionId &&
              candidate.spaceId === input.spaceId &&
              candidate.kind === "google" &&
              candidate.capabilities.includes(requiredCapability),
          );
          if (connection === undefined) {
            return yield* Effect.fail(
              `The requested Google connection does not grant ${requiredCapability}.`,
            );
          }
          return yield* google.read(input);
        }).pipe(
          Effect.flatMap((result) =>
            result.operation === "drive.export"
              ? Effect.fail("Drive export is unavailable to generic automation connector nodes.")
              : Effect.succeed(result),
          ),
          Effect.mapError((cause) => (typeof cause === "string" ? cause : cause.message)),
        ),
      googleDraft: (input) =>
        Effect.gen(function* () {
          const requiredCapability = googleCapabilityForDraft(input.operation);
          const connections = (yield* commandCenter.queryConnections({ spaceId: input.spaceId }))
            .connections;
          const connection = connections.find(
            (candidate) =>
              candidate.id === input.connectionId &&
              candidate.spaceId === input.spaceId &&
              candidate.kind === "google" &&
              candidate.capabilities.includes(requiredCapability),
          );
          if (connection === undefined) {
            return yield* Effect.fail(
              `The requested Google connection does not grant ${requiredCapability}.`,
            );
          }
          const artifacts =
            input.attachmentArtifactIds === undefined
              ? []
              : (yield* commandCenter.queryArtifacts({
                  spaceId: input.spaceId,
                  limit: 500,
                })).artifacts.filter((artifact) =>
                  input.attachmentArtifactIds!.includes(artifact.id),
                );
          if (artifacts.length !== (input.attachmentArtifactIds?.length ?? 0)) {
            return yield* Effect.fail("A Gmail draft attachment is not available in this Space.");
          }
          const attachmentPaths = artifacts.map((artifact) => {
            const extension = artifact.name.split(".").at(-1);
            return extension !== undefined &&
              /^[a-z0-9]{1,10}$/iu.test(extension) &&
              artifact.kind === "export" &&
              artifact.locator === `cc-artifact://${artifact.id}`
              ? path.join(serverConfig.attachmentsDir, "exports", `${artifact.id}.${extension}`)
              : undefined;
          });
          if (attachmentPaths.some((attachmentPath) => attachmentPath === undefined)) {
            return yield* Effect.fail(
              "Gmail drafts may attach only server-owned export artifacts.",
            );
          }
          const resolvedAttachmentPaths = attachmentPaths.filter(
            (attachmentPath): attachmentPath is string => attachmentPath !== undefined,
          );
          if (google.createDraft === undefined) {
            return yield* Effect.fail("Gmail draft creation is not configured on this server.");
          }
          return yield* google.createDraft(input, resolvedAttachmentPaths);
        }).pipe(Effect.mapError((cause) => (typeof cause === "string" ? cause : cause.message))),
    });
    const dependencies = yield* AutomationRuntime.makeDefaultDependencies(executeNode);
    return AutomationRuntime.layer({
      ...dependencies,
      defaultMaxAttempts: 3,
      defaultRetryDelayMs: 1_000,
    });
  }),
);
