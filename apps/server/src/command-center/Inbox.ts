import {
  Item,
  ObservationEligibilityPolicy,
  ObservationIsoInstant,
  evaluateObservationEligibility,
  type ItemId,
} from "@command-center/core";
import {
  CommandCenterError,
  CommandCenterInboxApproveAdjustmentInput,
  type CommandCenterInboxApproveAdjustmentInput as ApproveAdjustmentInput,
  CommandCenterInboxCandidateCreateInput,
  type CommandCenterInboxCandidateCreateInput as CandidateCreateInput,
  type CommandCenterInboxCandidateMutationInput as CandidateMutationInput,
  CommandCenterInboxCommentInput,
  type CommandCenterInboxCommentInput as CommentInput,
  CommandCenterInboxDetail,
  type CommandCenterInboxDetail as InboxDetail,
  type CommandCenterInboxDetailInput as DetailInput,
  CommandCenterInboxMutationResult,
  type CommandCenterInboxMutationResult as MutationResult,
  type CommandCenterInboxQueryInput as QueryInput,
  CommandCenterInboxQueryResult,
  type CommandCenterInboxQueryResult as QueryResult,
  type CommandCenterInboxResolveChangeRequestInput as ResolveChangeRequestInput,
  CommandCenterInboxRevision,
  type CommandCenterInboxSimpleMutationInput as SimpleMutationInput,
  type CommandCenterInboxSnoozeInput as SnoozeInput,
  type CommandCenterInboxState as InboxState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeCommandCenterAuditLog } from "./AuditLog.ts";
import { make as makeObservations } from "./Observations.ts";
import { makeSprintPlanService } from "./SprintPlan.ts";

const DEFAULT_HISTORY_LIMIT = 50;
const DEFAULT_LIST_LIMIT = 50;

const decodeItem = Schema.decodeUnknownEffect(Item);
const decodeDetail = Schema.decodeUnknownEffect(CommandCenterInboxDetail);
const decodeCommentInput = Schema.decodeUnknownEffect(CommandCenterInboxCommentInput);
const decodeRevision = Schema.decodeUnknownEffect(CommandCenterInboxRevision);
const decodeQueryResult = Schema.decodeUnknownEffect(CommandCenterInboxQueryResult);
const decodeMutationResult = Schema.decodeUnknownEffect(CommandCenterInboxMutationResult);
const MutationReceipt = Schema.Struct({
  resultVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  createdDiscussionId: Schema.optional(Schema.String),
  createdRevisionId: Schema.optional(Schema.String),
});
const decodeMutationReceipt = Schema.decodeUnknownEffect(Schema.fromJsonString(MutationReceipt));
const decodeProposalPayloadJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CommandCenterInboxCandidateCreateInput.fields.payload),
);
const decodeProposalPreviewJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CommandCenterInboxCandidateCreateInput.fields.preview),
);
const decodeEvidenceJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CommandCenterInboxCandidateCreateInput.fields.evidence),
);
const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeEligibilityPolicy = Schema.decodeUnknownEffect(ObservationEligibilityPolicy);
const decodeApproveAdjustment = Schema.decodeUnknownEffect(
  CommandCenterInboxApproveAdjustmentInput,
);
const decodeObservationInstant = Schema.decodeUnknownEffect(ObservationIsoInstant);
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const isCommandCenterError = Schema.is(CommandCenterError);

const persistenceError = (message: string, cause?: unknown) =>
  new CommandCenterError({
    reason: "persistence",
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const conflictError = (message: string) => new CommandCenterError({ reason: "conflict", message });

const validationError = (message: string) =>
  new CommandCenterError({ reason: "validation", message });

const notFoundError = () =>
  new CommandCenterError({
    reason: "not_found",
    message: "The Inbox item was not found in the requested active Space.",
  });

const actor = (subject: string) => ({ kind: "authenticated-user" as const, subject });

const nextUpdatedAt = (current: string, observed: string): string => {
  if (observed > current) return observed;
  return Option.match(DateTime.make(current), {
    onNone: () => observed,
    onSome: (value) => DateTime.formatIso(DateTime.add(value, { milliseconds: 1 })),
  });
};

interface InboxActorContext {
  readonly subject: string;
}

interface BaseMutationInput {
  readonly spaceId: string;
  readonly itemId: string;
  readonly mutationId: string;
  readonly expectedVersion: number;
}

interface ItemStateRow {
  readonly itemId: string;
  readonly spaceId: string;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly lifecycle: "open" | "snoozed" | "dismissed";
  readonly snoozedUntil: string | null;
  readonly version: number;
  readonly currentRevisionId: string | null;
  readonly stateCreatedAt: string;
  readonly stateUpdatedAt: string;
  readonly kind: string;
  readonly status: string;
  readonly title: string;
  readonly body: string | null;
  readonly priority: string;
  readonly dueAt: string | null;
  readonly sourceJson: string;
  readonly linksJson: string;
  readonly metadataJson: string;
  readonly itemCreatedAt: string;
  readonly itemUpdatedAt: string;
}

interface DiscussionRow {
  readonly sequence: number;
  readonly id: string;
  readonly itemId: string;
  readonly kind: "comment" | "change-request";
  readonly text: string;
  readonly actorSubject: string;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
  readonly resolvedBySubject: string | null;
}

interface RevisionRow {
  readonly sequence: number;
  readonly id: string;
  readonly itemId: string;
  readonly revision: number;
  readonly predecessorRevisionId: string | null;
  readonly status: "candidate" | "current" | "superseded" | "discarded";
  readonly source: "agent" | "direct";
  readonly payloadJson: string;
  readonly previewJson: string;
  readonly evidenceJson: string;
  readonly actorSubject: string;
  readonly createdAt: string;
  readonly acceptedAt: string | null;
  readonly acceptedBySubject: string | null;
  readonly discardedAt: string | null;
  readonly discardedBySubject: string | null;
}

interface MutationReceiptRow {
  readonly itemId: string;
  readonly spaceId: string;
  readonly commandKind: string;
  readonly actorSubject: string;
  readonly requestDigest: string;
  readonly receiptJson: string;
}

export class CommandCenterInbox extends Context.Service<
  CommandCenterInbox,
  {
    readonly query: (input: QueryInput) => Effect.Effect<QueryResult, CommandCenterError>;
    readonly detail: (input: DetailInput) => Effect.Effect<InboxDetail, CommandCenterError>;
    readonly comment: (
      input: CommentInput,
      context: InboxActorContext,
    ) => Effect.Effect<MutationResult, CommandCenterError>;
    readonly requestChanges: (
      input: CommentInput,
      context: InboxActorContext,
    ) => Effect.Effect<MutationResult, CommandCenterError>;
    readonly createCandidate: (
      input: CandidateCreateInput,
      context: InboxActorContext,
    ) => Effect.Effect<MutationResult, CommandCenterError>;
    readonly acceptCandidate: (
      input: CandidateMutationInput,
      context: InboxActorContext,
    ) => Effect.Effect<MutationResult, CommandCenterError>;
    readonly approveAdjustment: (
      input: ApproveAdjustmentInput,
      context: InboxActorContext,
    ) => Effect.Effect<MutationResult, CommandCenterError>;
    readonly discardCandidate: (
      input: CandidateMutationInput,
      context: InboxActorContext,
    ) => Effect.Effect<MutationResult, CommandCenterError>;
    readonly resolveChangeRequest: (
      input: ResolveChangeRequestInput,
      context: InboxActorContext,
    ) => Effect.Effect<MutationResult, CommandCenterError>;
    readonly snooze: (
      input: SnoozeInput,
      context: InboxActorContext,
    ) => Effect.Effect<MutationResult, CommandCenterError>;
    readonly unsnooze: (
      input: SimpleMutationInput,
      context: InboxActorContext,
    ) => Effect.Effect<MutationResult, CommandCenterError>;
    readonly dismiss: (
      input: SimpleMutationInput,
      context: InboxActorContext,
    ) => Effect.Effect<MutationResult, CommandCenterError>;
    readonly reopen: (
      input: SimpleMutationInput,
      context: InboxActorContext,
    ) => Effect.Effect<MutationResult, CommandCenterError>;
  }
>()("@awtprod/command-center/command-center/Inbox/CommandCenterInbox") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const audit = yield* makeCommandCenterAuditLog;
  const sprintPlan = yield* makeSprintPlanService();
  const observations = yield* makeObservations;
  const textEncoder = new TextEncoder();

  const digest = Effect.fn("CommandCenterInbox.digest")(function* (value: string) {
    return Encoding.encodeHex(yield* crypto.digest("SHA-256", textEncoder.encode(value)));
  });

  const proposalFingerprint = (input: {
    readonly spaceId: string;
    readonly planId: string;
    readonly evidence: {
      readonly source: string;
      readonly subjectId: string;
      readonly version: string;
      readonly digest?: string | undefined;
    };
    readonly operations: ReadonlyArray<{
      readonly taskId: string;
      readonly field: string;
      readonly before: string | boolean;
      readonly after: string | boolean;
    }>;
  }) =>
    digest(
      encodeUnknownJson({
        spaceId: input.spaceId,
        planId: input.planId,
        evidence: {
          source: input.evidence.source,
          subjectId: input.evidence.subjectId,
          version: input.evidence.version,
          digest: input.evidence.digest ?? null,
        },
        operations: [...input.operations].sort((a, b) =>
          `${a.taskId}\u0000${a.field}`.localeCompare(`${b.taskId}\u0000${b.field}`),
        ),
      }),
    );

  const decodeJson = Effect.fn("CommandCenterInbox.decodeJson")(function* (
    value: string,
    description: string,
  ) {
    return yield* decodeUnknownJson(value).pipe(
      Effect.mapError((cause) => persistenceError(`Stored ${description} is invalid.`, cause)),
    );
  });

  const decodeItemRow = Effect.fn("CommandCenterInbox.decodeItemRow")(function* (
    row: ItemStateRow,
  ) {
    return yield* decodeItem({
      id: row.itemId,
      spaceId: row.spaceId,
      kind: row.kind,
      status: row.status,
      priority: row.priority,
      title: row.title,
      description: row.body ?? undefined,
      dueAt: row.dueAt ?? undefined,
      artifactIds: yield* decodeJson(row.linksJson, "Inbox item links"),
      provenance: yield* decodeJson(row.sourceJson, "Inbox item provenance"),
      metadata: yield* decodeJson(row.metadataJson, "Inbox item metadata"),
      createdAt: row.itemCreatedAt,
      updatedAt: row.itemUpdatedAt,
    }).pipe(Effect.mapError((cause) => persistenceError("Stored Inbox item is invalid.", cause)));
  });

  const decodeRevisionRow = Effect.fn("CommandCenterInbox.decodeRevisionRow")(function* (
    row: RevisionRow,
  ) {
    return yield* decodeRevision({
      sequence: row.sequence,
      id: row.id,
      itemId: row.itemId,
      revision: row.revision,
      predecessorRevisionId: row.predecessorRevisionId ?? undefined,
      status: row.status,
      source: row.source,
      payload: yield* decodeProposalPayloadJson(row.payloadJson),
      preview: yield* decodeProposalPreviewJson(row.previewJson),
      evidence: yield* decodeEvidenceJson(row.evidenceJson),
      actor: actor(row.actorSubject),
      createdAt: row.createdAt,
      acceptedAt: row.acceptedAt ?? undefined,
      acceptedBy: row.acceptedBySubject === null ? undefined : actor(row.acceptedBySubject),
      discardedAt: row.discardedAt ?? undefined,
      discardedBy: row.discardedBySubject === null ? undefined : actor(row.discardedBySubject),
    }).pipe(
      Effect.mapError((cause) => persistenceError("Stored Inbox revision is invalid.", cause)),
    );
  });

  const requireActiveSpace = Effect.fn("CommandCenterInbox.requireActiveSpace")(function* (
    spaceId: string,
  ) {
    const rows = yield* sql<{ readonly id: string }>`
      SELECT id FROM command_center_spaces
      WHERE id = ${spaceId} AND lifecycle = 'active'
      LIMIT 1
    `;
    if (rows.length === 0) return yield* notFoundError();
  });

  const loadItemState = Effect.fn("CommandCenterInbox.loadItemState")(function* (
    spaceId: string,
    itemId: string,
  ) {
    const rows = yield* sql<ItemStateRow>`
      SELECT inbox.item_id AS "itemId", inbox.space_id AS "spaceId",
        inbox.subject_kind AS "subjectKind", inbox.subject_id AS "subjectId",
        inbox.lifecycle, inbox.snoozed_until AS "snoozedUntil", inbox.version,
        inbox.current_revision_id AS "currentRevisionId",
        inbox.created_at AS "stateCreatedAt", inbox.updated_at AS "stateUpdatedAt",
        item.kind, item.status, item.title, item.body, item.priority,
        item.due_at AS "dueAt", item.source_json AS "sourceJson",
        item.links_json AS "linksJson", item.metadata_json AS "metadataJson",
        item.created_at AS "itemCreatedAt", item.updated_at AS "itemUpdatedAt"
      FROM command_center_inbox_state inbox
      JOIN command_center_items item
        ON item.id = inbox.item_id AND item.space_id = inbox.space_id
      JOIN command_center_spaces space
        ON space.id = inbox.space_id AND space.lifecycle = 'active'
      WHERE inbox.space_id = ${spaceId} AND inbox.item_id = ${itemId}
      LIMIT 1
    `;
    const row = rows[0];
    if (row === undefined) return yield* notFoundError();
    return row;
  });

  const loadRevision = Effect.fn("CommandCenterInbox.loadRevision")(function* (
    revisionId: string,
    itemId: string,
  ) {
    const rows = yield* sql<RevisionRow>`
      SELECT sequence, id, item_id AS "itemId", revision,
        predecessor_revision_id AS "predecessorRevisionId", status, source,
        payload_json AS "payloadJson", preview_json AS "previewJson",
        evidence_json AS "evidenceJson", actor_subject AS "actorSubject",
        created_at AS "createdAt", accepted_at AS "acceptedAt",
        accepted_by_subject AS "acceptedBySubject", discarded_at AS "discardedAt",
        discarded_by_subject AS "discardedBySubject"
      FROM command_center_inbox_revisions
      WHERE id = ${revisionId} AND item_id = ${itemId}
      LIMIT 1
    `;
    return rows[0];
  });

  const assessAdjustment = Effect.fn("CommandCenterInbox.assessAdjustment")(function* (
    row: ItemStateRow,
    revisionRow: RevisionRow,
    now: string,
  ) {
    const revision = yield* decodeRevisionRow(revisionRow);
    if (revision.payload.kind !== "sprint-plan-task-patch") {
      return {
        supported: false as const,
        eligible: false as const,
        reason: "phase-a-no-executor" as const,
      };
    }
    const payload = revision.payload;
    if (row.subjectKind !== "sprint-plan" || row.subjectId !== payload.target.id) {
      return { supported: true as const, eligible: false as const, reason: "plan-stale" as const };
    }
    const applied = yield* sql<{ readonly mutationId: string }>`
      SELECT mutation_id AS "mutationId"
      FROM command_center_sprint_plan_adjustment_approvals
      WHERE item_id = ${row.itemId} AND revision_id = ${revision.id} LIMIT 1
    `;
    if (applied.length > 0) {
      return {
        supported: true as const,
        eligible: false as const,
        reason: "already-applied" as const,
      };
    }
    const policyRows = yield* sql<{ readonly policyJson: string }>`
      SELECT policy_json AS "policyJson" FROM command_center_spaces
      WHERE id = ${row.spaceId} AND lifecycle = 'active' LIMIT 1
    `;
    const raw =
      policyRows[0] === undefined
        ? null
        : yield* decodeJson(policyRows[0].policyJson, "Space policy");
    const configured =
      raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>).observationEligibility
        : undefined;
    if (configured === undefined) {
      return {
        supported: true as const,
        eligible: false as const,
        reason: "policy-not-configured" as const,
      };
    }
    const policy = yield* decodeEligibilityPolicy(configured).pipe(
      Effect.mapError((cause) => persistenceError("Stored observation policy is invalid.", cause)),
    );
    const source = revision.evidence.source;
    if (!source.startsWith("observation:") || source.length <= "observation:".length) {
      return {
        supported: true as const,
        eligible: false as const,
        reason: "evidence-stale" as const,
      };
    }
    const snapshot = yield* observations
      .get({
        spaceId: row.spaceId,
        observationId: source.slice("observation:".length),
      })
      .pipe(
        Effect.catch((cause) =>
          cause.reason === "not-found"
            ? Effect.succeed(null)
            : Effect.fail(persistenceError("Observation evidence could not be read.", cause)),
        ),
      );
    if (
      snapshot === null ||
      snapshot.observation.spaceId !== row.spaceId ||
      snapshot.observation.planId !== payload.target.id ||
      snapshot.observation.subjectId !== revision.evidence.subjectId ||
      String(snapshot.version) !== revision.evidence.version ||
      snapshot.revisionDigest !== revision.evidence.digest ||
      (revision.evidence.observedAt !== undefined &&
        revision.evidence.observedAt !== snapshot.observation.data.observedAt)
    ) {
      return {
        supported: true as const,
        eligible: false as const,
        reason: "evidence-stale" as const,
      };
    }
    const eligibility = evaluateObservationEligibility({
      policy,
      evidence: snapshot,
      asOf: yield* decodeObservationInstant(now).pipe(
        Effect.mapError((cause) => persistenceError("Current time is invalid.", cause)),
      ),
    });
    if (snapshot.hasCollectionConflict || eligibility.status !== "eligible") {
      return {
        supported: true as const,
        eligible: false as const,
        reason: "evidence-ineligible" as const,
      };
    }
    const plans = yield* sql<{ readonly version: number }>`
      SELECT version FROM command_center_sprint_plans
      WHERE id = ${payload.target.id} AND space_id = ${row.spaceId} LIMIT 1
    `;
    if (plans[0]?.version !== payload.expectedPlanVersion) {
      return { supported: true as const, eligible: false as const, reason: "plan-stale" as const };
    }
    return {
      supported: true as const,
      eligible: true as const,
      reason: "ready" as const,
      snapshot,
      policyDigest: eligibility.policyDigest!,
    };
  });

  const hydrateState = Effect.fn("CommandCenterInbox.hydrateState")(function* (
    row: ItemStateRow,
    now: string,
  ) {
    const counts = yield* sql<{
      readonly unresolvedChangeRequestCount: number;
      readonly candidateCount: number;
    }>`
      SELECT
        (SELECT COUNT(*) FROM command_center_inbox_discussion
          WHERE item_id = ${row.itemId} AND kind = 'change-request' AND resolved_at IS NULL)
          AS "unresolvedChangeRequestCount",
        (SELECT COUNT(*) FROM command_center_inbox_revisions
          WHERE item_id = ${row.itemId} AND status = 'candidate') AS "candidateCount"
    `;
    const count = counts[0];
    if (count === undefined) {
      return yield* persistenceError("Could not count Inbox history.");
    }
    const wakeElapsed =
      row.lifecycle === "snoozed" && row.snoozedUntil !== null && row.snoozedUntil <= now;
    const lifecycle = wakeElapsed ? ("open" as const) : row.lifecycle;
    const approvalReason =
      count.unresolvedChangeRequestCount > 0
        ? ("changes-requested" as const)
        : row.currentRevisionId === null
          ? ("no-current-proposal" as const)
          : count.candidateCount > 0
            ? ("candidate-pending" as const)
            : ("phase-a-no-executor" as const);
    const approval =
      approvalReason === "phase-a-no-executor" && row.currentRevisionId !== null
        ? yield* Effect.gen(function* () {
            const current = yield* loadRevision(row.currentRevisionId!, row.itemId);
            if (current === undefined)
              return yield* persistenceError("Current Inbox revision is missing.");
            return yield* assessAdjustment(row, current, now);
          })
        : { supported: false as const, eligible: false as const, reason: approvalReason };
    return {
      itemId: row.itemId as ItemId,
      spaceId: row.spaceId as InboxState["spaceId"],
      subject: { kind: row.subjectKind, id: row.subjectId },
      lifecycle,
      ...(lifecycle === "snoozed" && row.snoozedUntil !== null
        ? { snoozedUntil: row.snoozedUntil }
        : {}),
      version: row.version,
      ...(row.currentRevisionId === null ? {} : { currentRevisionId: row.currentRevisionId }),
      unresolvedChangeRequestCount: count.unresolvedChangeRequestCount,
      candidateCount: count.candidateCount,
      approval: {
        supported: approval.supported,
        eligible: approval.eligible,
        reason: approval.reason,
      },
      createdAt: row.stateCreatedAt,
      updatedAt: row.stateUpdatedAt,
    };
  });

  const loadSummary = Effect.fn("CommandCenterInbox.loadSummary")(function* (
    spaceId: string,
    itemId: string,
    now: string,
  ) {
    const row = yield* loadItemState(spaceId, itemId);
    const item = yield* decodeItemRow(row);
    const state = yield* hydrateState(row, now);
    const currentRevisionRow =
      row.currentRevisionId === null
        ? undefined
        : yield* loadRevision(row.currentRevisionId, row.itemId);
    if (row.currentRevisionId !== null && currentRevisionRow === undefined) {
      return yield* persistenceError("Inbox state references a missing current revision.");
    }
    const currentRevision =
      currentRevisionRow === undefined ? undefined : yield* decodeRevisionRow(currentRevisionRow);
    return { item, state, ...(currentRevision === undefined ? {} : { currentRevision }) };
  });

  const loadDetail = Effect.fn("CommandCenterInbox.loadDetail")(function* (
    input: DetailInput,
    now: string,
  ) {
    const summary = yield* loadSummary(input.spaceId, input.itemId, now);
    const limit = input.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    const discussionRows = yield* sql<DiscussionRow>`
      SELECT sequence, id, item_id AS "itemId", kind, text,
        actor_subject AS "actorSubject", created_at AS "createdAt",
        resolved_at AS "resolvedAt", resolved_by_subject AS "resolvedBySubject"
      FROM command_center_inbox_discussion
      WHERE item_id = ${input.itemId}
        AND (${input.discussionBeforeSequence ?? null} IS NULL
          OR sequence < ${input.discussionBeforeSequence ?? null})
      ORDER BY sequence DESC
      LIMIT ${limit + 1}
    `;
    const revisionRows = yield* sql<RevisionRow>`
      SELECT sequence, id, item_id AS "itemId", revision,
        predecessor_revision_id AS "predecessorRevisionId", status, source,
        payload_json AS "payloadJson", preview_json AS "previewJson",
        evidence_json AS "evidenceJson", actor_subject AS "actorSubject",
        created_at AS "createdAt", accepted_at AS "acceptedAt",
        accepted_by_subject AS "acceptedBySubject", discarded_at AS "discardedAt",
        discarded_by_subject AS "discardedBySubject"
      FROM command_center_inbox_revisions
      WHERE item_id = ${input.itemId}
        AND (${input.revisionBeforeSequence ?? null} IS NULL
          OR sequence < ${input.revisionBeforeSequence ?? null})
      ORDER BY sequence DESC
      LIMIT ${limit + 1}
    `;
    const visibleDiscussion = discussionRows.slice(0, limit);
    const visibleRevisions = revisionRows.slice(0, limit);
    const discussion = visibleDiscussion.map((entry) => ({
      sequence: entry.sequence,
      id: entry.id,
      itemId: entry.itemId,
      kind: entry.kind,
      text: entry.text,
      actor: actor(entry.actorSubject),
      createdAt: entry.createdAt,
      ...(entry.resolvedAt === null ? {} : { resolvedAt: entry.resolvedAt }),
      ...(entry.resolvedBySubject === null ? {} : { resolvedBy: actor(entry.resolvedBySubject) }),
    }));
    const revisions = yield* Effect.forEach(visibleRevisions, decodeRevisionRow);
    return yield* decodeDetail({
      ...summary,
      discussion,
      revisions,
      ...(discussionRows.length <= limit || visibleDiscussion.at(-1) === undefined
        ? {}
        : { nextDiscussionBeforeSequence: visibleDiscussion.at(-1)!.sequence }),
      ...(revisionRows.length <= limit || visibleRevisions.at(-1) === undefined
        ? {}
        : { nextRevisionBeforeSequence: visibleRevisions.at(-1)!.sequence }),
    }).pipe(
      Effect.mapError((cause) => persistenceError("Inbox detail could not be serialized.", cause)),
    );
  });

  const detail = Effect.fn("CommandCenterInbox.detail")(
    function* (input: DetailInput) {
      const now = DateTime.formatIso(yield* DateTime.now);
      return yield* loadDetail(input, now);
    },
    Effect.mapError((cause) =>
      isCommandCenterError(cause) ? cause : persistenceError("Could not load Inbox detail.", cause),
    ),
  );

  const query = Effect.fn("CommandCenterInbox.query")(
    function* (input: QueryInput) {
      if (input.spaceId !== undefined) yield* requireActiveSpace(input.spaceId);
      const now = DateTime.formatIso(yield* DateTime.now);
      const requested = input.lifecycles;
      const includeOpen = requested === undefined || requested.includes("open");
      const includeSnoozed = requested === undefined || requested.includes("snoozed");
      const includeDismissed = requested === undefined || requested.includes("dismissed");
      const view = input.view;
      const limit = input.limit ?? DEFAULT_LIST_LIMIT;
      const rows = yield* sql<{
        readonly itemId: string;
        readonly spaceId: string;
        readonly updatedAt: string;
      }>`
      SELECT inbox.item_id AS "itemId", inbox.space_id AS "spaceId",
        inbox.updated_at AS "updatedAt"
      FROM command_center_inbox_state inbox
      JOIN command_center_items item
        ON item.id = inbox.item_id AND item.space_id = inbox.space_id
      JOIN command_center_spaces space
        ON space.id = inbox.space_id AND space.lifecycle = 'active'
      WHERE (${input.spaceId ?? null} IS NULL OR inbox.space_id = ${input.spaceId ?? null})
        AND (
          (${view ?? null} IS NULL AND (
            (${includeOpen ? 1 : 0} = 1 AND (
              inbox.lifecycle = 'open'
              OR (inbox.lifecycle = 'snoozed' AND inbox.snoozed_until <= ${now})
            ))
            OR (${includeSnoozed ? 1 : 0} = 1 AND inbox.lifecycle = 'snoozed'
              AND inbox.snoozed_until > ${now})
            OR (${includeDismissed ? 1 : 0} = 1 AND inbox.lifecycle = 'dismissed')
          ))
          OR (${view ?? null} = 'actionable'
            AND item.status NOT IN ('done', 'canceled')
            AND (inbox.lifecycle = 'open'
              OR (inbox.lifecycle = 'snoozed' AND inbox.snoozed_until <= ${now})))
          OR (${view ?? null} = 'recent'
            AND (inbox.lifecycle = 'dismissed' OR item.status IN ('done', 'canceled'))
            AND NOT (inbox.lifecycle = 'snoozed' AND inbox.snoozed_until IS NOT NULL
              AND inbox.snoozed_until > ${now}))
          OR (${view ?? null} = 'snoozed'
            AND inbox.lifecycle = 'snoozed' AND inbox.snoozed_until > ${now})
        )
        AND (${input.cursor?.updatedAt ?? null} IS NULL
          OR inbox.updated_at < ${input.cursor?.updatedAt ?? null}
          OR (inbox.updated_at = ${input.cursor?.updatedAt ?? null}
            AND inbox.item_id < ${input.cursor?.itemId ?? null}))
      ORDER BY inbox.updated_at DESC, inbox.item_id DESC
      LIMIT ${limit + 1}
    `;
      const visible = rows.slice(0, limit);
      const items = yield* Effect.forEach(
        visible,
        (row) => loadSummary(row.spaceId, row.itemId, now),
        { concurrency: 8 },
      );
      const last = visible.at(-1);
      return yield* decodeQueryResult({
        items,
        ...(rows.length <= limit || last === undefined
          ? {}
          : { nextCursor: { updatedAt: last.updatedAt, itemId: last.itemId } }),
      }).pipe(
        Effect.mapError((cause) => persistenceError("Inbox query could not be serialized.", cause)),
      );
    },
    Effect.mapError((cause) =>
      isCommandCenterError(cause) ? cause : persistenceError("Could not query Inbox items.", cause),
    ),
  );

  const bumpState = Effect.fn("CommandCenterInbox.bumpState")(function* (
    input: BaseMutationInput,
    updatedAt: string,
  ) {
    const rows = yield* sql<{ readonly version: number }>`
      UPDATE command_center_inbox_state
      SET version = version + 1, updated_at = ${updatedAt}
      WHERE item_id = ${input.itemId} AND space_id = ${input.spaceId}
        AND version = ${input.expectedVersion}
      RETURNING version
    `;
    if (rows.length !== 1) {
      return yield* conflictError("The Inbox item changed while this mutation was applied.");
    }
  });

  const runMutation = <Input extends BaseMutationInput>(
    commandKind: string,
    input: Input,
    context: InboxActorContext,
    apply: (state: ItemStateRow, now: string) => Effect.Effect<void, Error>,
  ): Effect.Effect<MutationResult, CommandCenterError> =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const state = yield* loadItemState(input.spaceId, input.itemId);
          const requestDigest = yield* digest(
            encodeUnknownJson({ commandKind, input, actorSubject: context.subject }),
          );
          const receiptRows = yield* sql<MutationReceiptRow>`
          SELECT item_id AS "itemId", space_id AS "spaceId", command_kind AS "commandKind",
            actor_subject AS "actorSubject", request_digest AS "requestDigest",
            receipt_json AS "receiptJson"
          FROM command_center_inbox_mutation_receipts
          WHERE mutation_id = ${input.mutationId}
          LIMIT 1
        `;
          const receipt = receiptRows[0];
          if (receipt !== undefined) {
            if (
              receipt.itemId !== input.itemId ||
              receipt.spaceId !== input.spaceId ||
              receipt.commandKind !== commandKind ||
              receipt.actorSubject !== context.subject ||
              receipt.requestDigest !== requestDigest
            ) {
              return yield* conflictError(
                "The mutation id is already bound to a different Inbox request.",
              );
            }
            const prior = yield* decodeMutationReceipt(receipt.receiptJson).pipe(
              Effect.mapError((cause) =>
                persistenceError("Stored Inbox mutation receipt is invalid.", cause),
              ),
            );
            if (prior.resultVersion > state.version) {
              return yield* persistenceError(
                "Stored Inbox mutation receipt references a future item version.",
              );
            }
            // Replays prove identity from the compact receipt, then return the current
            // authoritative detail instead of a stale history snapshot.
            return {
              detail: yield* loadDetail(
                {
                  spaceId: input.spaceId as DetailInput["spaceId"],
                  itemId: input.itemId as DetailInput["itemId"],
                  historyLimit: DEFAULT_HISTORY_LIMIT,
                },
                DateTime.formatIso(yield* DateTime.now),
              ),
              duplicate: true,
            };
          }
          if (state.version !== input.expectedVersion) {
            return yield* conflictError(
              "The Inbox item changed after the supplied optimistic version.",
            );
          }
          const now = DateTime.formatIso(yield* DateTime.now);
          yield* apply(state, now);
          const result = yield* decodeMutationResult({
            detail: yield* loadDetail(
              {
                spaceId: input.spaceId as DetailInput["spaceId"],
                itemId: input.itemId as DetailInput["itemId"],
                historyLimit: DEFAULT_HISTORY_LIMIT,
              },
              now,
            ),
            duplicate: false,
          }).pipe(
            Effect.mapError((cause) =>
              persistenceError("Inbox mutation result could not be serialized.", cause),
            ),
          );
          const receiptJson = encodeUnknownJson({
            resultVersion: result.detail.state.version,
            ...(commandKind === "cc.inbox.comment"
              ? { createdDiscussionId: `comment:${input.mutationId}` }
              : commandKind === "cc.inbox.requestChanges"
                ? { createdDiscussionId: `change-request:${input.mutationId}` }
                : commandKind === "cc.inbox.candidate.create"
                  ? { createdRevisionId: `revision:${input.mutationId}` }
                  : {}),
          });
          yield* sql`
          INSERT INTO command_center_inbox_mutation_receipts (
            mutation_id, item_id, space_id, command_kind, actor_subject,
            request_digest, receipt_json, accepted_at
          ) VALUES (
            ${input.mutationId}, ${input.itemId}, ${input.spaceId}, ${commandKind},
            ${context.subject}, ${requestDigest}, ${receiptJson}, ${now}
          )
        `;
          yield* audit.append({
            eventId: `inbox-mutation:${input.mutationId}`,
            actorKind: "authenticated-user",
            action: commandKind,
            spaceId: input.spaceId,
            payload: {
              itemId: input.itemId,
              mutationId: input.mutationId,
              actorSubject: context.subject,
              expectedVersion: input.expectedVersion,
              resultingVersion: result.detail.state.version,
            },
            occurredAt: now,
          });
          return result;
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isCommandCenterError(cause)
            ? cause
            : persistenceError(`Could not apply Inbox mutation '${commandKind}'.`, cause),
        ),
      );

  const addDiscussion = (
    commandKind: "cc.inbox.comment" | "cc.inbox.requestChanges",
    kind: "comment" | "change-request",
    input: CommentInput,
    context: InboxActorContext,
  ) =>
    decodeCommentInput(input).pipe(
      Effect.mapError(
        (cause) =>
          new CommandCenterError({
            reason: "validation",
            message: "Inbox message is blank, oversized, or otherwise invalid.",
            cause,
          }),
      ),
      Effect.flatMap((validated) =>
        runMutation(commandKind, validated, context, (state, now) =>
          Effect.gen(function* () {
            const updatedAt = nextUpdatedAt(state.stateUpdatedAt, now);
            yield* bumpState(validated, updatedAt);
            yield* sql`
              INSERT INTO command_center_inbox_discussion (
                id, item_id, kind, text, actor_subject, created_at
              ) VALUES (
                ${`${kind}:${validated.mutationId}`}, ${validated.itemId}, ${kind},
                ${validated.text}, ${context.subject}, ${now}
              )
            `;
            if (kind === "change-request") {
              const invalidated = yield* sql<{
                readonly id: string;
                readonly runId: string | null;
                readonly payloadDigest: string;
              }>`
                UPDATE command_center_approvals
                SET status = 'canceled', decided_at = ${now},
                  decision_note = 'Invalidated by an Inbox change request.'
                WHERE item_id = ${validated.itemId}
                  AND (
                    status = 'requested'
                    OR (status = 'approved' AND EXISTS (
                      SELECT 1
                      FROM command_center_runs run
                      WHERE run.id = command_center_approvals.run_id
                        AND run.state IN ('waiting_approval', 'queued')
                        AND run.thread_id IS NULL
                    ))
                  )
                RETURNING id, run_id AS "runId", payload_digest AS "payloadDigest"
              `;
              yield* Effect.forEach(
                invalidated,
                (approval) =>
                  Effect.gen(function* () {
                    yield* audit.append({
                      eventId: `inbox-change-request:${validated.mutationId}:approval:${approval.id}`,
                      actorKind: "authenticated-user",
                      action: "cc.approvals.changed",
                      spaceId: validated.spaceId,
                      ...(approval.runId === null ? {} : { runId: approval.runId }),
                      payload: {
                        approvalId: approval.id,
                        status: "canceled",
                        payloadDigest: approval.payloadDigest,
                        reason: "changes-requested",
                      },
                      occurredAt: now,
                    });
                    if (approval.runId === null) return;
                    const runRows = yield* sql<{ readonly state: string }>`
                      SELECT state
                      FROM command_center_runs
                      WHERE id = ${approval.runId}
                      LIMIT 1
                    `;
                    const previousRunState = runRows[0]?.state;
                    if (previousRunState === undefined) {
                      return yield* persistenceError(
                        "An invalidated Inbox approval references a missing Run.",
                      );
                    }
                    const canceledRuns = yield* sql<{ readonly id: string }>`
                      UPDATE command_center_runs
                      SET state = 'canceled', execution_authorized_at = NULL, finished_at = ${now}
                      WHERE id = ${approval.runId}
                        AND state IN ('waiting_approval', 'queued')
                        AND thread_id IS NULL
                      RETURNING id
                    `;
                    if (canceledRuns.length === 0) return;
                    yield* audit.append({
                      eventId: `inbox-change-request:${validated.mutationId}:run:${approval.runId}`,
                      actorKind: "authenticated-user",
                      action: "cc.runs.state",
                      spaceId: validated.spaceId,
                      runId: approval.runId,
                      payload: {
                        status: "canceled",
                        previousStatus: previousRunState,
                        reason: "changes-requested",
                      },
                      occurredAt: now,
                    });
                  }),
                { discard: true },
              );
            }
          }),
        ),
      ),
    );

  const comment: CommandCenterInbox["Service"]["comment"] = (input, context) =>
    addDiscussion("cc.inbox.comment", "comment", input, context);

  const requestChanges: CommandCenterInbox["Service"]["requestChanges"] = (input, context) =>
    addDiscussion("cc.inbox.requestChanges", "change-request", input, context);

  const createCandidate: CommandCenterInbox["Service"]["createCandidate"] = (input, context) =>
    runMutation("cc.inbox.candidate.create", input, context, (state, now) =>
      Effect.gen(function* () {
        let fingerprint: string | null = null;
        if (input.payload.kind === "sprint-plan-task-patch") {
          if (state.subjectKind === "command-center-item" && state.currentRevisionId === null) {
            const prior = yield* sql<{ readonly id: string }>`
              SELECT id FROM command_center_inbox_revisions WHERE item_id = ${input.itemId} LIMIT 1
            `;
            if (prior.length > 0)
              return yield* conflictError("This Inbox item already has proposal history.");
            yield* sprintPlan
              .get({ planId: input.payload.target.id, spaceId: input.spaceId })
              .pipe(
                Effect.mapError(() =>
                  conflictError("The proposal target is not a current plan in this Space."),
                ),
              );
            yield* sql`
              UPDATE command_center_inbox_state
              SET subject_kind = 'sprint-plan', subject_id = ${input.payload.target.id}
              WHERE item_id = ${input.itemId} AND space_id = ${input.spaceId}
            `;
          } else if (
            state.subjectKind !== "sprint-plan" ||
            state.subjectId !== input.payload.target.id
          ) {
            return yield* conflictError("The Inbox item is bound to a different subject.");
          }
          fingerprint = yield* proposalFingerprint({
            spaceId: input.spaceId,
            planId: input.payload.target.id,
            evidence: input.evidence,
            operations: input.payload.operations,
          });
          const existing = yield* sql<{ readonly id: string }>`
            SELECT id FROM command_center_inbox_revisions
            WHERE item_id = ${input.itemId} AND proposal_fingerprint = ${fingerprint}
            LIMIT 1
          `;
          if (existing.length > 0) {
            return yield* conflictError(
              "This exact evidence and task diff already has an Inbox proposal.",
            );
          }
        }
        const revisions = yield* sql<{ readonly revision: number }>`
          SELECT COALESCE(MAX(revision), 0) + 1 AS revision
          FROM command_center_inbox_revisions
          WHERE item_id = ${input.itemId}
        `;
        const revision = revisions[0]?.revision;
        if (revision === undefined) {
          return yield* persistenceError("Could not allocate an Inbox revision.");
        }
        const updatedAt = nextUpdatedAt(state.stateUpdatedAt, now);
        yield* bumpState(input, updatedAt);
        yield* sql`
          INSERT INTO command_center_inbox_revisions (
            id, item_id, revision, predecessor_revision_id, status, source,
            payload_json, preview_json, evidence_json, proposal_fingerprint,
            actor_subject, created_at
          ) VALUES (
            ${`revision:${input.mutationId}`}, ${input.itemId}, ${revision},
            ${state.currentRevisionId}, 'candidate', ${input.source},
            ${encodeUnknownJson(input.payload)}, ${encodeUnknownJson(input.preview)},
            ${encodeUnknownJson(input.evidence)}, ${fingerprint}, ${context.subject}, ${now}
          )
        `;
      }),
    );

  const acceptCandidate: CommandCenterInbox["Service"]["acceptCandidate"] = (input, context) =>
    runMutation("cc.inbox.candidate.accept", input, context, (state, now) =>
      Effect.gen(function* () {
        const candidate = yield* loadRevision(input.candidateRevisionId, input.itemId);
        if (candidate === undefined) {
          return yield* new CommandCenterError({
            reason: "not_found",
            message: "The candidate revision was not found on this Inbox item.",
          });
        }
        if (candidate.status !== "candidate") {
          return yield* conflictError("The selected revision is no longer a candidate.");
        }
        const updatedAt = nextUpdatedAt(state.stateUpdatedAt, now);
        if (state.currentRevisionId !== null) {
          yield* sql`
            UPDATE command_center_inbox_revisions
            SET status = 'superseded'
            WHERE id = ${state.currentRevisionId} AND item_id = ${input.itemId}
              AND status = 'current'
          `;
        }
        const accepted = yield* sql<{ readonly id: string }>`
          UPDATE command_center_inbox_revisions
          SET status = 'current', accepted_at = ${now}, accepted_by_subject = ${context.subject}
          WHERE id = ${candidate.id} AND item_id = ${input.itemId} AND status = 'candidate'
          RETURNING id
        `;
        if (accepted.length !== 1) {
          return yield* conflictError("The candidate changed while it was being accepted.");
        }
        const changed = yield* sql<{ readonly version: number }>`
          UPDATE command_center_inbox_state
          SET current_revision_id = ${candidate.id}, version = version + 1,
            updated_at = ${updatedAt}
          WHERE item_id = ${input.itemId} AND space_id = ${input.spaceId}
            AND version = ${input.expectedVersion}
          RETURNING version
        `;
        if (changed.length !== 1) {
          return yield* conflictError("The Inbox item changed while the candidate was accepted.");
        }
      }),
    );

  const approveAdjustment: CommandCenterInbox["Service"]["approveAdjustment"] = (raw, context) =>
    Effect.gen(function* () {
      const input = yield* decodeApproveAdjustment(raw).pipe(
        Effect.mapError((cause) => validationError(`Invalid approval request: ${String(cause)}`)),
      );
      const normalized = { ...input, expectedVersion: input.expectedInboxVersion };
      return yield* runMutation("cc.inbox.adjustment.approve", normalized, context, (state, now) =>
        Effect.gen(function* () {
          if (state.currentRevisionId !== input.currentRevisionId) {
            return yield* conflictError("The accepted Inbox revision changed before approval.");
          }
          const currentState = yield* hydrateState(state, now);
          if (currentState.unresolvedChangeRequestCount > 0 || currentState.candidateCount > 0) {
            return yield* conflictError(
              "The proposal has unresolved changes or a pending candidate.",
            );
          }
          // An elapsed snooze reads as open everywhere else, so approval uses the same view.
          if (currentState.lifecycle !== "open") {
            return yield* conflictError("Only an open Inbox item can be approved.");
          }
          const revisionRow = yield* loadRevision(input.currentRevisionId, input.itemId);
          if (revisionRow?.status !== "current") {
            return yield* conflictError("The accepted Inbox revision is no longer current.");
          }
          const revision = yield* decodeRevisionRow(revisionRow);
          if (revision.payload.kind !== "sprint-plan-task-patch") {
            return yield* conflictError("This proposal cannot edit a sprint plan.");
          }
          if (revision.payload.expectedPlanVersion !== input.expectedPlanVersion) {
            return yield* conflictError("The proposal targets another sprint plan version.");
          }
          if (encodeUnknownJson(revision.payload) !== revisionRow.payloadJson) {
            return yield* persistenceError(
              "Stored proposal payload does not match its decoded body.",
            );
          }
          const assessed = yield* assessAdjustment(state, revisionRow, now);
          if (!assessed.eligible) {
            return yield* conflictError(`Adjustment approval is blocked: ${assessed.reason}.`);
          }
          const payloadDigest = yield* digest(revisionRow.payloadJson);
          const fingerprint = yield* proposalFingerprint({
            spaceId: input.spaceId,
            planId: revision.payload.target.id,
            evidence: revision.evidence,
            operations: revision.payload.operations,
          });
          const duplicate = yield* sql<{ readonly itemId: string }>`
            SELECT item_id AS "itemId"
            FROM command_center_sprint_plan_adjustment_approvals
            WHERE proposal_fingerprint = ${fingerprint} LIMIT 1
          `;
          if (duplicate.length > 0) {
            return yield* conflictError("This exact evidence and task diff was already approved.");
          }
          const before = revision.payload.operations.map(({ taskId, field, before }) => ({
            taskId,
            field,
            value: before,
          }));
          const after = revision.payload.operations.map(({ taskId, field, after }) => ({
            taskId,
            field,
            value: after,
          }));
          const plan = yield* sprintPlan
            .applyApprovedTaskFieldsInTransaction(
              {
                planId: revision.payload.target.id,
                spaceId: input.spaceId,
                expectedVersion: input.expectedPlanVersion,
                mutationId: input.mutationId,
                revisionId: revision.id,
                evidenceRef: assessed.snapshot.revisionId,
                reason: revision.payload.reason,
                operations: revision.payload.operations,
              },
              { id: context.subject, kind: "user" },
            )
            .pipe(
              Effect.mapError((cause) =>
                cause.reason === "conflict" || cause.reason === "validation"
                  ? conflictError(cause.message)
                  : persistenceError(cause.message, cause),
              ),
            );
          yield* sql`
            INSERT INTO command_center_sprint_plan_adjustment_approvals (
              mutation_id, space_id, item_id, revision_id, plan_id,
              before_plan_version, after_plan_version, payload_digest,
              evidence_revision_id, evidence_digest, policy_digest, proposal_fingerprint,
              approver_subject, diff_json, approved_at
            ) VALUES (
              ${input.mutationId}, ${input.spaceId}, ${input.itemId}, ${revision.id},
              ${plan.id}, ${input.expectedPlanVersion}, ${plan.version}, ${payloadDigest},
              ${assessed.snapshot.revisionId}, ${assessed.snapshot.revisionDigest},
              ${assessed.policyDigest}, ${fingerprint}, ${context.subject},
              ${encodeUnknownJson({ before, after })}, ${now}
            )
          `;
          yield* bumpState(normalized, nextUpdatedAt(state.stateUpdatedAt, now));
        }),
      );
    });

  const discardCandidate: CommandCenterInbox["Service"]["discardCandidate"] = (input, context) =>
    runMutation("cc.inbox.candidate.discard", input, context, (state, now) =>
      Effect.gen(function* () {
        const updatedAt = nextUpdatedAt(state.stateUpdatedAt, now);
        yield* bumpState(input, updatedAt);
        const discarded = yield* sql<{ readonly id: string }>`
          UPDATE command_center_inbox_revisions
          SET status = 'discarded', discarded_at = ${now},
            discarded_by_subject = ${context.subject}
          WHERE id = ${input.candidateRevisionId} AND item_id = ${input.itemId}
            AND status = 'candidate'
          RETURNING id
        `;
        if (discarded.length !== 1) {
          return yield* conflictError("The selected revision is no longer a candidate.");
        }
      }),
    );

  const resolveChangeRequest: CommandCenterInbox["Service"]["resolveChangeRequest"] = (
    input,
    context,
  ) =>
    runMutation("cc.inbox.changeRequest.resolve", input, context, (state, now) =>
      Effect.gen(function* () {
        const updatedAt = nextUpdatedAt(state.stateUpdatedAt, now);
        yield* bumpState(input, updatedAt);
        const resolved = yield* sql<{ readonly id: string }>`
          UPDATE command_center_inbox_discussion
          SET resolved_at = ${now}, resolved_by_subject = ${context.subject}
          WHERE id = ${input.changeRequestId} AND item_id = ${input.itemId}
            AND kind = 'change-request' AND resolved_at IS NULL
          RETURNING id
        `;
        if (resolved.length !== 1) {
          return yield* conflictError("The selected change request is no longer unresolved.");
        }
      }),
    );

  const snooze: CommandCenterInbox["Service"]["snooze"] = (input, context) =>
    runMutation("cc.inbox.snooze", input, context, (state, now) =>
      Effect.gen(function* () {
        if (state.lifecycle === "dismissed") {
          return yield* conflictError("A dismissed Inbox item must be reopened before snoozing.");
        }
        const wakeAt = DateTime.make(input.wakeAt);
        const observedAt = DateTime.make(now);
        if (
          Option.isNone(wakeAt) ||
          Option.isNone(observedAt) ||
          DateTime.toEpochMillis(wakeAt.value) <= DateTime.toEpochMillis(observedAt.value)
        ) {
          return yield* validationError("Inbox snooze wake time must be a valid future instant.");
        }
        const updatedAt = nextUpdatedAt(state.stateUpdatedAt, now);
        const changed = yield* sql<{ readonly version: number }>`
          UPDATE command_center_inbox_state
          SET lifecycle = 'snoozed', snoozed_until = ${DateTime.formatIso(wakeAt.value)},
            version = version + 1, updated_at = ${updatedAt}
          WHERE item_id = ${input.itemId} AND space_id = ${input.spaceId}
            AND version = ${input.expectedVersion}
          RETURNING version
        `;
        if (changed.length !== 1) {
          return yield* conflictError("The Inbox item changed while it was snoozed.");
        }
      }),
    );

  const setLifecycle = (
    commandKind: "cc.inbox.unsnooze" | "cc.inbox.dismiss" | "cc.inbox.reopen",
    target: "open" | "dismissed",
    allowed: ReadonlyArray<ItemStateRow["lifecycle"]>,
    input: SimpleMutationInput,
    context: InboxActorContext,
  ) =>
    runMutation(commandKind, input, context, (state, now) =>
      Effect.gen(function* () {
        if (!allowed.includes(state.lifecycle)) {
          return yield* conflictError(
            `The Inbox item cannot transition from '${state.lifecycle}'.`,
          );
        }
        const updatedAt = nextUpdatedAt(state.stateUpdatedAt, now);
        const changed = yield* sql<{ readonly version: number }>`
          UPDATE command_center_inbox_state
          SET lifecycle = ${target}, snoozed_until = NULL, version = version + 1,
            updated_at = ${updatedAt}
          WHERE item_id = ${input.itemId} AND space_id = ${input.spaceId}
            AND version = ${input.expectedVersion}
          RETURNING version
        `;
        if (changed.length !== 1) {
          return yield* conflictError("The Inbox item changed during its lifecycle transition.");
        }
      }),
    );

  const unsnooze: CommandCenterInbox["Service"]["unsnooze"] = (input, context) =>
    setLifecycle("cc.inbox.unsnooze", "open", ["snoozed"], input, context);
  const dismiss: CommandCenterInbox["Service"]["dismiss"] = (input, context) =>
    setLifecycle("cc.inbox.dismiss", "dismissed", ["open", "snoozed"], input, context);
  const reopen: CommandCenterInbox["Service"]["reopen"] = (input, context) =>
    setLifecycle("cc.inbox.reopen", "open", ["dismissed"], input, context);

  return CommandCenterInbox.of({
    query,
    detail,
    comment,
    requestChanges,
    createCandidate,
    acceptCandidate,
    approveAdjustment,
    discardCandidate,
    resolveChangeRequest,
    snooze,
    unsnooze,
    dismiss,
    reopen,
  });
});

export const layer = Layer.effect(CommandCenterInbox, make);
