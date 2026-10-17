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
 * The call is recorded as a `command_center_space_activity` row only after
 * ElevenLabs confirmed it started ("Phone: calling …"). Daily counts are read
 * from those rows, so there is no extra table; a call that failed to start
 * leaves no row and does not count. One lock serializes check, dial, and
 * record, so concurrent requests cannot both pass the cap.
 *
 * Phone rows use `source_kind = 'run'` (the activity table only admits thread
 * and run rows), `source_id = 'phone-start:<conversation id>'`, and event
 * sequence 0, which the activity reactor's resume cursor ignores.
 *
 * @module PhoneCalls
 */
import { SpaceId } from "@command-center/core";
import { CommandCenterError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { localDateAt } from "../DigestPeriod.ts";
import * as CommandCenterService from "../Service.ts";
import * as SpaceActivity from "../SpaceActivity.ts";
import { isSpaceAgentQuietTime } from "../SpaceAgentWaker.ts";
import { spaceAgentTimezone } from "../SpaceAgentWakeState.ts";
import {
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
} as const;
const OWNER_CALL_STATUSES = [PhoneCallStatus.callingOwner, PhoneCallStatus.askingOwner];
const THIRD_PARTY_CALL_STATUSES = [PhoneCallStatus.callingThirdParty];

export const phoneStartSourceId = (conversationId: string) => `phone-start:${conversationId}`;
export const phoneEndSourceId = (conversationId: string) => `phone-end:${conversationId}`;

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

export interface PhoneCallsShape {
  readonly callOwner: (
    request: OwnerCallRequest,
  ) => Effect.Effect<PhoneCallOutcome, CommandCenterError>;
  readonly callThirdParty: (
    plan: PhoneCallPlan,
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

const invalidRequest = (message: string) => (cause: unknown) =>
  new CommandCenterError({ reason: "validation", message, cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* PhoneConnectionStore;
  const client = yield* ElevenLabsClient;
  const commandCenter = yield* CommandCenterService.CommandCenterService;
  const activity = yield* SpaceActivity.SpaceActivity;
  // One call is checked, placed, and recorded at a time (per server process).
  const dialLock = yield* Semaphore.make(1);

  const callsToday = Effect.fn("PhoneCalls.callsToday")(function* (input: {
    readonly spaceId: string;
    readonly statuses: ReadonlyArray<string>;
    readonly nowMs: number;
    readonly timezone: string;
  }) {
    const now = DateTime.formatIso(DateTime.makeUnsafe(input.nowMs));
    const since = DateTime.formatIso(DateTime.makeUnsafe(input.nowMs - DAILY_COUNT_WINDOW_MS));
    const rows = yield* sql<{ readonly occurredAt: string }>`
      SELECT occurred_at AS "occurredAt"
      FROM command_center_space_activity
      WHERE space_id = ${input.spaceId}
        AND source_kind = ${PHONE_ACTIVITY_SOURCE_KIND}
        AND source_id LIKE 'phone-start:%'
        AND status IN ${sql.in(input.statuses)}
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

  /** Dial, then record the start row. Runs under `dialLock`. */
  const dialAndRecord = Effect.fn("PhoneCalls.dialAndRecord")(function* (input: {
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
    const started = yield* client
      .startOutboundCall({
        apiKey: input.connection.apiKey,
        agentId: input.agentId,
        agentPhoneNumberId: input.connection.phoneNumberId,
        to: input.to,
        dynamicVariables: input.dynamicVariables,
      })
      .pipe(Effect.mapError(providerError));
    const occurredAt = DateTime.formatIso(yield* DateTime.now);
    yield* activity
      .record({
        spaceId: input.spaceId,
        occurredAt,
        sourceKind: PHONE_ACTIVITY_SOURCE_KIND,
        sourceId: phoneStartSourceId(started.conversationId),
        projectId: null,
        title: `${START_TITLE_PREFIX}${input.calleeLabel} — ${input.purpose}`,
        status: input.status,
        text: input.summary,
        eventSequence: 0,
      })
      .pipe(
        // The call is already ringing; surface the bookkeeping failure with the
        // conversation id instead of reporting a call that never happened.
        Effect.mapError(
          (cause) =>
            new CommandCenterError({
              reason: "persistence",
              message: `The call started (conversation ${started.conversationId}) but could not be recorded.`,
              cause,
            }),
        ),
      );
    return { placed: true, conversationId: started.conversationId } satisfies PhoneCallOutcome;
  });

  const callOwner: PhoneCallsShape["callOwner"] = (raw) =>
    Effect.gen(function* () {
      const request = yield* decodeOwnerRequest(raw).pipe(
        Effect.mapError(invalidRequest("The owner call request is invalid.")),
      );
      const space = yield* commandCenter.getConfiguredSpace(request.spaceId);
      const connection = yield* requireConnection;
      if (Option.isNone(connection)) return refused(PHONE_NOT_CONFIGURED_REASON);
      const nowMs = yield* Clock.currentTimeMillis;
      if (space.agent !== undefined && isSpaceAgentQuietTime(space.agent, nowMs)) {
        return refused(
          "It is the Space agent's quiet hours; Andrew is not called now. File a decision Item instead.",
        );
      }
      return yield* dialLock.withPermits(1)(
        Effect.gen(function* () {
          const placedToday = yield* callsToday({
            spaceId: request.spaceId,
            statuses: OWNER_CALL_STATUSES,
            nowMs,
            timezone: spaceAgentTimezone(space.agent ?? {}),
          });
          if (placedToday >= PHONE_OWNER_CALLS_PER_DAY) {
            return refused(
              `Andrew was already called ${placedToday} times today in this Space (limit ${PHONE_OWNER_CALLS_PER_DAY}).`,
            );
          }
          const owner = connection.value;
          const question = request.question ?? "";
          return yield* dialAndRecord({
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

  const callThirdParty: PhoneCallsShape["callThirdParty"] = (raw) =>
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
            statuses: THIRD_PARTY_CALL_STATUSES,
            nowMs,
            timezone: spaceAgentTimezone(space.agent ?? {}),
          });
          if (placedToday >= PHONE_THIRD_PARTY_CALLS_PER_DAY) {
            return refused(
              `${placedToday} third-party calls were already placed today in this Space (limit ${PHONE_THIRD_PARTY_CALLS_PER_DAY}).`,
            );
          }
          const value = connection.value;
          return yield* dialAndRecord({
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
