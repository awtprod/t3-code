import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  Automation,
  CAPABILITY_NAMES,
  Connection,
  ItemId,
  Space,
  SpaceId,
} from "@command-center/core";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  AutomationRuns,
  layer as automationRunsLayer,
  makeGoogleDraftExecutors,
} from "./AutomationRuns.ts";
import { CommandCenterConfig, type LoadedCommandCenterConfig } from "./Config.ts";
import * as ConnectionHealth from "./ConnectionHealth.ts";
import { layer as eventStreamLayer } from "./EventStream.ts";
import { GoogleReadConnectorError, type GoogleReadConnectorShape } from "./GoogleReadConnector.ts";
import * as InboxGmailDrafts from "./InboxGmailDrafts.ts";
import { CommandCenterService, layer as serviceLayer } from "./Service.ts";
import { withAutomationInvariants } from "./automationTestInvariants.ts";
import { makeSafeAutomationNodeExecutor } from "./automation/NodeExecutor.ts";
import { layer as runtimeLayer } from "./automation/Runtime.ts";

// End-to-end coverage of the Inbox Gmail draft path through the real
// AutomationRuns approval flow, durable runtime, safe node executor and
// production draft executor. Only the Google connector is fake: it records
// every call and has no way to send mail.

const now = "2026-09-28T00:00:00.000Z";
const commitSha = "1234567890abcdef1234567890abcdef12345678";
const definitionDigest = `sha256:${"b".repeat(64)}`;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const spaceId = SpaceId.make("space-a");
const itemId = ItemId.make("item-a");

const space = Schema.decodeUnknownSync(Space)({
  id: spaceId,
  slug: "space-a",
  displayName: "Space A",
  kind: "business",
  instructions: "Use only the selected Space.",
  policy: { allowedCapabilities: CAPABILITY_NAMES, autoRunRiskLevels: ["low", "reversible"] },
  connectionIds: ["google-a"],
  repositories: [],
  aliases: [],
  lifecycle: "active",
  createdAt: now,
  updatedAt: now,
});

const draftTemplate = Schema.decodeUnknownSync(Automation)({
  id: "inbox-gmail-draft",
  spaceId,
  name: "Inbox Gmail draft",
  version: 1,
  enabled: true,
  trigger: { type: "manual" },
  nodes: [
    {
      id: "approve",
      kind: "approval",
      config: { approvalKey: "inbox-gmail-draft" },
      position: { x: 0, y: 0 },
    },
    {
      id: "draft",
      kind: "connector.write",
      config: { operation: "gmail.draft.create", source: "inbox.accepted" },
      position: { x: 200, y: 0 },
    },
  ],
  edges: [{ id: "approve-draft", sourceNodeId: "approve", targetNodeId: "draft" }],
  definitionDigest,
  configCommit: commitSha,
  createdAt: now,
  updatedAt: now,
});

interface FakeState {
  accountAlias: string;
  /** After this many account resolutions, resolve a different account. */
  switchAccountAfter: number | null;
  resolutions: number;
  failNextCreate: boolean;
  hangNextCreate: boolean;
  /** Released by the test to let a hung Gmail call finish. */
  readonly hangGate: Deferred.Deferred<void>;
  readonly calls: Array<{
    readonly method: string;
    readonly request: unknown;
    readonly expectedAccountAlias: string | undefined;
  }>;
}

const makeFake = (state: FakeState): GoogleReadConnectorShape => {
  const refuse = (method: string) => () => {
    state.calls.push({ method, request: null, expectedAccountAlias: undefined });
    return Effect.die(`${method} must not be called by the Inbox draft path`);
  };
  const createDraft: NonNullable<GoogleReadConnectorShape["createDraft"]> = (
    request,
    _attachments,
    expectedAccountAlias,
  ) => {
    state.calls.push({ method: "createDraft", request, expectedAccountAlias });
    if (state.hangNextCreate) {
      state.hangNextCreate = false;
      return Deferred.await(state.hangGate).pipe(
        Effect.as({
          operation: "gmail.draft.create" as const,
          draftId: "draft-late",
          messageId: "message-late",
        }),
      );
    }
    if (state.failNextCreate) {
      state.failNextCreate = false;
      return Effect.fail(
        new GoogleReadConnectorError({ reason: "process", message: "connection reset" }),
      );
    }
    return Effect.succeed({
      operation: "gmail.draft.create" as const,
      draftId: `draft-${state.calls.length}`,
      messageId: "message-1",
    });
  };
  return {
    verify: refuse("verify"),
    read: refuse("read"),
    exportDrive: refuse("exportDrive"),
    discardExport: refuse("discardExport"),
    createDraft,
  } as unknown as GoogleReadConnectorShape;
};

const unused = (name: string) => () => Effect.die(`${name} is not used by the Inbox draft path`);

function testLayer(state: FakeState, clock: "frozen" | "live" = "frozen") {
  const config = (): LoadedCommandCenterConfig => ({
    spaces: [space],
    connections: [
      Schema.decodeUnknownSync(Connection)({
        id: "google-a",
        spaceId,
        kind: "google",
        label: "Synthetic Gmail",
        capabilities: ["cc.connections.google.gmail.drafts.create"],
        health: "connected",
      }),
    ],
    automations: [draftTemplate],
    timezone: "Etc/UTC",
    routing: {
      mode: "auto",
      showPreview: true,
      explicitSelectionWins: true,
      providerFallback: "first-healthy-compatible",
    },
    health: { status: "loaded", configDirectory: "test-config" },
  });
  const configLayer = Layer.succeed(
    CommandCenterConfig,
    CommandCenterConfig.of({
      configDirectory: "test-config",
      load: Effect.sync(config),
      resolveGoogleAccount: () =>
        Effect.sync(() => {
          state.resolutions += 1;
          const accountAlias =
            state.switchAccountAfter !== null && state.resolutions > state.switchAccountAfter
              ? "someone-else@example.com"
              : state.accountAlias;
          return { accountAlias, label: accountAlias };
        }),
    }),
  );
  const commandCenterLayer = serviceLayer.pipe(
    Layer.provide(configLayer),
    Layer.provide(ConnectionHealth.layer),
  );
  let nextRuntimeId = 0;
  const durableRuntimeLayer = Layer.unwrap(
    Effect.gen(function* () {
      const { executeInboxDraft } = makeGoogleDraftExecutors({
        commandCenter: yield* CommandCenterService,
        inboxDrafts: yield* InboxGmailDrafts.InboxGmailDrafts,
        google: makeFake(state),
        path: yield* Path.Path,
        attachmentsDir: "/nonexistent/attachments",
      });
      return runtimeLayer({
        executeNode: makeSafeAutomationNodeExecutor({
          executeInboxDraft,
          startAgentRun: unused("startAgentRun"),
          createItem: unused("createItem"),
          googleRead: unused("googleRead"),
          runScopedShell: unused("runScopedShell"),
          evaluateProspects: unused("evaluateProspects"),
        }),
        now:
          clock === "live"
            ? DateTime.now.pipe(Effect.map(DateTime.formatIso))
            : Effect.succeed(now),
        randomUUID: Effect.sync(() => `execution-${++nextRuntimeId}`),
        defaultMaxAttempts: 3,
      });
    }),
  );
  return automationRunsLayer.pipe(
    Layer.provideMerge(durableRuntimeLayer),
    Layer.provideMerge(InboxGmailDrafts.layer),
    Layer.provideMerge(Layer.mergeAll(commandCenterLayer, eventStreamLayer)),
    Layer.provideMerge(configLayer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );
}

const approvedRequest = {
  spaceId,
  connectionId: "google-a",
  operation: "gmail.draft.create",
  to: ["recipient@example.com"],
  subject: "Exact draft",
  body: "Exact body",
} as const;

const seedItem = (id: ItemId, revisionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO command_center_items (
        id, space_id, kind, status, title, body, priority,
        source_json, links_json, metadata_json, created_at, updated_at
      ) VALUES (
        ${id}, ${spaceId}, 'decision', 'review', 'Review response', 'Source text', 'high',
        '{"kind":"user","capturedAt":"2026-09-28T00:00:00.000Z"}', '[]', '{}', ${now}, ${now}
      )
    `;
    yield* sql`
      INSERT INTO command_center_inbox_revisions (
        id, item_id, revision, status, source, payload_json, preview_json, evidence_json,
        actor_subject, created_at, accepted_at, accepted_by_subject
      ) VALUES (${revisionId}, ${id}, 1, 'current', 'direct', ${encodeJson({
        kind: "prepared-action",
        actionKind: "gmail.draft.create",
        target: { kind: "command-center-item", id },
        parameters: approvedRequest,
      })},
        '{"summary":"Exact draft","before":"No draft","after":"A Gmail draft"}',
        ${encodeJson({ source: "command-center-item", subjectId: id, version: now })},
        'andrew', ${now}, ${now}, 'andrew')
    `;
    yield* sql`
      UPDATE command_center_inbox_state
      SET current_revision_id = ${revisionId}, version = 1
      WHERE item_id = ${id}
    `;
  });

const seed = Effect.gen(function* () {
  // Load config so the Space is projected before the Item references it.
  yield* (yield* CommandCenterService).queryConnections({ spaceId });
  yield* seedItem(itemId, "revision-a");
});

const approval = (mutationId = "approve-a") =>
  ({ spaceId, itemId, mutationId, revisionId: "revision-a", expectedVersion: 1 }) as const;

const freshState = (): FakeState => ({
  accountAlias: "approved@example.com",
  switchAccountAfter: null,
  resolutions: 0,
  failNextCreate: false,
  hangNextCreate: false,
  hangGate: Deferred.makeUnsafe<void>(),
  calls: [],
});

const countGmailReceipts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM command_center_inbox_gmail_drafts
  `;
  return Number(rows[0]?.count ?? 0);
});

/**
 * Registers a scenario with fresh fake state twice: with frozen fixture time
 * and with the real advancing clock used in production, where repeated audit
 * writes of one transition are no longer byte-identical by accident.
 */
const bothClocks = <E>(
  name: string,
  body: (
    state: FakeState,
    layer: (state: FakeState) => ReturnType<typeof testLayer>,
  ) => Effect.Effect<void, E, never>,
) => {
  it.effect(name, () => body(freshState(), (state) => withAutomationInvariants(testLayer(state))));
  it.live(`${name} (real advancing clock)`, () =>
    body(freshState(), (state) => withAutomationInvariants(testLayer(state, "live"))),
  );
};

bothClocks(
  "creates exactly one draft with the approved content and account under concurrent and repeated approval",
  (state, layer) =>
    Effect.gen(function* () {
      yield* seed;
      const runs = yield* AutomationRuns;
      // Three clicks race the first approval through the runtime and audit.
      const racing = yield* Effect.all(
        [1, 2, 3].map(() =>
          runs.approveInboxDraft(approval(), "andrew").pipe(
            Effect.match({
              onFailure: (error) => ({ ok: false as const, error }),
              onSuccess: (value) => ({ ok: true as const, value }),
            }),
          ),
        ),
        { concurrency: "unbounded" },
      );
      const succeeded = racing.flatMap((result) => (result.ok ? [result.value] : []));
      expect(succeeded.length).toBeGreaterThan(0);
      for (const result of racing) {
        // A losing click may only be refused as already in progress, never by
        // a persistence (audit) failure.
        if (!result.ok) expect(result.error.reason).toBe("conflict");
      }
      // A click that joins an approval another click is completing may see
      // the receipt before the draft exists; none may see a second draft.
      for (const receipt of succeeded) {
        expect(["approved", "creating", "created"]).toContain(receipt.status);
      }
      expect(succeeded.some((receipt) => receipt.status === "created")).toBe(true);

      // Later sequential replays return the same draft.
      for (const _ of [1, 2]) {
        const replay = yield* runs.approveInboxDraft(approval(), "andrew");
        expect(replay).toMatchObject({ status: "created", draftId: "draft-1" });
      }

      expect(state.calls.map((call) => call.method)).toEqual(["createDraft"]);
      expect(state.calls[0]!.request).toMatchObject(approvedRequest);
      expect(state.calls[0]!.expectedAccountAlias).toBe("approved@example.com");
      expect(yield* countGmailReceipts).toBe(1);
    }).pipe(Effect.provide(layer(state))),
);

bothClocks("never retries an uncertain draft, even when approval is repeated", (state, layer) =>
  Effect.gen(function* () {
    yield* seed;
    state.failNextCreate = true;
    const runs = yield* AutomationRuns;
    const first = yield* Effect.exit(runs.approveInboxDraft(approval(), "andrew"));
    const receipt = yield* runs.getInboxDraftReceipt({ spaceId, itemId });
    expect(receipt?.status).toBe("uncertain");
    // The runtime allows retries (defaultMaxAttempts: 3), so a single call
    // proves the executor, not the attempt budget, stops a second draft.
    const again = yield* Effect.exit(runs.approveInboxDraft(approval(), "andrew"));
    expect(state.calls.map((call) => call.method)).toEqual(["createDraft"]);
    expect((yield* runs.getInboxDraftReceipt({ spaceId, itemId }))?.status).toBe("uncertain");
    // Both calls report the durable uncertain receipt instead of retrying.
    for (const exit of [first, again]) {
      expect(exit._tag).toBe("Success");
      if (exit._tag === "Success") expect(exit.value.status).toBe("uncertain");
    }
  }).pipe(Effect.provide(layer(state))),
);

bothClocks("refuses a draft whose accepted content no longer matches the Item", (state, layer) =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE command_center_items SET body = 'Edited after acceptance',
        updated_at = '2026-09-28T01:00:00.000Z'
      WHERE id = ${itemId}
    `;
    const runs = yield* AutomationRuns;
    const refused = yield* Effect.flip(runs.approveInboxDraft(approval(), "andrew"));
    expect(refused.reason).toBe("conflict");
    expect(state.calls).toEqual([]);
    expect(yield* countGmailReceipts).toBe(0);
  }).pipe(Effect.provide(layer(state))),
);

bothClocks("refuses a draft when the Google account changes after approval", (state, layer) =>
  Effect.gen(function* () {
    yield* seed;
    // The approval binds the account on the first resolution; every later
    // resolution (execution) sees a different account.
    state.switchAccountAfter = 1;
    const runs = yield* AutomationRuns;
    const refused = yield* Effect.flip(runs.approveInboxDraft(approval(), "andrew"));
    expect(refused.reason).toBe("conflict");
    expect(state.calls).toEqual([]);
    expect((yield* runs.getInboxDraftReceipt({ spaceId, itemId }))?.status).not.toBe("created");
  }).pipe(Effect.provide(layer(state))),
);

/**
 * Models process loss after the Gmail call but before the runtime recorded the
 * draft node's outcome: the execution and its draft checkpoint are left
 * running with no live lease, exactly as a dead worker leaves them.
 */
const crashBeforeDraftCheckpoint = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly id: string }>`
    SELECT id FROM command_center_automation_executions
    WHERE idempotency_key = ${`inbox-gmail-draft:${approval().mutationId}`}
  `;
  const executionId = rows[0]!.id;
  yield* sql`
    UPDATE command_center_automation_executions
    SET state = 'running', lease_owner = NULL, lease_token = NULL, lease_acquired_at = NULL,
      lease_expires_at = NULL, output_json = NULL, error = NULL, finished_at = NULL
    WHERE id = ${executionId}
  `;
  yield* sql`
    UPDATE command_center_automation_node_checkpoints
    SET state = 'running', output_json = NULL, error = NULL, finished_at = NULL
    WHERE execution_id = ${executionId} AND node_id = 'draft'
  `;
  // The canonical Run still shows the last state recorded before the crash.
  yield* sql`UPDATE command_center_runs SET state = 'running', finished_at = NULL WHERE id = ${executionId}`;
  return executionId;
});

bothClocks(
  "restart recovery after a created draft re-runs the node without a second draft",
  (state, layer) =>
    Effect.gen(function* () {
      yield* seed;
      const runs = yield* AutomationRuns;
      const created = yield* runs.approveInboxDraft(approval(), "andrew");
      expect(created.status).toBe("created");
      const executionId = yield* crashBeforeDraftCheckpoint;

      const report = yield* runs.recoverDue({ owner: "restarted-worker" });
      expect(report).toMatchObject({ recovered: 1, failures: [] });
      expect((yield* runs.get({ executionId, spaceId })).state).toBe("succeeded");
      expect(state.calls.map((call) => call.method)).toEqual(["createDraft"]);
      const receipt = yield* runs.getInboxDraftReceipt({ spaceId, itemId });
      expect(receipt).toMatchObject({ status: "created", draftId: created.draftId });
      expect(yield* countGmailReceipts).toBe(1);
    }).pipe(Effect.provide(layer(state))),
);

/** Waits, bounded, until the fake connector has been called; fails with the fiber's exit otherwise. */
const awaitGmailCall = <A, E>(state: FakeState, fiber: Fiber.Fiber<A, E>) =>
  Effect.gen(function* () {
    for (let spin = 0; spin < 10_000; spin++) {
      if (state.calls.length > 0) return;
      const exited = fiber.pollUnsafe();
      if (exited !== undefined) {
        return yield* Effect.die(new Error(`approval ended before Gmail: ${String(exited)}`));
      }
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(new Error("approval never reached Gmail"));
  });

bothClocks(
  "an approval abandoned during the Gmail call, then a worker crash, never drafts twice",
  (state, layer) =>
    Effect.gen(function* () {
      yield* seed;
      state.hangNextCreate = true;
      const runs = yield* AutomationRuns;
      // Gmail is slow to answer and the approving request is abandoned (client
      // gone). The drive is detached from the request, so the call continues.
      const inFlight = yield* runs.approveInboxDraft(approval(), "andrew").pipe(Effect.forkChild);
      yield* awaitGmailCall(state, inFlight);
      yield* Fiber.interrupt(inFlight);
      expect((yield* runs.getInboxDraftReceipt({ spaceId, itemId }))?.status).toBe("creating");

      // Repeated clicks: refused as in progress, never an audit conflict.
      const again = yield* Effect.flip(runs.approveInboxDraft(approval(), "andrew"));
      expect(again.reason).toBe("conflict");
      expect(again.message).not.toContain("already bound to different content");

      // The worker then dies mid-call; after restart, recovery re-runs the
      // draft node, which refuses the claimed receipt instead of calling Gmail.
      const executionId = yield* crashBeforeDraftCheckpoint;
      const report = yield* runs.recoverDue({ owner: "restarted-worker" });
      expect(report).toMatchObject({ recovered: 1, failures: [] });
      expect(state.calls.map((call) => call.method)).toEqual(["createDraft"]);
      const recovered = yield* runs.get({ executionId, spaceId });
      expect(["waiting_retry", "failed"]).toContain(recovered.state);
      expect((yield* runs.getInboxDraftReceipt({ spaceId, itemId }))?.status).toBe("creating");

      // The first call finally answers: the stale worker's runtime commit is
      // fenced, but the receipt records the draft that really exists.
      yield* Deferred.succeed(state.hangGate, undefined);
      for (let spin = 0; spin < 2_000; spin++) yield* Effect.yieldNow;
      expect(state.calls.map((call) => call.method)).toEqual(["createDraft"]);
      expect(yield* countGmailReceipts).toBe(1);
      const receipt = yield* runs.getInboxDraftReceipt({ spaceId, itemId });
      expect(receipt).toMatchObject({ status: "created", draftId: "draft-late" });
    }).pipe(Effect.provide(layer(state))),
);

bothClocks(
  "a second draft is refused, not absorbed, while another draft's run is active",
  (state, layer) =>
    Effect.gen(function* () {
      yield* seed;
      const otherItem = ItemId.make("item-b");
      yield* seedItem(otherItem, "revision-b");
      state.hangNextCreate = true;
      const runs = yield* AutomationRuns;
      // Draft A's run is active, its Gmail call still in flight.
      const first = yield* runs.approveInboxDraft(approval(), "andrew").pipe(Effect.forkChild);
      yield* awaitGmailCall(state, first);

      // Approving draft B must not coalesce onto A's run or decide A's gate.
      const draftB = {
        spaceId,
        itemId: otherItem,
        mutationId: "approve-b",
        revisionId: "revision-b",
        expectedVersion: 1,
      } as const;
      const refused = yield* Effect.flip(runs.approveInboxDraft(draftB, "andrew"));
      expect(refused.reason).toBe("conflict");
      expect(refused.message).toMatch(/Another Inbox Gmail draft/u);
      expect(yield* runs.getInboxDraftReceipt({ spaceId, itemId: otherItem })).toBeNull();
      expect(state.calls).toHaveLength(1);

      // Once A finishes, B gets its own run and its own single draft.
      yield* Deferred.succeed(state.hangGate, undefined);
      expect((yield* Fiber.join(first)).status).toBe("created");
      const second = yield* runs.approveInboxDraft(draftB, "andrew");
      expect(second.status).toBe("created");
      expect(state.calls).toHaveLength(2);
    }).pipe(Effect.provide(layer(state))),
);
