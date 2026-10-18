/**
 * Manager/worker model guardrail for Claude sessions, plus the generic SDK
 * hook plumbing it rides on.
 *
 * No subagent may run on a manager-tier model (the Fable family). An `Agent`
 * (formerly `Task`) spawn that would inherit or request one is downgraded to
 * the worker fallback, and a `Bash` command that dispatches a headless worker
 * (`claude -p --model …`, `codex exec -m …`) has manager models rewritten.
 * It runs as a `PreToolUse` hook because the SDK never consults `canUseTool`
 * for auto-allowed tools, and `Agent` is auto-allowed in every mode.
 *
 * `mergeClaudeSdkHooks` is the one place hook sets are combined, so other
 * features (the S4 tool-result sieve's `PostToolUse`) add matchers without
 * replacing the guardrail.
 */
import type {
  CanUseTool,
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  Options as ClaudeQueryOptions,
} from "@anthropic-ai/claude-agent-sdk";
import {
  CLAUDE_WORKER_FALLBACK_MODEL,
  isClaudeManagerModelSlug,
  rewriteManagerModelInCommand,
} from "@t3tools/contracts";

import {
  type ClaudeModelCatalog,
  resolveClaudeModelSlug,
} from "../../provider/ClaudeModelCatalog.ts";

export type ClaudeSdkHooks = NonNullable<ClaudeQueryOptions["hooks"]>;
type ToolInput = Parameters<CanUseTool>[1];

const SUBAGENT_SPAWN_TOOL_NAMES: ReadonlySet<string> = new Set(["Agent", "Task"]);

/** PreToolUse matcher for the tools the model guardrail rewrites. */
export const MODEL_GUARDRAIL_HOOK_MATCHER = [...SUBAGENT_SPAWN_TOOL_NAMES, "Bash"].join("|");

const trimmedString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

/**
 * Downgrades an `Agent`/`Task` spawn that would run on a manager-tier model,
 * by inheriting the session model or by requesting one. An explicit
 * non-manager model is respected; other tools pass through unchanged.
 */
export function maybeDowngradeSubagentModel(
  toolName: string,
  toolInput: ToolInput,
  sessionModel: string | undefined,
  catalog: ClaudeModelCatalog,
): ToolInput {
  if (!SUBAGENT_SPAWN_TOOL_NAMES.has(toolName)) return toolInput;
  const requested = trimmedString((toolInput as { readonly model?: unknown }).model);
  const effective = requested ?? sessionModel;
  if (!effective || !isClaudeManagerModelSlug(resolveClaudeModelSlug(catalog, effective))) {
    return toolInput;
  }
  return { ...toolInput, model: CLAUDE_WORKER_FALLBACK_MODEL };
}

/** Rewrites manager-tier models in a `Bash` headless worker dispatch. */
export function maybeDowngradeBashWorkerModel(toolName: string, toolInput: ToolInput): ToolInput {
  if (toolName !== "Bash") return toolInput;
  const command = trimmedString((toolInput as { readonly command?: unknown }).command);
  if (!command) return toolInput;
  const rewritten = rewriteManagerModelInCommand(command);
  return rewritten === command ? toolInput : { ...toolInput, command: rewritten };
}

/**
 * The guardrail's `PreToolUse` hooks. `sessionModel` is read at call time so a
 * live model switch is honoured.
 */
export function makeClaudeModelGuardrailHooks(input: {
  readonly sessionModel: () => string | undefined;
  readonly catalog: ClaudeModelCatalog;
}): ClaudeSdkHooks {
  const guardrail: HookCallback = async (hookInput) => {
    if (hookInput.hook_event_name !== "PreToolUse") return {};
    const rawInput: unknown = hookInput.tool_input;
    if (typeof rawInput !== "object" || rawInput === null || Array.isArray(rawInput)) return {};
    const toolInput = rawInput as ToolInput;
    const updatedInput = maybeDowngradeBashWorkerModel(
      hookInput.tool_name,
      maybeDowngradeSubagentModel(
        hookInput.tool_name,
        toolInput,
        input.sessionModel(),
        input.catalog,
      ),
    );
    if (updatedInput === toolInput) return {};
    return { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput } };
  };
  return {
    PreToolUse: [
      { matcher: MODEL_GUARDRAIL_HOOK_MATCHER, hooks: [guardrail] } satisfies HookCallbackMatcher,
    ],
  };
}

/** Concatenates hook matchers per event; earlier sets run first. */
export function mergeClaudeSdkHooks(
  ...sets: ReadonlyArray<ClaudeSdkHooks | undefined>
): ClaudeSdkHooks {
  const merged: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
  for (const set of sets) {
    if (set === undefined) continue;
    for (const [event, matchers] of Object.entries(set) as Array<
      [HookEvent, HookCallbackMatcher[] | undefined]
    >) {
      if (matchers === undefined || matchers.length === 0) continue;
      merged[event] = [...(merged[event] ?? []), ...matchers];
    }
  }
  return merged;
}
