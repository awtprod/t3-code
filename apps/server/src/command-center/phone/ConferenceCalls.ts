/**
 * ConferenceCalls - conference-mode third-party calls: Command Center owns a
 * Twilio Conference (`cc-<call id>`) and the ElevenLabs third-party agent is
 * one participant, so the owner can be brought in for part of a call while the
 * agent steps out, and the agent takes the call back when he leaves.
 *
 * Legs (all created through the Twilio REST API):
 *
 * - agent: dialed from `conference.callerId.owner` to `conference.inboundNumber`,
 *   the number ElevenLabs answers with the third-party agent. It waits in
 *   silence (the hold TwiML) until the callee joins. ElevenLabs fetches the
 *   call's dynamic variables from the initiation webhook before it answers;
 *   that request is matched to this call and records the conversation id and
 *   the `phone-start:` row, exactly as the ElevenLabs outbound path does.
 * - callee: dialed only once the agent leg is answered *and* initiated (an
 *   agent without its brief never talks to anyone), from
 *   `conference.callerId.callee`. The conference starts when the callee
 *   answers and ends when the callee leaves.
 * - owner: on the agent's `bring_owner_in` tool call, subject to the owner's
 *   quiet hours and daily cap (a bridge rings him, so it counts as an owner
 *   call). When he answers, Twilio fetches his TwiML; the agent is put on hold
 *   and muted first, and only if that succeeded is he told the brief and joined
 *   (fail closed: his verification details never reach the agent's transcript).
 *   When he hangs up the agent is taken off hold, hears a hand-back
 *   announcement, and is unmuted.
 *
 * End of call: the server ends the conference when the agent leaves without
 * the owner on the line, when the agent never answers or answers without its
 * brief, and when the callee does not answer (with a `Phone: not connected`
 * row); a callee hang-up ends it by itself. The ElevenLabs post-call webhook
 * then writes `Phone: ended` as for any call.
 *
 * One call is in flight per server: the record lives in
 * `ConferenceCallStateStore`, every transition is serialized by one lock and
 * saved, and status callbacks are idempotent on (call sid, status). A record
 * older than two hours is abandoned (best-effort conference end, `Phone:
 * outcome unknown` row) the next time anything reads it.
 *
 * @module ConferenceCalls
 */
import { CommandCenterError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as CommandCenterService from "../Service.ts";
import * as SpaceActivity from "../SpaceActivity.ts";
import { isSpaceAgentQuietTime } from "../SpaceAgentWaker.ts";
import type { PhoneCallDynamicVariables } from "./ElevenLabsClient.ts";
import {
  CONFERENCE_CALL_MAX_AGE_MS,
  type ConferenceCallRecord,
  ConferenceCallStateStore,
  type ConferenceLeg,
  type ConferenceLegName,
  type ConferencePhase,
  conferenceName,
  isTerminalLegStatus,
  isTerminalPhase,
  type LegStatus,
  type OwnerBridge,
  type OwnerBridgeState,
  twilioCallbackUrl,
} from "./ConferenceCallState.ts";
import {
  isPhoneConferenceConnection,
  maskPhoneNumber,
  type PhoneConferenceConnection,
} from "./PhoneConnection.ts";
import {
  clip,
  countPhoneCallsToday,
  outcomeUnknownError,
  PHONE_ACTIVITY_SOURCE_KIND,
  PHONE_OWNER_CALLS_PER_DAY,
  type PhoneCallOutcome,
  phoneCallingTitle,
  PhoneCallStatus,
  phoneCallTarget,
  phoneCallTimezone,
  PhoneConferenceDialer,
  type PhoneConferenceDialerShape,
  PhoneDialLock,
  phoneStartSourceId,
  phoneTitleFromStart,
  phoneUncertainSourceId,
  START_SUMMARY_CHARS,
  thirdPartyDynamicVariables,
} from "./PhoneCalls.ts";
import {
  TwilioClient,
  type TwilioRequestError,
  twilioRequestMayHaveStarted,
} from "./TwilioClient.ts";

/** Seconds Twilio lets each leg ring. */
const AGENT_RING_SECONDS = 20;
const CALLEE_RING_SECONDS = 45;
const OWNER_RING_SECONDS = 30;
/** How long `bring_owner_in` waits for the owner to answer or the attempt to fail. */
export const BRIDGE_WAIT_MS = 45_000;
/** The hold happens while Twilio waits for the owner's TwiML (15 s fetch timeout). */
const OWNER_HOLD_TIMEOUT_MS = 10_000;
const REASON_CHARS = 300;
const STATUS_EVENTS = ["answered", "completed"] as const;

export const CALL_IN_PROGRESS_REASON =
  "Another phone call is in progress; only one conference call runs at a time. Try again after it ends.";

// ── TwiML ────────────────────────────────────────────────────────────────────

const XML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};
const escapeXml = (text: string) => text.replace(/[&<>"']/gu, (match) => XML_ESCAPES[match] ?? "");

const twiml = (...verbs: ReadonlyArray<string>) =>
  `<?xml version="1.0" encoding="UTF-8"?><Response>${verbs.join("")}</Response>`;
const say = (text: string) => `<Say>${escapeXml(text)}</Say>`;

/** Whitespace collapsed, trailing sentence punctuation dropped, then one period. */
const asSentence = (text: string) =>
  `${text
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[\s.!?]+$/u, "")}.`;

/** Silence for a held or waiting agent (Twilio loops hold and wait TwiML). */
export const HOLD_TWIML = twiml('<Pause length="600"/>');

/** What the agent hears when the owner hangs up. */
export const announceTwiml = (ownerName: string) =>
  twiml(say(`${ownerName} has finished and left the call. Continue with the callee.`));

const hangupTwiml = (text: string) => twiml(say(text), "<Hangup/>");

export const CALL_ALREADY_ENDED_TWIML = hangupTwiml(
  "Command Center. This call has already ended. Goodbye.",
);

const ownerJoinTwiml = (record: ConferenceCallRecord, bridge: OwnerBridge) =>
  twiml(
    say(
      [
        "Command Center.",
        asSentence(`I have ${record.plan.calleeName} on the line about ${record.plan.purpose}`),
        asSentence(bridge.reason),
        "Hang up when you are done; the assistant continues the call.",
      ].join(" "),
    ),
    `<Dial><Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="false">${escapeXml(
      conferenceName(record.callId),
    )}</Conference></Dial>`,
  );

// ── Service ──────────────────────────────────────────────────────────────────

export interface InitiationRequest {
  readonly conversationId: string;
  readonly agentId?: string;
  readonly calledNumber?: string;
  readonly callSid?: string;
}

export type InitiationResult =
  | { readonly kind: "matched"; readonly dynamicVariables: PhoneCallDynamicVariables }
  | { readonly kind: "not-found" };

export interface BringOwnerInRequest {
  /** One line, at most 300 characters (the route normalizes it). */
  readonly reason: string;
  readonly conversationId?: string;
  readonly callSid?: string;
}

export type BringOwnerInStatus = "joined" | "no-answer" | "busy" | "failed" | "refused" | "calling";

export interface BringOwnerInResult {
  readonly status: BringOwnerInStatus;
  /** Spoken guidance for the agent; never contains a phone number. */
  readonly message: string;
}

export interface TwilioStatusEvent {
  readonly callId: string;
  readonly leg: ConferenceLegName;
  readonly callSid: string;
  readonly callStatus: string;
}

export type TwilioStatusOutcome = "applied" | "duplicate" | "ignored" | "unknown-call";

export interface ConferenceCallsShape {
  readonly start: PhoneConferenceDialerShape["start"];
  readonly initiation: (
    connection: PhoneConferenceConnection,
    request: InitiationRequest,
  ) => Effect.Effect<InitiationResult, CommandCenterError>;
  readonly bringOwnerIn: (
    connection: PhoneConferenceConnection,
    request: BringOwnerInRequest,
  ) => Effect.Effect<BringOwnerInResult, CommandCenterError>;
  readonly twilioStatus: (
    connection: PhoneConferenceConnection,
    event: TwilioStatusEvent,
  ) => Effect.Effect<TwilioStatusOutcome, CommandCenterError>;
  /** TwiML for the owner leg; puts the agent on hold before the owner can join. */
  readonly ownerTwiml: (
    connection: PhoneConferenceConnection,
    input: { readonly callId: string; readonly callSid: string },
  ) => Effect.Effect<string, CommandCenterError>;
}

export class ConferenceCalls extends Context.Service<ConferenceCalls, ConferenceCallsShape>()(
  "@awtprod/command-center/command-center/phone/ConferenceCalls",
) {}

/** Twilio `CallStatus` values that move a leg; ringing and queued do not. */
const legStatusOf = (callStatus: string): LegStatus | undefined => {
  switch (callStatus) {
    case "in-progress":
    case "answered":
      return "answered";
    case "completed":
    case "busy":
    case "no-answer":
    case "failed":
    case "canceled":
      return callStatus;
    default:
      return undefined;
  }
};

/**
 * The leg after a status event, or `None` for a duplicate or late event. A
 * terminal leg never changes again; `completed` means the call was answered.
 */
export const nextLeg = (
  previous: ConferenceLeg,
  status: LegStatus,
  updatedAt: string,
): Option.Option<ConferenceLeg> => {
  if (isTerminalLegStatus(previous.status)) return Option.none();
  if (status === "answered" && previous.answered) return Option.none();
  return Option.some({
    ...previous,
    status,
    answered: previous.answered || status === "answered" || status === "completed",
    updatedAt,
  });
};

const bridgeStateAfter = (bridge: OwnerBridge, leg: ConferenceLeg): OwnerBridgeState => {
  if (bridge.state === "joined") return "ended";
  if (bridge.state !== "calling") return bridge.state;
  switch (leg.status) {
    case "busy":
      return "busy";
    case "no-answer":
    case "canceled":
      return "no-answer";
    default:
      // Answered but never joined (hung up during the brief, or the TwiML failed).
      return "failed";
  }
};

const bridgeActive = (record: ConferenceCallRecord): boolean =>
  record.owner !== undefined &&
  (record.owner.state === "calling" || record.owner.state === "joined") &&
  !isTerminalLegStatus(record.owner.leg.status);

const legOf = (record: ConferenceCallRecord, leg: ConferenceLegName) =>
  leg === "agent" ? record.agent : leg === "callee" ? record.callee : record.owner?.leg;

const withLeg = (
  record: ConferenceCallRecord,
  leg: ConferenceLegName,
  value: ConferenceLeg,
): ConferenceCallRecord => {
  if (leg === "agent") return { ...record, agent: value };
  if (leg === "callee") return { ...record, callee: value };
  return record.owner === undefined
    ? record
    : { ...record, owner: { ...record.owner, leg: value } };
};

const persistence = (message: string) => (cause: unknown) =>
  new CommandCenterError({ reason: "persistence", message, cause });

/** @public Exported so tests can build a second instance over the same state file (a restart). */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const activity = yield* SpaceActivity.SpaceActivity;
  const commandCenter = yield* CommandCenterService.CommandCenterService;
  const crypto = yield* Crypto.Crypto;
  const twilio = yield* TwilioClient;
  const store = yield* ConferenceCallStateStore;
  const dialLock = yield* PhoneDialLock;
  // Serializes every read-modify-write of the record (callbacks, tools, start).
  const stateLock = yield* Semaphore.make(1);
  // The last saved record, for `bring_owner_in` waiters in this process.
  const latest = yield* SubscriptionRef.make<Option.Option<ConferenceCallRecord>>(Option.none());

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const save = (record: ConferenceCallRecord) =>
    store.save(record).pipe(Effect.andThen(SubscriptionRef.set(latest, Option.some(record))));

  /** Move to `phase`, save, and log the transition. */
  const transition = Effect.fn("ConferenceCalls.transition")(function* (
    record: ConferenceCallRecord,
    phase: ConferencePhase,
    patch: Partial<ConferenceCallRecord> = {},
  ) {
    const next: ConferenceCallRecord = {
      ...record,
      ...patch,
      phase,
      updatedAt: yield* nowIso,
    };
    yield* save(next);
    if (phase !== record.phase) {
      yield* Effect.logInfo("phone conference call transition", {
        callId: record.callId,
        from: record.phase,
        to: phase,
      });
    }
    return next;
  });

  const calleeLabel = (record: ConferenceCallRecord) => phoneCallTarget(record.plan).id;

  const writeRow = (
    record: ConferenceCallRecord,
    row: {
      readonly sourceId: string;
      readonly title: string;
      readonly status: string;
      readonly text: string;
    },
  ) =>
    Effect.gen(function* () {
      return yield* activity.record({
        spaceId: record.spaceId,
        occurredAt: yield* nowIso,
        sourceKind: PHONE_ACTIVITY_SOURCE_KIND,
        sourceId: row.sourceId,
        projectId: null,
        title: row.title,
        status: row.status,
        text: clip(row.text, START_SUMMARY_CHARS),
        eventSequence: SpaceActivity.SPACE_ACTIVITY_EXTERNAL_EVENT_SEQUENCE,
      });
    });

  /** Rows other than the start row are informative; a failure is logged, not fatal. */
  const writeRowLogged = (record: ConferenceCallRecord, row: Parameters<typeof writeRow>[1]) =>
    writeRow(record, row).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("phone conference activity row could not be recorded", {
          callId: record.callId,
          sourceId: row.sourceId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(false)),
      ),
    );

  const logFailure = (message: string, record: ConferenceCallRecord) => (error: unknown) =>
    Effect.logWarning(message, { callId: record.callId, cause: error });

  /** Ends the conference if Twilio created one; a failure is logged. */
  const endConference = (connection: PhoneConferenceConnection, record: ConferenceCallRecord) =>
    record.conferenceSid === undefined
      ? Effect.void
      : twilio
          .endConference(connection.twilio, record.conferenceSid)
          .pipe(Effect.catch(logFailure("phone conference could not be ended", record)));

  /** Persist `ending` (a crash marker), end the conference, then the terminal phase. */
  const endCall = Effect.fn("ConferenceCalls.endCall")(function* (
    connection: PhoneConferenceConnection,
    record: ConferenceCallRecord,
    outcome: "ended" | "failed",
  ) {
    const ending = yield* transition(record, "ending");
    yield* endConference(connection, ending);
    return yield* transition(ending, outcome);
  });

  const notConnected = Effect.fn("ConferenceCalls.notConnected")(function* (
    connection: PhoneConferenceConnection,
    record: ConferenceCallRecord,
    reason: string,
  ) {
    yield* writeRowLogged(record, {
      sourceId: `phone-not-connected:${record.callId}`,
      title: phoneTitleFromStart(
        phoneCallingTitle(calleeLabel(record), record.plan.purpose),
        "not connected",
      ),
      status: PhoneCallStatus.notConnected,
      text: `The call did not connect: ${reason}.`,
    });
    return yield* endCall(connection, record, "failed");
  });

  const abandon = Effect.fn("ConferenceCalls.abandon")(function* (
    connection: PhoneConferenceConnection,
    record: ConferenceCallRecord,
  ) {
    yield* endConference(connection, record);
    const abandoned = yield* transition(record, "abandoned");
    yield* writeRowLogged(record, {
      sourceId: `phone-abandoned:${record.callId}`,
      title: `Phone: outcome unknown ${calleeLabel(record)} — ${record.plan.purpose}`,
      status: PhoneCallStatus.outcomeUnknown,
      text: [
        "Command Center had no final status for this call after two hours and stopped tracking it;",
        "it was ended if it was still live. Check the ElevenLabs conversation history.",
      ].join(" "),
    });
    return abandoned;
  });

  /** The stored record, after abandoning it when it is too old. Callers hold `stateLock`. */
  const loadCurrent = (connection: PhoneConferenceConnection) =>
    Effect.gen(function* () {
      const stored = yield* store.load;
      if (Option.isNone(stored) || isTerminalPhase(stored.value.phase)) return stored;
      const nowMs = yield* Clock.currentTimeMillis;
      const created = DateTime.make(stored.value.createdAt);
      if (
        Option.isSome(created) &&
        nowMs - DateTime.toEpochMillis(created.value) <= CONFERENCE_CALL_MAX_AGE_MS
      ) {
        return stored;
      }
      return Option.some(yield* abandon(connection, stored.value));
    });

  const statusCallback = (
    connection: PhoneConferenceConnection,
    callId: string,
    leg: ConferenceLegName,
  ) =>
    twilioCallbackUrl({
      publicBaseUrl: connection.conference.publicBaseUrl,
      route: "status",
      callId,
      leg,
    });

  // ── start ────────────────────────────────────────────────────────────────

  const recordOutcomeUnknown = (record: ConferenceCallRecord, detail: string) =>
    writeRowLogged(record, {
      sourceId: phoneUncertainSourceId("third-party", record.spaceId, record.attemptId),
      title: `Phone: outcome unknown ${calleeLabel(record)} — ${record.plan.purpose}`,
      status: PhoneCallStatus.outcomeUnknown,
      text: [
        detail,
        "Twilio may have started this call, so it may be ringing; do not retry it.",
        "It counts toward today's call limit.",
      ].join(" "),
    });

  const start: ConferenceCallsShape["start"] = (input) =>
    stateLock
      .withPermits(1)(
        Effect.gen(function* () {
          const connection = input.connection;
          if (!isPhoneConferenceConnection(connection)) {
            return yield* new CommandCenterError({
              reason: "config",
              message: "The phone connection is not in conference mode.",
            });
          }
          const current = yield* loadCurrent(connection);
          if (Option.isSome(current) && !isTerminalPhase(current.value.phase)) {
            return { placed: false, reason: CALL_IN_PROGRESS_REASON } satisfies PhoneCallOutcome;
          }
          const callId = yield* crypto
            .randomUUIDv4()
            .pipe(Effect.mapError(persistence("Could not create a call id; nothing was dialed.")));
          const now = yield* nowIso;
          const created: ConferenceCallRecord = {
            version: 1,
            callId,
            spaceId: input.plan.spaceId,
            attemptId: input.attemptId,
            plan: input.plan,
            phase: "dialing-agent",
            agent: { status: "dialing", answered: false, updatedAt: now },
            bridgeCount: 0,
            createdAt: now,
            updatedAt: now,
          };
          // Saved before dialing, so callbacks that beat the REST answer find the call.
          yield* save(created);
          const agent = yield* Effect.result(
            twilio.addParticipant(connection.twilio, {
              conferenceName: conferenceName(callId),
              from: connection.conference.callerId.owner,
              to: connection.conference.inboundNumber,
              label: "agent",
              startConferenceOnEnter: false,
              endConferenceOnExit: false,
              timeout: AGENT_RING_SECONDS,
              statusCallback: statusCallback(connection, callId, "agent"),
              statusCallbackEvents: STATUS_EVENTS,
              waitUrl: twilioCallbackUrl({
                publicBaseUrl: connection.conference.publicBaseUrl,
                route: "hold",
                callId,
              }),
            }),
          );
          if (agent._tag === "Failure") {
            const error: TwilioRequestError = agent.failure;
            if (!twilioRequestMayHaveStarted(error)) {
              yield* transition(created, "failed", {
                agent: { ...created.agent, status: "failed", updatedAt: yield* nowIso },
              }).pipe(Effect.catch(logFailure("failed call could not be saved", created)));
              return yield* new CommandCenterError({
                reason: "connector",
                message: `Twilio refused the call. ${error.message}`,
                cause: error,
              });
            }
            // It may be ringing: keep the record so its callbacks still match, and count it.
            return yield* outcomeUnknownError(
              error,
              yield* recordOutcomeUnknown(created, error.message),
              "Twilio",
            );
          }
          const saved = yield* Effect.result(
            transition(created, "dialing-agent", {
              agent: { ...created.agent, callSid: agent.success.callSid },
              conferenceSid: agent.success.conferenceSid,
            }),
          );
          if (saved._tag === "Failure") {
            const message = "The call started but its state could not be saved.";
            yield* Effect.logWarning(message, { callId, cause: saved.failure });
            return yield* outcomeUnknownError(
              { message },
              yield* recordOutcomeUnknown(created, message),
              "Twilio",
            );
          }
          return { placed: true } satisfies PhoneCallOutcome;
        }),
      )
      .pipe(Effect.uninterruptible, Effect.withSpan("ConferenceCalls.start"));

  // ── initiation ───────────────────────────────────────────────────────────

  const initiation: ConferenceCallsShape["initiation"] = (connection, request) =>
    stateLock
      .withPermits(1)(
        Effect.gen(function* () {
          const notFound = { kind: "not-found" } as const;
          if (request.agentId !== undefined && request.agentId !== connection.agentId) {
            return notFound;
          }
          const current = yield* loadCurrent(connection);
          if (Option.isNone(current) || isTerminalPhase(current.value.phase)) return notFound;
          const record = current.value;
          const matched = {
            kind: "matched",
            dynamicVariables: thirdPartyDynamicVariables(record.plan, connection.ownerName),
          } as const;
          if (record.conversationId !== undefined) {
            // A repeated initiation of the same conversation gets the same answer.
            return record.conversationId === request.conversationId ? matched : notFound;
          }
          const bySid = request.callSid !== undefined && request.callSid === record.agent.callSid;
          const byNumber = request.calledNumber === connection.conference.inboundNumber;
          if (record.phase !== "dialing-agent" || !(bySid || byNumber)) return notFound;
          // The start row first: without it the call would neither count nor get its end row.
          yield* writeRow(record, {
            sourceId: phoneStartSourceId(request.conversationId),
            title: phoneCallingTitle(calleeLabel(record), record.plan.purpose),
            status: PhoneCallStatus.callingThirdParty,
            text: record.plan.brief,
          });
          yield* transition(record, "dialing-agent", {
            conversationId: request.conversationId,
            ...(request.callSid !== undefined && /^CA[0-9a-f]{32}$/u.test(request.callSid)
              ? { agentInboundCallSid: request.callSid }
              : {}),
          });
          return matched;
        }),
      )
      .pipe(
        // A dropped request must not split a Twilio call from the record of it.
        Effect.uninterruptible,
        Effect.withSpan("ConferenceCalls.initiation"),
      );

  // ── status callbacks ─────────────────────────────────────────────────────

  const onAgentAnswered = Effect.fn("ConferenceCalls.onAgentAnswered")(function* (
    connection: PhoneConferenceConnection,
    record: ConferenceCallRecord,
  ) {
    if (record.phase !== "dialing-agent") return record;
    if (record.conversationId === undefined) {
      return yield* notConnected(
        connection,
        record,
        "the call agent answered without loading its brief",
      );
    }
    const answered = yield* transition(record, "agent-answered");
    const callee = yield* Effect.result(
      twilio.addParticipant(connection.twilio, {
        conferenceName: conferenceName(record.callId),
        from: connection.conference.callerId.callee,
        to: record.plan.to,
        label: "callee",
        startConferenceOnEnter: true,
        endConferenceOnExit: true,
        timeout: CALLEE_RING_SECONDS,
        statusCallback: statusCallback(connection, record.callId, "callee"),
        statusCallbackEvents: STATUS_EVENTS,
      }),
    );
    const dialing: ConferenceLeg = { status: "dialing", answered: false, updatedAt: yield* nowIso };
    if (callee._tag === "Failure") {
      if (!twilioRequestMayHaveStarted(callee.failure)) {
        return yield* notConnected(
          connection,
          answered,
          `Twilio refused to dial the callee (${callee.failure.message})`,
        );
      }
      // It may be ringing; its own callbacks will tell.
      yield* logFailure("callee leg outcome unknown", answered)(callee.failure);
      return yield* transition(answered, "dialing-callee", { callee: dialing });
    }
    return yield* transition(answered, "dialing-callee", {
      callee: { ...dialing, callSid: callee.success.callSid },
    });
  });

  /**
   * Take the agent off hold, play the hand-back announcement, unmute. Each step
   * is attempted even if an earlier one failed; returns whether all succeeded.
   */
  const restoreAgent = Effect.fn("ConferenceCalls.restoreAgent")(function* (
    connection: PhoneConferenceConnection,
    record: ConferenceCallRecord,
  ) {
    if (record.conferenceSid === undefined || record.agent.callSid === undefined) return false;
    const target = { conferenceSid: record.conferenceSid, callSid: record.agent.callSid };
    const step = (
      request: Omit<Parameters<typeof twilio.updateParticipant>[1], "conferenceSid" | "callSid">,
    ) =>
      twilio.updateParticipant(connection.twilio, { ...target, ...request }).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          logFailure("agent could not be restored", record)(error).pipe(Effect.as(false)),
        ),
      );
    const unheld = yield* step({ hold: false });
    const announced = yield* step({
      announceUrl: twilioCallbackUrl({
        publicBaseUrl: connection.conference.publicBaseUrl,
        route: "announce",
        callId: record.callId,
      }),
    });
    const unmuted = yield* step({ muted: false });
    return unheld && announced && unmuted;
  });

  const onOwnerDone = Effect.fn("ConferenceCalls.onOwnerDone")(function* (
    connection: PhoneConferenceConnection,
    record: ConferenceCallRecord,
    bridge: OwnerBridge,
  ) {
    const joined = bridge.state === "joined";
    const done: OwnerBridge = { ...bridge, state: bridgeStateAfter(bridge, bridge.leg) };
    const backInProgress =
      record.phase === "bridging-owner" || record.phase === "owner-joined"
        ? "in-progress"
        : record.phase;
    const updated = yield* transition(record, backInProgress, { owner: done });
    if (isTerminalLegStatus(updated.agent.status)) {
      // The agent left while the owner talked; the callee is not left alone.
      return yield* endCall(connection, updated, "ended");
    }
    const restored = bridge.held ? yield* restoreAgent(connection, updated) : true;
    if (joined) {
      const owner = connection.ownerName;
      yield* writeRowLogged(updated, {
        sourceId: `phone-bridge-end:${updated.callId}:${bridge.n}`,
        title: restored
          ? `Phone: ${owner} left; assistant continued`
          : `Phone: ${owner} left; assistant could not be taken off hold`,
        status: PhoneCallStatus.bridgeEnded,
        text: restored
          ? `${owner} finished talking with ${calleeLabel(updated)}; the assistant took the call back.`
          : `${owner} finished talking with ${calleeLabel(updated)}, but the assistant could not be taken off hold, so the callee may be waiting in silence.`,
      });
    }
    return updated;
  });

  const twilioStatus: ConferenceCallsShape["twilioStatus"] = (connection, event) =>
    stateLock
      .withPermits(1)(
        Effect.gen(function* () {
          const current = yield* loadCurrent(connection);
          if (Option.isNone(current) || current.value.callId !== event.callId) {
            yield* Effect.logInfo("phone conference callback for an unknown call", {
              callId: event.callId,
              leg: event.leg,
            });
            return "unknown-call" as const;
          }
          const record = current.value;
          const status = legStatusOf(event.callStatus);
          const previous = legOf(record, event.leg);
          if (
            status === undefined ||
            previous === undefined ||
            (previous.callSid !== undefined && previous.callSid !== event.callSid)
          ) {
            return "ignored" as const;
          }
          const next = nextLeg(previous, status, yield* nowIso);
          if (Option.isNone(next)) return "duplicate" as const;
          const leg: ConferenceLeg = { ...next.value, callSid: event.callSid };
          const updated = yield* transition(withLeg(record, event.leg, leg), record.phase);
          yield* Effect.logInfo("phone conference leg status", {
            callId: record.callId,
            leg: event.leg,
            status,
          });
          // A late callback after the call ended only updates its leg.
          if (isTerminalPhase(updated.phase)) return "applied" as const;
          const terminal = isTerminalLegStatus(status);
          switch (event.leg) {
            case "agent":
              if (!terminal) {
                yield* onAgentAnswered(connection, updated);
              } else if (!leg.answered) {
                yield* notConnected(
                  connection,
                  updated,
                  `the call agent did not answer (${status})`,
                );
              } else if (!bridgeActive(updated)) {
                yield* endCall(connection, updated, "ended");
              }
              // With the owner on the line, the call ends when he leaves.
              break;
            case "callee":
              if (!terminal) {
                if (updated.phase === "agent-answered" || updated.phase === "dialing-callee") {
                  yield* transition(updated, "in-progress");
                }
              } else if (!leg.answered) {
                yield* notConnected(
                  connection,
                  updated,
                  `${updated.plan.calleeName} did not answer (${status})`,
                );
              } else {
                // The callee leaving ends the conference (EndConferenceOnExit).
                yield* transition(updated, "ended");
              }
              break;
            case "owner":
              if (terminal && updated.owner !== undefined) {
                yield* onOwnerDone(connection, updated, updated.owner);
              }
              break;
          }
          return "applied" as const;
        }),
      )
      .pipe(
        // A dropped request must not split a Twilio call from the record of it.
        Effect.uninterruptible,
        Effect.withSpan("ConferenceCalls.twilioStatus"),
      );

  // ── owner TwiML ──────────────────────────────────────────────────────────

  const ownerTwiml: ConferenceCallsShape["ownerTwiml"] = (connection, input) =>
    stateLock
      .withPermits(1)(
        Effect.gen(function* () {
          const current = yield* loadCurrent(connection);
          if (Option.isNone(current) || current.value.callId !== input.callId) {
            return CALL_ALREADY_ENDED_TWIML;
          }
          const record = current.value;
          const bridge = record.owner;
          const agentCallSid = record.agent.callSid;
          const conferenceSid = record.conferenceSid;
          if (
            record.phase !== "bridging-owner" ||
            bridge === undefined ||
            bridge.state !== "calling" ||
            (bridge.leg.callSid !== undefined && bridge.leg.callSid !== input.callSid) ||
            agentCallSid === undefined ||
            conferenceSid === undefined ||
            isTerminalLegStatus(record.agent.status) ||
            record.callee === undefined ||
            !record.callee.answered ||
            isTerminalLegStatus(record.callee.status)
          ) {
            return CALL_ALREADY_ENDED_TWIML;
          }
          const now = yield* nowIso;
          // Saved before the hold request, so the owner's hang-up always restores the agent.
          const holding = yield* transition(record, "bridging-owner", {
            owner: {
              ...bridge,
              held: true,
              leg: { ...bridge.leg, callSid: input.callSid, answered: true, updatedAt: now },
            },
          });
          const held = yield* twilio
            .updateParticipant(connection.twilio, {
              conferenceSid,
              callSid: agentCallSid,
              hold: true,
              holdUrl: twilioCallbackUrl({
                publicBaseUrl: connection.conference.publicBaseUrl,
                route: "hold",
                callId: record.callId,
              }),
              muted: true,
            })
            .pipe(Effect.timeoutOption(Duration.millis(OWNER_HOLD_TIMEOUT_MS)), Effect.result);
          const heldBridge = holding.owner ?? bridge;
          if (held._tag === "Failure" || Option.isNone(held.success)) {
            yield* Effect.logWarning("agent could not be put on hold; the owner is not joined", {
              callId: record.callId,
              cause: held._tag === "Failure" ? held.failure : "timeout",
            });
            yield* transition(holding, "in-progress", {
              owner: { ...heldBridge, state: "failed" },
            });
            return hangupTwiml(
              "Command Center. The assistant could not step out of the call, so you are not connected. Goodbye.",
            );
          }
          const joined = yield* transition(holding, "owner-joined", {
            owner: { ...heldBridge, state: "joined" },
          });
          return ownerJoinTwiml(joined, joined.owner ?? heldBridge);
        }),
      )
      .pipe(
        // A dropped request must not split a Twilio call from the record of it.
        Effect.uninterruptible,
        Effect.withSpan("ConferenceCalls.ownerTwiml"),
      );

  // ── bring_owner_in ───────────────────────────────────────────────────────

  const matchesRequest = (record: ConferenceCallRecord, request: BringOwnerInRequest) =>
    (request.conversationId === undefined || request.conversationId === record.conversationId) &&
    (request.callSid === undefined ||
      request.callSid === record.agentInboundCallSid ||
      request.callSid === record.agent.callSid);

  /** The answer for a bridge that is already under way, if there is one. */
  const bridgeInProgress = (
    connection: PhoneConferenceConnection,
    record: ConferenceCallRecord,
  ): Option.Option<BringOwnerInResult> => {
    if (!bridgeActive(record) || record.owner === undefined) return Option.none();
    const owner = connection.ownerName;
    return Option.some(
      record.owner.state === "joined"
        ? {
            status: "joined",
            message: `${owner} is already on the call. Stay silent until you hear that ${owner} has left.`,
          }
        : {
            status: "calling",
            message: `${owner} is already being called. Ask the callee to keep holding and stay silent.`,
          },
    );
  };

  const refused = (message: string): BringOwnerInResult => ({ status: "refused", message });

  const settledResult = (
    connection: PhoneConferenceConnection,
    state: OwnerBridgeState | "call-ended" | "calling",
  ): BringOwnerInResult => {
    const owner = connection.ownerName;
    const unavailable = `Tell the callee that ${owner} is not available right now and continue the call without ${owner}.`;
    switch (state) {
      case "joined":
        return {
          status: "joined",
          message: `${owner} has joined the call. You are on hold and muted while ${owner} talks with the callee; say nothing until you hear that ${owner} has left.`,
        };
      case "ended":
        return {
          status: "joined",
          message: `${owner} joined and has already left. Continue the call with the callee.`,
        };
      case "busy":
        return { status: "busy", message: `${owner}'s line is busy. ${unavailable}` };
      case "no-answer":
        return { status: "no-answer", message: `${owner} did not answer. ${unavailable}` };
      case "failed":
        return { status: "failed", message: `${owner} could not be connected. ${unavailable}` };
      case "call-ended":
        return { status: "failed", message: "The call has ended." };
      case "calling":
        return {
          status: "calling",
          message: `${owner}'s phone is still ringing. Ask the callee to keep holding; you are put on hold automatically if ${owner} answers.`,
        };
    }
  };

  /** The state of bridge `n` of `callId` in a saved record. */
  const bridgeStateIn = (
    stored: Option.Option<ConferenceCallRecord>,
    callId: string,
    n: number,
  ): OwnerBridgeState | "call-ended" => {
    if (Option.isNone(stored) || stored.value.callId !== callId) return "call-ended";
    const record = stored.value;
    if (record.owner === undefined || record.owner.n !== n) return "call-ended";
    if (record.owner.state === "calling" && isTerminalPhase(record.phase)) return "call-ended";
    return record.owner.state;
  };

  /**
   * The first settled state of bridge `n`, or `calling` at `deadlineMs`. The
   * subscription and its timer end with the wait, on interruption too.
   */
  const waitForBridge = (callId: string, n: number, deadlineMs: number) =>
    Effect.gen(function* () {
      const remainingMs = deadlineMs - (yield* Clock.currentTimeMillis);
      if (remainingMs <= 0) {
        return bridgeStateIn(yield* SubscriptionRef.get(latest), callId, n);
      }
      const settled = yield* SubscriptionRef.changes(latest).pipe(
        Stream.map((stored) => bridgeStateIn(stored, callId, n)),
        Stream.filter((state) => state !== "calling"),
        Stream.runHead,
        Effect.timeoutOption(Duration.millis(remainingMs)),
      );
      return Option.getOrElse(Option.flatten(settled), () => "calling" as const);
    });

  const bringOwnerIn: ConferenceCallsShape["bringOwnerIn"] = Effect.fn(
    "ConferenceCalls.bringOwnerIn",
  )(function* (connection, request) {
    const owner = connection.ownerName;
    const noCall = refused(`There is no call in progress to bring ${owner} into.`);
    const found = yield* stateLock.withPermits(1)(loadCurrent(connection));
    if (
      Option.isNone(found) ||
      isTerminalPhase(found.value.phase) ||
      !matchesRequest(found.value, request)
    ) {
      return noCall;
    }
    const repeat = bridgeInProgress(connection, found.value);
    if (Option.isSome(repeat)) return repeat.value;
    if (found.value.phase !== "in-progress") {
      return refused(`The callee is not on the line yet, so ${owner} cannot be brought in now.`);
    }
    const space = yield* commandCenter.getConfiguredSpace(found.value.spaceId);
    const dialed = yield* dialLock.withPermits(1)(
      Effect.gen(function* () {
        // Clock, quiet hours, and cap are read under the lock, as for owner calls.
        const nowMs = yield* Clock.currentTimeMillis;
        if (space.agent !== undefined && isSpaceAgentQuietTime(space.agent, nowMs)) {
          return refused(
            `It is ${owner}'s quiet hours, so ${owner} cannot be brought in now. Tell the callee and offer a callback.`,
          );
        }
        const placedToday = yield* countPhoneCallsToday({
          spaceId: found.value.spaceId,
          kind: "owner",
          nowMs,
          timezone: phoneCallTimezone(space.agent),
        }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
        if (placedToday >= PHONE_OWNER_CALLS_PER_DAY) {
          return refused(
            `${owner} was already called ${placedToday} times today (limit ${PHONE_OWNER_CALLS_PER_DAY}), so ${owner} cannot be brought in now. Tell the callee and offer a callback.`,
          );
        }
        return yield* stateLock.withPermits(1)(
          Effect.gen(function* () {
            // The call may have moved on while this request waited for the locks.
            const latestRecord = yield* loadCurrent(connection);
            if (
              Option.isNone(latestRecord) ||
              latestRecord.value.callId !== found.value.callId ||
              isTerminalPhase(latestRecord.value.phase)
            ) {
              return noCall;
            }
            const record = latestRecord.value;
            const again = bridgeInProgress(connection, record);
            if (Option.isSome(again)) return again.value;
            if (record.phase !== "in-progress") {
              return refused(
                `The callee is not on the line, so ${owner} cannot be brought in now.`,
              );
            }
            const now = yield* nowIso;
            // The wait is bounded from the moment the owner's phone is dialed.
            const deadlineMs = (yield* Clock.currentTimeMillis) + BRIDGE_WAIT_MS;
            const n = record.bridgeCount + 1;
            const bridging = yield* transition(record, "bridging-owner", {
              bridgeCount: n,
              owner: {
                n,
                reason: request.reason,
                state: "calling",
                held: false,
                leg: { status: "dialing", answered: false, updatedAt: now },
                requestedAt: now,
              },
            });
            const call = yield* Effect.result(
              twilio.createCall(connection.twilio, {
                from: connection.conference.callerId.owner,
                to: connection.ownerNumber,
                url: twilioCallbackUrl({
                  publicBaseUrl: connection.conference.publicBaseUrl,
                  route: "owner-twiml",
                  callId: record.callId,
                }),
                timeout: OWNER_RING_SECONDS,
                statusCallback: statusCallback(connection, record.callId, "owner"),
                statusCallbackEvents: STATUS_EVENTS,
              }),
            );
            const bridge = bridging.owner;
            if (bridge === undefined) return noCall;
            if (call._tag === "Failure" && !twilioRequestMayHaveStarted(call.failure)) {
              yield* logFailure("owner leg was refused", record)(call.failure);
              yield* transition(bridging, "in-progress", {
                owner: { ...bridge, state: "failed" },
              });
              return settledResult(connection, "failed");
            }
            if (call._tag === "Success") {
              yield* transition(bridging, "bridging-owner", {
                owner: { ...bridge, leg: { ...bridge.leg, callSid: call.success.callSid } },
              });
            } else {
              // It may be ringing; the owner leg's callbacks carry its sid.
              yield* logFailure("owner leg outcome unknown", record)(call.failure);
            }
            // The owner's phone rings: this counts as an owner call.
            yield* writeRowLogged(record, {
              sourceId: `phone-bridge:${record.callId}:${n}`,
              title: `Phone: bringing ${owner} in — ${clip(request.reason, 200)}`,
              status: PhoneCallStatus.bridgingOwner,
              text: `Calling ${owner} (${maskPhoneNumber(connection.ownerNumber)}) into the call with ${calleeLabel(record)}: ${request.reason}`,
            });
            return { n, deadlineMs };
          }),
        );
      }).pipe(Effect.uninterruptible),
    );
    if ("status" in dialed) return dialed;
    return settledResult(
      connection,
      yield* waitForBridge(found.value.callId, dialed.n, dialed.deadlineMs),
    );
  });

  return ConferenceCalls.of({ start, initiation, bringOwnerIn, twilioStatus, ownerTwiml });
});

/** Provides `ConferenceCalls` and, from the same instance, the `PhoneConferenceDialer` `PhoneCalls` uses. */
export const layer = Layer.effectContext(
  Effect.map(make, (calls) =>
    Context.make(ConferenceCalls, calls).pipe(
      Context.add(PhoneConferenceDialer, PhoneConferenceDialer.of({ start: calls.start })),
    ),
  ),
);

/** Agent-facing reason text: one line, at most 300 characters. */
export const normalizeBridgeReason = (reason: string): string =>
  clip(reason.replace(/\s+/gu, " ").trim(), REASON_CHARS);
