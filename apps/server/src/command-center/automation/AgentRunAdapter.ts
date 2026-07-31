// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  ModelId,
  ProjectId,
  ProviderId,
  RepositoryId,
  SpaceId,
  type ProviderAvailability,
  type RunStatus,
} from "@command-center/core";
import {
  type CommandCenterCommandSubmitInput,
  type CommandCenterCommandSubmitResult,
  type CommandCenterError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ProviderRegistry from "../../provider/Services/ProviderRegistry.ts";
import { commandCenterProviderAvailability } from "../ProviderAvailability.ts";
import * as CommandCenterService from "../Service.ts";

export interface AutomationAgentRunRequest {
  readonly executionId: string;
  readonly automationId: string;
  readonly nodeId: string;
  readonly spaceId: string;
  readonly text: string;
  readonly repositoryId?: string;
  readonly projectId?: string;
  readonly providerId?: string;
  readonly modelId?: string;
}

export interface AutomationAgentRunLinkedResult {
  readonly kind: "command-center-run";
  readonly relationship: "automation-child";
  readonly parentExecutionId: string;
  readonly automationId: string;
  readonly nodeId: string;
  readonly commandId: string;
  readonly runId: string;
  readonly spaceId: string;
  readonly repositoryId: string | null;
  readonly projectId: string | null;
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly state: RunStatus;
  readonly routeStatus: "ready" | "approval-required" | "blocked";
  readonly approvalRequired: boolean;
  readonly reasons: ReadonlyArray<string>;
  readonly duplicate: boolean;
}

export interface AutomationAgentRunFailure {
  readonly message: string;
  readonly retryable: boolean;
}

export type AutomationAgentRunStarter = (
  request: AutomationAgentRunRequest,
) => Effect.Effect<AutomationAgentRunLinkedResult, AutomationAgentRunFailure>;

export interface AutomationAgentRunInspection {
  readonly runId: string;
  readonly state: RunStatus;
  readonly result: Schema.Json | null;
  readonly error: string | null;
  readonly finishedAt: string | null;
}

export interface AutomationAgentRunBinding {
  readonly parentExecutionId: string;
  readonly nodeId: string;
  readonly commandId: string;
  readonly childRunId: string;
  readonly spaceId: string;
}

export interface AutomationAgentRunAdapterDependencies {
  readonly providerAvailability: Effect.Effect<
    ReadonlyArray<ProviderAvailability>,
    AutomationAgentRunFailure
  >;
  readonly submitCommand: (
    command: CommandCenterCommandSubmitInput,
    providers: ReadonlyArray<ProviderAvailability>,
  ) => Effect.Effect<CommandCenterCommandSubmitResult, AutomationAgentRunFailure>;
  readonly linkParent: (input: {
    readonly parentExecutionId: string;
    readonly childRunId: string;
    readonly commandId: string;
    readonly spaceId: string;
  }) => Effect.Effect<void, AutomationAgentRunFailure>;
  readonly authorizeRun: (
    runId: CommandCenterCommandSubmitResult["run"]["id"],
  ) => Effect.Effect<void, AutomationAgentRunFailure>;
}

const permanentFailure = (message: string): AutomationAgentRunFailure => ({
  message,
  retryable: false,
});

const retryableFailure = (message: string): AutomationAgentRunFailure => ({
  message,
  retryable: true,
});

/** Stable across runtime attempts so a crash cannot fan out duplicate child Runs. */
export const automationAgentCommandId = (request: {
  readonly executionId: string;
  readonly nodeId: string;
}): string => `automation-agent:${request.executionId}:${request.nodeId}`;

export function automationAgentRunResumeKey(binding: AutomationAgentRunBinding): string {
  const digest = NodeCrypto.createHash("sha256")
    .update(binding.parentExecutionId, "utf8")
    .update("\0", "utf8")
    .update(binding.nodeId, "utf8")
    .update("\0", "utf8")
    .update(binding.commandId, "utf8")
    .update("\0", "utf8")
    .update(binding.childRunId, "utf8")
    .update("\0", "utf8")
    .update(binding.spaceId, "utf8")
    .digest("hex");
  return `automation-agent-wait:${digest}`;
}

function validateSubmittedScope(
  request: AutomationAgentRunRequest,
  result: CommandCenterCommandSubmitResult,
): AutomationAgentRunFailure | undefined {
  if (
    String(result.run.spaceId) !== request.spaceId ||
    String(result.route.spaceId) !== request.spaceId
  ) {
    return permanentFailure("The routed child Run did not retain its automation Space scope.");
  }
  const exactSelections = [
    ["repository", request.repositoryId, result.route.repositoryId],
    ["project", request.projectId, result.route.projectId],
    ["provider", request.providerId, result.route.providerId],
    ["model", request.modelId, result.route.modelId],
  ] as const;
  for (const [label, requested, routed] of exactSelections) {
    if (requested !== undefined && String(routed) !== requested) {
      return permanentFailure(`The routed child Run did not retain its explicit ${label} scope.`);
    }
  }
  return undefined;
}

/**
 * Starts and links a durable child Run. The automation runtime persists this
 * receipt as an external wait; its recovery coordinator owns terminal joining.
 */
export function makeAutomationAgentRunAdapter(
  dependencies: AutomationAgentRunAdapterDependencies,
): AutomationAgentRunStarter {
  return Effect.fn("AutomationAgentRunAdapter.start")(function* (
    request: AutomationAgentRunRequest,
  ) {
    const commandId = automationAgentCommandId(request);
    const command: CommandCenterCommandSubmitInput = {
      commandId: CommandId.make(commandId),
      text: request.text,
      spaceId: SpaceId.make(request.spaceId),
      ...(request.repositoryId === undefined
        ? {}
        : { repositoryId: RepositoryId.make(request.repositoryId) }),
      ...(request.projectId === undefined ? {} : { projectId: ProjectId.make(request.projectId) }),
      ...(request.providerId === undefined
        ? {}
        : { providerId: ProviderId.make(request.providerId) }),
      ...(request.modelId === undefined ? {} : { modelId: ModelId.make(request.modelId) }),
    };
    const providers = yield* dependencies.providerAvailability;
    const result = yield* dependencies.submitCommand(command, providers);
    const invalidScope = validateSubmittedScope(request, result);
    if (invalidScope !== undefined) return yield* Effect.fail(invalidScope);

    yield* dependencies.linkParent({
      parentExecutionId: request.executionId,
      childRunId: String(result.run.id),
      commandId,
      spaceId: request.spaceId,
    });
    if (result.route.status === "ready" && result.run.status === "queued") {
      yield* dependencies.authorizeRun(result.run.id);
    }

    return {
      kind: "command-center-run" as const,
      relationship: "automation-child" as const,
      parentExecutionId: request.executionId,
      automationId: request.automationId,
      nodeId: request.nodeId,
      commandId,
      runId: String(result.run.id),
      spaceId: request.spaceId,
      repositoryId: result.route.repositoryId === null ? null : String(result.route.repositoryId),
      projectId: result.route.projectId === null ? null : String(result.route.projectId),
      providerId: result.route.providerId === null ? null : String(result.route.providerId),
      modelId: result.route.modelId === null ? null : String(result.route.modelId),
      state: result.run.status,
      routeStatus: result.route.status,
      approvalRequired: result.route.approvalRequired,
      reasons: result.route.reasons,
      duplicate: result.duplicate,
    };
  });
}

const decodeStoredJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

/** Exact child lookup used by durable automation wait reconciliation. */
export function makeAutomationAgentRunInspector(sql: SqlClient.SqlClient) {
  return Effect.fn("AutomationAgentRunAdapter.inspect")(function* (
    binding: AutomationAgentRunBinding,
  ) {
    const rows = yield* sql<{
      readonly id: string;
      readonly state: RunStatus;
      readonly resultJson: string | null;
      readonly error: string | null;
      readonly finishedAt: string | null;
    }>`
      SELECT child.id, child.state, child.result_json AS "resultJson",
        child.error, child.finished_at AS "finishedAt"
      FROM command_center_runs child
      WHERE child.id = ${binding.childRunId}
        AND child.command_id = ${binding.commandId}
        AND child.parent_run_id = ${binding.parentExecutionId}
        AND child.space_id = ${binding.spaceId}
        AND child.kind = 'agent'
        AND EXISTS (
          SELECT 1 FROM command_center_runs parent
          WHERE parent.id = ${binding.parentExecutionId}
            AND parent.space_id = ${binding.spaceId}
            AND parent.kind = 'automation'
        )
      LIMIT 1
    `.pipe(Effect.mapError(() => retryableFailure("The linked child Run could not be inspected.")));
    const row = rows[0];
    if (row === undefined) {
      return yield* Effect.fail(
        permanentFailure("The durable automation child Run binding is missing or invalid."),
      );
    }
    const result =
      row.resultJson === null
        ? null
        : yield* decodeStoredJson(row.resultJson).pipe(
            Effect.mapError(() =>
              permanentFailure("The linked child Run contains an invalid stored result."),
            ),
          );
    return {
      runId: row.id,
      state: row.state,
      result: result as Schema.Json | null,
      error: row.error,
      finishedAt: row.finishedAt,
    } satisfies AutomationAgentRunInspection;
  });
}

const commandCenterFailure = (cause: CommandCenterError): AutomationAgentRunFailure => ({
  message: cause.message,
  retryable:
    cause.reason === "config" || cause.reason === "persistence" || cause.reason === "connector",
});

export function makeAutomationAgentRunParentLinker(
  sql: SqlClient.SqlClient,
): AutomationAgentRunAdapterDependencies["linkParent"] {
  return (input) =>
    Effect.gen(function* () {
      const linked = yield* sql<{ readonly id: string }>`
        UPDATE command_center_runs AS child
        SET parent_run_id = ${input.parentExecutionId}
        WHERE child.id = ${input.childRunId}
          AND child.command_id = ${input.commandId}
          AND child.space_id = ${input.spaceId}
          AND (child.parent_run_id IS NULL OR child.parent_run_id = ${input.parentExecutionId})
          AND EXISTS (
            SELECT 1
            FROM command_center_runs AS parent
            WHERE parent.id = ${input.parentExecutionId}
              AND parent.space_id = ${input.spaceId}
              AND parent.kind = 'automation'
          )
        RETURNING id AS "id"
      `;
      if (linked[0]?.id !== input.childRunId) {
        return yield* Effect.fail(
          permanentFailure(
            "The child Run could not be linked to its exact automation execution scope.",
          ),
        );
      }
    }).pipe(
      Effect.mapError((cause) =>
        typeof cause === "object" && cause !== null && "retryable" in cause
          ? (cause as AutomationAgentRunFailure)
          : retryableFailure("The child Run parent link could not be persisted."),
      ),
    );
}

/** Production adapter; all authority remains in CommandCenterService/RunDispatcher. */
export const makeLiveAutomationAgentRunAdapter = Effect.gen(function* () {
  const commandCenter = yield* CommandCenterService.CommandCenterService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const sql = yield* SqlClient.SqlClient;

  return makeAutomationAgentRunAdapter({
    providerAvailability: providerRegistry.getProviders.pipe(
      Effect.map(commandCenterProviderAvailability),
    ),
    submitCommand: (command, providers) =>
      commandCenter.submitCommand(command, providers).pipe(Effect.mapError(commandCenterFailure)),
    linkParent: makeAutomationAgentRunParentLinker(sql),
    authorizeRun: (runId) =>
      commandCenter
        .authorizeRunExecution({ runId, actorKind: "automation" })
        .pipe(Effect.asVoid, Effect.mapError(commandCenterFailure)),
  });
});
