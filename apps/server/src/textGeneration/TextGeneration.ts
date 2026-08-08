import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as DateTime from "effect/DateTime";
import * as Random from "effect/Random";
import type {
  ChatAttachment,
  InternalGenerationUsage,
  ModelSelection,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { TextGenerationError } from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import type { TextGenerationPolicy } from "./TextGenerationPolicy.ts";

export type TextGenerationProvider =
  | "codex"
  | "claudeAgent"
  | "cursor"
  | "grok"
  | "opencode"
  | "kimi";

export interface CommitMessageGenerationInput {
  cwd: string;
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  /** When true, the model also returns a semantic branch name for the change. */
  includeBranch?: boolean;
  policy?: TextGenerationPolicy | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface CommitMessageGenerationResult {
  subject: string;
  body: string;
  /** Only present when `includeBranch` was set on the input. */
  branch?: string | undefined;
}

export interface PrContentGenerationInput {
  cwd: string;
  baseBranch: string;
  headBranch: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
  changeRequestTemplate?: string | undefined;
  policy?: TextGenerationPolicy | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface PrContentGenerationResult {
  title: string;
  body: string;
}

export interface BranchNameGenerationInput {
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface BranchNameGenerationResult {
  branch: string;
}

export interface ThreadTitleGenerationInput {
  cwd: string;
  message: string;
  /** Present when replacing an existing title from the current thread history. */
  previousTitle?: string | undefined;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface ThreadTitleGenerationResult {
  title: string;
}

export interface TextGenerationService {
  generateCommitMessage(
    input: CommitMessageGenerationInput,
  ): Promise<CommitMessageGenerationResult>;
  generatePrContent(input: PrContentGenerationInput): Promise<PrContentGenerationResult>;
  generateBranchName(input: BranchNameGenerationInput): Promise<BranchNameGenerationResult>;
  generateThreadTitle(input: ThreadTitleGenerationInput): Promise<ThreadTitleGenerationResult>;
}

/**
 * TextGeneration - Service tag for commit and change request text generation.
 */
export class TextGeneration extends Context.Service<
  TextGeneration,
  {
    /**
     * Generate a commit message from staged change context.
     */
    readonly generateCommitMessage: (
      input: CommitMessageGenerationInput,
    ) => Effect.Effect<CommitMessageGenerationResult, TextGenerationError>;

    /**
     * Generate change request title/body from branch and diff context.
     */
    readonly generatePrContent: (
      input: PrContentGenerationInput,
    ) => Effect.Effect<PrContentGenerationResult, TextGenerationError>;

    /**
     * Generate a concise branch name from a user message.
     */
    readonly generateBranchName: (
      input: BranchNameGenerationInput,
    ) => Effect.Effect<BranchNameGenerationResult, TextGenerationError>;

    /** Generate a concise thread title from a first message or thread history. */
    readonly generateThreadTitle: (
      input: ThreadTitleGenerationInput,
    ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;
  }
>()("@awtprod/command-center/textGeneration/TextGeneration") {}

/** @deprecated Use `TextGeneration["Service"]`. */
export type TextGenerationShape = TextGeneration["Service"];

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

const telemetryOperation = {
  generateCommitMessage: "commit",
  generatePrContent: "pull-request",
  generateBranchName: "branch",
  generateThreadTitle: "title",
} as const;

function instrumentInternalGeneration<A>(
  operation: TextGenerationOp,
  input: { readonly modelSelection: ModelSelection },
  effect: Effect.Effect<A, TextGenerationError>,
  record: (usage: InternalGenerationUsage) => Effect.Effect<void>,
): Effect.Effect<A, TextGenerationError> {
  return Effect.gen(function* () {
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
  });
}

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
    generateThreadTitle: (input) =>
      instrumentInternalGeneration(
        "generateThreadTitle",
        input,
        resolveInstance(registry, "generateThreadTitle", input.modelSelection.instanceId).pipe(
          Effect.flatMap((textGeneration) => textGeneration.generateThreadTitle(input)),
        ),
        record,
      ),
  });

export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const sql = yield* SqlClient.SqlClient;
  const record = (usage: InternalGenerationUsage): Effect.Effect<void> =>
    sql`
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
  return makeTextGenerationFromRegistry(registry, record);
});

export const layer = Layer.effect(TextGeneration, make);
