import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CodexSettings,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
  ProjectId,
  type ProviderApprovalDecision,
  type ProviderRequestKind,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import packageJson from "../../../package.json" with { type: "json" };
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { makeReplayServerConfig } from "./CodexAdapterV2.testkit.ts";

/**
 * Codex `item/permissions/requestApproval` is a sandbox escalation request.
 * These tests pin the auto-approval setting, the prompt kind and text, and the
 * response each approval decision produces.
 */

const DEFAULT_CODEX_SETTINGS = Schema.decodeSync(CodexSettings)({});
const AUTO_APPROVE_CODEX_SETTINGS = {
  ...DEFAULT_CODEX_SETTINGS,
  autoApproveReadOnlyPermissions: true,
} satisfies typeof DEFAULT_CODEX_SETTINGS;
const CODEX_TEST_MODEL_SELECTION = {
  instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
  model: "gpt-5.4",
} satisfies ModelSelection;
const CODEX_TEST_RUNTIME_POLICY = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});

type PermissionProfile = Readonly<Record<string, unknown>>;

const readEntry = (path: string) => ({
  access: "read",
  path: { type: "path", path },
});
const writeEntry = (path: string) => ({
  access: "write",
  path: { type: "path", path },
});
const denyEntry = (path: string) => ({
  access: "deny",
  path: { type: "path", path },
});

function makeTurn(input: { readonly id: string; readonly status: "inProgress" | "completed" }) {
  return {
    id: input.id,
    items: [],
    itemsView: "notLoaded",
    status: input.status,
    error: null,
    startedAt: 1782622440,
    completedAt: input.status === "completed" ? 1782622450 : null,
    durationMs: null,
  };
}

function permissionsReplayEntries(input: {
  readonly nativeThreadId: string;
  readonly nativeTurnId: string;
  readonly prompt: string;
  readonly permissions: PermissionProfile;
  readonly reason?: string;
  /** What the adapter must write back for the escalation request. */
  readonly expectedResponse: unknown;
}): Array<CodexReplay.CodexAppServerReplayEntry> {
  const { nativeThreadId, nativeTurnId } = input;
  return [
    {
      type: "expect_outbound",
      label: "initialize",
      frame: {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: "Command Center",
            title: "Command Center",
            version: packageJson.version,
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: ["turn/diff/updated"],
            extensions: {
              "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
            },
          },
        },
      },
    },
    {
      type: "emit_inbound",
      label: "initialize",
      frame: {
        id: 1,
        result: {
          userAgent: "T3 Code/0.156.1",
          codexHome: "/tmp/codex-home",
          platformFamily: "unix",
          platformOs: "macos",
        },
      },
    },
    { type: "expect_outbound", label: "initialized", frame: { method: "initialized" } },
    {
      type: "expect_outbound",
      label: "thread/start",
      frame: {
        id: 2,
        method: "thread/start",
        params: { config: CodexAdapterV2.CODEX_THREAD_CONFIG },
      },
    },
    {
      type: "emit_inbound",
      label: "thread/start",
      frame: {
        id: 2,
        result: {
          thread: {
            id: nativeThreadId,
            sessionId: nativeThreadId,
            forkedFromId: null,
            preview: "",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 1782622440,
            updatedAt: 1782622440,
            status: { type: "idle" },
            path: `/tmp/${nativeThreadId}.jsonl`,
            cwd: "/workspace",
            cliVersion: "0.144.0",
            source: "vscode",
            threadSource: null,
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: [],
          },
          model: "gpt-5.4",
          modelProvider: "openai",
          serviceTier: null,
          cwd: "/workspace",
          instructionSources: [],
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
          reasoningEffort: "medium",
        },
      },
    },
    {
      type: "expect_outbound",
      label: "turn/start",
      frame: {
        id: 3,
        method: "turn/start",
        params: {
          threadId: nativeThreadId,
          input: [{ type: "text", text: input.prompt }],
          cwd: "/workspace",
          model: "gpt-5.4",
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "dangerFullAccess" },
          summary: "detailed",
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/start",
      frame: { id: 3, result: { turn: makeTurn({ id: nativeTurnId, status: "inProgress" }) } },
    },
    {
      type: "emit_inbound",
      label: "turn/started",
      frame: {
        method: "turn/started",
        params: {
          threadId: nativeThreadId,
          turn: makeTurn({ id: nativeTurnId, status: "inProgress" }),
        },
      },
    },
    {
      type: "emit_inbound",
      label: "permissions request",
      frame: {
        id: 200,
        method: "item/permissions/requestApproval",
        params: {
          threadId: nativeThreadId,
          turnId: nativeTurnId,
          itemId: "permissions-item",
          startedAtMs: 1782622441000,
          cwd: "/workspace",
          permissions: input.permissions,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        },
      },
    },
    {
      type: "expect_outbound",
      label: "permissions response",
      frame: { id: 200, result: input.expectedResponse },
    },
    {
      type: "emit_inbound",
      label: "turn/completed",
      frame: {
        method: "turn/completed",
        params: {
          threadId: nativeThreadId,
          turn: makeTurn({ id: nativeTurnId, status: "completed" }),
        },
      },
    },
  ];
}

function makeAppThread(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
}): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: input.threadId,
    projectId: ProjectId.make(`project-${input.threadId}`),
    title: "Codex permissions test",
    providerInstanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
    modelSelection: CODEX_TEST_MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: input.providerThread.id,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: input.threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

const awaitUntil = (predicate: () => boolean, label: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 5000; attempt++) {
      if (predicate()) {
        return;
      }
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(`Timed out waiting for ${label}.`);
  });

interface PermissionsScenario {
  readonly name: string;
  readonly settings: typeof DEFAULT_CODEX_SETTINGS;
  readonly permissions: PermissionProfile;
  readonly reason?: string;
  /** Null when the request must be answered without prompting. */
  readonly decision: ProviderApprovalDecision | null;
  readonly expectedResponse: unknown;
}

const runPermissionsScenario = (scenario: PermissionsScenario) =>
  Effect.gen(function* () {
    const nativeThreadId = `permissions-${scenario.name}-thread`;
    const nativeTurnId = `permissions-${scenario.name}-turn`;
    const prompt = "Inspect the workspace.";
    const transcript: CodexReplay.CodexAppServerReplayTranscript = {
      provider: "codex",
      protocol: "codex.app-server",
      version: "0.144.0",
      scenario: `permissions-${scenario.name}`,
      entries: permissionsReplayEntries({
        nativeThreadId,
        nativeTurnId,
        prompt,
        permissions: scenario.permissions,
        ...(scenario.reason === undefined ? {} : { reason: scenario.reason }),
        expectedResponse: scenario.expectedResponse,
      }),
    };
    const serverConfig = yield* makeReplayServerConfig(transcript.scenario).pipe(Effect.orDie);
    const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
      instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
      settings: scenario.settings,
      environment: {},
      clientFactory: {
        open: (openInput) =>
          Layer.build(CodexReplay.layerReplay(transcript)).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterOpenSessionError({
                  driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                  providerSessionId: openInput.providerSessionId,
                  cause,
                }),
            ),
            Effect.flatMap((context) =>
              Effect.service(CodexClient.CodexAppServerClient).pipe(Effect.provide(context)),
            ),
          ),
      },
      crypto: yield* Crypto.Crypto,
      fileSystem: yield* FileSystem.FileSystem,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      serverConfig,
    });
    const threadId = ThreadId.make(`thread-${transcript.scenario}`);
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`provider-session-${transcript.scenario}`),
      modelSelection: CODEX_TEST_MODEL_SELECTION,
      runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
    });
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection: CODEX_TEST_MODEL_SELECTION,
      runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
    });
    const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
    yield* runtime.events.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      ),
      Effect.forkScoped,
    );
    const attemptId = RunAttemptId.make(`permissions-${scenario.name}-attempt`);
    yield* runtime.startTurn({
      appThread: makeAppThread({ threadId, providerThread, now: yield* DateTime.now }),
      threadId,
      runId: RunId.make(`run-${attemptId}`),
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId,
      rootNodeId: NodeId.make(`node-${attemptId}`),
      providerThread,
      message: {
        createdBy: "user",
        creationSource: "web",
        messageId: MessageId.make(`message-${attemptId}`),
        text: prompt,
        attachments: [],
      },
      modelSelection: CODEX_TEST_MODEL_SELECTION,
      runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
    });

    const runtimeRequests = () =>
      events.flatMap((event) =>
        event.type === "runtime_request.updated" ? [event.runtimeRequest] : [],
      );
    const approvalItems = () =>
      events.flatMap(
        (event): Array<Extract<OrchestrationV2TurnItem, { type: "approval_request" }>> =>
          event.type === "turn_item.updated" && event.turnItem.type === "approval_request"
            ? [event.turnItem]
            : [],
      );

    if (scenario.decision !== null) {
      yield* awaitUntil(() => runtimeRequests().length > 0, "permissions approval request");
      yield* runtime.respondToRuntimeRequest({
        requestId: runtimeRequests()[0]!.id,
        decision: scenario.decision,
      });
    }
    // The replay turn only completes once the adapter wrote the expected
    // response frame, so a wrong or missing answer never reaches this point.
    yield* awaitUntil(
      () => events.some((event) => event.type === "turn.terminal"),
      "turn terminal",
    );
    return { events, runtimeRequests, approvalItems };
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
    ),
  );

const READ_ENTRIES: PermissionProfile = {
  fileSystem: { entries: [readEntry("/workspace/docs"), readEntry("/workspace/notes.md")] },
};
const LEGACY_READ: PermissionProfile = { fileSystem: { read: ["/workspace/docs"] } };

describe("CodexAdapterV2 permission escalations: read-only auto-approval", () => {
  it.effect.each([
    ["entries", READ_ENTRIES],
    ["legacy-read", LEGACY_READ],
  ] as const)(
    "answers a read-only %s request immediately for the turn without prompting when enabled",
    ([name, permissions]) =>
      Effect.gen(function* () {
        const result = yield* runPermissionsScenario({
          name: `auto-${name}`,
          settings: AUTO_APPROVE_CODEX_SETTINGS,
          permissions,
          reason: "Read project files.",
          decision: null,
          expectedResponse: { permissions, scope: "turn" },
        });
        assert.lengthOf(result.runtimeRequests(), 0);
        assert.lengthOf(result.approvalItems(), 0);
      }),
  );

  it.effect("prompts for the same read-only request when the setting is off (default)", () =>
    Effect.gen(function* () {
      assert.isFalse(DEFAULT_CODEX_SETTINGS.autoApproveReadOnlyPermissions);
      const result = yield* runPermissionsScenario({
        name: "default-off",
        settings: DEFAULT_CODEX_SETTINGS,
        permissions: READ_ENTRIES,
        decision: "accept",
        expectedResponse: { permissions: READ_ENTRIES, scope: "turn" },
      });
      assert.lengthOf(result.runtimeRequests(), 1);
      assert.equal(result.runtimeRequests()[0]!.kind, "file-read");
    }),
  );

  const stillPrompts: ReadonlyArray<
    readonly [
      name: string,
      permissions: PermissionProfile,
      kind: ProviderRequestKind,
      expectedPrompt: string,
    ]
  > = [
    [
      "write-entry",
      { fileSystem: { entries: [writeEntry("/workspace/out")] } },
      "file-change",
      "write: /workspace/out",
    ],
    [
      "read-and-write-entry",
      { fileSystem: { entries: [readEntry("/workspace/docs"), writeEntry("/workspace/out")] } },
      "file-change",
      "write: /workspace/out; read: /workspace/docs",
    ],
    [
      "legacy-write",
      { fileSystem: { write: ["/workspace/out"] } },
      "file-change",
      "write: /workspace/out",
    ],
    [
      "deny-entry",
      { fileSystem: { entries: [denyEntry("/workspace/secrets")] } },
      "file-change",
      "deny: /workspace/secrets",
    ],
    ["network", { network: { enabled: true } }, "file-change", "network access"],
    [
      "read-and-network",
      { fileSystem: { entries: [readEntry("/workspace/docs")] }, network: { enabled: true } },
      "file-change",
      "read: /workspace/docs; network access",
    ],
  ];

  it.effect.each(stillPrompts)(
    "still prompts with auto-approval enabled for a %s request",
    ([name, permissions, kind, expectedPrompt]) =>
      Effect.gen(function* () {
        const result = yield* runPermissionsScenario({
          name: `escalating-${name}`,
          settings: AUTO_APPROVE_CODEX_SETTINGS,
          permissions,
          decision: "decline",
          expectedResponse: { permissions: {}, scope: "turn" },
        });
        assert.lengthOf(result.runtimeRequests(), 1);
        assert.equal(result.runtimeRequests()[0]!.kind, kind);
        assert.notEqual(result.runtimeRequests()[0]!.kind, "command");
        assert.equal(result.approvalItems()[0]?.prompt, expectedPrompt);
      }),
  );
});

describe("CodexAdapterV2 permission escalations: prompt text", () => {
  it.effect("names the requested paths, network access and reason", () =>
    Effect.gen(function* () {
      const result = yield* runPermissionsScenario({
        name: "prompt-text",
        settings: DEFAULT_CODEX_SETTINGS,
        permissions: {
          fileSystem: { entries: [writeEntry("/workspace/out")] },
          network: { enabled: true },
        },
        reason: "Build and publish the report.",
        decision: "decline",
        expectedResponse: { permissions: {}, scope: "turn" },
      });
      assert.equal(result.runtimeRequests()[0]!.kind, "file-change");
      assert.equal(
        result.approvalItems()[0]?.prompt,
        "write: /workspace/out; network access — Build and publish the report.",
      );
    }),
  );

  it.effect("labels a read-only prompt as a file read and names the paths", () =>
    Effect.gen(function* () {
      const result = yield* runPermissionsScenario({
        name: "prompt-read",
        settings: DEFAULT_CODEX_SETTINGS,
        permissions: READ_ENTRIES,
        reason: "Need the docs.",
        decision: "decline",
        expectedResponse: { permissions: {}, scope: "turn" },
      });
      assert.equal(result.runtimeRequests()[0]!.kind, "file-read");
      assert.equal(
        result.approvalItems()[0]?.prompt,
        "read: /workspace/docs, /workspace/notes.md — Need the docs.",
      );
    }),
  );
});

describe("CodexAdapterV2 permission escalations: decisions", () => {
  const permissions: PermissionProfile = {
    fileSystem: { entries: [writeEntry("/workspace/out")] },
    network: { enabled: true },
  };
  const cases: ReadonlyArray<readonly [ProviderApprovalDecision, unknown]> = [
    ["accept", { permissions, scope: "turn" }],
    ["acceptForSession", { permissions, scope: "session" }],
    ["decline", { permissions: {}, scope: "turn" }],
  ];

  it.effect.each(cases)("answers %s with the matching grant", ([decision, expectedResponse]) =>
    Effect.gen(function* () {
      const result = yield* runPermissionsScenario({
        name: `decision-${decision}`,
        settings: DEFAULT_CODEX_SETTINGS,
        permissions,
        decision,
        expectedResponse,
      });
      assert.lengthOf(result.runtimeRequests(), 1);
    }),
  );
});
