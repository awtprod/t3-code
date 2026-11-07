import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import type {
  InternalGenerationUsage,
  ModelSelection,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  isProviderAvailable,
  isProviderTextGenerationCapable,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";
import { exhaustedUsageWindow } from "@t3tools/shared/usageLimits";
import {
  defaultTextGenerationModel,
  fallbackTextGenerationModelSelection,
} from "@t3tools/shared/serverSettings";
import * as ServerSettings from "../serverSettings.ts";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import { TextGenerationError } from "@t3tools/contracts";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as ThreadTitleLinks from "./ThreadTitleLinks.ts";

export type {
  AutomationScheduleGenerationInput,
  AutomationScheduleGenerationResult,
  BranchNameGenerationInput,
  BranchNameGenerationResult,
  CommitMessageGenerationInput,
  CommitMessageGenerationResult,
  PrContentGenerationInput,
  PrContentGenerationResult,
  ReviewGuideGenerationInput,
  ReviewGuideGenerationResult,
  ThreadTitleGenerationInput,
  ThreadTitleGenerationResult,
} from "@t3tools/provider-core/server/textGeneration";

export class TextGeneration extends Context.Service<TextGeneration, ProviderTextGeneration>()(
  "@awtprod/command-center/textGeneration/TextGeneration",
) {}

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle"
  | "generateReviewGuide"
  | "generateAutomationSchedule";

// Command Center records each internal generation (commit, PR, branch, title,
// schedule) so internal model usage shows up in usage analytics.
const telemetryOperation = {
  generateCommitMessage: "commit",
  generatePrContent: "pull-request",
  generateBranchName: "branch",
  generateThreadTitle: "title",
  generateAutomationSchedule: "schedule",
} as const;

const instrumentInternalGeneration = Effect.fn("TextGeneration.instrumentInternalGeneration")(
  function* <A>(
    operation: keyof typeof telemetryOperation,
    input: { readonly modelSelection: ModelSelection },
    effect: Effect.Effect<A, TextGenerationError>,
    record: (usage: InternalGenerationUsage) => Effect.Effect<void>,
  ) {
    const operationId = `internal-${Math.floor((yield* Random.next) * Number.MAX_SAFE_INTEGER).toString(36)}`;
    const startedAt = yield* DateTime.now;
    return yield* effect.pipe(
      Effect.onExit((exit) =>
        DateTime.now.pipe(
          Effect.flatMap((completedAt) =>
            Effect.succeed({
              operationId,
              operation: telemetryOperation[operation],
              providerInstanceId: input.modelSelection.instanceId,
              model: input.modelSelection.model,
              ...(input.modelSelection.options === undefined
                ? {}
                : { options: input.modelSelection.options }),
              durationMs: Math.max(0, completedAt.epochMilliseconds - startedAt.epochMilliseconds),
              // Ephemeral CLIs do not consistently report these values. Keep them
              // explicitly unavailable instead of fabricating zero-token usage.
              inputTokens: null,
              outputTokens: null,
              costMicroUsd: null,
              status: Exit.isSuccess(exit) ? "success" : "error",
              completedAt: DateTime.formatIso(completedAt),
            } satisfies InternalGenerationUsage),
          ),
          Effect.tap((usage) => Effect.logInfo("internal text generation completed", usage)),
          Effect.flatMap(record),
        ),
      ),
      Effect.withSpan("internal.text-generation", {
        attributes: {
          "text_generation.operation_id": operationId,
          "text_generation.operation": telemetryOperation[operation],
          "gen_ai.provider.instance_id": input.modelSelection.instanceId,
          "gen_ai.request.model": input.modelSelection.model,
        },
      }),
    );
  },
);

const resolveInstance = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  operation: TextGenerationOp,
  instanceId: ProviderInstanceId,
): Effect.Effect<ProviderInstance["textGeneration"], TextGenerationError> =>
  registry.getInstance(instanceId).pipe(
    Effect.flatMap((instance) =>
      instance
        ? Effect.succeed(instance.textGeneration)
        : Effect.fail(
            new TextGenerationError({
              operation,
              detail: `No provider instance registered for id '${instanceId}'.`,
            }),
          ),
    ),
  );

// Review guides investigate the checkout read-only; the other drivers reject that request.
const INVESTIGATING_DRIVERS = new Set(["codex", "claudeAgent"]);

/**
 * Builds the service over a registry. `serverSettings` enables upstream's
 * out-of-usage fallback; without it (tests) the requested selection is used.
 * Command Center records every op except review guides through `record`.
 */
export const makeTextGenerationFromRegistry = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  record: (usage: InternalGenerationUsage) => Effect.Effect<void> = () => Effect.void,
  sourceControl?: SourceControlProviderRegistry.SourceControlProviderRegistry["Service"],
  serverSettings?: ServerSettings.ServerSettingsService["Service"],
): TextGeneration["Service"] => {
  const fallbackSelection = Effect.fn("TextGeneration.fallbackSelection")(function* (
    operation: TextGenerationOp,
    selection: ModelSelection,
    settingsService: ServerSettings.ServerSettingsService["Service"],
  ) {
    const snapshots = yield* registry.listInstances.pipe(
      Effect.flatMap((instances) =>
        Effect.forEach(instances, (instance) => instance.snapshot.getSnapshot),
      ),
    );
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const limited = exhaustedUsageWindow(
      snapshots.find((provider) => provider.instanceId === selection.instanceId),
      now,
      selection.model,
    );
    if (!limited) return selection;
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Could not read fallback model settings.",
            cause,
          }),
      ),
    );
    return (
      fallbackTextGenerationModelSelection(
        settings.providerInstances,
        (instanceId, driver) => {
          const provider = snapshots.find((candidate) => candidate.instanceId === instanceId);
          return (
            instanceId !== selection.instanceId &&
            provider?.enabled === true &&
            resolveProjectProviderInstanceEnabled(settings, null, instanceId) &&
            provider.installed &&
            provider.auth.status !== "unauthenticated" &&
            isProviderAvailable(provider) &&
            isProviderTextGenerationCapable(provider) &&
            (operation !== "generateReviewGuide" || INVESTIGATING_DRIVERS.has(driver)) &&
            !exhaustedUsageWindow(provider, now, defaultTextGenerationModel(driver))
          );
        },
        { includeConfiguredInstances: true },
      ) ?? selection
    );
  });
  const generate = Effect.fn("TextGeneration.generate")(function* <A>(
    operation: TextGenerationOp,
    requested: ModelSelection,
    invoke: (
      service: ProviderTextGeneration,
      modelSelection: ModelSelection,
    ) => Effect.Effect<A, TextGenerationError>,
  ) {
    const selection =
      serverSettings === undefined
        ? requested
        : yield* fallbackSelection(operation, requested, serverSettings);
    const run = resolveInstance(registry, operation, selection.instanceId).pipe(
      Effect.flatMap((service) => invoke(service, selection)),
    );
    // Usage is recorded against the selection that actually ran (after any fallback).
    return yield* operation === "generateReviewGuide"
      ? run
      : instrumentInternalGeneration(operation, { modelSelection: selection }, run, record);
  });
  return TextGeneration.of({
    generateCommitMessage: Effect.fn("TextGeneration.generateCommitMessage")(function (input) {
      return generate("generateCommitMessage", input.modelSelection, (service, modelSelection) =>
        service.generateCommitMessage({ ...input, modelSelection }),
      );
    }),
    generatePrContent: Effect.fn("TextGeneration.generatePrContent")(function (input) {
      return generate("generatePrContent", input.modelSelection, (service, modelSelection) =>
        service.generatePrContent({ ...input, modelSelection }),
      );
    }),
    generateBranchName: Effect.fn("TextGeneration.generateBranchName")(function (input) {
      return generate("generateBranchName", input.modelSelection, (service, modelSelection) =>
        service.generateBranchName({ ...input, modelSelection }),
      );
    }),
    generateReviewGuide: Effect.fn("TextGeneration.generateReviewGuide")(function (input) {
      return generate("generateReviewGuide", input.modelSelection, (service, modelSelection) =>
        service.generateReviewGuide({ ...input, modelSelection }),
      );
    }),
    generateThreadTitle: Effect.fn("TextGeneration.generateThreadTitle")(function (input) {
      return generate(
        "generateThreadTitle",
        input.modelSelection,
        (textGeneration, modelSelection) =>
          Effect.gen(function* () {
            const linkedContext =
              input.linkedContext ??
              (sourceControl === undefined
                ? undefined
                : yield* ThreadTitleLinks.resolveThreadTitleLinks(input).pipe(
                    Effect.provideService(
                      SourceControlProviderRegistry.SourceControlProviderRegistry,
                      sourceControl,
                    ),
                  ));
            return yield* textGeneration.generateThreadTitle({
              ...input,
              linkedContext,
              modelSelection,
            });
          }),
      );
    }),
    generateAutomationSchedule: Effect.fn("TextGeneration.generateAutomationSchedule")(
      function (input) {
        return generate(
          "generateAutomationSchedule",
          input.modelSelection,
          (service, modelSelection) =>
            service.generateAutomationSchedule({ ...input, modelSelection }),
        );
      },
    ),
  });
};

/** @public */
export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const sourceControl = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  // SqlClient is optional so the service can be constructed in contexts without
  // persistence (tests); when present, internal generation usage is recorded.
  const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
  const record: (usage: InternalGenerationUsage) => Effect.Effect<void> = Option.isNone(sqlOption)
    ? () => Effect.void
    : (usage: InternalGenerationUsage): Effect.Effect<void> => {
        const sql = sqlOption.value;
        return sql`
      INSERT INTO internal_generation_usage (
        operation_id, operation, provider_instance_id, model, options_json,
        duration_ms, input_tokens, output_tokens, cost_micro_usd, status, completed_at
      ) VALUES (
        ${usage.operationId}, ${usage.operation}, ${usage.providerInstanceId}, ${usage.model},
        ${usage.options === undefined ? null : JSON.stringify(usage.options)},
        ${usage.durationMs}, ${usage.inputTokens}, ${usage.outputTokens}, ${usage.costMicroUsd},
        ${usage.status}, ${usage.completedAt}
      )
      ON CONFLICT (operation_id) DO NOTHING
    `.pipe(
          Effect.asVoid,
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to record internal text generation usage", {
              operationId: usage.operationId,
              cause,
            }),
          ),
        );
      };
  return makeTextGenerationFromRegistry(registry, record, sourceControl, serverSettings);
});

export const layer = Layer.effect(TextGeneration, make);
