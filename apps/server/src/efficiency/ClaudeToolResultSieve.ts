/**
 * The tool-result sieve for Claude sessions on orchestration V2, as a
 * `PostToolUse` SDK hook carried through ClaudeAdapterV2's generic `sdkHooks`
 * passthrough (merged after the model guardrail, which always runs).
 *
 * The hook set is built per opened query: none while
 * `settings.efficiency.sieve.mode` is `off` (the default), so a query opened
 * with the sieve off has no `PostToolUse` matcher at all. Each callback
 * re-reads the live sieve settings, so switching the mode off mid-query makes
 * an already-registered hook pass results through untouched.
 *
 * The sieve's task context is the thread's latest user message, read from
 * the V2 message projection. The assistant's stated intent is not available
 * to a V2 hook and is sent empty (the sieve judge still has the request).
 *
 * This module holds only the service tag and the hook factory, so the Claude
 * driver can import it without the judge's module graph (which reaches the
 * usage drivers, and so the Claude driver, again). The live layer is in
 * `ClaudeToolResultSieveLive.ts`.
 *
 * @module ClaudeToolResultSieve
 */
import type { HookCallback, PostToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import type { EfficiencySettings, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import type { ClaudeSdkHooks } from "../orchestration-v2/Adapters/ClaudeModelGuardrail.ts";
import type { JudgeShape } from "./Judge.ts";
import { sieveToolResult, type SieveOutcome } from "./ToolResultSieve.ts";

/** Tools whose `PostToolUse` reaches the sieve; live `sieve.tools` narrows further. */
export const SIEVE_HOOK_MATCHER = ["Read", "Grep"].join("|");
/** Ceiling for one hook call; the judge timeout bounds the work inside it. */
const SIEVE_HOOK_HARD_TIMEOUT = Duration.seconds(30);
/** Head of the user request handed to the sieve judge. */
const SIEVE_TASK_USER_REQUEST_CHARS = 1_500;

export interface ClaudeToolResultSieveShape {
  /** Hooks for one opened query; undefined while the sieve is off. */
  readonly sdkHooks: (context: {
    readonly threadId: ThreadId;
    readonly sessionModel: () => string;
  }) => ClaudeSdkHooks | undefined;
}

export class ClaudeToolResultSieve extends Context.Service<
  ClaudeToolResultSieve,
  ClaudeToolResultSieveShape
>()("@awtprod/command-center/efficiency/ClaudeToolResultSieve") {}

export interface ClaudeToolResultSieveDeps {
  readonly judge: JudgeShape;
  /** The live efficiency settings, read synchronously when a query opens. */
  readonly currentSettings: () => EfficiencySettings;
  /** The thread's latest user message, for the sieve's task context. */
  readonly latestUserRequest: (threadId: ThreadId) => Effect.Effect<string | undefined>;
  readonly onOutcome?: (outcome: SieveOutcome) => Effect.Effect<void>;
}

/** Builds the per-query hook factory (pure apart from the injected reads). */
export function makeClaudeToolResultSieveHooks(
  deps: ClaudeToolResultSieveDeps,
): ClaudeToolResultSieveShape["sdkHooks"] {
  return (context) => {
    if (deps.currentSettings().sieve.mode === "off") return undefined;
    const callback: HookCallback = async (hookInput) => {
      try {
        if (hookInput.hook_event_name !== "PostToolUse") return {};
        const post = hookInput as PostToolUseHookInput;
        const updatedToolOutput = await Effect.runPromise(
          Effect.gen(function* () {
            const settings = deps.currentSettings();
            if (settings.sieve.mode === "off") return undefined;
            const request = yield* deps.latestUserRequest(context.threadId);
            const outcome = yield* sieveToolResult(
              {
                judge: deps.judge,
                settings: settings.sieve,
                timeoutMs: settings.judge.timeoutMs,
              },
              {
                toolName: post.tool_name,
                toolInput: post.tool_input,
                toolResponse: post.tool_response,
                task: {
                  user_request: (request ?? "").slice(0, SIEVE_TASK_USER_REQUEST_CHARS),
                  assistant_intent: "",
                },
                threadId: context.threadId,
                ...(post.agent_id ? { agentId: post.agent_id } : {}),
              },
            );
            if (deps.onOutcome !== undefined) yield* deps.onOutcome(outcome);
            return outcome.updatedToolOutput;
          }).pipe(
            Effect.timeout(SIEVE_HOOK_HARD_TIMEOUT),
            Effect.catchCause(() => Effect.succeed(undefined)),
          ),
        );
        if (updatedToolOutput === undefined) return {};
        return { hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput } };
      } catch {
        // The hook must never throw into the SDK: leave the result untouched.
        return {};
      }
    };
    return { PostToolUse: [{ matcher: SIEVE_HOOK_MATCHER, hooks: [callback] }] };
  };
}
