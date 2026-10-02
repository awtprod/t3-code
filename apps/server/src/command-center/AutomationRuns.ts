import {
  CommandCenterAutomationExecution,
  type CommandCenterAutomationExecution as CommandCenterAutomationExecutionType,
  type CommandCenterApprovalDecisionInput,
  type CommandCenterAutomationRunGetInput,
  type CommandCenterAutomationRunStartInput,
  CommandCenterError,
  GoogleDraftCreateResult,
  type CommandCenterInboxDraftApproveInput,
} from "@t3tools/contracts";
import { ApprovalId, ItemId, SpaceId, type Approval as ApprovalType } from "@command-center/core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as Schedule from "effect/Schedule";
import * as Duration from "effect/Duration";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as CommandCenterService from "./Service.ts";
import * as RepositoryChecks from "./RepositoryChecks.ts";
import * as InboxGmailDrafts from "./InboxGmailDrafts.ts";
import * as CommandCenterCredentialStore from "./CredentialStore.ts";
import { makeProspectEvaluationConnector } from "./ProspectEvaluation.ts";
import * as ProspectNotificationRelay from "../relay/ProspectNotificationRelay.ts";
import { ServerConfig } from "../config.ts";
import * as GoogleReadConnector from "./GoogleReadConnector.ts";
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
import {
  makeSafeAutomationNodeExecutor,
  type ProspectNotificationResult,
} from "./automation/NodeExecutor.ts";
import * as AutomationRuntime from "./automation/Runtime.ts";

const decodeExecution = Schema.decodeUnknownEffect(CommandCenterAutomationExecution);
const decodeDraftResult = Schema.decodeUnknownEffect(GoogleDraftCreateResult);
const isCommandCenterError = Schema.is(CommandCenterError);
const isAutomationRuntimeError = Schema.is(AutomationRuntime.AutomationRuntimeError);
const terminalStates = new Set(["succeeded", "failed", "canceled"]);
const retryableProspectNotificationReasons =
  new Set<ProspectNotificationRelay.ProspectNotificationRelayFailureReason>([
    "item_load_failed",
    "signing_failed",
    "request_failed",
    "timed_out",
  ]);

type JsonRecord = Readonly<Record<string, Schema.Json>>;

function isJsonRecord(value: Schema.Json | null): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readRequiredString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function summarizeProspectNotificationResults(
  results: ReadonlyArray<ProspectNotificationRelay.ProspectNotificationRelayItemResult>,
): ProspectNotificationResult {
  const queuedCount = results.filter((result) => result.status === "queued").length;
  const skippedCount = results.filter((result) => result.status === "skipped").length;
  const failedCount = results.filter((result) => result.status === "failed").length;
  const status =
    results.length === 0
      ? "noop"
      : skippedCount === results.length
        ? "skipped"
        : queuedCount === results.length
          ? "queued"
          : "partial";
  return { status, queuedCount, skippedCount, failedCount };
}

function isRetryableProspectNotificationError(
  error: ProspectNotificationRelay.ProspectNotificationRelayBatchError,
): boolean {
  const failedReasons = error.results.flatMap((result) =>
    result.status === "failed" ? [result.reason] : [],
  );
  const reasons = failedReasons.length === 0 ? [error.reason] : failedReasons;
  return reasons.every((reason) => retryableProspectNotificationReasons.has(reason));
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
  readonly approveInboxDraft: (
    input: CommandCenterInboxDraftApproveInput,
    actorSubject: string,
  ) => Effect.Effect<
    import("@t3tools/contracts").CommandCenterInboxDraftReceipt,
    CommandCenterError
  >;
  readonly getInboxDraftReceipt: (
    input: import("@t3tools/contracts").CommandCenterInboxDraftReceiptInput,
  ) => Effect.Effect<
    import("@t3tools/contracts").CommandCenterInboxDraftReceipt | null,
    CommandCenterError
  >;
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

/**
 * Resolve the server-owned export files a Gmail draft may attach. The requested Artifact ids are
 * looked up directly with Space scope, so an older export stays attachable no matter how many
 * newer Artifacts the Space holds, while an id from another Space is still rejected.
 */
export const resolveGoogleDraftAttachmentPaths = Effect.fn(
  "AutomationRuns.resolveGoogleDraftAttachmentPaths",
)(function* (input: {
  readonly commandCenter: Pick<
    CommandCenterService.CommandCenterService["Service"],
    "getArtifactsByIds"
  >;
  readonly path: Pick<Path.Path, "join">;
  readonly attachmentsDir: string;
  readonly spaceId: SpaceId;
  readonly attachmentArtifactIds: ReadonlyArray<string>;
}) {
  const requestedArtifactIds = input.attachmentArtifactIds;
  const found =
    requestedArtifactIds.length === 0
      ? []
      : (yield* input.commandCenter.getArtifactsByIds({
          spaceId: input.spaceId,
          artifactIds: requestedArtifactIds,
        })).artifacts;
  const foundById = new Map(
    found
      .filter((artifact) => artifact.spaceId === input.spaceId)
      .map((artifact) => [artifact.id as string, artifact] as const),
  );
  const artifacts = requestedArtifactIds.flatMap((artifactId) => {
    const artifact = foundById.get(artifactId);
    return artifact === undefined ? [] : [artifact];
  });
  if (artifacts.length !== requestedArtifactIds.length) {
    return yield* Effect.fail("A Gmail draft attachment is not available in this Space.");
  }
  const paths = artifacts.map((artifact) => {
    const extension = artifact.name.split(".").at(-1);
    return extension !== undefined &&
      /^[a-z0-9]{1,10}$/iu.test(extension) &&
      artifact.kind === "export" &&
      artifact.locator === `cc-artifact://${artifact.id}`
      ? input.path.join(input.attachmentsDir, "exports", `${artifact.id}.${extension}`)
      : undefined;
  });
  if (paths.some((attachmentPath) => attachmentPath === undefined)) {
    return yield* Effect.fail("Gmail drafts may attach only server-owned export artifacts.");
  }
  return paths.filter((attachmentPath): attachmentPath is string => attachmentPath !== undefined);
});

/** Bounded wait for in-flight drives on shutdown (systemd stops after 30 s). */
const DRIVE_SHUTDOWN_DRAIN = Duration.seconds(20);

export const layer = Layer.effect(
  AutomationRuns,
  Effect.gen(function* () {
    const runtime = yield* AutomationRuntime.AutomationRuntime;
    const commandCenter = yield* CommandCenterService.CommandCenterService;
    const inboxDrafts = yield* InboxGmailDrafts.InboxGmailDrafts;
    const sql = yield* SqlClient.SqlClient;
    // Drives run on the server's lifetime, not the request's: a client
    // disconnect or RPC cancel must not interrupt a step mid-way (an unsafe
    // step would then have to fail closed). On shutdown, in-flight drives get
    // a bounded drain before they are interrupted.
    const drives = yield* FiberSet.make<AutomationRuntime.AutomationExecutionSnapshot, unknown>();
    const inboxDraftAdmission = yield* Semaphore.make(1);
    yield* Effect.addFinalizer(() =>
      FiberSet.awaitEmpty(drives).pipe(Effect.timeoutOption(DRIVE_SHUTDOWN_DRAIN), Effect.asVoid),
    );
    // Operator hold: executions created before this process started are not
    // resumed by any path while it is set.
    const held = yield* AutomationRuntime.readAutomationRecoveryHold;
    const startedAt = yield* runtime.now;
    const isHeld = (snapshot: AutomationRuntime.AutomationExecutionSnapshot) =>
      held && snapshot.createdAt < startedAt;
    const inspectAgentRun = makeAutomationAgentRunInspector(sql);

    const recordSnapshot = (snapshot: AutomationRuntime.AutomationExecutionSnapshot) =>
      commandCenter.recordAutomationEvent({
        executionId: snapshot.id,
        automationId: snapshot.automationId,
        spaceId: snapshot.spaceId,
        state: snapshot.state,
        configCommitSha: snapshot.configCommitSha,
        definitionDigest: snapshot.definitionDigest,
        input: snapshot.input,
        output: snapshot.output,
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.updatedAt,
        checkpoints: snapshot.checkpoints.map((checkpoint) => ({
          nodeId: checkpoint.nodeId,
          state: checkpoint.state,
          attemptCount: checkpoint.attemptCount,
          resolutionKey: checkpoint.resolutionKey,
        })),
        finishedAt: snapshot.finishedAt,
        ...(snapshot.error === null ? {} : { error: snapshot.error }),
      });

    const record = Effect.fn("AutomationRuns.record")(function* (
      snapshot: AutomationRuntime.AutomationExecutionSnapshot,
    ) {
      // A superseded snapshot is still audited, but it must not drive the
      // Run projection or approval gates: whoever wrote the newer runtime row
      // records that row.
      const { projected } = yield* recordSnapshot(snapshot);
      if (!projected) return;
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
      if (isHeld(initial)) return initial;
      const acquired = yield* runtime
        .acquireLease({
          executionId: initial.id,
          owner,
          ttlMs: AutomationRuntime.AUTOMATION_LEASE_TTL_MS,
        })
        .pipe(
          Effect.map((lease) => ({ lease })),
          Effect.catchIf(
            (cause) =>
              isAutomationRuntimeError(cause) &&
              (cause.code === "lease-denied" || cause.code === "invalid-state"),
            () => Effect.succeed(null),
          ),
        );
      // Another worker holds the live lease and is driving this execution (or
      // it already finished); it records the result. Report the current state
      // instead of failing.
      if (acquired === null) return yield* runtime.get(initial.id);
      const lease = acquired.lease;
      const command = { executionId: initial.id, owner, token: lease.token };
      const drive = Effect.gen(function* () {
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
      }).pipe(
        Effect.ensuring(runtime.releaseLease(command).pipe(Effect.ignore)),
        // Project the result from the detached fiber too: the caller may be
        // gone (cancelled request, shutdown drain) by the time the step ends.
        Effect.andThen(runtime.get(initial.id)),
        Effect.tap((finished) => record(finished).pipe(Effect.retry(Schedule.recurs(2)))),
      );
      return yield* Fiber.join(yield* FiberSet.run(drives)(drive));
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
      // Held executions are left exactly as they are, decisions included.
      if (isHeld(snapshot)) return snapshot;
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
      // While held, scan only work created after start so held executions
      // (which are left untouched) cannot fill every batch.
      const scope = {
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(held ? { createdAtOrAfter: startedAt } : {}),
      };
      const due = yield* runtime.listRecoverable(scope);
      const waitingAgents = yield* runtime.listWaitingExternal(scope);
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
      // A process can also stop after the runtime reached waiting_approval
      // but before the Run and its approval gate were projected. Nothing would
      // ever show that gate, so recover it here.
      const unprojectedGates = yield* sql<{ readonly id: string }>`
        SELECT DISTINCT execution.id
        FROM command_center_automation_executions execution
        JOIN command_center_automation_node_checkpoints checkpoint
          ON checkpoint.execution_id = execution.id AND checkpoint.state = 'waiting_approval'
        WHERE execution.state = 'waiting_approval'
          AND execution.created_at >= ${held ? startedAt : ""}
          AND NOT EXISTS (
            SELECT 1 FROM command_center_approvals approval
            WHERE approval.id = 'automation-approval:' || execution.id || ':' || checkpoint.node_id
          )
        ORDER BY execution.updated_at, execution.id
        LIMIT ${input.limit ?? 50}
      `;
      const executionIds = [
        ...new Set([
          ...due.map((snapshot) => snapshot.id),
          ...waitingAgents.map((snapshot) => snapshot.id),
          ...waitingApprovalIds,
          ...unprojectedGates.map((row) => row.id),
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
      if (snapshot.state === "waiting_approval" && !isHeld(snapshot)) {
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

    const approveInboxDraft: AutomationRunsShape["approveInboxDraft"] = Effect.fn(
      "AutomationRuns.approveInboxDraft",
    )(function* (input, actorSubject) {
      const automations = (yield* commandCenter.queryAutomations({
        spaceId: input.spaceId,
        enabled: true,
        limit: 500,
      })).automations;
      const templates = automations.filter((automation) => {
        if (
          automation.trigger.type !== "manual" ||
          automation.configCommit === undefined ||
          automation.nodes.length !== 2 ||
          automation.edges.length !== 1
        )
          return false;
        const approval = automation.nodes.find((node) => node.kind === "approval");
        const draft = automation.nodes.find((node) => node.kind === "connector.write");
        return (
          approval !== undefined &&
          draft !== undefined &&
          draft.config.operation === "gmail.draft.create" &&
          draft.config.source === "inbox.accepted" &&
          automation.edges[0]?.sourceNodeId === approval.id &&
          automation.edges[0]?.targetNodeId === draft.id
        );
      });
      if (templates.length !== 1) {
        return yield* new CommandCenterError({
          reason: "validation",
          message:
            "This Space needs exactly one enabled Inbox Gmail draft approval flow before a draft can be created.",
        });
      }
      const template = templates[0]!;
      // Admission coalesces onto a Responsibility's active run. Another draft's
      // run (e.g. one held across a deploy) would otherwise absorb this
      // approval, or this approval would decide that run's gate.
      // The check, the receipt approval and the admission run under one lock,
      // so two different drafts approved at once cannot both pass the check
      // and have one bound to the other's run.
      const admitted = yield* inboxDraftAdmission.withPermits(1)(
        Effect.gen(function* () {
          const otherActive = yield* sql<{ readonly id: string; readonly state: string }>`
            SELECT id, state FROM command_center_automation_executions
            WHERE automation_id = ${template.id} AND space_id = ${input.spaceId}
              AND state NOT IN ('succeeded', 'failed', 'canceled')
              AND COALESCE(json_extract(input_json, '$.mutationId'), '') != ${input.mutationId}
            LIMIT 1
          `;
          const blocking = otherActive[0];
          if (blocking !== undefined) {
            return yield* new CommandCenterError({
              reason: "conflict",
              message: `Another Inbox Gmail draft (run ${blocking.id}, ${blocking.state}) is still being processed in this Space. Approve this draft after it finishes.`,
            });
          }
          const approvedReceipt = yield* inboxDrafts.approve(input, actorSubject);
          if (approvedReceipt.status === "created" || approvedReceipt.status === "uncertain") {
            return { approved: approvedReceipt };
          }
          yield* inboxDrafts.loadForExecution({
            mutationId: input.mutationId,
            spaceId: input.spaceId,
            payloadDigest: approvedReceipt.payloadDigest,
          });
          // Admission only; the run is driven after the lock is released so
          // other approvals never wait on a step.
          yield* runtime.start({
            automationId: template.id,
            expectedSpaceId: input.spaceId,
            idempotencyKey: `inbox-gmail-draft:${input.mutationId}`,
            expectedConfigCommitSha: template.configCommit!,
            expectedDefinitionDigest: template.definitionDigest,
            input: { mutationId: input.mutationId, payloadDigest: approvedReceipt.payloadDigest },
          });
          return { approved: approvedReceipt, payloadDigest: approvedReceipt.payloadDigest };
        }),
      );
      const approved = admitted.approved;
      if (!("payloadDigest" in admitted)) return approved;
      // Same idempotency key: returns the run admitted above and drives it.
      const execution = yield* start({
        automationId: template.id,
        spaceId: input.spaceId,
        idempotencyKey: `inbox-gmail-draft:${input.mutationId}`,
        expectedConfigCommitSha: template.configCommit!,
        expectedDefinitionDigest: template.definitionDigest,
        input: { mutationId: input.mutationId, payloadDigest: admitted.payloadDigest },
      });
      if (execution.input.mutationId !== input.mutationId) {
        return yield* new CommandCenterError({
          reason: "conflict",
          message:
            "Another Inbox Gmail draft is still being processed in this Space. Approve this draft after it finishes.",
        });
      }
      const waiting = execution.checkpoints.find(
        (checkpoint) =>
          checkpoint.state === "waiting_approval" && checkpoint.nodeKind === "approval",
      );
      if (waiting === undefined) {
        const latest = yield* inboxDrafts.receipt({ spaceId: input.spaceId, itemId: input.itemId });
        if (
          latest !== null &&
          latest.revisionId === input.revisionId &&
          latest.status === "created"
        )
          return latest;
        return yield* new CommandCenterError({
          reason: "conflict",
          message: "The Gmail draft automation is not waiting at its approval gate.",
        });
      }
      const approvalId = `automation-approval:${execution.id}:${waiting.nodeId}`;
      const rows = yield* sql<{ readonly payloadDigest: string }>`
        SELECT payload_digest AS "payloadDigest" FROM command_center_approvals
        WHERE id = ${approvalId} AND status = 'requested' LIMIT 1
      `;
      const gate = rows[0];
      if (gate === undefined)
        return yield* new CommandCenterError({
          reason: "conflict",
          message: "The Gmail draft approval gate is unavailable.",
        });
      yield* inboxDrafts.loadForExecution({
        mutationId: input.mutationId,
        spaceId: input.spaceId,
        payloadDigest: approved.payloadDigest,
      });
      yield* decideApproval({
        approvalId: ApprovalId.make(approvalId),
        payloadDigest: gate.payloadDigest,
        decision: "approved",
      });
      const latest = yield* inboxDrafts.receipt({ spaceId: input.spaceId, itemId: input.itemId });
      if (latest === null || latest.revisionId !== input.revisionId) {
        return yield* new CommandCenterError({
          reason: "persistence",
          message: "The Gmail draft receipt is unavailable.",
        });
      }
      return latest;
    }, Effect.mapError(toCommandCenterError));

    return AutomationRuns.of({
      start,
      get,
      recoverDue,
      decideApproval,
      approveInboxDraft,
      getInboxDraftReceipt: inboxDrafts.receipt,
    });
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
 * Gmail draft executors for the safe runtime. `prepareGoogleDraft` checks the
 * Space-scoped connection grant and resolves attachments. `executeInboxDraft`
 * runs the `connector.write` node of an Inbox Gmail draft approval flow: it
 * re-binds the approved receipt, claims it, and makes exactly one
 * `createDraft` call. A created receipt short-circuits; a failed or
 * unverified response becomes `uncertain` and is never retried.
 */
export const makeGoogleDraftExecutors = (dependencies: {
  readonly commandCenter: CommandCenterService.CommandCenterServiceShape;
  readonly inboxDrafts: InboxGmailDrafts.InboxGmailDrafts["Service"];
  readonly google: GoogleReadConnector.GoogleReadConnectorShape;
  readonly path: Path.Path;
  readonly attachmentsDir: string;
}) => {
  const { commandCenter, inboxDrafts, google, path, attachmentsDir } = dependencies;
  const prepareGoogleDraft = Effect.fn("AutomationRuns.prepareGoogleDraft")(function* (
    input: import("@t3tools/contracts").GoogleDraftCreateRequest,
  ) {
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
    return yield* resolveGoogleDraftAttachmentPaths({
      commandCenter,
      path,
      attachmentsDir,
      spaceId: input.spaceId,
      attachmentArtifactIds: input.attachmentArtifactIds ?? [],
    });
  });

  const executeInboxDraft = Effect.fn("AutomationRuns.executeInboxDraft")(
    function* (context: import("./automation/Runtime.ts").AutomationNodeExecutionContext) {
      const runInput = context.runInput;
      const mutationId = runInput.mutationId;
      const payloadDigest = runInput.payloadDigest;
      if (typeof mutationId !== "string" || typeof payloadDigest !== "string") {
        return yield* Effect.fail(
          "The accepted Inbox draft Run has no immutable approval binding.",
        );
      }
      const bound = yield* inboxDrafts.loadForExecution({
        mutationId,
        spaceId: context.spaceId,
        payloadDigest,
      });
      if (bound.status === "created") return bound.receipt as unknown as Schema.Json;
      const attachmentPaths = yield* prepareGoogleDraft(bound.request);
      if (google.createDraft === undefined) {
        return yield* Effect.fail("Gmail draft creation is not configured on this server.");
      }
      yield* inboxDrafts.claim(mutationId);
      const drafted = yield* google
        .createDraft(bound.request, attachmentPaths, bound.accountAlias)
        .pipe(
          Effect.match({
            onFailure: (error) => ({ ok: false as const, error }),
            onSuccess: (value) => ({ ok: true as const, value }),
          }),
        );
      if (!drafted.ok) {
        yield* inboxDrafts.uncertain(mutationId, drafted.error.message);
        return yield* Effect.fail(
          "Gmail draft creation needs reconciliation; no automatic retry will create another draft.",
        );
      }
      const result = yield* decodeDraftResult(drafted.value).pipe(
        Effect.match({
          onFailure: () => ({ ok: false as const }),
          onSuccess: (value) => ({ ok: true as const, value }),
        }),
      );
      if (!result.ok) {
        yield* inboxDrafts.uncertain(
          mutationId,
          "The Gmail draft response did not contain a verified draft ID.",
        );
        return yield* Effect.fail(
          "Gmail draft creation needs reconciliation; the draft ID was not verified.",
        );
      }
      return (yield* inboxDrafts.complete(mutationId, {
        draftId: result.value.draftId,
        ...(result.value.messageId === undefined ? {} : { messageId: result.value.messageId }),
        ...(result.value.threadId === undefined ? {} : { threadId: result.value.threadId }),
      })) as unknown as Schema.Json;
    },
    Effect.mapError((cause) => (typeof cause === "string" ? cause : cause.message)),
  );
  return { prepareGoogleDraft, executeInboxDraft };
};

/**
 * Runtime layer for the deliberately small v1 executor surface. Every external
 * operation is resolved through its Space-scoped service. Agent work uses the
 * durable Run dispatcher, and shell work receives only a server-resolved
 * owner allowlist entry instead of ambient host access.
 */
export const safeRuntimeLayer = Layer.unwrap(
  Effect.gen(function* () {
    const commandCenter = yield* CommandCenterService.CommandCenterService;
    const inboxDrafts = yield* InboxGmailDrafts.InboxGmailDrafts;
    const google = yield* GoogleReadConnector.GoogleReadConnector;
    const serverConfig = yield* ServerConfig;
    const path = yield* Path.Path;
    const scopedShell = yield* AutomationScopedShell.AutomationScopedShell;
    const prospectNotificationRelay = yield* ProspectNotificationRelay.ProspectNotificationRelay;
    const repositoryChecks = yield* RepositoryChecks.RepositoryChecks;
    const credentials = yield* CommandCenterCredentialStore.make;
    const startAgentRun = yield* makeLiveAutomationAgentRunAdapter;
    const prospectEvaluation = makeProspectEvaluationConnector({
      credentials,
      items: {
        queryItems: (input) =>
          commandCenter
            .queryItems({ spaceId: SpaceId.make(input.spaceId) })
            .pipe(Effect.mapError((cause) => cause.message)),
        createItem: (input) =>
          commandCenter
            .createItem({ ...input, spaceId: SpaceId.make(input.spaceId) })
            .pipe(Effect.mapError((cause) => cause.message)),
        updateItem: (input) =>
          commandCenter
            .updateItem({
              ...input,
              itemId: ItemId.make(input.itemId),
              spaceId: SpaceId.make(input.spaceId),
            })
            .pipe(Effect.mapError((cause) => cause.message)),
      },
    });
    const { prepareGoogleDraft, executeInboxDraft } = makeGoogleDraftExecutors({
      commandCenter,
      inboxDrafts,
      google,
      path,
      attachmentsDir: serverConfig.attachmentsDir,
    });

    const executeNode = makeSafeAutomationNodeExecutor({
      pollRepositoryChecks: repositoryChecks.poll,
      executeInboxDraft,
      startAgentRun,
      evaluateProspects: prospectEvaluation.evaluate,
      notifyProspects: (input) =>
        prospectNotificationRelay.notify(input).pipe(
          Effect.map(summarizeProspectNotificationResults),
          Effect.mapError((error) => ({
            message: error.message,
            retryable: isRetryableProspectNotificationError(error),
          })),
        ),
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
          const attachmentPaths = yield* prepareGoogleDraft(input);
          if (google.createDraft === undefined)
            return yield* Effect.fail("Gmail draft creation is not configured on this server.");
          const created = yield* google.createDraft(input, attachmentPaths);
          return {
            operation: created.operation,
            draftId: created.draftId,
            ...(created.messageId === undefined ? {} : { messageId: created.messageId }),
            ...(created.threadId === undefined ? {} : { threadId: created.threadId }),
          };
        }).pipe(Effect.mapError((cause) => (typeof cause === "string" ? cause : cause.message))),
    });
    const dependencies = yield* AutomationRuntime.makeDefaultDependencies(executeNode);
    return AutomationRuntime.layer({
      ...dependencies,
      defaultMaxAttempts: 3,
      defaultRetryDelayMs: 1_000,
    });
  }),
).pipe(Layer.provide(ProspectNotificationRelay.layer));
