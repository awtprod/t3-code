import { assert, describe, it } from "@effect/vitest";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { ProviderInstanceId } from "@t3tools/contracts";

import { BUNDLED_CLAUDE_MODEL_CATALOG } from "../../provider/ClaudeModelCatalog.ts";
import { makeClaudeQueryOptions } from "./ClaudeAdapterV2.ts";
import {
  MODEL_GUARDRAIL_HOOK_MATCHER,
  makeClaudeModelGuardrailHooks,
  maybeDowngradeBashWorkerModel,
  maybeDowngradeSubagentModel,
  mergeClaudeSdkHooks,
} from "./ClaudeModelGuardrail.ts";

describe("maybeDowngradeSubagentModel", () => {
  const catalog = BUNDLED_CLAUDE_MODEL_CATALOG;
  const taskInput = (model?: string) =>
    ({
      description: "delegated work",
      prompt: "do the thing",
      subagent_type: "worker",
      ...(model ? { model } : {}),
    }) as Parameters<typeof maybeDowngradeSubagentModel>[1];
  const modelOf = (input: unknown) => (input as { model?: unknown }).model;

  // The spawn tool was renamed `Task` -> `Agent` across SDK versions; the guard
  // must cover every name, so run the core scenarios against each.
  const SPAWN_TOOLS = ["Agent", "Task"] as const;
  it.each(SPAWN_TOOLS)(
    `downgrades an inheriting %s spawn from a Fable manager to the worker fallback`,
    (spawnTool) => {
      const result = maybeDowngradeSubagentModel(
        spawnTool,
        taskInput(),
        "claude-fable-5-1",
        catalog,
      );
      assert.equal(modelOf(result), "claude-opus-5-5");
    },
  );

  it.each(SPAWN_TOOLS)(
    `downgrades an explicit Fable %s subagent (including via alias) to the worker fallback`,
    (spawnTool) => {
      assert.equal(
        modelOf(
          maybeDowngradeSubagentModel(
            spawnTool,
            taskInput("claude-fable-5-1"),
            "claude-fable-5-1",
            catalog,
          ),
        ),
        "claude-opus-5-5",
      );
      // Alias resolves to the canonical Fable slug before the manager check.
      assert.equal(
        modelOf(
          maybeDowngradeSubagentModel(spawnTool, taskInput("fable"), "claude-fable-5-1", catalog),
        ),
        "claude-opus-5-5",
      );
    },
  );

  it.each(SPAWN_TOOLS)(
    `respects an explicit non-manager worker model chosen under a Fable manager (%s)`,
    (spawnTool) => {
      assert.equal(
        modelOf(
          maybeDowngradeSubagentModel(spawnTool, taskInput("sonnet"), "claude-fable-5-1", catalog),
        ),
        "sonnet",
      );
    },
  );

  it.each(SPAWN_TOOLS)(
    `leaves inheriting %s spawns untouched when the session model is not a manager`,
    (spawnTool) => {
      const input = taskInput();
      assert.strictEqual(
        maybeDowngradeSubagentModel(spawnTool, input, "claude-opus-5", catalog),
        input,
      );
      assert.strictEqual(
        maybeDowngradeSubagentModel(spawnTool, input, "claude-sonnet-5", catalog),
        input,
      );
    },
  );

  it.each(SPAWN_TOOLS)(
    `downgrades an explicit Fable %s subagent even under a non-manager session`,
    (spawnTool) => {
      assert.equal(
        modelOf(
          maybeDowngradeSubagentModel(spawnTool, taskInput("fable"), "claude-opus-5-5", catalog),
        ),
        "claude-opus-5-5",
      );
      assert.equal(
        modelOf(
          maybeDowngradeSubagentModel(spawnTool, taskInput("claude-fable-5-1"), undefined, catalog),
        ),
        "claude-opus-5-5",
      );
    },
  );

  it("ignores non-spawn tools and unknown session models", () => {
    const input = taskInput();
    assert.strictEqual(
      maybeDowngradeSubagentModel("Bash", input, "claude-fable-5-1", catalog),
      input,
    );
    assert.strictEqual(maybeDowngradeSubagentModel("Agent", input, undefined, catalog), input);
  });
});

describe("maybeDowngradeBashWorkerModel", () => {
  const bashInput = (command: string) =>
    ({ command }) as Parameters<typeof maybeDowngradeBashWorkerModel>[1];
  const commandOf = (input: unknown) => (input as { command?: unknown }).command;

  it("rewrites a Fable `claude -p` worker dispatch", () => {
    const result = maybeDowngradeBashWorkerModel(
      "Bash",
      bashInput("claude -p --model claude-fable-5-1 --max-turns 120 'go'"),
    );
    assert.equal(commandOf(result), "claude -p --model claude-opus-5-5 --max-turns 120 'go'");
  });

  it("rewrites an Astra `codex exec` worker dispatch", () => {
    const result = maybeDowngradeBashWorkerModel(
      "Bash",
      bashInput("codex exec -m gpt-6-astra 'review the diff'"),
    );
    assert.equal(commandOf(result), "codex exec -m gpt-6-sol 'review the diff'");
  });

  it("leaves an opus worker dispatch untouched (same reference)", () => {
    const input = bashInput("claude -p --model claude-opus-4-8 --max-turns 160");
    assert.strictEqual(maybeDowngradeBashWorkerModel("Bash", input), input);
  });

  it("ignores non-Bash tools", () => {
    const input = bashInput("claude -p --model claude-fable-5-1");
    assert.strictEqual(maybeDowngradeBashWorkerModel("Agent", input), input);
  });
});

describe("Claude model guardrail PreToolUse hook", () => {
  const preToolUse = (toolName: string, toolInput: Record<string, unknown>) =>
    ({
      hook_event_name: "PreToolUse",
      session_id: "session-acme",
      transcript_path: "/tmp/transcript.jsonl",
      cwd: "/workspace",
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: "tool-use-1",
    }) as unknown as HookInput;
  const signal = { signal: new AbortController().signal };

  it("downgrades an auto-allowed Agent spawn that canUseTool never sees", async () => {
    let model = "claude-fable-5-1";
    const hooks = makeClaudeModelGuardrailHooks({
      sessionModel: () => model,
      catalog: BUNDLED_CLAUDE_MODEL_CATALOG,
    });
    const matcher = hooks.PreToolUse?.[0];
    assert.strictEqual(matcher?.matcher, MODEL_GUARDRAIL_HOOK_MATCHER);
    assert.match("Agent", new RegExp(`^(?:${matcher?.matcher})$`));
    assert.match("Bash", new RegExp(`^(?:${matcher?.matcher})$`));
    const hook = matcher!.hooks[0]!;
    const output = await hook(preToolUse("Agent", { prompt: "go" }), "tool-use-1", signal);
    assert.deepEqual(output, {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: { prompt: "go", model: "claude-opus-5-5" },
      },
    });
    // A live switch to a worker model is read at call time.
    model = "claude-opus-5-5";
    assert.deepEqual(await hook(preToolUse("Agent", { prompt: "go" }), "tool-use-2", signal), {});
    // Bash worker dispatch is rewritten regardless of the session model.
    assert.deepEqual(
      await hook(
        preToolUse("Bash", { command: "claude -p --model fable 'go'" }),
        "tool-use-3",
        signal,
      ),
      {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          updatedInput: { command: "claude -p --model claude-opus-5-5 'go'" },
        },
      },
    );
  });

  it("merges extra hook sets after the guardrail and passes them to the SDK options", () => {
    const guardrail = makeClaudeModelGuardrailHooks({
      sessionModel: () => "claude-opus-5-5",
      catalog: BUNDLED_CLAUDE_MODEL_CATALOG,
    });
    const postToolUse = { matcher: "Read", hooks: [async () => ({})] };
    const extraPre = { matcher: "Edit", hooks: [async () => ({})] };
    const merged = mergeClaudeSdkHooks(guardrail, undefined, {
      PostToolUse: [postToolUse],
      PreToolUse: [extraPre],
    });
    assert.deepEqual(
      merged.PreToolUse?.map((entry) => entry.matcher),
      [MODEL_GUARDRAIL_HOOK_MATCHER, "Edit"],
    );
    assert.strictEqual(merged.PostToolUse?.[0], postToolUse);

    const options = makeClaudeQueryOptions({
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-5-5",
      },
      nativeThreadId: "native-acme",
      resume: false,
      cwd: "/workspace",
      hooks: merged,
    } as Parameters<typeof makeClaudeQueryOptions>[0]);
    assert.strictEqual(options.hooks, merged);
    const without = makeClaudeQueryOptions({
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-5-5",
      },
      nativeThreadId: "native-acme",
      resume: false,
      cwd: "/workspace",
    } as Parameters<typeof makeClaudeQueryOptions>[0]);
    assert.isFalse("hooks" in without);
  });
});
