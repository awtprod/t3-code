import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ApprovalRequestId,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ProviderItemId,
  ThreadId,
  TurnId,
} from "./baseSchemas.ts";
import {
  ChatAttachment,
  ModelSelection,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProviderApprovalDecision,
  ProviderApprovalPolicy,
  ProviderInteractionMode,
  ProviderRequestKind,
  ProviderSandboxMode,
  ProviderUserInputAnswers,
  RuntimeMode,
} from "./orchestration.ts";
import { ProviderInstanceId, ProviderDriverKind } from "./providerInstance.ts";

const ProviderSessionStatus = Schema.Literals([
  "connecting",
  "ready",
  "running",
  "error",
  "closed",
]);

export const ProviderSession = Schema.Struct({
  provider: ProviderDriverKind,
  // Optional during the driver/instance migration. Once every producer
  // populates it (post-slice-4), routing flips to instance-id-only and the
  // legacy `provider` field is removed.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  status: ProviderSessionStatus,
  runtimeMode: RuntimeMode,
  /**
   * Per-runtime-start nonce, minted by the session runtime and stamped on every
   * event it emits (see `ProviderEvent.sessionGeneration`). It lives here so the
   * value the orchestration layer binds to a thread is the SAME one the events
   * carry: a restarted runtime can reuse its `providerInstanceId`, so the
   * instance id alone cannot distinguish a live runtime from its dead
   * predecessor. A binding that omits this leaves the ingestion generation guard
   * comparing against `undefined`, which matches nothing and therefore accepts
   * the stale runtime's terminal events.
   */
  sessionGeneration: Schema.optional(TrimmedNonEmptyString),
  cwd: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  threadId: ThreadId,
  resumeCursor: Schema.optional(Schema.Unknown),
  activeTurnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastError: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderSession = typeof ProviderSession.Type;

export const ProviderSessionStartInput = Schema.Struct({
  threadId: ThreadId,
  projectId: Schema.optional(ProjectId),
  provider: Schema.optional(ProviderDriverKind),
  // See ProviderSession for the migration story.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  cwd: Schema.optional(TrimmedNonEmptyString),
  title: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  resumeCursor: Schema.optional(Schema.Unknown),
  approvalPolicy: Schema.optional(ProviderApprovalPolicy),
  sandboxMode: Schema.optional(ProviderSandboxMode),
  runtimeMode: RuntimeMode,
});
export type ProviderSessionStartInput = typeof ProviderSessionStartInput.Type;

export const ProviderSendTurnInput = Schema.Struct({
  threadId: ThreadId,
  input: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  ),
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
  modelSelection: Schema.optional(ModelSelection),
  interactionMode: Schema.optional(ProviderInteractionMode),
  /**
   * Sequence of the `thread.turn-start-requested` event that drove this send.
   *
   * Carried through the adapter and stamped back onto the `turn.started` it
   * produces, so the projector can adopt the placeholder this turn actually
   * belongs to instead of guessing positionally. Without it, two sends whose
   * `turn.started` events arrive out of order swap each other's message,
   * model, source plan, and interrupt flag.
   *
   * Optional because not every send originates from a turn-start request —
   * an adapter-internal or synthetic turn has no requesting event. Absence
   * explicitly means the resulting turn is uncorrelated: the projector must
   * not adopt any placeholder for it, including by an oldest-first fallback.
   */
  turnRequestSequence: Schema.optional(NonNegativeInt),
});
export type ProviderSendTurnInput = typeof ProviderSendTurnInput.Type;

export const ProviderTurnTargetIdentity = Schema.Struct({
  /**
   * Runtime generation that accepted the turn.
   *
   * Used when the provider has no native resumable thread identity. Providers
   * with a resume cursor may match that stronger identity across runtime
   * generations.
   */
  sessionGeneration: TrimmedNonEmptyString,
  /**
   * Provider-native resumable thread identity captured by the successful send.
   */
  resumeCursor: Schema.optional(Schema.Unknown),
});
export type ProviderTurnTargetIdentity = typeof ProviderTurnTargetIdentity.Type;

export const ProviderTurnStartResult = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  resumeCursor: Schema.optional(Schema.Unknown),
  /**
   * Immutable identity of the provider session that accepted this exact turn.
   * Historical interrupts carry it back so an old turn id is never combined
   * with an unrelated current provider session.
   */
  target: Schema.optional(ProviderTurnTargetIdentity),
  /**
   * True when this send was folded into an already-running turn (a "steer")
   * rather than opening a new one.
   *
   * A steer deliberately emits no `turn.started` — the work continues as the
   * same turn — so nothing downstream ever consumes the
   * `thread.turn-start-requested` placeholder this send answered. Left
   * unreported, that stranded row reads as "requested but never started" and
   * makes recovery re-issue a message the provider already received.
   *
   * Only the adapter knows whether a steer happened, so it is reported here and
   * the reactor folds the placeholder explicitly. Absent/false means a real turn
   * boundary, where `turn.started` consumes the placeholder as usual.
   */
  steered: Schema.optional(Schema.Boolean),
});
export type ProviderTurnStartResult = typeof ProviderTurnStartResult.Type;

export const ProviderInterruptTurnInput = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  /**
   * Identity returned by the successful send that created `turnId`.
   * Absence retains ordinary current-session interrupt behavior.
   */
  target: Schema.optional(ProviderTurnTargetIdentity),
});
export type ProviderInterruptTurnInput = typeof ProviderInterruptTurnInput.Type;

export const ProviderStopSessionInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderStopSessionInput = typeof ProviderStopSessionInput.Type;

export const ProviderRespondToRequestInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
});
export type ProviderRespondToRequestInput = typeof ProviderRespondToRequestInput.Type;

export const ProviderRespondToUserInputInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
});
export type ProviderRespondToUserInputInput = typeof ProviderRespondToUserInputInput.Type;

const ProviderEventKind = Schema.Literals(["session", "notification", "request", "error"]);

export const ProviderEvent = Schema.Struct({
  id: EventId,
  kind: ProviderEventKind,
  provider: ProviderDriverKind,
  // See ProviderSession for the migration story.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  // Per-runtime-start nonce. Distinguishes successive runtime generations that
  // reuse the same providerInstanceId, so a terminal event from a superseded
  // generation can be told apart from one for the live runtime.
  sessionGeneration: Schema.optional(Schema.String),
  threadId: ThreadId,
  createdAt: IsoDateTime,
  method: TrimmedNonEmptyString,
  message: Schema.optional(TrimmedNonEmptyString),
  turnId: Schema.optional(TurnId),
  itemId: Schema.optional(ProviderItemId),
  requestId: Schema.optional(ApprovalRequestId),
  requestKind: Schema.optional(ProviderRequestKind),
  textDelta: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Unknown),
});
export type ProviderEvent = typeof ProviderEvent.Type;
