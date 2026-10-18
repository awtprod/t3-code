/**
 * PhoneCalls - places the Space agent's outbound calls, inside fixed limits.
 *
 * Two kinds of call exist:
 *
 * - owner: rings Andrew (the connection's `ownerNumber`) on the owner agent,
 *   to brief him or ask a yes/no question. At most
 *   `PHONE_OWNER_CALLS_PER_DAY` per Space per local day, and never during the
 *   Space agent's quiet hours (the waker's own predicate).
 * - third party: rings someone else on the third-party agent. At most
 *   `PHONE_THIRD_PARTY_CALLS_PER_DAY` per Space per local day. Only the
 *   approval executor (`PhoneCallProposals`) calls this, after Andrew accepted
 *   the call plan in the Inbox.
 *
 * A call ElevenLabs confirmed is recorded as a `command_center_space_activity`
 * row "Phone: calling …". A call whose start ElevenLabs neither confirmed nor
 * refused (timeout, transport failure, unusable 2xx answer) may be ringing, so
 * it is recorded too, as "Phone: outcome unknown …", and the caller is told not
 * to retry. Daily counts are read from both kinds of row, so there is no extra
 * table; only a call ElevenLabs refused leaves no row and does not count. One
 * lock serializes the clock read, quiet-hours and cap checks, dial, and record,
 * so concurrent or queued requests cannot pass on a stale check, and the dial
 * and record cannot be interrupted between them.
 *
 * Phone rows use `source_kind = 'run'` (the activity table only admits thread
 * and run rows), `source_id = 'phone-start:<conversation id>'` or
 * `'phone-uncertain:<kind>:<space id>:<attempt id>'`, and event sequence 0,
 * which the activity reactor's resume cursor ignores.
 *
 * @module PhoneCalls
 */
import { type SpaceAgentConfig, SpaceId } from "@command-center/core";
import { CommandCenterError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import { localDateAt } from "../DigestPeriod.ts";
import * as CommandCenterService from "../Service.ts";
import * as SpaceActivity from "../SpaceActivity.ts";
import { isSpaceAgentQuietTime } from "../SpaceAgentWaker.ts";
import { spaceAgentTimezone } from "../SpaceAgentWakeState.ts";
import {
  callMayHaveStarted,
  ElevenLabsClient,
  type ElevenLabsCallError,
  type PhoneCallDynamicVariables,
} from "./ElevenLabsClient.ts";
import {
  hasControlCharacters,
  maskPhoneNumber,
  type PhoneConnection,
  PhoneConnectionStore,
  PhoneNumberE164,
} from "./PhoneConnection.ts";

const PHONE_OWNER_CALLS_PER_DAY = 3;
const PHONE_THIRD_PARTY_CALLS_PER_DAY = 5;
const PHONE_BRIEF_MAX_CHARS = 1_500;
/** Activity rows looked at for a daily count; well above both caps. */
const DAILY_COUNT_SCAN_ROWS = 50;
/** A local day is at most 25 h (DST); scan a little more and filter by local date. */
const DAILY_COUNT_WINDOW_MS = 26 * 60 * 60 * 1000;
const START_SUMMARY_CHARS = 300;

export const PHONE_ACTIVITY_SOURCE_KIND = "run" as const;
export const PhoneCallStatus = {
  callingOwner: "calling-owner",
  askingOwner: "asking-owner",
  callingThirdParty: "calling-third-party",
  ended: "ended",
  notConnected: "not-connected",
  notPlaced: "not-placed",
  /** ElevenLabs neither confirmed nor refused the start; the call may be ringing. */
  outcomeUnknown: "outcome-unknown",
} as const;
export type PhoneCallKind = "owner" | "third-party";
const OWNER_CALL_STATUSES = [PhoneCallStatus.callingOwner, PhoneCallStatus.askingOwner];
const THIRD_PARTY_CALL_STATUSES = [PhoneCallStatus.callingThirdParty];

export const phoneStartSourceId = (conversationId: string) => `phone-start:${conversationId}`;
export const phoneEndSourceId = (conversationId: string) => `phone-end:${conversationId}`;
const phoneUncertainSourceId = (kind: PhoneCallKind, spaceId: string, attemptId: string) =>
  `phone-uncertain:${kind}:${spaceId}:${attemptId}`;

const START_TITLE_PREFIX = "Phone: calling ";

/** "Phone: calling X — purpose" becomes "Phone: <verb> X — purpose". */
export const phoneTitleFromStart = (startTitle: string, verb: string): string =>
  startTitle.startsWith(START_TITLE_PREFIX)
    ? `Phone: ${verb} ${startTitle.slice(START_TITLE_PREFIX.length)}`
    : `Phone: ${verb} call`;

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const singleLine = (max: number) =>
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(max),
    Schema.makeFilter(
      (value) =>
        (value.trim() === value && !hasControlCharacters(value)) || "Use trimmed single-line text.",
    ),
  );

const multiLine = (max: number) =>
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(max),
    Schema.makeFilter(
      (value) =>
        (value.trim().length > 0 && !hasControlCharacters(value, true)) ||
        "Use non-blank text without control characters.",
    ),
  );

export const PhoneCalleeName = singleLine(80);
export const PhoneCallPurpose = singleLine(200);
export const PhoneCallBrief = multiLine(PHONE_BRIEF_MAX_CHARS);
export const PhoneCallQuestion = singleLine(300);
export const PhoneCallOutcomeOption = singleLine(200);
export const PhoneCallPatchInWhen = multiLine(500);

/** The full plan of a third-party call: what the approver accepts, and exactly what is dialed. */
export const PhoneCallPlan = Schema.Struct({
  spaceId: SpaceId,
  to: PhoneNumberE164,
  calleeName: PhoneCalleeName,
  purpose: PhoneCallPurpose,
  brief: PhoneCallBrief,
  allowedOutcomes: Schema.Array(PhoneCallOutcomeOption).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(10),
  ),
  patchInWhen: Schema.optional(PhoneCallPatchInWhen),
});
export type PhoneCallPlan = typeof PhoneCallPlan.Type;

export const OwnerCallRequest = Schema.Struct({
  spaceId: SpaceId,
  purpose: PhoneCallPurpose,
  brief: PhoneCallBrief,
  question: Schema.optional(PhoneCallQuestion),
});
export type OwnerCallRequest = typeof OwnerCallRequest.Type;

export const PhoneCallOutcome = Schema.Struct({
  placed: Schema.Boolean,
  conversationId: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
});
export type PhoneCallOutcome = typeof PhoneCallOutcome.Type;

const decodePlan = Schema.decodeUnknownEffect(PhoneCallPlan, { onExcessProperty: "error" });
const decodeOwnerRequest = Schema.decodeUnknownEffect(OwnerCallRequest, {
  onExcessProperty: "error",
});

/** The Inbox target of a third-party plan: what the approver sees as "who is called". */
export const phoneCallTarget = (plan: Pick<PhoneCallPlan, "calleeName" | "to">) => ({
  kind: "phone-number",
  id: `${plan.calleeName} (${maskPhoneNumber(plan.to)})`,
});

export const PHONE_NOT_CONFIGURED_REASON =
  "Phone calls are not set up on this server (no ElevenLabs connection is stored).";

const refused = (reason: string): PhoneCallOutcome => ({ placed: false, reason });

/**
 * The local clock for quiet hours and daily caps: the quiet-hours timezone
 * (the one `isSpaceAgentQuietTime` reads), else the check-in timezone, else
 * the Space agent default.
 */
export const phoneCallTimezone = (
  agent: Pick<SpaceAgentConfig, "checkIns" | "quietHours"> | undefined,
): string => agent?.quietHours?.timezone ?? spaceAgentTimezone(agent ?? {});

export interface PhoneCallsShape {
  readonly callOwner: (
    request: OwnerCallRequest,
  ) => Effect.Effect<PhoneCallOutcome, CommandCenterError>;
  /** `attemptId` keys the "outcome unknown" row; the approval executor passes the revision id. */
  readonly callThirdParty: (
    plan: PhoneCallPlan,
    options?: { readonly attemptId?: string },
  ) => Effect.Effect<PhoneCallOutcome, CommandCenterError>;
}

export class PhoneCalls extends Context.Service<PhoneCalls, PhoneCallsShape>()(
  "@awtprod/command-center/command-center/phone/PhoneCalls",
) {}

const providerError = (error: ElevenLabsCallError) =>
  new CommandCenterError({
    reason: "connector",
    message:
      error.body === undefined || error.body.length === 0
        ? error.message
        : `${error.message} ${error.body}`,
    cause: error,
  });

/**
 * The `cause` of a CommandCenterError for a call that may be live (its outcome
 * is unknown, or it started but its row failed). Such a call is never reported
 * as "not placed" and must not be retried.
 */
export class PhoneCallMayBeLive extends Schema.TaggedError<PhoneCallMayBeLive>()(
  "PhoneCallMayBeLive",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}
const isPhoneCallMayBeLive = Schema.is(PhoneCallMayBeLive);
export const phoneCallMayBeLive = (error: CommandCenterError): boolean =>
  isPhoneCallMayBeLive(error.cause);

const outcomeUnknownError = (error: ElevenLabsCallError, recorded: boolean) => {
  const message = [
    `Call outcome unknown — do not retry. ${error.message}`,
    "ElevenLabs may have started the call, so it may be ringing now.",
    recorded
      ? "It counts toward today's call limit."
      : "It could not be recorded, so it does not count toward today's call limit.",
    "Check Space activity and the ElevenLabs conversation history before calling again.",
  ].join(" ");
  return new CommandCenterError({
    reason: "connector",
    message,
    cause: new PhoneCallMayBeLive({ message, cause: error }),
  });
};

const invalidRequest = (message: string) => (cause: unknown) =>
  new CommandCenterError({ reason: "validation", message, cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* PhoneConnectionStore;
  const client = yield* ElevenLabsClient;
  const crypto = yield* Crypto.Crypto;
  const commandCenter = yield* CommandCenterService.CommandCenterService;
  const activity = yield* SpaceActivity.SpaceActivity;
  // One call is checked, placed, and recorded at a time (per server process).
  const dialLock = yield* Semaphore.make(1);

  /** Calls of `kind` started today, including those whose outcome is unknown. */
  const callsToday = Effect.fn("PhoneCalls.callsToday")(function* (input: {
    readonly spaceId: string;
    readonly kind: PhoneCallKind;
    readonly nowMs: number;
    readonly timezone: string;
  }) {
    const now = DateTime.formatIso(DateTime.makeUnsafe(input.nowMs));
    const since = DateTime.formatIso(DateTime.makeUnsafe(input.nowMs - DAILY_COUNT_WINDOW_MS));
    const statuses = input.kind === "owner" ? OWNER_CALL_STATUSES : THIRD_PARTY_CALL_STATUSES;
    const uncertainPrefix = `phone-uncertain:${input.kind}:%`;
    const rows = yield* sql<{ readonly occurredAt: string }>`
      SELECT occurred_at AS "occurredAt"
      FROM command_center_space_activity
      WHERE space_id = ${input.spaceId}
        AND source_kind = ${PHONE_ACTIVITY_SOURCE_KIND}
        AND (
          (source_id LIKE 'phone-start:%' AND status IN ${sql.in(statuses)})
          OR (source_id LIKE ${uncertainPrefix} AND status = ${PhoneCallStatus.outcomeUnknown})
        )
        AND occurred_at >= ${since}
      ORDER BY occurred_at DESC
      LIMIT ${DAILY_COUNT_SCAN_ROWS}
    `.pipe(
      Effect.mapError(
        (cause) =>
          new CommandCenterError({
            reason: "persistence",
            message: "Could not count today's phone calls.",
            cause,
          }),
      ),
    );
    const today = localDateAt(now, input.timezone);
    return rows.filter((row) => localDateAt(row.occurredAt, input.timezone) === today).length;
  });

  const requireConnection = store.load;

  const newAttemptId = crypto.randomUUIDv4().pipe(
    Effect.mapError(
      (cause) =>
        new CommandCenterError({
          reason: "persistence",
          message: "Could not create a phone call attempt id; nothing was dialed.",
          cause,
        }),
    ),
  );

  /**
   * Dial, then record the start row, or the "outcome unknown" row when
   * ElevenLabs may have started the call without confirming it. Runs under
   * `dialLock`; the dial (bounded by the client's deadline) and the record
   * cannot be separated by an interrupt.
   */
  const dialAndRecord = Effect.fn("PhoneCalls.dialAndRecord")(function* (input: {
    readonly kind: PhoneCallKind;
    readonly attemptId: string;
    readonly spaceId: string;
    readonly connection: PhoneConnection;
    readonly agentId: string;
    readonly to: string;
    readonly calleeLabel: string;
    readonly purpose: string;
    readonly status: string;
    readonly summary: string;
    readonly dynamicVariables: PhoneCallDynamicVariables;
  }) {
    const attempt = yield* Effect.result(
      client.startOutboundCall({
        apiKey: input.connection.apiKey,
        agentId: input.agentId,
        agentPhoneNumberId: input.connection.phoneNumberId,
        to: input.to,
        dynamicVariables: input.dynamicVariables,
      }),
    );
    /** A call that may be ringing still gets a row, so it counts and nobody dials again. */
    const recordOutcomeUnknown = (detail: string) =>
      Effect.gen(function* () {
        yield* activity.record({
          spaceId: input.spaceId,
          occurredAt: DateTime.formatIso(yield* DateTime.now),
          sourceKind: PHONE_ACTIVITY_SOURCE_KIND,
          sourceId: phoneUncertainSourceId(input.kind, input.spaceId, input.attemptId),
          projectId: null,
          title: `Phone: outcome unknown ${input.calleeLabel} — ${input.purpose}`,
          status: PhoneCallStatus.outcomeUnknown,
          text: [
            detail,
            "ElevenLabs may have started this call, so it may be ringing; do not retry it.",
            "It counts toward today's call limit. No end-of-call result will be recorded",
            "here; check the ElevenLabs conversation history.",
          ].join(" "),
          eventSequence: SpaceActivity.SPACE_ACTIVITY_EXTERNAL_EVENT_SEQUENCE,
        });
        return true;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("phone call outcome-unknown activity could not be recorded", {
            attemptId: input.attemptId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(false)),
        ),
      );

    if (attempt._tag === "Failure") {
      const error = attempt.failure;
      if (!callMayHaveStarted(error)) return yield* providerError(error);
      return yield* outcomeUnknownError(error, yield* recordOutcomeUnknown(error.message));
    }
    const started = attempt.success;
    const occurredAt = DateTime.formatIso(yield* DateTime.now);
    const startRecorded = yield* Effect.result(
      activity.record({
        spaceId: input.spaceId,
        occurredAt,
        sourceKind: PHONE_ACTIVITY_SOURCE_KIND,
        sourceId: phoneStartSourceId(started.conversationId),
        projectId: null,
        title: `${START_TITLE_PREFIX}${input.calleeLabel} — ${input.purpose}`,
        status: input.status,
        text: input.summary,
        eventSequence: SpaceActivity.SPACE_ACTIVITY_EXTERNAL_EVENT_SEQUENCE,
      }),
    );
    if (startRecorded._tag === "Failure") {
      // The call is ringing but its start row is missing: fall back to an
      // outcome-unknown row so it still counts, and never report it as not placed.
      const recorded = yield* recordOutcomeUnknown(
        `The call started (conversation ${started.conversationId}) but its start row could not be recorded.`,
      );
      const message = [
        `The call started (conversation ${started.conversationId}) but could not be recorded; do not retry.`,
        recorded
          ? "It was recorded as outcome unknown and counts toward today's call limit."
          : "It does not count toward today's call limit.",
      ].join(" ");
      return yield* new CommandCenterError({
        reason: "persistence",
        message,
        cause: new PhoneCallMayBeLive({ message, cause: startRecorded.failure }),
      });
    }
    return { placed: true, conversationId: started.conversationId } satisfies PhoneCallOutcome;
  }, Effect.uninterruptible);

  const callOwner: PhoneCallsShape["callOwner"] = (raw) =>
    Effect.gen(function* () {
      const request = yield* decodeOwnerRequest(raw).pipe(
        Effect.mapError(invalidRequest("The owner call request is invalid.")),
      );
      const space = yield* commandCenter.getConfiguredSpace(request.spaceId);
      const connection = yield* requireConnection;
      if (Option.isNone(connection)) return refused(PHONE_NOT_CONFIGURED_REASON);
      return yield* dialLock.withPermits(1)(
        Effect.gen(function* () {
          // Read the clock under the lock: a call that waited for it must not
          // dial on a quiet-hours check or a local day from before the wait.
          const nowMs = yield* Clock.currentTimeMillis;
          if (space.agent !== undefined && isSpaceAgentQuietTime(space.agent, nowMs)) {
            return refused(
              "It is the Space agent's quiet hours; Andrew is not called now. File a decision Item instead.",
            );
          }
          const placedToday = yield* callsToday({
            spaceId: request.spaceId,
            kind: "owner",
            nowMs,
            timezone: phoneCallTimezone(space.agent),
          });
          if (placedToday >= PHONE_OWNER_CALLS_PER_DAY) {
            return refused(
              `Andrew was already called ${placedToday} times today in this Space (limit ${PHONE_OWNER_CALLS_PER_DAY}).`,
            );
          }
          const owner = connection.value;
          const question = request.question ?? "";
          return yield* dialAndRecord({
            kind: "owner",
            attemptId: yield* newAttemptId,
            spaceId: request.spaceId,
            connection: owner,
            agentId: owner.ownerAgentId,
            to: owner.ownerNumber,
            calleeLabel: `${owner.ownerName} (${maskPhoneNumber(owner.ownerNumber)})`,
            purpose: request.purpose,
            status:
              question.length > 0 ? PhoneCallStatus.askingOwner : PhoneCallStatus.callingOwner,
            // An asking row's summary is exactly the question; the webhook reads it back.
            summary: question.length > 0 ? question : clip(request.brief, START_SUMMARY_CHARS),
            dynamicVariables: {
              purpose: request.purpose,
              brief: request.brief,
              allowed_outcomes: question.length > 0 ? "yes; no; unclear" : "acknowledged",
              owner_name: owner.ownerName,
              callee_name: owner.ownerName,
              patch_in_when: "",
              call_kind: "owner",
              question,
            },
          });
        }),
      );
    });

  const callThirdParty: PhoneCallsShape["callThirdParty"] = (raw, options) =>
    Effect.gen(function* () {
      const plan = yield* decodePlan(raw).pipe(
        Effect.mapError(invalidRequest("The phone call plan is invalid.")),
      );
      const space = yield* commandCenter.getConfiguredSpace(plan.spaceId);
      const connection = yield* requireConnection;
      if (Option.isNone(connection)) return refused(PHONE_NOT_CONFIGURED_REASON);
      return yield* dialLock.withPermits(1)(
        Effect.gen(function* () {
          const nowMs = yield* Clock.currentTimeMillis;
          const placedToday = yield* callsToday({
            spaceId: plan.spaceId,
            kind: "third-party",
            nowMs,
            timezone: phoneCallTimezone(space.agent),
          });
          if (placedToday >= PHONE_THIRD_PARTY_CALLS_PER_DAY) {
            return refused(
              `${placedToday} third-party calls were already placed today in this Space (limit ${PHONE_THIRD_PARTY_CALLS_PER_DAY}).`,
            );
          }
          const value = connection.value;
          return yield* dialAndRecord({
            kind: "third-party",
            attemptId: options?.attemptId ?? (yield* newAttemptId),
            spaceId: plan.spaceId,
            connection: value,
            agentId: value.agentId,
            to: plan.to,
            calleeLabel: phoneCallTarget(plan).id,
            purpose: plan.purpose,
            status: PhoneCallStatus.callingThirdParty,
            summary: clip(plan.brief, START_SUMMARY_CHARS),
            dynamicVariables: {
              purpose: plan.purpose,
              brief: plan.brief,
              allowed_outcomes: plan.allowedOutcomes.join("; "),
              owner_name: value.ownerName,
              callee_name: plan.calleeName,
              patch_in_when: plan.patchInWhen ?? "",
              call_kind: "third_party",
              question: "",
            },
          });
        }),
      );
    });

  return PhoneCalls.of({ callOwner, callThirdParty });
});

export const layer = Layer.effect(PhoneCalls, make);
