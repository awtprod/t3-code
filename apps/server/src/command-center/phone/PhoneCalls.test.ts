// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - signs raw webhook bodies with node:crypto.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ItemId, SpaceId } from "@command-center/core";
import type { CommandCenterError } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as CommandCenterInbox from "../Inbox.ts";
import { CommandCenterService, type CommandCenterServiceShape } from "../Service.ts";
import * as SpaceActivity from "../SpaceActivity.ts";
import { pendingSpaceAgentReplies } from "../SpaceAgentReplies.ts";
import {
  ElevenLabsCallError,
  ElevenLabsClient,
  type OutboundCallRequest,
} from "./ElevenLabsClient.ts";
import * as PhoneConnection from "./PhoneConnection.ts";
import * as PhoneCallProposals from "./PhoneCallProposals.ts";
import * as PhoneCalls from "./PhoneCalls.ts";
import * as PhoneWebhook from "./PhoneWebhook.ts";

const SPACE = "acme";
const THREAD = "cc-space-agent-acme";
const connection = {
  apiKey: "xi_test_api_key_0123456789", // gitleaks:allow (test fixture)
  webhookSecret: "wsec_test_0123456789abcdef", // gitleaks:allow (test fixture)
  agentId: "agent_third_party",
  ownerAgentId: "agent_owner",
  phoneNumberId: "phnum_acme",
  ownerNumber: "+15550100000",
  ownerName: "Andrew",
};
const encoder = new TextEncoder();
const epoch = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));
/** 14:00 in New York: outside the 23:00-07:00 quiet hours. */
const DAYTIME = "2026-10-17T18:00:00.000Z";
/** 01:00 in New York: inside quiet hours. */
const NIGHT = "2026-10-18T05:00:00.000Z";

interface Harness {
  readonly dialed: Array<OutboundCallRequest>;
  /** Every request the fake ElevenLabs client received, including failed ones. */
  readonly requested: Array<OutboundCallRequest>;
  /** Next outcomes of the fake ElevenLabs client; empty means "succeed". */
  readonly failures: Array<ElevenLabsCallError>;
  /** Effects the next requests wait on before answering, to hold a dial in flight. */
  readonly holds: Array<Effect.Effect<void>>;
  /** The live Space config `getConfiguredSpace` returns; tests may edit it. */
  readonly space: { enabled: boolean; capabilities: Array<string> };
}

const makeLayer = (options: { readonly configured?: boolean } = {}) => {
  const harness: Harness = {
    dialed: [],
    requested: [],
    failures: [],
    holds: [],
    space: { enabled: true, capabilities: ["cc.phone.call-owner", "cc.phone.call"] },
  };
  const secrets = new Map<string, Uint8Array>(
    options.configured === false
      ? []
      : [
          [
            PhoneConnection.PHONE_CONNECTION_SECRET_NAME,
            encoder.encode(JSON.stringify(connection)),
          ],
        ],
  );
  const secretStore = Layer.succeed(
    ServerSecretStore,
    ServerSecretStore.of({
      get: (name) => Effect.sync(() => Option.fromNullishOr(secrets.get(name))),
      set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
      create: (name, value) => Effect.sync(() => void secrets.set(name, value)),
      getOrCreateRandom: () => Effect.die("unused"),
      remove: (name) => Effect.sync(() => void secrets.delete(name)),
    }),
  );
  const client = Layer.succeed(
    ElevenLabsClient,
    ElevenLabsClient.of({
      startOutboundCall: (request) =>
        Effect.gen(function* () {
          harness.requested.push(request);
          const hold = harness.holds.shift();
          if (hold !== undefined) yield* hold;
          const failure = harness.failures.shift();
          if (failure !== undefined) return yield* failure;
          harness.dialed.push(request);
          return { conversationId: `conv_${harness.dialed.length}` };
        }),
    }),
  );
  // The Service methods the phone module uses, backed by the same SQLite rows.
  const service = Layer.effect(
    CommandCenterService,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return {
        getConfiguredSpace: (spaceId: string) =>
          Effect.sync(() => ({
            id: spaceId,
            policy: { allowedCapabilities: [...harness.space.capabilities] },
            agent: {
              enabled: harness.space.enabled,
              quietHours: { start: "23:00", end: "07:00", timezone: "America/New_York" },
              dailyWakeLimit: 8,
              debounceMinutes: 10,
            },
          })),
        createItem: (
          input: {
            requestId: string;
            spaceId: string;
            kind: string;
            priority: string;
            title: string;
            description?: string;
          },
          actor?: { readonly threadId: string },
        ) =>
          Effect.gen(function* () {
            const now = DateTime.formatIso(yield* DateTime.now);
            const existing = yield* sql<{ readonly updatedAt: string }>`
              SELECT updated_at AS "updatedAt" FROM command_center_items WHERE id = ${input.requestId}
            `;
            if (existing[0] === undefined) {
              yield* sql`
                INSERT INTO command_center_items (
                  id, space_id, kind, status, title, body, priority,
                  source_json, links_json, metadata_json, created_at, updated_at
                ) VALUES (
                  ${input.requestId}, ${input.spaceId}, ${input.kind}, 'captured', ${input.title},
                  ${input.description ?? null}, ${input.priority},
                  ${JSON.stringify({ kind: "agent", sourceRef: actor?.threadId, capturedAt: now })},
                  '[]', ${JSON.stringify(actor === undefined ? {} : { spaceAgent: true, threadId: actor.threadId })},
                  ${now}, ${now}
                )
              `;
            }
            return { id: input.requestId, updatedAt: existing[0]?.updatedAt ?? now };
          }).pipe(Effect.orDie),
      } as unknown as CommandCenterServiceShape;
    }),
  );
  const layer = PhoneCallProposals.layer.pipe(
    Layer.provideMerge(PhoneCalls.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        PhoneConnection.layer,
        CommandCenterInbox.layer,
        SpaceActivity.layer,
        client,
        service,
      ),
    ),
    Layer.provideMerge(secretStore),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );
  return { harness, layer };
};

const seedSpace = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO command_center_spaces (id, slug, name, kind, created_at, updated_at)
    VALUES (${SPACE}, ${SPACE}, 'Acme', 'business', ${DAYTIME}, ${DAYTIME})
  `;
});

const phoneRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly sourceId: string;
    readonly title: string;
    readonly status: string;
    readonly summary: string;
    readonly url: string | null;
    readonly eventSequence: number;
  }>`
    SELECT source_id AS "sourceId", title, status, summary, url, event_sequence AS "eventSequence"
    FROM command_center_space_activity WHERE space_id = ${SPACE} ORDER BY id ASC
  `;
});

const plan = {
  spaceId: SpaceId.make(SPACE),
  to: "+15550100123",
  calleeName: "Acme Dental",
  purpose: "Move Tuesday's cleaning to Thursday",
  brief: "Andrew has a cleaning on Tuesday at 10am and needs Thursday morning instead.",
  allowedOutcomes: ["Thursday before noon", "keep Tuesday"],
  patchInWhen: "they need Andrew to confirm insurance details",
};

const timeoutError = () =>
  new ElevenLabsCallError({
    reason: "timeout",
    message: "ElevenLabs did not answer within 15 s.",
  });

/** Holds the next dial in flight: `dialing` resolves when it starts, `release` lets it finish. */
const holdNextDial = (harness: Harness) =>
  Effect.gen(function* () {
    const dialing = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    harness.holds.push(
      Deferred.succeed(dialing, undefined).pipe(Effect.andThen(Deferred.await(release))),
    );
    return { dialing, release };
  });

const ownerCall = (question?: string) => ({
  spaceId: SpaceId.make(SPACE),
  purpose: "Vendor switch",
  brief: "Acme Supply raised prices 20%; Example Parts quotes 10% lower.",
  ...(question === undefined ? {} : { question }),
});

describe("PhoneCalls", () => {
  it.effect("rings Andrew on the owner agent and records a masked activity row", () => {
    const { harness, layer } = makeLayer();
    return Effect.gen(function* () {
      yield* TestClock.setTime(epoch(DAYTIME));
      yield* seedSpace;
      const calls = yield* PhoneCalls.PhoneCalls;
      const outcome = yield* calls.callOwner(ownerCall("Switch to Example Parts?"));
      expect(outcome).toEqual({ placed: true, conversationId: "conv_1" });
      expect(harness.dialed).toEqual([
        {
          apiKey: connection.apiKey,
          agentId: "agent_owner",
          agentPhoneNumberId: "phnum_acme",
          to: "+15550100000",
          dynamicVariables: {
            purpose: "Vendor switch",
            brief: "Acme Supply raised prices 20%; Example Parts quotes 10% lower.",
            allowed_outcomes: "yes; no; unclear",
            owner_name: "Andrew",
            callee_name: "Andrew",
            patch_in_when: "",
            call_kind: "owner",
            question: "Switch to Example Parts?",
          },
        },
      ]);
      const rows = yield* phoneRows;
      expect(rows).toEqual([
        {
          sourceId: "phone-start:conv_1",
          title: "Phone: calling Andrew (…0000) — Vendor switch",
          status: "asking-owner",
          summary: "Switch to Example Parts?",
          url: null,
          eventSequence: SpaceActivity.SPACE_ACTIVITY_EXTERNAL_EVENT_SEQUENCE,
        },
      ]);
      expect(JSON.stringify(rows)).not.toContain("+15550100000");
      // Phone rows never move the activity reactor's resume cursor.
      const activity = yield* SpaceActivity.SpaceActivity;
      expect(yield* activity.latestEventSequence("run")).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses to call Andrew during quiet hours without dialing", () => {
    const { harness, layer } = makeLayer();
    return Effect.gen(function* () {
      yield* TestClock.setTime(epoch(NIGHT));
      yield* seedSpace;
      const calls = yield* PhoneCalls.PhoneCalls;
      const outcome = yield* calls.callOwner(ownerCall());
      expect(outcome.placed).toBe(false);
      expect(outcome.reason).toMatch(/quiet hours/u);
      expect(harness.dialed).toEqual([]);
      expect(yield* phoneRows).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("stops at 3 owner calls and 5 third-party calls per Space per day", () => {
    const { harness, layer } = makeLayer();
    return Effect.gen(function* () {
      yield* TestClock.setTime(epoch(DAYTIME));
      yield* seedSpace;
      const calls = yield* PhoneCalls.PhoneCalls;
      for (let index = 0; index < 3; index += 1) {
        expect((yield* calls.callOwner(ownerCall())).placed).toBe(true);
      }
      const fourth = yield* calls.callOwner(ownerCall());
      expect(fourth.placed).toBe(false);
      expect(fourth.reason).toMatch(/limit 3/u);
      for (let index = 0; index < 5; index += 1) {
        expect((yield* calls.callThirdParty(plan)).placed).toBe(true);
      }
      expect((yield* calls.callThirdParty(plan)).reason).toMatch(/limit 5/u);
      expect(harness.dialed).toHaveLength(8);
      // The next local day starts a fresh count (07:00 New York, after quiet hours).
      yield* TestClock.setTime(epoch("2026-10-18T11:00:00.000Z"));
      expect((yield* calls.callOwner(ownerCall())).placed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("leaves no row and no count behind when the call fails to start", () => {
    const { harness, layer } = makeLayer();
    return Effect.gen(function* () {
      yield* TestClock.setTime(epoch(DAYTIME));
      yield* seedSpace;
      const calls = yield* PhoneCalls.PhoneCalls;
      for (let index = 0; index < 3; index += 1) {
        harness.failures.push(
          new ElevenLabsCallError({
            reason: "http",
            status: 429,
            message: "ElevenLabs refused the call (HTTP 429).",
            body: "rate limited",
          }),
        );
        const error = yield* Effect.flip(calls.callOwner(ownerCall()));
        expect(error.reason).toBe("connector");
        expect(error.message).toContain("HTTP 429");
        expect(PhoneCalls.phoneCallMayBeLive(error)).toBe(false);
      }
      expect(yield* phoneRows).toEqual([]);
      expect((yield* calls.callOwner(ownerCall())).placed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("records an unconfirmed call as outcome unknown and counts it toward the cap", () => {
    const { harness, layer } = makeLayer();
    return Effect.gen(function* () {
      yield* TestClock.setTime(epoch(DAYTIME));
      yield* seedSpace;
      const calls = yield* PhoneCalls.PhoneCalls;
      expect((yield* calls.callOwner(ownerCall())).placed).toBe(true);
      harness.failures.push(
        timeoutError(),
        new ElevenLabsCallError({
          reason: "transport",
          message: "ElevenLabs could not be reached.",
        }),
      );
      for (let index = 0; index < 2; index += 1) {
        const error = yield* Effect.flip(calls.callOwner(ownerCall()));
        expect(error.reason).toBe("connector");
        expect(error.message).toMatch(/^Call outcome unknown — do not retry\./u);
        expect(error.message).toContain("It counts toward today's call limit.");
        expect(PhoneCalls.phoneCallMayBeLive(error)).toBe(true);
      }
      const rows = yield* phoneRows;
      expect(rows.map((row) => row.status)).toEqual([
        "calling-owner",
        "outcome-unknown",
        "outcome-unknown",
      ]);
      expect(rows[1]).toMatchObject({
        sourceId: expect.stringMatching(/^phone-uncertain:owner:acme:[0-9a-f-]{36}$/u),
        title: "Phone: outcome unknown Andrew (…0000) — Vendor switch",
        summary: expect.stringMatching(
          /^ElevenLabs did not answer within 15 s\. .*may be ringing; do not retry it\./u,
        ),
        eventSequence: SpaceActivity.SPACE_ACTIVITY_EXTERNAL_EVENT_SEQUENCE,
      });
      expect(rows[2]?.sourceId).not.toBe(rows[1]?.sourceId);
      // Both unconfirmed calls count like placed ones: the fourth is refused before dialing.
      const fourth = yield* calls.callOwner(ownerCall());
      expect(fourth.placed).toBe(false);
      expect(fourth.reason).toMatch(/called 3 times today .*limit 3/u);
      expect(harness.requested).toHaveLength(3);
      // Owner rows do not use up the third-party allowance.
      expect((yield* calls.callThirdParty(plan)).placed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("re-checks quiet hours under the lock for a call queued behind another", () => {
    const { harness, layer } = makeLayer();
    return Effect.gen(function* () {
      // 22:59 in New York, one minute before quiet hours.
      yield* TestClock.setTime(epoch("2026-10-18T02:59:00.000Z"));
      yield* seedSpace;
      const calls = yield* PhoneCalls.PhoneCalls;
      const { dialing, release } = yield* holdNextDial(harness);
      const first = yield* Effect.forkChild(calls.callOwner(ownerCall()));
      yield* Deferred.await(dialing);
      const queued = yield* Effect.forkChild(calls.callOwner(ownerCall()));
      // Let the queued call run up to the lock while it is still before quiet hours.
      for (let spin = 0; spin < 200; spin += 1) yield* Effect.yieldNow;
      // 23:01: quiet hours have begun by the time the lock is free.
      yield* TestClock.setTime(epoch("2026-10-18T03:01:00.000Z"));
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(first)).placed).toBe(true);
      const outcome = yield* Fiber.join(queued);
      expect(outcome.placed).toBe(false);
      expect(outcome.reason).toMatch(/quiet hours/u);
      expect(harness.requested).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("still records a call whose caller is interrupted while it dials", () => {
    const { harness, layer } = makeLayer();
    return Effect.gen(function* () {
      yield* TestClock.setTime(epoch(DAYTIME));
      yield* seedSpace;
      const calls = yield* PhoneCalls.PhoneCalls;
      const { dialing, release } = yield* holdNextDial(harness);
      const call = yield* Effect.forkChild(calls.callOwner(ownerCall()));
      yield* Deferred.await(dialing);
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(call));
      for (let spin = 0; spin < 200; spin += 1) yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(interrupting);
      expect(harness.dialed).toHaveLength(1);
      expect((yield* phoneRows).map((row) => [row.sourceId, row.status])).toEqual([
        ["phone-start:conv_1", "calling-owner"],
      ]);
    }).pipe(Effect.provide(layer));
  });

  it("uses one timezone for quiet hours and the daily cap: quiet hours, then check-ins", () => {
    const quietHours = { start: "23:00", end: "07:00", timezone: "America/Los_Angeles" };
    const checkIns = { cron: ["0 9 * * *"], timezone: "Europe/Paris" };
    expect(PhoneCalls.phoneCallTimezone({ quietHours, checkIns })).toBe("America/Los_Angeles");
    expect(PhoneCalls.phoneCallTimezone({ checkIns })).toBe("Europe/Paris");
    expect(PhoneCalls.phoneCallTimezone(undefined)).toBe("America/New_York");
  });

  it.effect("refuses when no phone connection is stored", () => {
    const { harness, layer } = makeLayer({ configured: false });
    return Effect.gen(function* () {
      yield* TestClock.setTime(epoch(DAYTIME));
      yield* seedSpace;
      const outcome = yield* (yield* PhoneCalls.PhoneCalls).callOwner(ownerCall());
      expect(outcome).toEqual({ placed: false, reason: PhoneCalls.PHONE_NOT_CONFIGURED_REASON });
      expect(harness.dialed).toEqual([]);
    }).pipe(Effect.provide(layer));
  });
});

const fileCall = (requestId = "dentist-1") =>
  Effect.gen(function* () {
    const proposals = yield* PhoneCallProposals.PhoneCallProposals;
    return yield* proposals.file({ spaceId: SPACE, threadId: THREAD, requestId, plan });
  });

const inboxVersion = (itemId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly version: number; readonly status: string | null }>`
      SELECT inbox.version, revision.status
      FROM command_center_inbox_state inbox
      LEFT JOIN command_center_inbox_revisions revision ON revision.item_id = inbox.item_id
      WHERE inbox.item_id = ${itemId}
    `.pipe(Effect.orDie);
    return rows[0]!;
  });

const accept = (
  filed: { readonly itemId: string; readonly candidateRevisionId: string },
  options: { readonly canApprove: boolean; readonly mutationId?: string },
) =>
  Effect.gen(function* () {
    const proposals = yield* PhoneCallProposals.PhoneCallProposals;
    const { version } = yield* inboxVersion(filed.itemId);
    return yield* proposals.acceptCandidate(
      {
        spaceId: SpaceId.make(SPACE),
        itemId: ItemId.make(filed.itemId),
        mutationId: options.mutationId ?? "web:accept-1",
        expectedVersion: version,
        candidateRevisionId: filed.candidateRevisionId,
      },
      { subject: "andrew", canApprove: options.canApprove },
    );
  });

describe("PhoneCallProposals", () => {
  it.effect("files a decision Item with the plan as a phone.call candidate and never dials", () => {
    const { harness, layer } = makeLayer();
    return Effect.gen(function* () {
      yield* TestClock.setTime(epoch(DAYTIME));
      yield* seedSpace;
      const filed = yield* fileCall();
      expect(filed.status).toBe("awaiting-approval");
      expect(harness.dialed).toEqual([]);
      const inbox = yield* CommandCenterInbox.CommandCenterInbox;
      const detail = yield* inbox.detail({
        spaceId: SpaceId.make(SPACE),
        itemId: ItemId.make(filed.itemId),
      });
      expect(detail.item).toMatchObject({
        kind: "decision",
        title: "Call Acme Dental: Move Tuesday's cleaning to Thursday",
        metadata: { spaceAgent: true, threadId: THREAD },
      });
      expect(
        detail.revisions
          .filter((revision) => revision.status === "candidate")
          .map((revision) => revision.payload),
      ).toEqual([
        {
          kind: "prepared-action",
          actionKind: "phone.call",
          target: { kind: "phone-number", id: "Acme Dental (…0123)" },
          parameters: plan,
        },
      ]);
      // The same request id returns the same proposal instead of a second one.
      expect(yield* fileCall()).toEqual(filed);
      const sql = yield* SqlClient.SqlClient;
      const [count] = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM command_center_inbox_revisions WHERE item_id = ${filed.itemId}
      `;
      expect(count?.n).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rolls the Item back when its candidate cannot be filed", () => {
    const { layer } = makeLayer();
    return Effect.gen(function* () {
      yield* TestClock.setTime(epoch(DAYTIME));
      yield* seedSpace;
      const first = yield* fileCall("other");
      // Bind the next proposal's candidate mutation id to another Item first.
      const sql = yield* SqlClient.SqlClient;
      const hash = NodeCrypto.createHash("sha256")
        .update(`${SPACE}\0dentist-2`)
        .digest("hex")
        .slice(0, 40);
      yield* sql`
        INSERT INTO command_center_inbox_mutation_receipts (
          mutation_id, item_id, space_id, command_kind, actor_subject,
          request_digest, receipt_json, accepted_at
        ) VALUES (
          ${`phone-call-candidate:${hash}`}, ${first.itemId}, ${SPACE}, 'cc.inbox.comment',
          'andrew', 'digest', '{"resultVersion":1}', ${DAYTIME}
        )
      `;
      const error: CommandCenterError = yield* Effect.flip(fileCall("dentist-2"));
      expect(error.reason).toBe("conflict");
      const rows = yield* sql<{ readonly id: string }>`
        SELECT id FROM command_center_items WHERE id = ${`phone-call:${hash}`}
      `;
      expect(rows).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("needs approval authority to accept, then dials the plan exactly once", () => {
    const { harness, layer } = makeLayer();
    return Effect.gen(function* () {
      yield* TestClock.setTime(epoch(DAYTIME));
      yield* seedSpace;
      const filed = yield* fileCall();

      const refused = yield* Effect.flip(accept(filed, { canApprove: false }));
      expect(refused.message).toMatch(/approval authority/u);
      expect((yield* inboxVersion(filed.itemId)).status).toBe("candidate");
      expect(harness.dialed).toEqual([]);

      const accepted = yield* accept(filed, { canApprove: true });
      expect(accepted.duplicate).toBe(false);
      expect(harness.dialed).toEqual([
        {
          apiKey: connection.apiKey,
          agentId: "agent_third_party",
          agentPhoneNumberId: "phnum_acme",
          to: "+15550100123",
          dynamicVariables: {
            purpose: plan.purpose,
            brief: plan.brief,
            allowed_outcomes: "Thursday before noon; keep Tuesday",
            owner_name: "Andrew",
            callee_name: "Acme Dental",
            patch_in_when: plan.patchInWhen,
            call_kind: "third_party",
            question: "",
          },
        },
      ]);
      // Replaying the same accept is a duplicate and never dials again.
      const proposals = yield* PhoneCallProposals.PhoneCallProposals;
      const replay = yield* proposals.acceptCandidate(
        {
          spaceId: SpaceId.make(SPACE),
          itemId: ItemId.make(filed.itemId),
          mutationId: "web:accept-1",
          expectedVersion: (yield* inboxVersion(filed.itemId)).version - 1,
          candidateRevisionId: filed.candidateRevisionId,
        },
        { subject: "andrew", canApprove: true },
      );
      expect(replay.duplicate).toBe(true);
      expect(harness.dialed).toHaveLength(1);
      expect((yield* phoneRows).map((row) => [row.sourceId, row.status])).toEqual([
        ["phone-start:conv_1", "calling-third-party"],
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not approve a call on a dismissed Item", () => {
    const { harness, layer } = makeLayer();
    return Effect.gen(function* () {
      yield* TestClock.setTime(epoch(DAYTIME));
      yield* seedSpace;
      const filed = yield* fileCall();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        UPDATE command_center_inbox_state SET lifecycle = 'dismissed' WHERE item_id = ${filed.itemId}
      `;
      const error = yield* Effect.flip(accept(filed, { canApprove: true }));
      expect(error.reason).toBe("conflict");
      expect((yield* inboxVersion(filed.itemId)).status).toBe("candidate");
      expect(harness.dialed).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("records why an approved call was not placed", () => {
    const { harness, layer } = makeLayer();
    return Effect.gen(function* () {
      yield* TestClock.setTime(epoch(DAYTIME));
      yield* seedSpace;
      const filed = yield* fileCall();
      harness.failures.push(
        new ElevenLabsCallError({
          reason: "http",
          status: 422,
          message: "ElevenLabs refused the call (HTTP 422).",
          body: "invalid to_number",
        }),
      );
      const error = yield* Effect.flip(accept(filed, { canApprove: true }));
      expect(error.reason).toBe("connector");
      expect(error.message).toContain("HTTP 422");
      expect(yield* phoneRows).toMatchObject([
        {
          sourceId: `phone-not-placed:${filed.candidateRevisionId}`,
          title: "Phone: not placed Acme Dental (…0123) — Move Tuesday's cleaning to Thursday",
          status: "not-placed",
        },
      ]);
      expect(harness.dialed).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("re-checks the live Space policy before dialing an approved call", () => {
    const { harness, layer } = makeLayer();
    return Effect.gen(function* () {
      yield* TestClock.setTime(epoch(DAYTIME));
      yield* seedSpace;
      const disabled = yield* fileCall("dentist-disabled");
      const narrowed = yield* fileCall("dentist-narrowed");
      harness.space.enabled = false;
      const first = yield* Effect.flip(accept(disabled, { canApprove: true }));
      harness.space.enabled = true;
      harness.space.capabilities = ["cc.phone.call-owner"];
      const second = yield* Effect.flip(
        accept(narrowed, { canApprove: true, mutationId: "web:accept-2" }),
      );
      for (const error of [first, second]) {
        expect(error.reason).toBe("conflict");
        expect(error.message).toMatch(/not placed: policy: /u);
      }
      expect((yield* phoneRows).map((row) => [row.sourceId, row.status])).toEqual([
        [`phone-not-placed:${disabled.candidateRevisionId}`, "not-placed"],
        [`phone-not-placed:${narrowed.candidateRevisionId}`, "not-placed"],
      ]);
      expect(harness.requested).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a phone.call candidate the Space agent did not file", () => {
    const { harness, layer } = makeLayer();
    return Effect.gen(function* () {
      yield* TestClock.setTime(epoch(DAYTIME));
      yield* seedSpace;
      const filed = yield* fileCall();
      // An operate session adds its own call plan to the Space agent's Item.
      const inbox = yield* CommandCenterInbox.CommandCenterInbox;
      const sql = yield* SqlClient.SqlClient;
      const [item] = yield* sql<{ readonly updatedAt: string }>`
        SELECT updated_at AS "updatedAt" FROM command_center_items WHERE id = ${filed.itemId}
      `;
      const forged = { ...plan, to: "+15550100999", calleeName: "Someone Else" };
      const target = PhoneCalls.phoneCallTarget(forged);
      yield* inbox.createCandidate(
        {
          spaceId: SpaceId.make(SPACE),
          itemId: ItemId.make(filed.itemId),
          mutationId: "web:forged-candidate",
          expectedVersion: (yield* inboxVersion(filed.itemId)).version,
          source: "direct",
          payload: {
            kind: "prepared-action",
            actionKind: "phone.call",
            target,
            parameters: { ...forged, allowedOutcomes: [...forged.allowedOutcomes] },
          },
          preview: { summary: `Call ${target.id}`, after: "Call them." },
          evidence: {
            source: "command-center-item",
            subjectId: filed.itemId,
            version: item!.updatedAt,
          },
        },
        { subject: "operator" },
      );
      const [revision] = yield* sql<{ readonly id: string }>`
        SELECT id FROM command_center_inbox_revisions
        WHERE item_id = ${filed.itemId} AND actor_subject = 'operator'
      `;
      const error = yield* Effect.flip(
        accept(
          { itemId: filed.itemId, candidateRevisionId: revision!.id },
          { canApprove: true, mutationId: "web:accept-forged" },
        ),
      );
      expect(error.reason).toBe("validation");
      expect(error.message).toMatch(/filed by this Item's Space agent/u);
      const [status] = yield* sql<{ readonly status: string }>`
        SELECT status FROM command_center_inbox_revisions WHERE id = ${revision!.id}
      `;
      expect(status?.status).toBe("candidate");
      expect(harness.requested).toEqual([]);
      expect(yield* phoneRows).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("still dials and records an approved call when the accept is interrupted", () => {
    const { harness, layer } = makeLayer();
    return Effect.gen(function* () {
      yield* TestClock.setTime(epoch(DAYTIME));
      yield* seedSpace;
      const filed = yield* fileCall();
      const { dialing, release } = yield* holdNextDial(harness);
      const accepting = yield* Effect.forkChild(accept(filed, { canApprove: true }));
      yield* Deferred.await(dialing);
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(accepting));
      for (let spin = 0; spin < 200; spin += 1) yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(interrupting);
      expect(harness.dialed).toHaveLength(1);
      expect((yield* phoneRows).map((row) => [row.sourceId, row.status])).toEqual([
        ["phone-start:conv_1", "calling-third-party"],
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "records a started call whose start row fails as outcome unknown, not not-placed",
    () => {
      const { harness, layer } = makeLayer();
      return Effect.gen(function* () {
        yield* TestClock.setTime(epoch(DAYTIME));
        yield* seedSpace;
        const filed = yield* fileCall();
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
        CREATE TRIGGER fail_phone_start BEFORE INSERT ON command_center_space_activity
        WHEN NEW.source_id LIKE 'phone-start:%'
        BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END
      `;
        const error = yield* Effect.flip(accept(filed, { canApprove: true }));
        expect(error.reason).toBe("persistence");
        expect(error.message).toMatch(
          /^The call started \(conversation conv_1\) .*do not retry\./u,
        );
        expect(error.message).toContain("recorded as outcome unknown");
        expect(PhoneCalls.phoneCallMayBeLive(error)).toBe(true);
        expect(harness.dialed).toHaveLength(1);
        expect(yield* phoneRows).toMatchObject([
          {
            sourceId: `phone-uncertain:third-party:${SPACE}:${filed.candidateRevisionId}`,
            status: "outcome-unknown",
            summary: expect.stringMatching(/^The call started \(conversation conv_1\)/u),
          },
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("treats an approved call whose outcome is unknown as dialed and counts it", () => {
    const { harness, layer } = makeLayer();
    return Effect.gen(function* () {
      yield* TestClock.setTime(epoch(DAYTIME));
      yield* seedSpace;
      const calls = yield* PhoneCalls.PhoneCalls;
      for (let index = 0; index < 4; index += 1) {
        expect((yield* calls.callThirdParty(plan)).placed).toBe(true);
      }
      const filed = yield* fileCall();
      harness.failures.push(timeoutError());
      const error = yield* Effect.flip(accept(filed, { canApprove: true }));
      expect(error.reason).toBe("connector");
      expect(error.message).toMatch(/^Call outcome unknown — do not retry\./u);
      expect(error.message).not.toMatch(/not placed/u);
      const rows = yield* phoneRows;
      expect(rows.slice(4)).toMatchObject([
        {
          sourceId: `phone-uncertain:third-party:${SPACE}:${filed.candidateRevisionId}`,
          title: "Phone: outcome unknown Acme Dental (…0123) — Move Tuesday's cleaning to Thursday",
          status: "outcome-unknown",
        },
      ]);
      expect(rows.filter((row) => row.status === "not-placed")).toEqual([]);
      // The revision stays accepted, like a dialed call: accepting it again never dials.
      expect((yield* inboxVersion(filed.itemId)).status).toBe("current");
      const again = yield* Effect.flip(
        accept(filed, { canApprove: true, mutationId: "web:accept-2" }),
      );
      expect(again.reason).toBe("conflict");
      // It is the fifth third-party call today, so the next one is refused by the cap.
      expect((yield* calls.callThirdParty(plan)).reason).toMatch(/^5 third-party .*limit 5/u);
      expect(harness.requested).toHaveLength(5);
    }).pipe(Effect.provide(layer));
  });
});

const signedDelivery = (body: string, nowMs: number) => ({
  signatureHeader: `t=${Math.floor(nowMs / 1000)},v0=${NodeCrypto.createHmac(
    "sha256",
    connection.webhookSecret,
  )
    .update(`${Math.floor(nowMs / 1000)}.${body}`)
    .digest("hex")}`,
  body: encoder.encode(body),
});

const transcription = (conversationId: string, answer?: string) =>
  JSON.stringify({
    type: "post_call_transcription",
    event_timestamp: 1,
    data: {
      agent_id: "agent_owner",
      conversation_id: conversationId,
      status: "done",
      analysis: {
        call_successful: "success",
        transcript_summary: "Andrew agreed to switch vendors.",
        data_collection_results:
          answer === undefined
            ? {}
            : {
                outcome: { data_collection_id: "outcome", value: "decided", rationale: "r" },
                owner_answer: { data_collection_id: "owner_answer", value: answer, rationale: "r" },
              },
      },
    },
  });

describe("PhoneWebhook", () => {
  it.effect("records the end of an owner question call and queues Andrew's answer once", () => {
    const { layer } = makeLayer();
    return Effect.gen(function* () {
      yield* TestClock.setTime(epoch(DAYTIME));
      yield* seedSpace;
      yield* (yield* PhoneCalls.PhoneCalls).callOwner(ownerCall("Switch to Example Parts?"));
      const webhook = yield* PhoneWebhook.make;
      const delivery = signedDelivery(transcription("conv_1", "yes"), epoch(DAYTIME));

      expect(yield* webhook.handle(delivery)).toEqual({ status: 200, duplicate: false });
      expect(yield* webhook.handle(delivery)).toEqual({ status: 200, duplicate: true });

      const rows = yield* phoneRows;
      expect(rows.map((row) => row.sourceId)).toEqual(["phone-start:conv_1", "phone-end:conv_1"]);
      expect(rows[1]).toEqual({
        sourceId: "phone-end:conv_1",
        title: "Phone: ended Andrew (…0000) — Vendor switch",
        status: "ended",
        summary: "Andrew agreed to switch vendors. (outcome: decided)",
        url: "https://api.elevenlabs.io/v1/convai/conversations/conv_1",
        eventSequence: SpaceActivity.SPACE_ACTIVITY_EXTERNAL_EVENT_SEQUENCE,
      });
      const replies = yield* pendingSpaceAgentReplies(SPACE);
      expect(
        replies.map(({ itemId, itemTitle, kind, body }) => ({ itemId, itemTitle, kind, body })),
      ).toEqual([
        {
          itemId: "phone:conv_1",
          itemTitle: "Phone call: Switch to Example Parts?",
          kind: "comment",
          body: "Answered by phone: yes. Andrew agreed to switch vendors.",
        },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "writes no reply for a brief-only call and ignores conversations it did not start",
    () => {
      const { layer } = makeLayer();
      return Effect.gen(function* () {
        yield* TestClock.setTime(epoch(DAYTIME));
        yield* seedSpace;
        yield* (yield* PhoneCalls.PhoneCalls).callOwner(ownerCall());
        const webhook = yield* PhoneWebhook.make;
        const nowMs = epoch(DAYTIME);
        expect(yield* webhook.handle(signedDelivery(transcription("conv_1"), nowMs))).toEqual({
          status: 200,
          duplicate: false,
        });
        expect(yield* pendingSpaceAgentReplies(SPACE)).toEqual([]);
        expect(yield* webhook.handle(signedDelivery(transcription("conv_unknown"), nowMs))).toEqual(
          {
            status: 204,
            duplicate: false,
          },
        );
        const audio = JSON.stringify({ type: "post_call_audio", data: { full_audio: "AAAA" } });
        expect((yield* webhook.handle(signedDelivery(audio, nowMs))).status).toBe(204);
        expect((yield* phoneRows).map((row) => row.sourceId)).toEqual([
          "phone-start:conv_1",
          "phone-end:conv_1",
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("tells the agent when Andrew did not pick up a question call", () => {
    const { layer } = makeLayer();
    return Effect.gen(function* () {
      yield* TestClock.setTime(epoch(DAYTIME));
      yield* seedSpace;
      yield* (yield* PhoneCalls.PhoneCalls).callOwner(ownerCall("Switch to Example Parts?"));
      const webhook = yield* PhoneWebhook.make;
      const failure = JSON.stringify({
        type: "call_initiation_failure",
        event_timestamp: 1,
        data: { agent_id: "agent_owner", conversation_id: "conv_1", failure_reason: "no-answer" },
      });
      expect((yield* webhook.handle(signedDelivery(failure, epoch(DAYTIME)))).status).toBe(200);
      expect((yield* phoneRows)[1]).toMatchObject({
        title: "Phone: not connected Andrew (…0000) — Vendor switch",
        status: "not-connected",
      });
      expect((yield* pendingSpaceAgentReplies(SPACE))[0]?.body).toMatch(
        /did not pick up \(no-answer\)/u,
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects unsigned, stale, oversized, and malformed deliveries without writing", () => {
    const { layer } = makeLayer();
    return Effect.gen(function* () {
      yield* TestClock.setTime(epoch(DAYTIME));
      yield* seedSpace;
      yield* (yield* PhoneCalls.PhoneCalls).callOwner(ownerCall("Switch to Example Parts?"));
      const webhook = yield* PhoneWebhook.make;
      const body = transcription("conv_1", "yes");
      const nowMs = epoch(DAYTIME);
      const reasons = [];
      for (const delivery of [
        { signatureHeader: undefined, body: encoder.encode(body) },
        { ...signedDelivery(body, nowMs), body: encoder.encode(body.replace("yes", "no")) },
        signedDelivery(body, nowMs - 31 * 60 * 1000),
        signedDelivery(`{"pad":"${"x".repeat(1024 * 1024)}"}`, nowMs),
        signedDelivery("{not json", nowMs),
      ]) {
        reasons.push((yield* Effect.flip(webhook.handle(delivery))).reason);
      }
      expect(reasons).toEqual([
        "unauthorized",
        "unauthorized",
        "unauthorized",
        "payload-too-large",
        "invalid-payload",
      ]);
      expect((yield* phoneRows).map((row) => row.sourceId)).toEqual(["phone-start:conv_1"]);
      expect(yield* pendingSpaceAgentReplies(SPACE)).toEqual([]);
    }).pipe(Effect.provide(layer));
  });
});
