import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import { TextGenerationError } from "@t3tools/contracts";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as ThreadTitleLinks from "./ThreadTitleLinks.ts";

export type {
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

export interface AutomationScheduleGenerationInput {
  cwd: string;
  text: string;
  timezone: string;
  modelSelection: ModelSelection;
}

export type AutomationScheduleGenerationResult =
  | { readonly status: "interpreted"; readonly expression: string }
  | { readonly status: "needs_clarification"; readonly message: string };

export interface TextGenerationService {
  generateCommitMessage(
    input: CommitMessageGenerationInput,
  ): Promise<CommitMessageGenerationResult>;
  generatePrContent(input: PrContentGenerationInput): Promise<PrContentGenerationResult>;
  generateBranchName(input: BranchNameGenerationInput): Promise<BranchNameGenerationResult>;
  generateThreadTitle(input: ThreadTitleGenerationInput): Promise<ThreadTitleGenerationResult>;
  generateAutomationSchedule(
    input: AutomationScheduleGenerationInput,
  ): Promise<AutomationScheduleGenerationResult>;
}

/**
 * TextGeneration - Service tag for commit and change request text generation.
 */
export class TextGeneration extends Context.Service<TextGeneration, ProviderTextGeneration>()(
  "t3/textGeneration/TextGeneration",
) {}

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle"
  | "generateReviewGuide";

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

export const makeTextGenerationFromRegistry = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  record: (usage: InternalGenerationUsage) => Effect.Effect<void> = () => Effect.void,
  sourceControl?: SourceControlProviderRegistry.SourceControlProviderRegistry["Service"],
): TextGeneration["Service"] =>
  TextGeneration.of({
    generateCommitMessage: (input) =>
      instrumentInternalGeneration(
        "generateCommitMessage",
        input,
        resolveInstance(registry, "generateCommitMessage", input.modelSelection.instanceId).pipe(
          Effect.flatMap((textGeneration) => textGeneration.generateCommitMessage(input)),
        ),
        record,
      ),
    generatePrContent: (input) =>
      instrumentInternalGeneration(
        "generatePrContent",
        input,
        resolveInstance(registry, "generatePrContent", input.modelSelection.instanceId).pipe(
          Effect.flatMap((textGeneration) => textGeneration.generatePrContent(input)),
        ),
        record,
      ),
    generateBranchName: (input) =>
      instrumentInternalGeneration(
        "generateBranchName",
        input,
        resolveInstance(registry, "generateBranchName", input.modelSelection.instanceId).pipe(
          Effect.flatMap((textGeneration) => textGeneration.generateBranchName(input)),
        ),
        record,
      ),
    generateReviewGuide: (input) =>
      resolveInstance(registry, "generateReviewGuide", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateReviewGuide(input)),
      ),
    generateThreadTitle: (input) =>
      instrumentInternalGeneration(
        "generateThreadTitle",
        input,
        resolveInstance(registry, "generateThreadTitle", input.modelSelection.instanceId).pipe(
          Effect.flatMap((textGeneration) =>
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
              return yield* textGeneration.generateThreadTitle({ ...input, linkedContext });
            }),
          ),
        ),
        record,
      ),
    generateAutomationSchedule: (input) =>
      instrumentInternalGeneration(
        "generateAutomationSchedule",
        input,
        resolveInstance(
          registry,
          "generateAutomationSchedule",
          input.modelSelection.instanceId,
        ).pipe(
          Effect.flatMap((textGeneration) => textGeneration.generateAutomationSchedule(input)),
        ),
        record,
      ),
  });

export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const sourceControl = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
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
  return makeTextGenerationFromRegistry(registry, record, sourceControl);
});

export const layer = Layer.effect(TextGeneration, make);
