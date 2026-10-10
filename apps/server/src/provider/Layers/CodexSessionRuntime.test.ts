import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";
import { DEFAULT_MODEL, ThreadId } from "@t3tools/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import {
  buildCodexAdditionalContext,
  buildCodexDeveloperInstructions,
  codexDefaultModeDeveloperInstructions,
} from "../CodexDeveloperInstructions.ts";
import { codexSessionAppServerArgs } from "./codexLaunchArgs.ts";
import {
  buildCommandCenterDarwinIsolationProbeScript,
  buildCommandCenterIsolationProbeScript,
  buildCommandCenterWindowsIsolationProbeScript,
  buildThreadStartParams,
  buildTurnStartParams,
  describeMcpElicitation,
  ensureCommandCenterWindowsSandbox,
  hasConfiguredMcpServer,
  isCommandCenterIsolationProbeAccepted,
  isRecoverableThreadResumeError,
  makeMemoryConsolidationNotificationFilter,
  openCodexThread,
  readCodexThread,
  rollbackCodexThread,
  toMcpElicitationResponse,
} from "./CodexSessionRuntime.ts";
const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);
const isCodexAppServerProtocolParseError = Schema.is(CodexErrors.CodexAppServerProtocolParseError);

describe("Command Center native sandbox admission", () => {
  it.effect("skips Windows setup when Codex reports the sandbox ready", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      yield* ensureCommandCenterWindowsSandbox({
        client: {
          request: (method) =>
            Effect.sync(() => {
              calls.push(method);
              return { status: "ready" };
            }),
        },
        cwd: "C:\\workspace",
        mode: "elevated",
        setupCompleted: Effect.never,
      });

      NodeAssert.deepStrictEqual(calls, ["windowsSandbox/readiness"]);
    }),
  );

  it.effect("reports failed elevated setup without offering an unsafe fallback", () =>
    Effect.gen(function* () {
      const error = yield* ensureCommandCenterWindowsSandbox({
        client: {
          request: (method) =>
            Effect.succeed(
              method === "windowsSandbox/readiness"
                ? { status: "notConfigured" }
                : { started: true },
            ),
        },
        cwd: "C:\\workspace",
        mode: "elevated",
        setupCompleted: Effect.succeed({
          mode: "elevated",
          success: false,
          error: "administrator approval was unavailable",
        }),
      }).pipe(Effect.flip);

      NodeAssert.equal(error.mode, "elevated");
      NodeAssert.match(error.issue, /administrator-approved Windows sandbox/u);
      NodeAssert.match(error.issue, /administrator approval was unavailable/u);
    }),
  );

  it("builds native probes without Linux-only process assumptions", () => {
    const linux = buildCommandCenterIsolationProbeScript(true);
    const darwin = buildCommandCenterDarwinIsolationProbeScript(true);
    const windows = buildCommandCenterWindowsIsolationProbeScript(false);

    NodeAssert.doesNotMatch(linux, /\/proc\//u);
    NodeAssert.match(linux, /CC_PROVIDER_ISOLATION_SENTINEL/u);
    NodeAssert.doesNotMatch(darwin, /\/proc\//u);
    NodeAssert.match(darwin, /HOME\/auth\.json/u);
    NodeAssert.match(windows, /USERPROFILE/u);
    NodeAssert.match(windows, /WriteAllText/u);
    NodeAssert.match(windows, /exit 73/u);
  });

  it("admits both shell-reported and sandbox-enforced read denials after the marker", () => {
    const linux = buildCommandCenterIsolationProbeScript(false);
    NodeAssert.ok(
      linux.indexOf("command-center-isolation-read-denial-ready") <
        linux.indexOf(': > "$probe_path"'),
    );
    NodeAssert.equal(
      isCommandCenterIsolationProbeAccepted(false, {
        exitCode: 1,
        stdout: "command-center-isolation-read-denial-ready\n",
      }),
      true,
    );
    NodeAssert.equal(
      isCommandCenterIsolationProbeAccepted(false, {
        exitCode: 74,
        stdout: "command-center-isolation-read-denial-ready\n",
      }),
      false,
    );
    NodeAssert.equal(
      isCommandCenterIsolationProbeAccepted(false, { exitCode: 1, stdout: "" }),
      false,
    );
  });
});

describe("Codex thread history", () => {
  for (const numTurns of [1, 2, 3, 5]) {
    it.effect(`reverts ${numTurns} paginated turns at the durable boundary`, () =>
      Effect.gen(function* () {
        let retained = ["turn-1", "turn-2", "turn-3"];
        const client: Parameters<typeof rollbackCodexThread>[0] = {
          request: () => Effect.die("Legacy history API must not be used for paginated threads"),
          raw: {
            request: (method, params) =>
              Effect.sync(() => {
                if (method === "thread/read") return { thread: { historyMode: "paginated" } };
                if (method === "thread/turns/list") {
                  const { cursor } = params as { cursor: string | null };
                  const start = cursor === null ? 0 : Number(cursor);
                  const ids = retained.slice(start, start + 2);
                  return {
                    data: ids.map((id) => ({ id, items: [], status: "completed" })),
                    nextCursor: start + 2 < retained.length ? String(start + 2) : null,
                  };
                }
                NodeAssert.equal(method, "thread/revert");
                const { beforeTurnId } = params as { beforeTurnId: string };
                retained = retained.slice(0, retained.indexOf(beforeTurnId));
                return { thread: { id: "thread-1", turns: [] } };
              }),
          },
        };
        const result = yield* rollbackCodexThread(client, "thread-1", numTurns);
        const expected = ["turn-1", "turn-2", "turn-3"].slice(0, Math.max(0, 3 - numTurns));
        NodeAssert.deepEqual(
          result.turns.map((turn) => turn.id),
          expected,
        );
        NodeAssert.deepEqual(
          (yield* readCodexThread(client, "thread-1")).turns.map((turn) => turn.id),
          expected,
        );
      }),
    );
  }

  for (const cursors of [
    ["next", "next"],
    ["first", "second", "first"],
  ]) {
    it.effect(`rejects a pagination cursor cycle: ${cursors.join(", ")}`, () =>
      Effect.gen(function* () {
        let pageCount = 0;
        const client: Parameters<typeof readCodexThread>[0] = {
          request: () => Effect.die("Unexpected legacy request"),
          raw: {
            request: (method) =>
              Effect.sync(() => {
                if (method === "thread/read") return { thread: { historyMode: "paginated" } };
                NodeAssert.ok(pageCount < cursors.length, "Repeated cursor was requested");
                return { data: [], nextCursor: cursors[pageCount++] };
              }),
          },
        };
        const error = yield* Effect.flip(readCodexThread(client, "thread-1"));
        NodeAssert.ok(isCodexAppServerRequestError(error));
        NodeAssert.equal(pageCount, cursors.length);
      }),
    );
  }

  it.effect("surfaces Codex rejecting a revert of a legacy thread", () =>
    Effect.gen(function* () {
      const rejection = CodexErrors.CodexAppServerRequestError.invalidRequest(
        "thread/revert only supports paginated threads",
      );
      const client: Parameters<typeof rollbackCodexThread>[0] = {
        raw: {
          request: (method) => {
            if (method === "thread/read") return Effect.succeed({ thread: {} });
            if (method === "thread/revert") return Effect.fail(rejection);
            return Effect.die(`Unexpected raw request: ${method}`);
          },
        },
        request: <M extends CodexRpc.ClientRequestMethod>(method: M) => {
          NodeAssert.equal(method, "thread/read");
          return Effect.succeed({
            thread: { id: "legacy-thread", turns: [{ id: "turn-1", items: [] }] },
          } as unknown as CodexRpc.ClientRequestResponsesByMethod[M]);
        },
      };
      const error = yield* Effect.flip(rollbackCodexThread(client, "legacy-thread", 1));
      NodeAssert.strictEqual(error, rejection);
    }),
  );
});

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
): CodexRpc.ClientRequestResponsesByMethod["thread/start"] {
  return {
    cwd: "/tmp/project",
    model: "gpt-5.3-codex",
    modelProvider: "openai",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    thread: {
      id: threadId,
      cliVersion: "0.0.0-test",
      createdAt: 1_776_470_400,
      cwd: "/tmp/project",
      ephemeral: false,
      modelProvider: "openai",
      preview: "",
      sessionId: "session-test",
      updatedAt: 1_776_470_400,
      source: "cli",
      turns: [],
      status: { type: "idle" },
    },
  } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/start"];
}

describe("buildThreadStartParams", () => {
  const base = { cwd: "/repo", runtimeMode: "full-access", serviceTier: undefined } as const;

  it("points an Astra thread's inheriting subagents at the worker model", () => {
    const params = buildThreadStartParams({ ...base, model: "gpt-6-astra" });
    NodeAssert.deepEqual(params.config, { "agents.default_subagent_model": "gpt-6-sol" });
  });

  it("leaves non-manager threads without a subagent config override", () => {
    NodeAssert.equal(buildThreadStartParams({ ...base, model: "gpt-6-terra" }).config, undefined);
    NodeAssert.equal(buildThreadStartParams({ ...base, model: undefined }).config, undefined);
  });
});

describe("buildTurnStartParams", () => {
  it.effect("sends currency skill aliases in Codex's canonical dollar form", () =>
    Effect.gen(function* () {
      for (const symbol of ["€", "£", "¥", "₹", "₩", "₿", "𑿝"]) {
        const prose = `${symbol}20 ${symbol}20k ${symbol}100M ${symbol}1e6 5${symbol}review`;
        const params = yield* buildTurnStartParams({
          threadId: "provider-thread-1",
          runtimeMode: "full-access",
          prompt: `${symbol}review ${symbol}2spec $existing ${prose} ${symbol}last`,
        });

        NodeAssert.deepEqual(params.input, [
          { type: "text", text: `$review $2spec $existing ${prose} $last` },
        ]);
      }
    }),
  );

  it("keeps invalid turn values only in the schema cause", () => {
    const secret = "codex-turn-input-secret-sentinel";
    const error = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        attachments: [
          {
            type: "localImage",
            path: { secret } as unknown as string,
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
      approvalsReviewer: "user",
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
          developer_instructions: buildCodexDeveloperInstructions("plan"),
        },
      },
      additionalContext: buildCodexAdditionalContext({
        model: "gpt-5.3-codex",
        reasoningEffort: "medium",
      }),
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
            type: "localImage",
            path: "/tmp/generated.png",
          },
        ],
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
      },
      input: [
        {
          type: "text",
          text: "Implement it",
        },
        {
          type: "localImage",
          path: "/tmp/generated.png",
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: buildCodexDeveloperInstructions("default"),
        },
      },
      additionalContext: buildCodexAdditionalContext({
        model: "gpt-5.3-codex",
        reasoningEffort: "medium",
      }),
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
    NodeAssert.ok(
      params.additionalContext?.t3_code_runtime?.value.includes(`as ${DEFAULT_MODEL} with medium`),
    );
  });

  it.effect("omits preview instructions from database-only plan and default turns", () =>
    Effect.gen(function* () {
      for (const interactionMode of ["plan", "default"] as const) {
        const params = yield* buildTurnStartParams({
          threadId: "provider-thread-database-only",
          runtimeMode: "full-access",
          prompt: "Use the database tools",
          interactionMode,
          browserToolsAvailable: false,
        });

        const instructions = params.collaborationMode?.settings.developer_instructions ?? "";
        NodeAssert.match(instructions, /<collaboration_mode>/);
        NodeAssert.doesNotMatch(instructions, /preview_status/);
        NodeAssert.doesNotMatch(instructions, /preview_open/);
        // The tool block travels in additionalContext; with no tools it is omitted.
        NodeAssert.equal(params.additionalContext?.t3_code_tools, undefined);
      }
    }),
  );

  it.effect("names the model by display name and slug in the runtime context", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        model: "gpt-5.3-codex",
        modelName: "GPT-5.3-Codex",
        effort: "high",
        interactionMode: "plan",
      });

      NodeAssert.match(
        params.additionalContext?.t3_code_runtime?.value ?? "",
        /as GPT-5\.3-Codex \(model slug: gpt-5\.3-codex\) with high reasoning effort/,
      );
    }),
  );

  it.effect("routes approvals to the auto reviewer in auto mode", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto",
        prompt: "Ship it",
      });

      NodeAssert.deepStrictEqual(params, {
        threadId: "provider-thread-1",
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandboxPolicy: {
          type: "workspaceWrite",
        },
        input: [
          {
            type: "text",
            text: "Ship it",
          },
        ],
      });
    }),
  );

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
      approvalsReviewer: "user",
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
});

describe("Codex MCP elicitation approvals", () => {
  const request = {
    mode: "form",
    message: "Allow ChatGPT to use Safari?",
    serverName: "computer-use",
    threadId: "provider-thread-1",
    turnId: "turn-1",
    _meta: {
      app_name: "Safari",
      persist: ["session", "always"],
    },
    requestedSchema: {
      type: "object",
      properties: {
        approval: {
          type: "string",
          oneOf: [
            { const: "once", title: "Allow once" },
            { const: "session", title: "Allow for this session" },
            { const: "always", title: "Always allow Safari" },
          ],
        },
      },
      required: ["approval"],
    },
  } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

  it("preserves the app name and advertised persistence choices", () => {
    NodeAssert.deepStrictEqual(describeMcpElicitation(request), {
      appName: "computer-use",
      options: [
        { decision: "cancel", label: "Cancel" },
        { decision: "decline", label: "Decline" },
        { decision: "acceptForSession", label: "Allow for this session" },
        { decision: "acceptAlways", label: "Always allow Safari" },
        { decision: "accept", label: "Approve" },
      ],
    });
  });

  it("uses the trusted MCP server name instead of request-controlled app metadata", () => {
    const { _meta, ...requestWithoutMetadata } = request;

    NodeAssert.equal(describeMcpElicitation(requestWithoutMetadata).appName, "computer-use");
  });

  it("returns the accepted form option to Codex", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "accept"), {
      action: "accept",
      content: { approval: "once" },
    });
  });

  it("returns session-scoped approval in the MCP response", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "acceptForSession"), {
      action: "accept",
      _meta: { persist: "session" },
      content: { approval: "session" },
    });
  });

  it("returns persistent approval in the MCP response", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { approval: "always" },
    });
  });

  it("returns rejection without form content", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "decline"), {
      action: "decline",
    });
  });

  it("returns cancellation without form content", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "cancel"), {
      action: "cancel",
    });
  });

  it("supports boolean permanent-approval fields", () => {
    const booleanRequest = {
      ...request,
      _meta: { app_name: "Safari" },
      requestedSchema: {
        type: "object",
        properties: {
          always: { type: "boolean", title: "Always allow Safari" },
        },
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.ok(
      describeMcpElicitation(booleanRequest).options.some(
        (option) => option.decision === "acceptAlways",
      ),
    );
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(booleanRequest, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { always: true },
    });
  });

  it("preserves valid nullable MCP form fields and persistence choices", () => {
    const nullableRequest = {
      ...request,
      _meta: {
        app_name: null,
        appName: "Safari",
        connector_name: null,
        persist: null,
        target: null,
        tool_params: null,
      },
      requestedSchema: {
        type: "object",
        properties: {
          approval: {
            type: "string",
            title: null,
            description: null,
            default: null,
            enum: ["once", "always"],
            enumNames: null,
          },
        },
        required: ["approval"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.equal(describeMcpElicitation(nullableRequest).appName, "computer-use");
    NodeAssert.ok(
      describeMcpElicitation(nullableRequest).options.some(
        (option) => option.decision === "acceptAlways",
      ),
    );
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(nullableRequest, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { approval: "always" },
    });
  });

  it("declines required form fields that an approval prompt cannot collect", () => {
    const inputRequest = {
      ...request,
      requestedSchema: {
        type: "object",
        properties: {
          email: { type: "string", format: "email" },
        },
        required: ["email"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(toMcpElicitationResponse(inputRequest, "accept"), {
      action: "decline",
    });
  });

  it("does not approve URL elicitations without opening their requested URL", () => {
    const urlRequest = {
      mode: "url",
      message: "Finish signing in to continue.",
      serverName: "computer-use",
      threadId: "provider-thread-1",
      turnId: "turn-1",
      elicitationId: "sign-in-1",
      url: "https://example.com/authorize",
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(toMcpElicitationResponse(urlRequest, "accept"), {
      action: "decline",
    });
  });

  it("omits persistence choices that cannot satisfy required form fields", () => {
    const onceOnlyRequest = {
      ...request,
      _meta: { app_name: "Safari", persist: ["session", "always"] },
      requestedSchema: {
        type: "object",
        properties: {
          approval: {
            type: "string",
            enum: ["once"],
          },
        },
        required: ["approval"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(describeMcpElicitation(onceOnlyRequest).options, [
      { decision: "cancel", label: "Cancel" },
      { decision: "decline", label: "Decline" },
      { decision: "accept", label: "Approve" },
    ]);
  });

  it("keeps boolean session consent session-scoped", () => {
    const { _meta: _requestMeta, ...requestWithoutMetadata } = request;
    const sessionRequest = {
      ...requestWithoutMetadata,
      requestedSchema: {
        type: "object",
        properties: {
          session: { type: "boolean", title: "Allow for this session" },
        },
        required: ["session"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(describeMcpElicitation(sessionRequest).options, [
      { decision: "cancel", label: "Cancel" },
      { decision: "decline", label: "Decline" },
      { decision: "acceptForSession", label: "Allow for this session" },
      { decision: "accept", label: "Approve" },
    ]);
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(sessionRequest, "acceptForSession"), {
      action: "accept",
      _meta: { persist: "session" },
      content: { session: true },
    });
  });

  it("declines required enum values that do not explicitly mean one-time approval", () => {
    const unsafeOptionRequest = {
      ...request,
      requestedSchema: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["disallow", "allow_admin"] },
        },
        required: ["scope"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(toMcpElicitationResponse(unsafeOptionRequest, "accept"), {
      action: "decline",
    });
  });
});

describe("buildCodexDeveloperInstructions", () => {
  it("keeps T3 context out of the mode prompt, which the model catalog can replace", () => {
    for (const mode of ["default", "plan"] as const) {
      const instructions = buildCodexDeveloperInstructions(mode);
      NodeAssert.match(instructions, /^<collaboration_mode>[\s\S]*<\/collaboration_mode>$/);
      NodeAssert.doesNotMatch(instructions, /runtime_info|pull_request_linking|preview_|device_/);
    }
  });
});

describe("buildCodexAdditionalContext", () => {
  const runtime = { model: "gpt-5.3-codex", reasoningEffort: "high" };
  const runtimeValue = (context: ReturnType<typeof buildCodexAdditionalContext>) =>
    context.t3_code_runtime?.value ?? "";

  it("describes the harness, model, effort, and Markdown media support", () => {
    const context = buildCodexAdditionalContext(runtime);

    NodeAssert.equal(context.t3_code_runtime?.kind, "application");
    NodeAssert.match(
      runtimeValue(context),
      /<runtime_info>.*Codex harness, as gpt-5\.3-codex with high reasoning effort.*embed images and videos.*Markdown.*<\/runtime_info>/,
    );
  });

  it("varies with the model and effort of each turn", () => {
    NodeAssert.notEqual(
      runtimeValue(
        buildCodexAdditionalContext({ model: "gpt-5.3-codex", reasoningEffort: "medium" }),
      ),
      runtimeValue(buildCodexAdditionalContext({ model: "gpt-5.4", reasoningEffort: "high" })),
    );
  });

  it("flattens multiline metadata into single-line runtime info", () => {
    const value = runtimeValue(
      buildCodexAdditionalContext({ model: "gpt\n5.3\ncodex", reasoningEffort: " high\neffort " }),
    );

    NodeAssert.match(value, /as gpt 5\.3 codex with high effort reasoning effort/);
    NodeAssert.doesNotMatch(value, /<runtime_info>[^<]*\n/);
  });

  it("keeps every entry under Codex's 1,000 token cap per entry", () => {
    const context = buildCodexAdditionalContext(runtime, { browser: true, device: true });
    for (const entry of Object.values(context)) {
      // Codex estimates 4 bytes per token and truncates the middle of longer values.
      NodeAssert.ok(Buffer.byteLength(entry.value) < 4_000);
    }
  });
});

describe("T3 tool instructions", () => {
  const runtime = { model: "gpt-5.3-codex", reasoningEffort: "high" };

  it("prefers the product-native preview tools when they are attached", () => {
    const tools = buildCodexAdditionalContext(runtime, true).t3_code_tools?.value ?? "";
    NodeAssert.match(tools, /t3-code/);
    NodeAssert.match(tools, /preview_status/);
    NodeAssert.match(tools, /preview_open/);
    NodeAssert.match(tools, /Do not switch to global browser skills/);
    NodeAssert.doesNotMatch(tools, /device_open/);
  });

  it("describes device tools only when the credential grants them", () => {
    const tools =
      buildCodexAdditionalContext(runtime, { browser: false, device: true }).t3_code_tools?.value ??
      "";
    NodeAssert.match(tools, /device_open/);
    NodeAssert.doesNotMatch(tools, /preview_open/);
  });

  it("omits the tool entry entirely when no tools are attached", () => {
    // Steering away from other browser automation must go with the tools;
    // keeping it would leave the model talked out of its only option.
    const context = buildCodexAdditionalContext(runtime, false);
    NodeAssert.deepStrictEqual(Object.keys(context), ["t3_code_runtime"]);
  });

  it("routes default-mode questions through request_user_input when it is listed", () => {
    const instructions = codexDefaultModeDeveloperInstructions(true);
    NodeAssert.match(
      instructions,
      /ask it with the `request_user_input` tool when that tool is listed/,
    );
    // The plain-text fallback remains only for the tool-unavailable case.
    NodeAssert.match(instructions, /only when the tool is unavailable, ask directly/);
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

function makeThreadStartedNotification(
  threadId: string,
  source: EffectCodexSchema.V2ThreadStartedNotification["thread"]["source"],
  threadSource?: string,
) {
  return {
    method: "thread/started" as const,
    params: {
      thread: {
        cliVersion: "0.0.0",
        createdAt: 0,
        cwd: "/tmp/project",
        ephemeral: true,
        id: threadId,
        modelProvider: "openai",
        preview: "",
        projectId: null,
        sessionId: threadId,
        source,
        status: { type: "idle" as const },
        ...(threadSource ? { threadSource } : {}),
        turns: [],
        updatedAt: 0,
      },
    },
  };
}

describe("makeMemoryConsolidationNotificationFilter", () => {
  it("suppresses memory consolidation without hiding other Codex subagents", () => {
    const shouldSuppress = makeMemoryConsolidationNotificationFilter();

    NodeAssert.equal(
      shouldSuppress(
        makeThreadStartedNotification("memory-thread", "unknown", "memory_consolidation"),
      ),
      true,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "item/agentMessage/delta",
        params: {
          delta: "internal memory update",
          itemId: "memory-message",
          threadId: "memory-thread",
          turnId: "memory-turn",
        },
      }),
      true,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "serverRequest/resolved",
        params: {
          requestId: "memory-approval",
          threadId: "memory-thread",
        },
      }),
      false,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "warning",
        params: {
          message: "internal warning",
          threadId: "memory-thread",
        },
      }),
      true,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "item/agentMessage/delta",
        params: {
          delta: "normal reply",
          itemId: "root-message",
          threadId: "root-thread",
          turnId: "root-turn",
        },
      }),
      false,
    );

    NodeAssert.equal(
      shouldSuppress(
        makeThreadStartedNotification("legacy-memory-thread", {
          subAgent: "memory_consolidation",
        }),
      ),
      true,
    );

    for (const source of [
      { subAgent: "review" as const },
      { subAgent: "compact" as const },
      {
        subAgent: {
          thread_spawn: {
            depth: 1,
            parent_thread_id: "root-thread",
          },
        },
      },
    ]) {
      NodeAssert.equal(
        shouldSuppress(makeThreadStartedNotification("visible-subagent", source)),
        false,
      );
    }
  });

  it("forgets memory consolidation threads after they close", () => {
    const shouldSuppress = makeMemoryConsolidationNotificationFilter();
    shouldSuppress(
      makeThreadStartedNotification("memory-thread", "unknown", "memory_consolidation"),
    );

    NodeAssert.equal(
      shouldSuppress({
        method: "thread/closed",
        params: { threadId: "memory-thread" },
      }),
      true,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "item/agentMessage/delta",
        params: {
          delta: "later message",
          itemId: "later-message",
          threadId: "memory-thread",
          turnId: "later-turn",
        },
      }),
      false,
    );
  });
});

describe("codexSessionAppServerArgs", () => {
  it("keeps the app-server subcommand when explicit args are provided", () => {
    NodeAssert.deepStrictEqual(codexSessionAppServerArgs(["-c", "model=gpt-5"], undefined), [
      "app-server",
      "-c",
      "features.default_mode_request_user_input=true",
      "-c",
      "model=gpt-5",
    ]);
  });

  it("keeps launch args when explicit app-server args are provided", () => {
    NodeAssert.deepStrictEqual(
      codexSessionAppServerArgs(
        ["-c", "mcp_servers.t3-code.url=http://127.0.0.1/mcp"],
        "--strict-config --enable foo",
      ),
      [
        "app-server",
        "--strict-config",
        "--enable",
        "foo",
        "-c",
        "features.default_mode_request_user_input=true",
        "-c",
        "mcp_servers.t3-code.url=http://127.0.0.1/mcp",
      ],
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

  it("matches a missing rollout for a known thread id", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "no rollout found for thread id 019fdf74-aaa9-7950-b252-7cc7a8650470",
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
  for (const kind of [
    "started",
    "interacted",
    "interrupted",
    "completed",
    "unknown",
    null,
    undefined,
  ]) {
    it.effect(`validates resumed subagent activity kind ${String(kind)}`, () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const response = makeThreadOpenResponse("resumed-thread");
        const activity = {
          type: "subAgentActivity",
          id: "activity-1",
          agentThreadId: "child-thread",
          agentPath: "/agents/child",
          ...(kind === undefined ? {} : { kind }),
        };
        const resume = openCodexThread({
          client: {
            request: (method) => {
              calls.push(method);
              return Effect.succeed({
                ...response,
                thread: {
                  ...response.thread,
                  turns: [{ id: "turn-1", status: "completed", items: [activity] }],
                },
              });
            },
          },
          threadId: ThreadId.make("thread-1"),
          runtimeMode: "full-access",
          cwd: "/tmp/project",
          requestedModel: "gpt-5.3-codex",
          serviceTier: undefined,
          resumeThreadId: "resumed-thread",
        });

        if (kind === "unknown" || kind === null || kind === undefined) {
          const error = yield* resume.pipe(Effect.flip);
          NodeAssert.ok(isCodexAppServerProtocolParseError(error));
          NodeAssert.equal(error.operation, "decode-response-payload");
          NodeAssert.equal(error.method, "thread/resume");
        } else {
          const opened = yield* resume;
          NodeAssert.equal(opened.thread.id, "resumed-thread");
          NodeAssert.equal(opened.resumeFellBack, false);
          NodeAssert.deepStrictEqual(opened.thread.turns[0]?.items, [activity]);
        }
        NodeAssert.deepStrictEqual(calls, ["thread/resume"]);
      }),
    );
  }

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
      NodeAssert.equal(opened.resumeFellBack, true);
      NodeAssert.deepStrictEqual(
        calls.map((call) => call.method),
        ["thread/resume", "thread/start"],
      );
    }),
  );

  it.effect("marks a successful native resume as preserved", () =>
    Effect.gen(function* () {
      const resumed = makeThreadOpenResponse("resumed-thread");
      const opened = yield* openCodexThread({
        client: {
          request: () => Effect.succeed(resumed),
        },
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "resumed-thread",
      });

      NodeAssert.equal(opened.thread.id, "resumed-thread");
      NodeAssert.equal(opened.resumeFellBack, false);
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
});
