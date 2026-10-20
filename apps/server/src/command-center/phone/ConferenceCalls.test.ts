// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - temporary state directories and raw request bodies.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { SpaceId } from "@command-center/core";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { layerMemory as SqlitePersistenceMemory } from "../../persistence/Sqlite.ts";
import { CommandCenterService, type CommandCenterServiceShape } from "../Service.ts";
import * as SpaceActivity from "../SpaceActivity.ts";
import * as ConferenceCalls from "./ConferenceCalls.ts";
import * as ConferenceCallState from "./ConferenceCallState.ts";
import { type ConferenceHttpResult, handleConferenceRequest } from "./ConferenceRoutes.ts";
import { ElevenLabsClient, type OutboundCallRequest } from "./ElevenLabsClient.ts";
import * as PhoneConnection from "./PhoneConnection.ts";
import * as PhoneCalls from "./PhoneCalls.ts";
import { TwilioClient, TwilioRequestError } from "./TwilioClient.ts";
import { computeTwilioSignature } from "./TwilioSignature.ts";

const SPACE = "acme";
const BASE_URL = "https://cc.example.com/api/command-center/phone/webhook";
const MOUNT = "/api/command-center/phone/webhook";
const twilio = {
  accountSid: `AC${"0".repeat(32)}`,
  authToken: "twilio_test_auth_token_0123456789", // gitleaks:allow (test fixture)
};
const conference = {
  inboundNumber: "+15555550111",
  callerId: { callee: "+15555550112", owner: "+15555550113" },
  publicBaseUrl: BASE_URL,
  toolSecret: "tool_secret_test_0123456789abcdef0123", // gitleaks:allow (test fixture)
};
const legacyConnection = {
  apiKey: "xi_test_api_key_0123456789", // gitleaks:allow (test fixture)
  webhookSecret: "wsec_test_0123456789abcdef", // gitleaks:allow (test fixture)
  agentId: "agent_third_party",
  ownerAgentId: "agent_owner",
  phoneNumberId: "phnum_acme",
  ownerNumber: "+15555550100",
  ownerName: "Andrew",
};
const connection = { ...legacyConnection, twilio, conference };
const encoder = new TextEncoder();
const epoch = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));
/** 14:00 in New York: outside the 23:00-07:00 quiet hours. */
const DAYTIME = "2026-10-17T18:00:00.000Z";
/** 01:00 in New York: inside quiet hours. */
const NIGHT = "2026-10-18T05:00:00.000Z";
const sid = (prefix: "CA" | "CF", n: number) => `${prefix}${n.toString(16).padStart(32, "0")}`;
const CONFERENCE_SID = sid("CF", 1);
const AGENT_SID = sid("CA", 1);
const CALLEE_SID = sid("CA", 2);
const OWNER_SID = sid("CA", 3);

const plan = {
  spaceId: SpaceId.make(SPACE),
  to: "+15555550101",
  calleeName: "Acme Bank",
  purpose: "Dispute a card charge",
  brief: "Andrew saw a duplicate charge of $42 on Oct 12 and wants it reversed.",
  allowedOutcomes: ["charge reversed", "dispute opened"],
  patchInWhen: "the bank asks to verify the card holder",
};

type TwilioMethod = "addParticipant" | "createCall" | "updateParticipant" | "endConference";

interface Harness {
  readonly twilio: Array<{ readonly method: TwilioMethod; readonly input: unknown }>;
  readonly failures: Partial<Record<TwilioMethod, Array<TwilioRequestError>>>;
  readonly elevenLabs: Array<OutboundCallRequest>;
  /** Completed by the next owner dial; replace it to wait for another. */
  ownerDialed: Deferred.Deferred<void>;
}

const directories: Array<string> = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
const tempStateDir = () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cc-conference-"));
  directories.push(directory);
  return NodePath.join(directory, "phone");
};

const makeLayer = (options: { readonly stateDir?: string; readonly connection?: unknown } = {}) => {
  const stateDir = options.stateDir ?? tempStateDir();
  const harness: Harness = {
    twilio: [],
    failures: {},
    elevenLabs: [],
    ownerDialed: Deferred.makeUnsafe<void>(),
  };
  let sids = 0;
  const secrets = new Map<string, Uint8Array>([
    [
      PhoneConnection.PHONE_CONNECTION_SECRET_NAME,
      encoder.encode(JSON.stringify(options.connection ?? connection)),
    ],
  ]);
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
  const record = (method: TwilioMethod, input: unknown) =>
    Effect.suspend(() => {
      harness.twilio.push({ method, input });
      const failure = harness.failures[method]?.shift();
      return failure === undefined ? Effect.void : Effect.fail(failure);
    });
  const fakeTwilio = Layer.succeed(
    TwilioClient,
    TwilioClient.of({
      addParticipant: (_credentials, input) =>
        record("addParticipant", input).pipe(
          Effect.map(() => ({ callSid: sid("CA", (sids += 1)), conferenceSid: CONFERENCE_SID })),
        ),
      createCall: (_credentials, input) =>
        record("createCall", input).pipe(
          Effect.map(() => ({ callSid: sid("CA", (sids += 1)) })),
          Effect.ensuring(Deferred.succeed(harness.ownerDialed, undefined)),
        ),
      updateParticipant: (_credentials, input) => record("updateParticipant", input),
      endConference: (_credentials, conferenceSid) => record("endConference", conferenceSid),
    }),
  );
  const fakeElevenLabs = Layer.succeed(
    ElevenLabsClient,
    ElevenLabsClient.of({
      startOutboundCall: (request) =>
        Effect.sync(() => {
          harness.elevenLabs.push(request);
          return { conversationId: `conv_owner_${harness.elevenLabs.length}` };
        }),
    }),
  );
  const service = Layer.succeed(CommandCenterService, {
    getConfiguredSpace: (spaceId: string) =>
      Effect.succeed({
        id: spaceId,
        policy: { allowedCapabilities: ["cc.phone.call-owner", "cc.phone.call"] },
        agent: {
          enabled: true,
          quietHours: { start: "23:00", end: "07:00", timezone: "America/New_York" },
          dailyWakeLimit: 8,
          debounceMinutes: 10,
        },
      }),
  } as unknown as CommandCenterServiceShape);
  const conferenceLayer = ConferenceCalls.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(fakeTwilio, ConferenceCallState.layerAt(stateDir))),
  );
  const base = Layer.mergeAll(PhoneConnection.layer, SpaceActivity.layer, fakeElevenLabs, service);
  const layer = PhoneCalls.layer.pipe(
    Layer.provideMerge(conferenceLayer),
    Layer.provideMerge(base),
    Layer.provideMerge(secretStore),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );
  // Without ConferenceCalls, PhoneCalls has no conference dialer.
  const legacyOnly = PhoneCalls.layer.pipe(
    Layer.provideMerge(base),
    Layer.provideMerge(secretStore),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );
  return { harness, layer, legacyOnly, stateDir, fakeTwilio };
};

const seedSpace = Effect.gen(function* () {
  yield* TestClock.setTime(epoch(DAYTIME));
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
  }>`
    SELECT source_id AS "sourceId", title, status, summary
    FROM command_center_space_activity WHERE space_id = ${SPACE} ORDER BY id ASC
  `;
});

const loadRecord = Effect.gen(function* () {
  const store = yield* ConferenceCallState.ConferenceCallStateStore;
  return Option.getOrThrow(yield* store.load);
});

const calls = (harness: Harness, method: TwilioMethod) =>
  harness.twilio.filter((call) => call.method === method).map((call) => call.input);

// ── Requests as Twilio and ElevenLabs send them ──────────────────────────────

const twilioRequest = (input: {
  readonly route: ConferenceCallState.TwilioCallbackRoute;
  readonly callId: string;
  readonly leg?: ConferenceCallState.ConferenceLegName;
  readonly params: Record<string, string>;
  /** Sign a different URL than the one Command Center gave Twilio. */
  readonly signedUrl?: string;
  readonly authToken?: string;
}) => {
  const url = ConferenceCallState.twilioCallbackUrl({
    publicBaseUrl: BASE_URL,
    route: input.route,
    callId: input.callId,
    ...(input.leg === undefined ? {} : { leg: input.leg }),
  });
  const pairs = Object.entries({ AccountSid: twilio.accountSid, ...input.params });
  const signature = computeTwilioSignature({
    authToken: input.authToken ?? twilio.authToken,
    url: input.signedUrl ?? url,
    params: pairs,
  });
  const target = new URL(url);
  return handleConferenceRequest(`twilio/${input.route}`, {
    url: `${target.pathname}${target.search}`,
    // The Host header is attacker-controlled and must not matter.
    headers: { "x-twilio-signature": signature, host: "attacker.example" },
    body: encoder.encode(new URLSearchParams(pairs).toString()),
  });
};

const status = (
  callId: string,
  leg: ConferenceCallState.ConferenceLegName,
  callSid: string,
  callStatus: string,
) =>
  twilioRequest({
    route: "status",
    callId,
    leg,
    params: { CallSid: callSid, CallStatus: callStatus },
  });

const elevenLabsRequest = (
  route: "elevenlabs/initiation" | "elevenlabs/tool/bring-owner-in",
  body: unknown,
  /** `null` sends no token header. */
  token: string | null = conference.toolSecret,
) =>
  handleConferenceRequest(route, {
    url: `${MOUNT}/${route}`,
    headers: token === null ? {} : { "x-cc-phone-token": token },
    body: encoder.encode(typeof body === "string" ? body : JSON.stringify(body)),
  });

const initiate = (body: Record<string, unknown> = {}) =>
  elevenLabsRequest("elevenlabs/initiation", {
    caller_id: conference.callerId.owner,
    called_number: conference.inboundNumber,
    agent_id: legacyConnection.agentId,
    call_sid: sid("CA", 0xe1),
    conversation_id: "conv_third_party_1",
    ...body,
  });

const bringOwnerIn = (body: Record<string, unknown> = {}) =>
  elevenLabsRequest("elevenlabs/tool/bring-owner-in", {
    reason: "The bank needs Andrew to confirm the card holder's date of birth.",
    conversation_id: "conv_third_party_1",
    ...body,
  });

const bodyOf = (result: ConferenceHttpResult) => (result.kind === "json" ? result.body : result);

/** Approve-time path: `callThirdParty` in conference mode. */
const startCall = Effect.gen(function* () {
  const phone = yield* PhoneCalls.PhoneCalls;
  const outcome = yield* phone.callThirdParty(plan, { attemptId: "revision:test" });
  expect(outcome).toEqual({ placed: true });
  return (yield* loadRecord).callId;
});

/** Start, initiate, agent answers, callee answers: the call is in progress. */
const connectCall = Effect.gen(function* () {
  const callId = yield* startCall;
  expect((yield* initiate()).kind).toBe("json");
  yield* status(callId, "agent", AGENT_SID, "in-progress");
  yield* status(callId, "callee", CALLEE_SID, "in-progress");
  expect((yield* loadRecord).phase).toBe("in-progress");
  return callId;
});

describe("conference-mode third-party calls", () => {
  it.effect("dial the agent leg through Twilio, one call at a time", () => {
    const { harness, layer } = makeLayer();
    return Effect.gen(function* () {
      yield* seedSpace;
      const callId = yield* startCall;
      expect(harness.elevenLabs).toEqual([]);
      expect(calls(harness, "addParticipant")).toEqual([
        {
          conferenceName: `cc-${callId}`,
          from: conference.callerId.owner,
          to: conference.inboundNumber,
          label: "agent",
          startConferenceOnEnter: false,
          endConferenceOnExit: false,
          timeout: 20,
          statusCallback: `${BASE_URL}/twilio/status?call=${callId}&leg=agent`,
          statusCallbackEvents: ["answered", "completed"],
          waitUrl: `${BASE_URL}/twilio/hold?call=${callId}`,
        },
      ]);
      const record = yield* loadRecord;
      expect(record).toMatchObject({
        phase: "dialing-agent",
        conferenceSid: CONFERENCE_SID,
        agent: { callSid: AGENT_SID, status: "dialing" },
      });
      // Nothing is recorded until ElevenLabs initiates the conversation.
      expect(yield* phoneRows).toEqual([]);
      const phone = yield* PhoneCalls.PhoneCalls;
      const second = yield* phone.callThirdParty(plan);
      expect(second.placed).toBe(false);
      expect(second.reason).toMatch(/Another phone call is in progress/u);
      expect(calls(harness, "addParticipant")).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuse in conference mode when the conference service is not wired", () => {
    const { harness, legacyOnly } = makeLayer();
    return Effect.gen(function* () {
      yield* seedSpace;
      const phone = yield* PhoneCalls.PhoneCalls;
      const outcome = yield* phone.callThirdParty(plan);
      expect(outcome).toEqual({ placed: false, reason: PhoneCalls.CONFERENCE_UNAVAILABLE_REASON });
      expect(harness.elevenLabs).toEqual([]);
      expect(harness.twilio).toEqual([]);
    }).pipe(Effect.provide(legacyOnly));
  });

  it.effect(
    "report a Twilio refusal as not placed and an unanswered request as outcome unknown",
    () => {
      const { harness, layer } = makeLayer();
      return Effect.gen(function* () {
        yield* seedSpace;
        const phone = yield* PhoneCalls.PhoneCalls;
        harness.failures.addParticipant = [
          new TwilioRequestError({
            reason: "http",
            status: 400,
            message: "Twilio answered HTTP 400",
          }),
          new TwilioRequestError({
            reason: "timeout",
            message: "Twilio did not answer within 15 s.",
          }),
        ];
        const refused = yield* Effect.flip(phone.callThirdParty(plan, { attemptId: "rev-1" }));
        expect(PhoneCalls.phoneCallMayBeLive(refused)).toBe(false);
        expect(refused.message).toMatch(/Twilio refused the call/u);
        expect((yield* loadRecord).phase).toBe("failed");

        const unknown = yield* Effect.flip(phone.callThirdParty(plan, { attemptId: "rev-2" }));
        expect(PhoneCalls.phoneCallMayBeLive(unknown)).toBe(true);
        expect(unknown.message).toMatch(/Twilio may have started the call/u);
        expect(yield* phoneRows).toEqual([
          expect.objectContaining({
            sourceId: `phone-uncertain:third-party:${SPACE}:rev-2`,
            status: "outcome-unknown",
          }),
        ]);
        // It may be ringing, so it still blocks a second call.
        expect((yield* loadRecord).phase).toBe("dialing-agent");
        expect((yield* phone.callThirdParty(plan)).placed).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "match the initiation webhook by call sid or agent number and answer its variables",
    () => {
      const { layer } = makeLayer();
      return Effect.gen(function* () {
        yield* seedSpace;
        expect(yield* initiate()).toEqual({
          kind: "json",
          status: 404,
          body: { error: "call_not_found" },
        });
        const callId = yield* startCall;
        expect((yield* initiate({ agent_id: "agent_other" })) as unknown).toMatchObject({
          status: 404,
        });
        expect(
          (yield* initiate({
            called_number: "+15555550199",
            call_sid: sid("CA", 0xe2),
          })) as unknown,
        ).toMatchObject({ status: 404 });
        const expected = {
          type: "conversation_initiation_client_data",
          dynamic_variables: {
            purpose: plan.purpose,
            brief: plan.brief,
            allowed_outcomes: "charge reversed; dispute opened",
            owner_name: "Andrew",
            callee_name: plan.calleeName,
            patch_in_when: plan.patchInWhen,
            call_kind: "third_party",
            question: "",
          },
        };
        // ElevenLabs reports its own leg's sid, so the agent number is the match.
        expect(yield* initiate()).toEqual({ kind: "json", status: 200, body: expected });
        expect(yield* initiate()).toEqual({ kind: "json", status: 200, body: expected });
        expect((yield* initiate({ conversation_id: "conv_other" })) as unknown).toMatchObject({
          status: 404,
        });
        const record = yield* loadRecord;
        expect(record).toMatchObject({
          callId,
          conversationId: "conv_third_party_1",
          agentInboundCallSid: sid("CA", 0xe1),
        });
        const rows = yield* phoneRows;
        expect(rows).toEqual([
          {
            sourceId: "phone-start:conv_third_party_1",
            title: "Phone: calling Acme Bank (…0101) — Dispute a card charge",
            status: "calling-third-party",
            summary: plan.brief,
          },
        ]);
        expect(JSON.stringify(rows)).not.toContain(plan.to);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("match the initiation webhook by the agent leg's call sid", () => {
    const { layer } = makeLayer();
    return Effect.gen(function* () {
      yield* seedSpace;
      yield* startCall;
      const result = yield* initiate({ called_number: "+15555550199", call_sid: AGENT_SID });
      expect(result).toMatchObject({ kind: "json", status: 200 });
    }).pipe(Effect.provide(layer));
  });

  it.effect("dial the callee only once the agent is answered and briefed", () => {
    const { harness, layer } = makeLayer();
    return Effect.gen(function* () {
      yield* seedSpace;
      const callId = yield* startCall;
      yield* initiate();
      expect(yield* status(callId, "agent", AGENT_SID, "in-progress")).toEqual({ kind: "empty" });
      expect(calls(harness, "addParticipant")[1]).toEqual({
        conferenceName: `cc-${callId}`,
        from: conference.callerId.callee,
        to: plan.to,
        label: "callee",
        startConferenceOnEnter: true,
        endConferenceOnExit: true,
        timeout: 45,
        statusCallback: `${BASE_URL}/twilio/status?call=${callId}&leg=callee`,
        statusCallbackEvents: ["answered", "completed"],
      });
      expect((yield* loadRecord).phase).toBe("dialing-callee");
      // A duplicate answered callback dials nobody.
      yield* status(callId, "agent", AGENT_SID, "in-progress");
      expect(calls(harness, "addParticipant")).toHaveLength(2);
      yield* status(callId, "callee", CALLEE_SID, "in-progress");
      expect((yield* loadRecord).phase).toBe("in-progress");
    }).pipe(Effect.provide(layer));
  });

  it.effect("end the call when the agent answers without its brief", () => {
    const { harness, layer } = makeLayer();
    return Effect.gen(function* () {
      yield* seedSpace;
      const callId = yield* startCall;
      yield* status(callId, "agent", AGENT_SID, "in-progress");
      expect(calls(harness, "addParticipant")).toHaveLength(1);
      expect(calls(harness, "endConference")).toEqual([CONFERENCE_SID]);
      expect((yield* loadRecord).phase).toBe("failed");
      expect(yield* phoneRows).toEqual([
        expect.objectContaining({
          sourceId: `phone-not-connected:${callId}`,
          status: "not-connected",
          title: "Phone: not connected Acme Bank (…0101) — Dispute a card charge",
        }),
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("record a callee who does not answer as not connected and end the conference", () => {
    const { harness, layer } = makeLayer();
    return Effect.gen(function* () {
      yield* seedSpace;
      const callId = yield* startCall;
      yield* initiate();
      yield* status(callId, "agent", AGENT_SID, "in-progress");
      yield* status(callId, "callee", CALLEE_SID, "busy");
      expect(calls(harness, "endConference")).toEqual([CONFERENCE_SID]);
      expect((yield* loadRecord).phase).toBe("failed");
      const rows = yield* phoneRows;
      expect(rows.map((row) => row.sourceId)).toEqual([
        "phone-start:conv_third_party_1",
        `phone-not-connected:${callId}`,
      ]);
      expect(rows[1]?.summary).toMatch(/Acme Bank did not answer \(busy\)/u);
      // The agent leg ending afterwards changes nothing.
      yield* status(callId, "agent", AGENT_SID, "completed");
      expect(calls(harness, "endConference")).toHaveLength(1);
      // A new call may start now.
      expect((yield* (yield* PhoneCalls.PhoneCalls).callThirdParty(plan)).placed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("tolerate duplicate, out-of-order, foreign, and forged callbacks", () => {
    const { harness, layer } = makeLayer();
    return Effect.gen(function* () {
      yield* seedSpace;
      const callId = yield* startCall;
      yield* initiate();
      yield* status(callId, "agent", AGENT_SID, "in-progress");
      // Ringing is not a transition; a foreign call sid is ignored.
      yield* status(callId, "callee", CALLEE_SID, "ringing");
      yield* status(callId, "callee", sid("CA", 0x99), "in-progress");
      expect((yield* loadRecord).phase).toBe("dialing-callee");
      // "completed" means answered and ended, even if "answered" never arrived.
      yield* status(callId, "callee", CALLEE_SID, "completed");
      expect((yield* loadRecord).phase).toBe("ended");
      yield* status(callId, "callee", CALLEE_SID, "in-progress");
      const record = yield* loadRecord;
      expect(record.callee).toMatchObject({ status: "completed", answered: true });
      expect(calls(harness, "endConference")).toEqual([]);
      expect((yield* phoneRows).map((row) => row.sourceId)).toEqual([
        "phone-start:conv_third_party_1",
      ]);
      // Unknown calls are acknowledged and change nothing.
      expect(
        yield* status("0f8fad5b-d9cb-469f-a165-70867728950e", "agent", AGENT_SID, "completed"),
      ).toEqual({ kind: "empty" });
      // Signatures over another URL or with another token fail; bad queries never reach the call.
      const forged = [
        yield* twilioRequest({
          route: "status",
          callId,
          leg: "agent",
          params: { CallSid: AGENT_SID, CallStatus: "completed" },
          signedUrl: `https://attacker.example${MOUNT}/twilio/status?call=${callId}&leg=agent`,
        }),
        yield* twilioRequest({
          route: "status",
          callId,
          leg: "agent",
          params: { CallSid: AGENT_SID, CallStatus: "completed" },
          authToken: "wrong_auth_token_0123456789",
        }),
        yield* handleConferenceRequest("twilio/status", {
          url: `${MOUNT}/twilio/status?call=${callId}&leg=agent&extra=1`,
          headers: {},
          body: encoder.encode("CallSid=x"),
        }),
        yield* handleConferenceRequest("twilio/hold", {
          url: `${MOUNT}/twilio/hold?call=not-a-call-id`,
          headers: {},
          body: new Uint8Array([0xff, 0xfe]),
        }),
      ];
      for (const result of forged) {
        expect(result).toEqual({
          kind: "json",
          status: 401,
          body: { error: "invalid_webhook_credential" },
        });
      }
      // A signed request with a malformed CallSid is a 400, not a 5xx.
      expect(
        yield* twilioRequest({
          route: "status",
          callId,
          leg: "agent",
          params: { CallSid: "bogus", CallStatus: "completed" },
        }),
      ).toMatchObject({ status: 400 });
    }).pipe(Effect.provide(layer));
  });

  it.effect("end the conference when the agent hangs up without Andrew on the line", () => {
    const { harness, layer } = makeLayer();
    return Effect.gen(function* () {
      yield* seedSpace;
      const callId = yield* connectCall;
      yield* status(callId, "agent", AGENT_SID, "completed");
      expect(calls(harness, "endConference")).toEqual([CONFERENCE_SID]);
      expect((yield* loadRecord).phase).toBe("ended");
    }).pipe(Effect.provide(layer));
  });

  it.effect("serve the hold and hand-back TwiML only to signed requests", () => {
    const { layer } = makeLayer();
    return Effect.gen(function* () {
      yield* seedSpace;
      const callId = yield* startCall;
      expect(yield* twilioRequest({ route: "hold", callId, params: {} })).toEqual({
        kind: "twiml",
        body: '<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="600"/></Response>',
      });
      const announce = yield* twilioRequest({ route: "announce", callId, params: {} });
      expect(announce).toMatchObject({ kind: "twiml" });
      expect(announce.kind === "twiml" ? announce.body : "").toContain(
        "<Say>Andrew has finished and left the call. Continue with the callee.</Say>",
      );
      expect(
        yield* twilioRequest({ route: "hold", callId, params: {}, authToken: "x".repeat(32) }),
      ).toMatchObject({ status: 401 });
    }).pipe(Effect.provide(layer));
  });
});

describe("bring_owner_in", () => {
  it.effect("holds and mutes the agent before Andrew joins, then hands the call back", () => {
    const { harness, layer } = makeLayer();
    return Effect.gen(function* () {
      yield* seedSpace;
      const callId = yield* connectCall;
      const tool = yield* Effect.forkChild(bringOwnerIn({ call_sid: "" }));
      yield* Deferred.await(harness.ownerDialed);
      expect(calls(harness, "createCall")).toEqual([
        {
          from: conference.callerId.owner,
          to: legacyConnection.ownerNumber,
          url: `${BASE_URL}/twilio/owner-twiml?call=${callId}`,
          timeout: 30,
          statusCallback: `${BASE_URL}/twilio/status?call=${callId}&leg=owner`,
          statusCallbackEvents: ["answered", "completed"],
        },
      ]);
      const twiml = yield* twilioRequest({
        route: "owner-twiml",
        callId,
        params: { CallSid: OWNER_SID, CallStatus: "in-progress" },
      });
      // The agent is held and muted before the TwiML that joins Andrew is returned.
      expect(calls(harness, "updateParticipant")).toEqual([
        {
          conferenceSid: CONFERENCE_SID,
          callSid: AGENT_SID,
          hold: true,
          holdUrl: `${BASE_URL}/twilio/hold?call=${callId}`,
          muted: true,
        },
      ]);
      expect(twiml).toEqual({
        kind: "twiml",
        body: [
          '<?xml version="1.0" encoding="UTF-8"?><Response>',
          "<Say>Command Center. I have Acme Bank on the line about Dispute a card charge. ",
          "The bank needs Andrew to confirm the card holder&apos;s date of birth. ",
          "Hang up when you are done; the assistant continues the call.</Say>",
          '<Dial><Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="false">',
          `cc-${callId}</Conference></Dial></Response>`,
        ].join(""),
      });
      expect(bodyOf(yield* Fiber.join(tool))).toMatchObject({ status: "joined" });
      expect((yield* loadRecord).phase).toBe("owner-joined");
      // A repeated tool call reports the bridge instead of dialing again.
      expect(bodyOf(yield* bringOwnerIn())).toMatchObject({ status: "joined" });
      expect(calls(harness, "createCall")).toHaveLength(1);

      yield* status(callId, "owner", OWNER_SID, "in-progress");
      yield* status(callId, "owner", OWNER_SID, "completed");
      // Unhold, announce, unmute — in that order, to the agent only.
      expect(calls(harness, "updateParticipant").slice(1)).toEqual([
        { conferenceSid: CONFERENCE_SID, callSid: AGENT_SID, hold: false },
        {
          conferenceSid: CONFERENCE_SID,
          callSid: AGENT_SID,
          announceUrl: `${BASE_URL}/twilio/announce?call=${callId}`,
        },
        { conferenceSid: CONFERENCE_SID, callSid: AGENT_SID, muted: false },
      ]);
      const record = yield* loadRecord;
      expect(record.phase).toBe("in-progress");
      expect(record.owner).toMatchObject({ n: 1, state: "ended" });
      expect(calls(harness, "endConference")).toEqual([]);
      const rows = yield* phoneRows;
      expect(rows.map((row) => [row.sourceId, row.status])).toEqual([
        ["phone-start:conv_third_party_1", "calling-third-party"],
        [`phone-bridge:${callId}:1`, "bridging-owner"],
        [`phone-bridge-end:${callId}:1`, "bridge-ended"],
      ]);
      expect(rows[1]?.title).toBe(
        "Phone: bringing Andrew in — The bank needs Andrew to confirm the card holder's date of birth.",
      );
      expect(rows[2]?.title).toBe("Phone: Andrew left; assistant continued");
      expect(JSON.stringify(rows)).not.toContain(legacyConnection.ownerNumber);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps the call up while Andrew talks after the agent left, then ends it", () => {
    const { harness, layer } = makeLayer();
    return Effect.gen(function* () {
      yield* seedSpace;
      const callId = yield* connectCall;
      const tool = yield* Effect.forkChild(bringOwnerIn());
      yield* Deferred.await(harness.ownerDialed);
      yield* twilioRequest({
        route: "owner-twiml",
        callId,
        params: { CallSid: OWNER_SID, CallStatus: "in-progress" },
      });
      yield* Fiber.join(tool);
      yield* status(callId, "agent", AGENT_SID, "completed");
      expect(calls(harness, "endConference")).toEqual([]);
      yield* status(callId, "owner", OWNER_SID, "completed");
      expect(calls(harness, "endConference")).toEqual([CONFERENCE_SID]);
      expect((yield* loadRecord).phase).toBe("ended");
      // The agent is gone, so nobody is taken off hold.
      expect(calls(harness, "updateParticipant")).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports no answer and leaves the agent untouched; the attempt counts", () => {
    const { harness, layer } = makeLayer();
    return Effect.gen(function* () {
      yield* seedSpace;
      const callId = yield* connectCall;
      const tool = yield* Effect.forkChild(bringOwnerIn());
      yield* Deferred.await(harness.ownerDialed);
      // A second request while Andrew's phone rings does not dial again.
      expect(bodyOf(yield* bringOwnerIn())).toMatchObject({ status: "calling" });
      yield* status(callId, "owner", OWNER_SID, "no-answer");
      expect(bodyOf(yield* Fiber.join(tool))).toEqual({
        status: "no-answer",
        message:
          "Andrew did not answer. Tell the callee that Andrew is not available right now and continue the call without Andrew.",
      });
      expect(calls(harness, "createCall")).toHaveLength(1);
      expect(calls(harness, "updateParticipant")).toEqual([]);
      expect((yield* loadRecord).phase).toBe("in-progress");
      expect((yield* phoneRows).map((row) => row.sourceId)).toContain(`phone-bridge:${callId}:1`);
      // Answering the stale owner leg later joins nobody.
      const late = yield* twilioRequest({
        route: "owner-twiml",
        callId,
        params: { CallSid: OWNER_SID, CallStatus: "in-progress" },
      });
      expect(late.kind === "twiml" ? late.body : "").toContain("<Hangup/>");
      expect(calls(harness, "updateParticipant")).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not connect Andrew when the agent cannot be put on hold", () => {
    const { harness, layer } = makeLayer();
    return Effect.gen(function* () {
      yield* seedSpace;
      const callId = yield* connectCall;
      harness.failures.updateParticipant = [
        new TwilioRequestError({
          reason: "http",
          status: 404,
          message: "Twilio answered HTTP 404",
        }),
      ];
      const tool = yield* Effect.forkChild(bringOwnerIn());
      yield* Deferred.await(harness.ownerDialed);
      const twiml = yield* twilioRequest({
        route: "owner-twiml",
        callId,
        params: { CallSid: OWNER_SID, CallStatus: "in-progress" },
      });
      const body = twiml.kind === "twiml" ? twiml.body : "";
      expect(body).not.toContain("<Dial>");
      expect(body).toContain("<Hangup/>");
      expect(bodyOf(yield* Fiber.join(tool))).toMatchObject({ status: "failed" });
      // While his leg is still up, a retry does not ring him again.
      expect(JSON.stringify(bodyOf(yield* bringOwnerIn()))).toMatch(/still ending/u);
      expect(calls(harness, "createCall")).toHaveLength(1);
      // His hang-up still takes the agent off hold, in case the hold did apply.
      yield* status(callId, "owner", OWNER_SID, "completed");
      expect(calls(harness, "updateParticipant").slice(1)).toEqual([
        expect.objectContaining({ hold: false }),
        expect.objectContaining({ announceUrl: `${BASE_URL}/twilio/announce?call=${callId}` }),
        expect.objectContaining({ muted: false }),
      ]);
      // He never joined, so there is no "left" row.
      expect((yield* phoneRows).map((row) => row.status)).not.toContain("bridge-ended");
      // Afterwards a second bridge works.
      harness.ownerDialed = Deferred.makeUnsafe<void>();
      const retry = yield* Effect.forkChild(bringOwnerIn());
      yield* Deferred.await(harness.ownerDialed);
      const secondOwnerSid = sid("CA", 4);
      const joinTwiml = yield* twilioRequest({
        route: "owner-twiml",
        callId,
        params: { CallSid: secondOwnerSid, CallStatus: "in-progress" },
      });
      expect(joinTwiml.kind === "twiml" ? joinTwiml.body : "").toContain("<Dial>");
      expect(bodyOf(yield* Fiber.join(retry))).toMatchObject({ status: "joined" });
      expect((yield* loadRecord).owner).toMatchObject({ n: 2, state: "joined" });
      expect((yield* phoneRows).map((row) => row.sourceId)).toContain(`phone-bridge:${callId}:2`);
    }).pipe(Effect.provide(layer));
  });

  it.effect("waits at most 45 seconds for Andrew", () => {
    const { harness, layer } = makeLayer();
    return Effect.gen(function* () {
      yield* seedSpace;
      yield* connectCall;
      const tool = yield* Effect.forkChild(bringOwnerIn());
      yield* Deferred.await(harness.ownerDialed);
      yield* TestClock.adjust("44 seconds");
      expect(tool.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 second");
      expect(bodyOf(yield* Fiber.join(tool))).toMatchObject({ status: "calling" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("is refused during quiet hours without ringing Andrew", () => {
    const { harness, layer } = makeLayer();
    return Effect.gen(function* () {
      yield* seedSpace;
      // Third-party calls have no quiet hours; bringing Andrew in does.
      yield* TestClock.setTime(epoch(NIGHT));
      const callId = yield* connectCall;
      const result = bodyOf(yield* bringOwnerIn());
      expect(result).toMatchObject({ status: "refused" });
      expect(JSON.stringify(result)).toMatch(/quiet hours/u);
      expect(calls(harness, "createCall")).toEqual([]);
      expect((yield* phoneRows).map((row) => row.sourceId)).not.toContain(
        `phone-bridge:${callId}:1`,
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("shares the owner's daily cap with owner calls", () => {
    const { harness, layer } = makeLayer();
    return Effect.gen(function* () {
      yield* seedSpace;
      const phone = yield* PhoneCalls.PhoneCalls;
      const ownerCall = {
        spaceId: SpaceId.make(SPACE),
        purpose: "Vendor switch",
        brief: "Acme Supply raised prices.",
      };
      expect((yield* phone.callOwner(ownerCall)).placed).toBe(true);
      expect((yield* phone.callOwner(ownerCall)).placed).toBe(true);
      const callId = yield* connectCall;
      // The third owner call of the day is this bridge.
      const tool = yield* Effect.forkChild(bringOwnerIn());
      yield* Deferred.await(harness.ownerDialed);
      yield* status(callId, "owner", OWNER_SID, "no-answer");
      yield* Fiber.join(tool);
      const capped = bodyOf(yield* bringOwnerIn());
      expect(capped).toMatchObject({ status: "refused" });
      expect(JSON.stringify(capped)).toMatch(/limit 3/u);
      // And the bridge counts against cc_phone_call_me too.
      expect((yield* phone.callOwner(ownerCall)).reason).toMatch(/limit 3/u);
      expect(calls(harness, "createCall")).toHaveLength(1);
      expect(harness.elevenLabs).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("needs a live, matching call with the callee on the line", () => {
    const { harness, layer } = makeLayer();
    return Effect.gen(function* () {
      yield* seedSpace;
      expect(bodyOf(yield* bringOwnerIn())).toMatchObject({ status: "refused" });
      const callId = yield* startCall;
      yield* initiate();
      yield* status(callId, "agent", AGENT_SID, "in-progress");
      // The callee has not answered yet.
      expect(JSON.stringify(bodyOf(yield* bringOwnerIn()))).toMatch(/not on the line/u);
      yield* status(callId, "callee", CALLEE_SID, "in-progress");
      expect(bodyOf(yield* bringOwnerIn({ conversation_id: "conv_other" }))).toMatchObject({
        status: "refused",
      });
      expect(calls(harness, "createCall")).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("authenticates the tool and validates its body", () => {
    const { layer } = makeLayer();
    return Effect.gen(function* () {
      yield* seedSpace;
      const unauthorized = {
        kind: "json",
        status: 401,
        body: { error: "invalid_webhook_credential" },
      };
      expect(
        yield* elevenLabsRequest("elevenlabs/tool/bring-owner-in", { reason: "x" }, null),
      ).toEqual(unauthorized);
      expect(
        yield* elevenLabsRequest(
          "elevenlabs/tool/bring-owner-in",
          { reason: "x" },
          `${conference.toolSecret}x`,
        ),
      ).toEqual(unauthorized);
      expect(
        yield* elevenLabsRequest("elevenlabs/initiation", { conversation_id: "c" }, "wrong"),
      ).toEqual(unauthorized);
      for (const body of [
        "{not json",
        { reason: "" },
        { reason: "   " },
        { reason: "a".repeat(1_001) },
        { reason: `bell${String.fromCharCode(7)}` },
        { conversation_id: "conv" },
      ]) {
        expect(yield* elevenLabsRequest("elevenlabs/tool/bring-owner-in", body)).toMatchObject({
          status: 400,
        });
      }
      expect(
        yield* elevenLabsRequest("elevenlabs/initiation", { conversation_id: "../bad" }),
      ).toMatchObject({ status: 400 });
    }).pipe(Effect.provide(layer));
  });
});

describe("conference call lifecycle", () => {
  it.effect(
    "answers every route like a bad credential without a conference-mode connection",
    () => {
      const { layer } = makeLayer({ connection: legacyConnection });
      return Effect.gen(function* () {
        yield* seedSpace;
        expect(yield* initiate()).toMatchObject({ status: 401 });
        expect(yield* bringOwnerIn()).toMatchObject({ status: 401 });
        expect(
          yield* status("0f8fad5b-d9cb-469f-a165-70867728950e", "agent", AGENT_SID, "completed"),
        ).toMatchObject({ status: 401 });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("abandons a call with no final status after two hours", () => {
    const { harness, layer } = makeLayer();
    return Effect.gen(function* () {
      yield* seedSpace;
      const callId = yield* connectCall;
      yield* TestClock.adjust("121 minutes");
      const phone = yield* PhoneCalls.PhoneCalls;
      expect((yield* phone.callThirdParty(plan)).placed).toBe(true);
      expect(calls(harness, "endConference")).toEqual([CONFERENCE_SID]);
      expect(yield* phoneRows).toContainEqual(
        expect.objectContaining({
          sourceId: `phone-abandoned:${callId}`,
          status: "outcome-unknown",
          title: "Phone: outcome unknown Acme Bank (…0101) — Dispute a card charge",
        }),
      );
      expect((yield* loadRecord).callId).not.toBe(callId);
    }).pipe(Effect.provide(layer));
  });

  it.effect("continues a call from the state file after a server restart", () => {
    const first = makeLayer();
    return Effect.gen(function* () {
      yield* seedSpace;
      const callId = yield* startCall;
      yield* initiate();
      // A new server process: a fresh engine and Twilio client over the same state directory.
      const restarted = makeLayer({ stateDir: first.stateDir });
      const engine = yield* ConferenceCalls.make.pipe(
        Effect.provide(
          Layer.mergeAll(restarted.fakeTwilio, ConferenceCallState.layerAt(first.stateDir)),
        ),
      );
      const decoded = Option.getOrThrow(
        PhoneConnection.decodePhoneConnection(encoder.encode(JSON.stringify(connection))),
      );
      if (!PhoneConnection.isPhoneConferenceConnection(decoded)) throw new Error("fixture");
      expect(
        yield* engine.twilioStatus(decoded, {
          callId,
          leg: "agent",
          callSid: AGENT_SID,
          callStatus: "in-progress",
        }),
      ).toBe("applied");
      expect(calls(restarted.harness, "addParticipant")).toEqual([
        expect.objectContaining({ label: "callee", to: plan.to }),
      ]);
      expect(calls(first.harness, "addParticipant")).toHaveLength(1);
      expect((yield* loadRecord).phase).toBe("dialing-callee");
    }).pipe(Effect.provide(first.layer));
  });
});
