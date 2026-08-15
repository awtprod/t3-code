import { TextGenerationError, type ModelSelection } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { KimiRuntimeClient } from "../provider/kimiRuntime.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildAutomationSchedulePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const KIMI_TEXT_TIMEOUT_MS = 180_000;
const KIMI_TEXT_GENERATION_DISABLED_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Grep",
  "Glob",
  "Bash",
  "Shell",
  "Terminal",
  "WebSearch",
  "WebFetch",
  "FetchURL",
  "Agent",
  "AgentSwarm",
  "TaskOutput",
  "KillShell",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
] as const;

export const makeKimiTextGeneration = Effect.fn("makeKimiTextGeneration")(function (
  runtime: KimiRuntimeClient,
) {
  const runJson = <S extends Schema.Top>(input: {
    readonly operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle"
      | "generateAutomationSchedule";
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchema: S;
    readonly modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> => {
    let pendingScope: Scope.Closeable | undefined;
    return Effect.gen(function* () {
      const output = yield* Ref.make("");
      const done = yield* Deferred.make<void, TextGenerationError>();
      const session = yield* runtime
        .request<Record<string, unknown>>("/sessions", {
          method: "POST",
          body: {
            metadata: { cwd: input.cwd },
            agent_config: { model: input.modelSelection.model, permission_mode: "yolo" },
          },
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: input.operation,
                detail: "Kimi could not create a text-generation session.",
                cause,
              }),
          ),
        );
      const sessionId = typeof session.id === "string" ? session.id : "";
      if (!sessionId) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: "Kimi returned a session without an id.",
        });
      }
      const scope = yield* Scope.make("sequential");
      pendingScope = scope;
      const nativeEvents = yield* Queue.unbounded<Record<string, unknown>>();
      yield* Stream.runForEach(Stream.fromQueue(nativeEvents), (frame) => {
        const payload =
          frame.payload && typeof frame.payload === "object"
            ? (frame.payload as Record<string, unknown>)
            : {};
        if (frame.type === "assistant.delta" && typeof payload.delta === "string") {
          return Ref.update(output, (current) => current + payload.delta);
        }
        if (frame.type === "turn.ended") {
          const failed = payload.reason === "failed";
          return failed
            ? Deferred.fail(
                done,
                new TextGenerationError({
                  operation: input.operation,
                  detail: "Kimi failed while generating text.",
                }),
              ).pipe(Effect.ignore)
            : Deferred.succeed(done, undefined).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkIn(scope));
      yield* runtime
        .subscribe(sessionId, (frame) => {
          Queue.offerUnsafe(nativeEvents, frame);
        })
        .pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: input.operation,
                detail: "Kimi streaming connection failed.",
                cause,
              }),
          ),
        );
      yield* runtime
        .request(`/sessions/${encodeURIComponent(sessionId)}/prompts`, {
          method: "POST",
          body: {
            content: [{ type: "text", text: input.prompt }],
            model: input.modelSelection.model,
            permission_mode: "manual",
            plan_mode: false,
            disabled_tools: KIMI_TEXT_GENERATION_DISABLED_TOOLS,
          },
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: input.operation,
                detail: "Kimi rejected the text-generation prompt.",
                cause,
              }),
          ),
        );
      const completed = yield* Deferred.await(done).pipe(
        Effect.timeoutOption(KIMI_TEXT_TIMEOUT_MS),
        Effect.ensuring(Scope.close(scope, Exit.void)),
      );
      pendingScope = undefined;
      if (Option.isNone(completed)) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: "Kimi text generation timed out.",
        });
      }
      const text = (yield* Ref.get(output)).trim();
      if (!text) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: "Kimi returned empty text.",
        });
      }
      // oxlint-disable-next-line t3code/no-inline-schema-compile -- the output schema is selected per text-generation operation
      return yield* Schema.decodeEffect(Schema.fromJsonString(input.outputSchema))(
        extractJsonObject(text),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: "Kimi returned invalid structured output.",
              cause,
            }),
        ),
      );
    }).pipe(
      Effect.onError(() =>
        pendingScope === undefined
          ? Effect.void
          : Scope.close(pendingScope, Exit.void).pipe(Effect.ignore),
      ),
    );
  };

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("KimiTextGeneration.generateCommitMessage")(function* (input) {
      const built = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const generated = yield* runJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt: built.prompt,
        outputSchema: built.outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("KimiTextGeneration.generatePrContent")(function* (input) {
      const built = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });
      const generated = yield* runJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt: built.prompt,
        outputSchema: built.outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("KimiTextGeneration.generateBranchName")(function* (input) {
      const built = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const generated = yield* runJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt: built.prompt,
        outputSchema: built.outputSchema,
        modelSelection: input.modelSelection,
      });
      return { branch: sanitizeBranchFragment(generated.branch) };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("KimiTextGeneration.generateThreadTitle")(function* (input) {
      const built = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });
      const generated = yield* runJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt: built.prompt,
        outputSchema: built.outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizeThreadTitle(generated.title) };
    });

  const generateAutomationSchedule: TextGeneration.TextGeneration["Service"]["generateAutomationSchedule"] =
    Effect.fn("KimiTextGeneration.generateAutomationSchedule")(function* (input) {
      const built = buildAutomationSchedulePrompt(input);
      return yield* runJson({
        operation: "generateAutomationSchedule",
        cwd: input.cwd,
        prompt: built.prompt,
        outputSchema: built.outputSchema,
        modelSelection: input.modelSelection,
      });
    });

  return Effect.succeed({
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    generateAutomationSchedule,
  } satisfies TextGeneration.TextGeneration["Service"]);
});
