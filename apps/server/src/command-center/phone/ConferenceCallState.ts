/**
 * ConferenceCallState - the one conference-mode third-party call this server
 * tracks, persisted as `<stateDir>/phone/active-call.json`.
 *
 * Conference mode allows a single call in flight, so one record is enough: a
 * new call replaces a record whose phase is terminal. The file is written to a
 * temporary sibling (mode 0600, fsync) and renamed over the old one, so a
 * crash leaves either the old or the new record, and it is read again on every
 * use, so it survives a server restart. It holds the call plan (the callee's
 * number and the brief), which is why it is private to the server user.
 *
 * A record is shape-checked whenever it is read; an unreadable or malformed
 * file fails closed (no new conference call starts, callbacks answer 503)
 * until an operator removes it.
 *
 * This module also owns the callback URLs Command Center gives Twilio, because
 * signatures are verified against exactly those URLs.
 *
 * @module ConferenceCallState
 */
import { CommandCenterError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import { ElevenLabsConversationId } from "./ElevenLabsClient.ts";
import { PhoneCallPlan } from "./PhoneCalls.ts";
import { TwilioCallSid, TwilioConferenceSid } from "./TwilioClient.ts";

/** A call older than this is abandoned: ended best-effort and reported as outcome unknown. */
export const CONFERENCE_CALL_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const STATE_FILE_NAME = "active-call.json";
const STATE_MAX_BYTES = 64 * 1024;

/** Call ids are UUIDs; the conference is `cc-<call id>`. */
export const ConferenceCallId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
);
export const conferenceName = (callId: string) => `cc-${callId}`;

export const ConferenceLegName = Schema.Literals(["agent", "callee", "owner"]);
export type ConferenceLegName = typeof ConferenceLegName.Type;

export const ConferencePhase = Schema.Literals([
  "dialing-agent",
  "agent-answered",
  "dialing-callee",
  "in-progress",
  "bridging-owner",
  "owner-joined",
  "ending",
  "ended",
  "failed",
  "abandoned",
]);
export type ConferencePhase = typeof ConferencePhase.Type;

const TERMINAL_PHASES: ReadonlySet<ConferencePhase> = new Set(["ended", "failed", "abandoned"]);
export const isTerminalPhase = (phase: ConferencePhase): boolean => TERMINAL_PHASES.has(phase);

/** One leg's last known Twilio status; `answered` stays true once the leg was answered. */
export const LegStatus = Schema.Literals([
  "dialing",
  "answered",
  "completed",
  "busy",
  "no-answer",
  "failed",
  "canceled",
]);
export type LegStatus = typeof LegStatus.Type;
const TERMINAL_LEG_STATUSES: ReadonlySet<LegStatus> = new Set([
  "completed",
  "busy",
  "no-answer",
  "failed",
  "canceled",
]);
export const isTerminalLegStatus = (status: LegStatus): boolean =>
  TERMINAL_LEG_STATUSES.has(status);

const IsoTime = Schema.String.check(Schema.isMaxLength(40));

export const ConferenceLeg = Schema.Struct({
  callSid: Schema.optional(TwilioCallSid),
  status: LegStatus,
  answered: Schema.Boolean,
  updatedAt: IsoTime,
});
export type ConferenceLeg = typeof ConferenceLeg.Type;

export const OwnerBridgeState = Schema.Literals([
  "calling",
  "joined",
  "no-answer",
  "busy",
  "failed",
  "ended",
]);
export type OwnerBridgeState = typeof OwnerBridgeState.Type;

/** The current (latest) time the owner was brought into the call. */
export const OwnerBridge = Schema.Struct({
  /** 1 for the first bridge of the call, 2 for the second, ... */
  n: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  state: OwnerBridgeState,
  /** A hold was requested for the agent during this bridge, so it must be taken off hold. */
  held: Schema.Boolean,
  leg: ConferenceLeg,
  requestedAt: IsoTime,
});
export type OwnerBridge = typeof OwnerBridge.Type;

export const ConferenceCallRecord = Schema.Struct({
  version: Schema.Literal(1),
  callId: ConferenceCallId,
  spaceId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  /** Keys the outcome-unknown row; the approval executor passes the Inbox revision id. */
  attemptId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  plan: PhoneCallPlan,
  phase: ConferencePhase,
  agent: ConferenceLeg,
  callee: Schema.optional(ConferenceLeg),
  owner: Schema.optional(OwnerBridge),
  bridgeCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  conferenceSid: Schema.optional(TwilioConferenceSid),
  /** The ElevenLabs conversation, learned from the initiation webhook. */
  conversationId: Schema.optional(ElevenLabsConversationId),
  /** The call sid ElevenLabs reported at initiation (its side of the agent leg). */
  agentInboundCallSid: Schema.optional(TwilioCallSid),
  createdAt: IsoTime,
  updatedAt: IsoTime,
});
export type ConferenceCallRecord = typeof ConferenceCallRecord.Type;

const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(ConferenceCallRecord), {
  onExcessProperty: "error",
});
const encodeRecord = Schema.encodeSync(Schema.fromJsonString(ConferenceCallRecord));

// ── Callback URLs ────────────────────────────────────────────────────────────

/** Twilio callback routes below the phone webhook mount. */
export const TwilioCallbackRoute = Schema.Literals(["status", "owner-twiml", "hold", "announce"]);
export type TwilioCallbackRoute = typeof TwilioCallbackRoute.Type;

/**
 * The URL Command Center gives Twilio for `route`, and the only URL a
 * signature on that route is checked against. The query is always
 * `call=<id>` then, for status callbacks, `leg=<leg>`.
 */
export const twilioCallbackUrl = (input: {
  readonly publicBaseUrl: string;
  readonly route: TwilioCallbackRoute;
  readonly callId: string;
  readonly leg?: ConferenceLegName;
}): string =>
  `${input.publicBaseUrl}/twilio/${input.route}?call=${input.callId}${
    input.leg === undefined ? "" : `&leg=${input.leg}`
  }`;

// ── Store ────────────────────────────────────────────────────────────────────

export interface ConferenceCallStateStoreShape {
  /** The stored record (terminal or not); `None` when there is none. Fails when unreadable. */
  readonly load: Effect.Effect<Option.Option<ConferenceCallRecord>, CommandCenterError>;
  readonly save: (record: ConferenceCallRecord) => Effect.Effect<void, CommandCenterError>;
}

export class ConferenceCallStateStore extends Context.Service<
  ConferenceCallStateStore,
  ConferenceCallStateStoreShape
>()("@awtprod/command-center/command-center/phone/ConferenceCallState/ConferenceCallStateStore") {}

/** A file-backed store in `directory` (created 0700). */
const makeFileStore = (directory: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const file = path.join(directory, STATE_FILE_NAME);
    const unreadable = (cause: unknown) =>
      new CommandCenterError({
        reason: "persistence",
        message: `The conference call state at ${file} is unreadable; remove it once no call is live.`,
        cause,
      });

    const load: ConferenceCallStateStoreShape["load"] = Effect.gen(function* () {
      const stat = yield* fileSystem.stat(file).pipe(
        Effect.asSome,
        Effect.catch((cause) =>
          cause.reason._tag === "NotFound" ? Effect.succeedNone : Effect.fail(unreadable(cause)),
        ),
      );
      if (Option.isNone(stat)) return Option.none();
      if (Number(stat.value.size) > STATE_MAX_BYTES) return yield* unreadable("oversized");
      const text = yield* fileSystem.readFileString(file).pipe(Effect.mapError(unreadable));
      const record = decodeRecord(text);
      if (Option.isNone(record)) return yield* unreadable("malformed");
      return record;
    }).pipe(Effect.withSpan("ConferenceCallStateStore.load"));

    const save: ConferenceCallStateStoreShape["save"] = Effect.fn("ConferenceCallStateStore.save")(
      function* (record) {
        const suffix = yield* crypto.randomUUIDv4();
        const temporary = `${file}.${suffix}.tmp`;
        yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* fileSystem.open(temporary, { flag: "wx", mode: 0o600 });
            yield* handle.writeAll(new TextEncoder().encode(encodeRecord(record)));
            yield* handle.sync;
          }),
        ).pipe(
          Effect.andThen(fileSystem.chmod(temporary, 0o600)),
          Effect.andThen(fileSystem.rename(temporary, file)),
          Effect.tapError(() => fileSystem.remove(temporary).pipe(Effect.ignore)),
        );
      },
      Effect.mapError(
        (cause) =>
          new CommandCenterError({
            reason: "persistence",
            message: "The conference call state could not be saved.",
            cause,
          }),
      ),
    );

    return ConferenceCallStateStore.of({ load, save });
  });

export const layerAt = (directory: string) =>
  Layer.effect(ConferenceCallStateStore, makeFileStore(directory));

/** `<stateDir>/phone/active-call.json`. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return layerAt(path.join(config.stateDir, "phone"));
  }),
);
