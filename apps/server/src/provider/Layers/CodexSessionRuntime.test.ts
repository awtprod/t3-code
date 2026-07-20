import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";
import { DEFAULT_MODEL, ThreadId } from "@t3tools/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";

import {
  buildCodexDeveloperInstructions,
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "../CodexDeveloperInstructions.ts";
import {
  buildCommandCenterIsolationProbeScript,
  buildThreadStartParams,
  buildTurnStartParams,
  hasConfiguredMcpServer,
  isRecoverableThreadResumeError,
  openCodexThread,
  verifyCommandCenterCodexIsolation,
} from "./CodexSessionRuntime.ts";
const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);

describe("CodexSessionRuntimeIdentifierGenerationError", () => {
  it("retains identifier purpose and the random source failure", () => {
    const cause = new Error("random source unavailable");
    const error = new CodexErrors.CodexAppServerIdentifierGenerationError({
      purpose: "provider-event",
      cause,
    });

    NodeAssert.equal(error.purpose, "provider-event");
    NodeAssert.strictEqual(error.cause, cause);
    NodeAssert.equal(
      error.message,
      "Failed to generate Codex App Server identifier for provider-event.",
    );
  });
});

function makeThreadOpenResponse(
  threadId: string,
  permissionProfile?: string,
): CodexRpc.ClientRequestResponsesByMethod["thread/start"] {
  return {
    cwd: "/tmp/project",
    model: "gpt-5.3-codex",
    modelProvider: "openai",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    ...(permissionProfile
      ? { activePermissionProfile: { id: permissionProfile, extends: null } }
      : {}),
    thread: {
      cliVersion: "0.144.6",
      createdAt: 1_766_000_000,
      cwd: "/tmp/project",
      ephemeral: false,
      id: threadId,
      modelProvider: "openai",
      preview: "",
      sessionId: "session-1",
      source: "appServer",
      turns: [],
      status: { type: "idle" },
      updatedAt: 1_766_000_000,
    },
  } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/start"];
}

describe("buildTurnStartParams", () => {
  it("keeps invalid turn values only in the schema cause", () => {
    const secret = "codex-turn-input-secret-sentinel";
    const error = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        attachments: [
          {
            type: "image",
            url: { secret } as unknown as string,
          },
        ],
      }).pipe(Effect.flip),
    );
    const { cause, ...directDiagnostics } = error;

    NodeAssert.equal(error.operation, "decode-request-payload");
    NodeAssert.equal(error.method, "turn/start");
    NodeAssert.ok((error.issueCount ?? 0) > 0);
    NodeAssert.ok(error.issueKinds?.includes("Pointer"));
    NodeAssert.ok((error.maximumPathDepth ?? 0) > 0);
    NodeAssert.ok(Schema.isSchemaError(cause));
    NodeAssert.doesNotMatch(error.message, new RegExp(secret));
    NodeAssert.doesNotMatch(JSON.stringify(directDiagnostics), new RegExp(secret));
  });

  it("includes plan collaboration mode when requested", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Make a plan",
        model: "gpt-5.3-codex",
        effort: "medium",
        interactionMode: "plan",
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "dangerFullAccess",
      },
      input: [
        {
          type: "text",
          text: "Make a plan",
        },
      ],
      model: "gpt-5.3-codex",
      effort: "medium",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: buildCodexDeveloperInstructions("plan", {
            model: "gpt-5.3-codex",
            reasoningEffort: "medium",
          }),
        },
      },
    });
  });

  it("includes default collaboration mode and image attachments", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto-accept-edits",
        prompt: "Implement it",
        model: "gpt-5.3-codex",
        interactionMode: "default",
        attachments: [
          {
            type: "image",
            url: "data:image/png;base64,abc",
          },
        ],
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "on-request",
      sandboxPolicy: {
        type: "workspaceWrite",
      },
      input: [
        {
          type: "text",
          text: "Implement it",
        },
        {
          type: "image",
          url: "data:image/png;base64,abc",
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: buildCodexDeveloperInstructions("default", {
            model: "gpt-5.3-codex",
            reasoningEffort: "medium",
          }),
        },
      },
    });
  });

  it("reports the same fallback model and effort in settings and instructions", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Go",
        interactionMode: "default",
      }),
    );

    const settings = params.collaborationMode?.settings;
    NodeAssert.equal(settings?.model, DEFAULT_MODEL);
    NodeAssert.equal(settings?.reasoning_effort, "medium");
    NodeAssert.ok(settings?.developer_instructions?.includes(`as ${DEFAULT_MODEL} with medium`));
  });

  it("omits collaboration mode when interaction mode is absent", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "approval-required",
        prompt: "Review",
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "untrusted",
      sandboxPolicy: {
        type: "readOnly",
      },
      input: [
        {
          type: "text",
          text: "Review",
        },
      ],
    });
  });

  it.effect("selects a non-escalatable permission profile without a legacy sandbox policy", () =>
    Effect.gen(function* () {
      const permissionProfile = "command-center-isolated-write-v1";
      const thread = buildThreadStartParams({
        cwd: "/runtime/project",
        runtimeMode: "auto-accept-edits",
        model: undefined,
        serviceTier: undefined,
        permissionProfile,
      });
      const turn = yield* buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto-accept-edits",
        prompt: "Implement it",
        permissionProfile,
      });

      NodeAssert.deepStrictEqual(thread, {
        cwd: "/runtime/project",
        approvalPolicy: "never",
        permissions: permissionProfile,
      });
      NodeAssert.equal("sandbox" in thread, false);
      NodeAssert.equal(turn.approvalPolicy, "never");
      NodeAssert.equal(turn.permissions, permissionProfile);
      NodeAssert.equal("sandboxPolicy" in turn, false);
    }),
  );
});

describe("buildCodexDeveloperInstructions", () => {
  it("appends runtime info after the mode instructions", () => {
    const instructions = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
    });

    NodeAssert.ok(instructions.startsWith(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS));
    NodeAssert.match(instructions, /Command Center/);
    NodeAssert.match(instructions, /Codex harness/);
    NodeAssert.match(instructions, /as gpt-5\.3-codex with high reasoning effort/);
  });

  it("includes runtime info alongside plan mode instructions", () => {
    const instructions = buildCodexDeveloperInstructions("plan", {
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });

    NodeAssert.ok(instructions.startsWith(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS));
    NodeAssert.match(instructions, /as gpt-5\.3-codex with medium reasoning effort/);
  });

  it("varies with the model and effort of each turn", () => {
    const first = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });
    const second = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.4",
      reasoningEffort: "high",
    });

    NodeAssert.notEqual(first, second);
  });

  it("flattens multiline metadata into single-line runtime info", () => {
    const instructions = buildCodexDeveloperInstructions("default", {
      model: "gpt\n5.3\ncodex",
      reasoningEffort: " high\neffort ",
    });

    NodeAssert.match(instructions, /as gpt 5\.3 codex with high effort reasoning effort/);
    NodeAssert.doesNotMatch(instructions, /<runtime_info>[^<]*\n/);
  });
});

describe("T3 browser developer instructions", () => {
  it("prefers the product-native preview tools in both collaboration modes", () => {
    for (const instructions of [
      CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
      CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
    ]) {
      NodeAssert.match(instructions, /t3-code/);
      NodeAssert.match(instructions, /preview_status/);
      NodeAssert.match(instructions, /preview_open/);
      NodeAssert.match(instructions, /Do not switch to global browser skills/);
    }
  });
});

describe("hasConfiguredMcpServer", () => {
  it("detects inline Codex MCP configuration arguments", () => {
    NodeAssert.equal(hasConfiguredMcpServer(undefined), false);
    NodeAssert.equal(hasConfiguredMcpServer(["--model", "gpt-5.4"]), false);
    NodeAssert.equal(
      hasConfiguredMcpServer(["-c", 'mcp_servers.t3-code.url="http://127.0.0.1/mcp"']),
      true,
    );
  });
});

describe("verifyCommandCenterCodexIsolation", () => {
  it.effect("executes a fail-closed app-server probe before a Command Center turn", () =>
    Effect.gen(function* () {
      const calls: Array<{
        method: string;
        payload: CodexRpc.ClientRequestParamsByMethod["command/exec"];
      }> = [];
      yield* verifyCommandCenterCodexIsolation({
        client: {
          request: (method, payload) => {
            calls.push({ method, payload });
            return Effect.succeed({
              exitCode: 0,
              stdout: "command-center-isolation-ok\n",
              stderr: "",
            });
          },
        },
        cwd: "/runtime/worktree",
        permissionProfile: "command-center-isolated-write-v1",
      });

      NodeAssert.equal(calls.length, 1);
      NodeAssert.equal(calls[0]?.method, "command/exec");
      NodeAssert.equal(calls[0]?.payload.cwd, "/runtime/worktree");
      const command = calls[0]?.payload.command;
      NodeAssert.deepStrictEqual(command?.slice(0, 2), ["/usr/bin/bash", "-c"]);
      const script = command?.[2] ?? "";
      NodeAssert.match(script, /\/proc\/\[0-9\]\*\/environ/u);
      NodeAssert.match(script, /T3_MCP_BEARER_TOKEN/u);
      NodeAssert.match(script, /test ! -r "\$HOME\/auth\.json"/u);
      NodeAssert.match(script, /test ! -r "\/proc\/1\/root\$HOME\/auth\.json"/u);
      NodeAssert.match(script, /: > "\$probe_path"/u);
      NodeAssert.match(script, /git status --porcelain=v1/u);
    }),
  );

  it.effect("rejects a failed or forged app-server probe result", () =>
    Effect.gen(function* () {
      const error = yield* verifyCommandCenterCodexIsolation({
        client: {
          request: () =>
            Effect.succeed({
              exitCode: 70,
              stdout: "",
              stderr: "",
            }),
        },
        cwd: "/runtime/worktree",
        permissionProfile: "command-center-isolated-read-v1",
      }).pipe(Effect.flip);

      NodeAssert.equal(error._tag, "CodexSessionRuntimeIsolationProbeError");
      NodeAssert.equal(error.exitCode, 70);
      NodeAssert.match(error.message, /live filesystem, process, or environment isolation/u);
      NodeAssert.doesNotMatch(error.message, /T3_MCP_BEARER_TOKEN/u);
    }),
  );

  it.effect("accepts only an actual sandbox-denied write for the read profile", () =>
    verifyCommandCenterCodexIsolation({
      client: {
        request: () =>
          Effect.succeed({
            exitCode: 73,
            stdout: "command-center-isolation-read-denial-ready\n",
            stderr: "",
          }),
      },
      cwd: "/runtime/worktree",
      permissionProfile: "command-center-isolated-read-v1",
    }),
  );

  it.effect("rejects the read profile when its workspace write succeeds", () =>
    Effect.gen(function* () {
      const error = yield* verifyCommandCenterCodexIsolation({
        client: {
          request: () =>
            Effect.succeed({
              exitCode: 74,
              stdout: "",
              stderr: "",
            }),
        },
        cwd: "/runtime/worktree",
        permissionProfile: "command-center-isolated-read-v1",
      }).pipe(Effect.flip);

      NodeAssert.equal(error._tag, "CodexSessionRuntimeIsolationProbeError");
      NodeAssert.equal(error.exitCode, 74);
    }),
  );

  it("makes the read probe's final operation an actual write that must be denied", () => {
    const script = buildCommandCenterIsolationProbeScript(false);
    NodeAssert.match(script, /command-center-isolation-read-denial-ready/u);
    NodeAssert.match(script, /: > "\$probe_path"/u);
    NodeAssert.ok(
      script.indexOf("git status --porcelain=v1") < script.indexOf(': > "$probe_path"'),
    );
    NodeAssert.ok(
      script.indexOf(': > "$probe_path"') <
        script.indexOf("command-center-isolation-read-denial-ready"),
    );
  });
});

describe("isRecoverableThreadResumeError", () => {
  it("matches missing thread errors", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Thread does not exist",
        }),
      ),
      true,
    );
  });

  it("ignores non-recoverable resume errors", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Permission denied",
        }),
      ),
      false,
    );
  });

  it("ignores unrelated missing-resource errors that do not mention threads", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Config file not found",
        }),
      ),
      false,
    );
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Model does not exist",
        }),
      ),
      false,
    );
  });
});

describe("openCodexThread", () => {
  it.effect("falls back to thread/start when resume fails recoverably", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: "thread/start" | "thread/resume"; payload: unknown }> = [];
      const started = makeThreadOpenResponse("fresh-thread");
      const client = {
        request: (method: "thread/start" | "thread/resume", payload: unknown) => {
          calls.push({ method, payload });
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "thread not found",
              }),
            );
          }
          return Effect.succeed(started);
        },
      };

      const opened = yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      });

      NodeAssert.equal(opened.thread.id, "fresh-thread");
      NodeAssert.deepStrictEqual(
        calls.map((call) => call.method),
        ["thread/resume", "thread/start"],
      );
    }),
  );

  it.effect("propagates non-recoverable resume failures", () =>
    Effect.gen(function* () {
      const client = {
        request: (method: "thread/start" | "thread/resume", _payload: unknown) => {
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "timed out waiting for server",
              }),
            );
          }
          return Effect.succeed(makeThreadOpenResponse("fresh-thread"));
        },
      };

      const error = yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      }).pipe(Effect.flip);

      NodeAssert.ok(isCodexAppServerRequestError(error));
      NodeAssert.equal(error.errorMessage, "timed out waiting for server");
    }),
  );

  it.effect("sends the permission profile on both resume and fallback start", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: "thread/start" | "thread/resume"; payload: unknown }> = [];
      const client = {
        request: (method: "thread/start" | "thread/resume", payload: unknown) => {
          calls.push({ method, payload });
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "thread not found",
              }),
            );
          }
          return Effect.succeed(
            makeThreadOpenResponse("fresh-thread", "command-center-isolated-read-v1"),
          );
        },
      };

      yield* openCodexThread({
        client,
        threadId: ThreadId.make("cc:thread-1"),
        runtimeMode: "approval-required",
        cwd: "/runtime/project",
        requestedModel: undefined,
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
        permissionProfile: "command-center-isolated-read-v1",
      });

      for (const call of calls) {
        const payload = call.payload as Record<string, unknown>;
        NodeAssert.equal(payload.permissions, "command-center-isolated-read-v1");
        NodeAssert.equal("sandbox" in payload, false);
        NodeAssert.equal("sandboxPolicy" in payload, false);
      }
    }),
  );

  it.effect("fails closed when Codex does not acknowledge the required permission profile", () =>
    Effect.gen(function* () {
      const error = yield* openCodexThread({
        client: {
          request: () => Effect.succeed(makeThreadOpenResponse("fresh-thread")),
        },
        threadId: ThreadId.make("cc:thread-1"),
        runtimeMode: "approval-required",
        cwd: "/runtime/project",
        requestedModel: undefined,
        serviceTier: undefined,
        resumeThreadId: undefined,
        permissionProfile: "command-center-isolated-read-v1",
      }).pipe(Effect.flip);

      NodeAssert.equal(error._tag, "CodexSessionRuntimePermissionProfileMismatchError");
      NodeAssert.match(error.message, /did not activate required permission profile/u);
    }),
  );
});
