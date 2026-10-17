/**
 * PhoneCallProposals - third-party calls only happen after Andrew approves them.
 *
 * `cc_phone_call` never dials. `file` records a `decision` Item ("Call <callee>:
 * <purpose>", `metadata.spaceAgent`, so web push fires) and, in the same
 * transaction, an Inbox prepared-action candidate `phone.call` whose target is
 * the callee with a masked number and whose parameters are the full call plan.
 *
 * Accepting that candidate is the approval: `acceptCandidate` wraps the Inbox
 * accept for every candidate. For a `phone.call` candidate it requires the
 * `command-center:approve` scope (plain accepts only need operate) and a
 * revision authored by the Item's own Space agent thread (an operate session
 * can add candidates to any Item, so a hand-made `phone.call` candidate is
 * refused before it is accepted), lets the Inbox accept it, and then runs the
 * executor exactly once: only for a fresh accept (a replayed mutation returns
 * `duplicate` and never dials again), only for the revision this session just
 * made current, only while the live Space config still enables the agent and
 * allows `cc.phone.call`, and only with a plan that still decodes strictly and
 * matches the target the approver saw. The accept and the executor run
 * uninterruptibly, so a closed socket cannot strand an accepted call without a
 * dial or a row. Nothing else reaches `PhoneCalls.callThirdParty`.
 *
 * A call that is accepted but cannot be placed (daily cap, provider refusal)
 * leaves an activity row "Phone: not placed …" so the Space agent learns why,
 * and the accept reports the failure. A call whose outcome is unknown (no
 * answer from ElevenLabs) may be ringing: `PhoneCalls` records it as "Phone:
 * outcome unknown …" under the revision id, no "not placed" row is written, and
 * the accept reports "outcome unknown — do not retry". Either way the revision
 * stays accepted, so the same candidate never dials twice.
 *
 * @module PhoneCallProposals
 */
import { ItemId, SpaceId } from "@command-center/core";
import {
  CommandCenterError,
  CommandCenterInboxProposalPayload,
  type CommandCenterInboxCandidateMutationInput,
  type CommandCenterInboxMutationResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as CommandCenterInbox from "../Inbox.ts";
import * as CommandCenterService from "../Service.ts";
import * as SpaceActivity from "../SpaceActivity.ts";
import { isSpaceAgentItemMetadata } from "../SpaceAgentReplies.ts";
import { maskPhoneNumber, PhoneConnectionStore } from "./PhoneConnection.ts";
import {
  PHONE_ACTIVITY_SOURCE_KIND,
  PHONE_NOT_CONFIGURED_REASON,
  phoneCallMayBeLive,
  PhoneCallPlan,
  phoneCallTarget,
  PhoneCalls,
  PhoneCallStatus,
} from "./PhoneCalls.ts";

const PHONE_CALL_ACTION_KIND = "phone.call";
const PHONE_CALL_CAPABILITY = "cc.phone.call";

export interface PhoneCallFiled {
  readonly status: "awaiting-approval";
  readonly itemId: string;
  readonly candidateRevisionId: string;
}

export interface PhoneCallAcceptContext {
  readonly subject: string;
  /** The session holds `command-center:approve`. */
  readonly canApprove: boolean;
}

export interface PhoneCallProposalsShape {
  /** File the plan for approval. Idempotent on `requestId`; never dials. */
  readonly file: (input: {
    readonly spaceId: string;
    readonly threadId: string;
    readonly requestId: string;
    readonly plan: PhoneCallPlan;
  }) => Effect.Effect<PhoneCallFiled, CommandCenterError>;
  /** Inbox candidate accept; accepting a `phone.call` candidate places the call. */
  readonly acceptCandidate: (
    input: CommandCenterInboxCandidateMutationInput,
    context: PhoneCallAcceptContext,
  ) => Effect.Effect<CommandCenterInboxMutationResult, CommandCenterError>;
}

export class PhoneCallProposals extends Context.Service<
  PhoneCallProposals,
  PhoneCallProposalsShape
>()("@awtprod/command-center/command-center/phone/PhoneCallProposals") {}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeProposal = Schema.decodeUnknownOption(CommandCenterInboxProposalPayload);
const decodePlan = Schema.decodeUnknownOption(PhoneCallPlan, { onExcessProperty: "error" });
const encodePlan = Schema.encodeSync(PhoneCallPlan);

const isCommandCenterError = Schema.is(CommandCenterError);
const invalid = (message: string) => new CommandCenterError({ reason: "validation", message });
const conflict = (message: string) => new CommandCenterError({ reason: "conflict", message });
const persistence = (message: string) => (cause: unknown) =>
  new CommandCenterError({ reason: "persistence", message, cause });

/** The `phone.call` plan inside a stored proposal payload, if it is one. */
const phoneCallPlanOf = (payloadJson: string) => {
  const payload = Option.flatMap(decodeJson(payloadJson), decodeProposal);
  if (
    Option.isNone(payload) ||
    payload.value.kind !== "prepared-action" ||
    payload.value.actionKind !== PHONE_CALL_ACTION_KIND
  ) {
    return Option.none();
  }
  return Option.some({
    target: payload.value.target,
    plan: decodePlan(payload.value.parameters),
  });
};

type EncodedPlan = typeof PhoneCallPlan.Encoded;

/** The plan as Inbox prepared-action parameters (plain JSON, no absent keys). */
const planParameters = (plan: EncodedPlan): Record<string, Schema.Json> => ({
  spaceId: plan.spaceId,
  to: plan.to,
  calleeName: plan.calleeName,
  purpose: plan.purpose,
  brief: plan.brief,
  allowedOutcomes: [...plan.allowedOutcomes],
  ...(plan.patchInWhen === undefined ? {} : { patchInWhen: plan.patchInWhen }),
});

const renderPlan = (plan: EncodedPlan): string =>
  [
    `Call ${plan.calleeName} at ${maskPhoneNumber(plan.to)}.`,
    `Purpose: ${plan.purpose}`,
    `Brief for the call agent:\n${plan.brief}`,
    `Allowed outcomes: ${plan.allowedOutcomes.join("; ")}`,
    plan.patchInWhen === undefined
      ? "Patch Andrew in: only if the callee asks for him."
      : `Patch Andrew in when: ${plan.patchInWhen}`,
    "Accepting this candidate places the call immediately.",
  ].join("\n\n");

/**
 * Whether the revision was authored by the Space agent thread that owns the
 * Item (`file` writes candidates as `space-agent:<thread id>`).
 */
const filedBySpaceAgent = (row: {
  readonly actorSubject: string;
  readonly metadataJson: string;
}): boolean => {
  if (!isSpaceAgentItemMetadata(row.metadataJson)) return false;
  const metadata = Option.getOrUndefined(decodeJson(row.metadataJson));
  const threadId =
    typeof metadata === "object" && metadata !== null
      ? (metadata as Record<string, unknown>)["threadId"]
      : undefined;
  return typeof threadId === "string" && row.actorSubject === `space-agent:${threadId}`;
};

/** A call is only placed from an Item that is neither closed nor dismissed. */
const openForCalling = (row: { readonly itemStatus: string; readonly lifecycle: string }) =>
  row.itemStatus !== "done" && row.itemStatus !== "canceled" && row.lifecycle !== "dismissed";

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const inbox = yield* CommandCenterInbox.CommandCenterInbox;
  const commandCenter = yield* CommandCenterService.CommandCenterService;
  const store = yield* PhoneConnectionStore;
  const phoneCalls = yield* PhoneCalls;
  const activity = yield* SpaceActivity.SpaceActivity;
  const textEncoder = new TextEncoder();

  const file: PhoneCallProposalsShape["file"] = (input) =>
    Effect.gen(function* () {
      if (input.plan.spaceId !== input.spaceId) {
        return yield* invalid("The call plan belongs to another Space.");
      }
      if (Option.isNone(yield* store.load)) return yield* invalid(PHONE_NOT_CONFIGURED_REASON);
      const hash = Encoding.encodeHex(
        yield* crypto
          .digest("SHA-256", textEncoder.encode(`${input.spaceId}\0${input.requestId}`))
          .pipe(Effect.mapError(persistence("Could not derive the call proposal id."))),
      ).slice(0, 40);
      const itemId = `phone-call:${hash}`;
      const mutationId = `phone-call-candidate:${hash}`;
      const plan = encodePlan(input.plan);
      const target = phoneCallTarget(plan);
      const description = renderPlan(plan);
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const item = yield* commandCenter.createItem(
              {
                requestId: itemId,
                spaceId: SpaceId.make(input.spaceId),
                kind: "decision",
                priority: "high",
                title: clip(`Call ${plan.calleeName}: ${plan.purpose}`, 200),
                description,
              },
              { kind: "space-agent", threadId: input.threadId },
            );
            // Version 0 is the Item's first Inbox state; a replay of the same
            // request hits the stored mutation receipt and returns it unchanged.
            const result = yield* inbox.createCandidate(
              {
                spaceId: SpaceId.make(input.spaceId),
                itemId: ItemId.make(item.id),
                mutationId,
                expectedVersion: 0,
                source: "direct",
                payload: {
                  kind: "prepared-action",
                  actionKind: PHONE_CALL_ACTION_KIND,
                  target,
                  parameters: planParameters(plan),
                },
                preview: {
                  summary: `Call ${target.id}: ${plan.purpose}`,
                  after: description,
                },
                evidence: {
                  source: "command-center-item",
                  subjectId: item.id,
                  version: item.updatedAt,
                },
              },
              { subject: `space-agent:${input.threadId}` },
            );
            return {
              status: "awaiting-approval" as const,
              itemId: result.detail.item.id,
              candidateRevisionId: `revision:${mutationId}`,
            };
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isCommandCenterError(cause)
              ? cause
              : persistence("Could not file the phone call for approval.")(cause),
          ),
        );
    });

  /** The `phone.call` plan of a candidate, when the candidate is one. */
  const peekCandidate = Effect.fn("PhoneCallProposals.peekCandidate")(function* (
    input: CommandCenterInboxCandidateMutationInput,
  ) {
    const rows = yield* sql<{
      readonly payloadJson: string;
      readonly actorSubject: string;
      readonly metadataJson: string;
      readonly itemStatus: string;
      readonly lifecycle: string;
    }>`
      SELECT revision.payload_json AS "payloadJson", revision.actor_subject AS "actorSubject",
        item.metadata_json AS "metadataJson", item.status AS "itemStatus", inbox.lifecycle
      FROM command_center_inbox_revisions revision
      JOIN command_center_items item ON item.id = revision.item_id
      JOIN command_center_inbox_state inbox ON inbox.item_id = item.id
      WHERE revision.id = ${input.candidateRevisionId} AND revision.item_id = ${input.itemId}
        AND item.space_id = ${input.spaceId}
      LIMIT 1
    `.pipe(Effect.mapError(persistence("Could not read the Inbox candidate.")));
    const row = rows[0];
    if (row === undefined) return Option.none();
    return Option.map(phoneCallPlanOf(row.payloadJson), (proposal) => ({ ...proposal, ...row }));
  });

  /**
   * Tell the Space agent an approved call was not placed. The caller's own
   * failure is what the accept reports, so a failure to write this row is
   * logged rather than allowed to replace it.
   */
  const recordNotPlaced = (input: {
    readonly spaceId: string;
    readonly revisionId: string;
    readonly targetLabel: string;
    readonly purpose: string;
    readonly reason: string;
  }) =>
    Effect.gen(function* () {
      yield* activity.record({
        spaceId: input.spaceId,
        occurredAt: DateTime.formatIso(yield* DateTime.now),
        sourceKind: PHONE_ACTIVITY_SOURCE_KIND,
        sourceId: `phone-not-placed:${input.revisionId}`,
        projectId: null,
        title: `Phone: not placed ${input.targetLabel} — ${input.purpose}`,
        status: PhoneCallStatus.notPlaced,
        text: `Andrew approved the call, but it was not placed: ${input.reason}`,
        eventSequence: SpaceActivity.SPACE_ACTIVITY_EXTERNAL_EVENT_SEQUENCE,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("phone call not-placed activity could not be recorded", {
          revisionId: input.revisionId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  /** Runs only after this session's accept made the revision current. */
  const execute = Effect.fn("PhoneCallProposals.execute")(function* (
    input: CommandCenterInboxCandidateMutationInput,
    subject: string,
  ) {
    const rows = yield* sql<{
      readonly status: string;
      readonly acceptedBySubject: string | null;
      readonly actorSubject: string;
      readonly payloadJson: string;
      readonly metadataJson: string;
      readonly itemStatus: string;
      readonly lifecycle: string;
      readonly currentRevisionId: string | null;
    }>`
      SELECT revision.status, revision.accepted_by_subject AS "acceptedBySubject",
        revision.actor_subject AS "actorSubject", revision.payload_json AS "payloadJson",
        item.metadata_json AS "metadataJson",
        item.status AS "itemStatus", inbox.lifecycle,
        inbox.current_revision_id AS "currentRevisionId"
      FROM command_center_inbox_revisions revision
      JOIN command_center_items item ON item.id = revision.item_id
      JOIN command_center_inbox_state inbox ON inbox.item_id = item.id
      WHERE revision.id = ${input.candidateRevisionId} AND revision.item_id = ${input.itemId}
        AND item.space_id = ${input.spaceId}
      LIMIT 1
    `.pipe(Effect.mapError(persistence("Could not read the accepted call plan.")));
    const row = rows[0];
    if (
      row === undefined ||
      row.status !== "current" ||
      row.currentRevisionId !== input.candidateRevisionId ||
      row.acceptedBySubject !== subject
    ) {
      return yield* conflict(
        "The call plan is no longer the accepted proposal; nothing was dialed.",
      );
    }
    if (!filedBySpaceAgent(row)) {
      return yield* invalid("Only a Space agent's call proposal can be placed.");
    }
    if (!openForCalling(row)) {
      return yield* conflict(
        "The call proposal's Item is closed or dismissed; nothing was dialed.",
      );
    }
    const proposal = phoneCallPlanOf(row.payloadJson);
    if (Option.isNone(proposal) || Option.isNone(proposal.value.plan)) {
      return yield* invalid("The accepted call plan is invalid; nothing was dialed.");
    }
    const plan = proposal.value.plan.value;
    const target = phoneCallTarget(plan);
    if (
      plan.spaceId !== input.spaceId ||
      proposal.value.target.kind !== target.kind ||
      proposal.value.target.id !== target.id
    ) {
      return yield* invalid(
        "The accepted call plan does not match its target; nothing was dialed.",
      );
    }
    // Re-check the live policy: the agent may have been disabled, or lost the
    // capability, between filing and approval.
    const space = yield* commandCenter.getConfiguredSpace(input.spaceId);
    if (
      space.agent?.enabled !== true ||
      !space.policy.allowedCapabilities.includes(PHONE_CALL_CAPABILITY)
    ) {
      const reason = `policy: the Space agent is disabled or no longer allowed ${PHONE_CALL_CAPABILITY}.`;
      yield* recordNotPlaced({
        spaceId: input.spaceId,
        revisionId: input.candidateRevisionId,
        targetLabel: target.id,
        purpose: plan.purpose,
        reason,
      });
      return yield* conflict(`Accepted, but the call was not placed: ${reason}`);
    }
    const outcome = yield* phoneCalls
      .callThirdParty(plan, { attemptId: input.candidateRevisionId })
      .pipe(
        Effect.tapError((error) =>
          // A call that may be ringing already has its own row; never call it "not placed".
          phoneCallMayBeLive(error)
            ? Effect.void
            : recordNotPlaced({
                spaceId: input.spaceId,
                revisionId: input.candidateRevisionId,
                targetLabel: target.id,
                purpose: plan.purpose,
                reason: error.message,
              }),
        ),
      );
    if (!outcome.placed) {
      const reason = outcome.reason ?? "the call was refused.";
      yield* recordNotPlaced({
        spaceId: input.spaceId,
        revisionId: input.candidateRevisionId,
        targetLabel: target.id,
        purpose: plan.purpose,
        reason,
      });
      return yield* conflict(`Accepted, but the call was not placed: ${reason}`);
    }
    return outcome;
  });

  const acceptCandidate: PhoneCallProposalsShape["acceptCandidate"] = (input, context) =>
    Effect.gen(function* () {
      const phoneCall = yield* peekCandidate(input);
      if (Option.isNone(phoneCall)) {
        return yield* inbox.acceptCandidate(input, { subject: context.subject });
      }
      if (!context.canApprove) {
        return yield* invalid(
          "Accepting this candidate places a phone call, which needs approval authority.",
        );
      }
      if (!filedBySpaceAgent(phoneCall.value)) {
        return yield* invalid(
          "Only a call plan filed by this Item's Space agent can be approved; nothing was accepted.",
        );
      }
      if (!openForCalling(phoneCall.value)) {
        return yield* conflict("Reopen this Item before approving its call.");
      }
      // Once accepted, the call is attempted and recorded even if the caller goes away.
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const result = yield* inbox.acceptCandidate(input, { subject: context.subject });
          if (result.duplicate) return result;
          yield* execute(input, context.subject);
          return result;
        }),
      );
    });

  return PhoneCallProposals.of({ file, acceptCandidate });
});

export const layer = Layer.effect(PhoneCallProposals, make);
