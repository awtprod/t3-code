import * as NodeCrypto from "node:crypto";

import {
  CommandCenterError,
  CommandCenterInboxDraftReceipt,
  CommandCenterInboxProposalPayload,
  GoogleDraftCreateRequest,
  type CommandCenterInboxDraftApproveInput,
  type CommandCenterInboxDraftReceiptInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as CommandCenterConfig from "./Config.ts";
import * as CommandCenter from "./Service.ts";
import { googleCapabilityForDraft } from "./GoogleCapabilities.ts";

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeProposal = Schema.decodeUnknownEffect(CommandCenterInboxProposalPayload);
const decodeDraft = Schema.decodeUnknownEffect(GoogleDraftCreateRequest);
const decodeReceipt = Schema.decodeUnknownEffect(CommandCenterInboxDraftReceipt);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const isCommandCenterError = Schema.is(CommandCenterError);

const DRAFT_REQUEST_KEYS = new Set([
  "spaceId",
  "connectionId",
  "operation",
  "to",
  "cc",
  "bcc",
  "subject",
  "body",
  "bodyHtml",
  "replyToMessageId",
  "threadId",
  "attachmentArtifactIds",
]);

type ProposalRow = {
  readonly itemId: string;
  readonly spaceId: string;
  readonly itemUpdatedAt: string;
  readonly itemStatus: string;
  readonly itemTitle: string;
  readonly itemBody: string | null;
  readonly lifecycle: string;
  readonly version: number;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly currentRevisionId: string | null;
  readonly revisionStatus: string;
  readonly payloadJson: string;
  readonly evidenceJson: string;
  readonly unresolvedChanges: number;
  readonly candidateCount: number;
};

type DraftRow = {
  readonly mutationId: string;
  readonly itemId: string;
  readonly spaceId: string;
  readonly revisionId: string;
  readonly expectedVersion: number;
  readonly actorSubject: string;
  readonly requestDigest: string;
  readonly payloadDigest: string;
  readonly evidenceDigest: string;
  readonly connectionId: string;
  readonly accountAlias: string;
  readonly status: "approved" | "creating" | "created" | "uncertain";
  readonly draftId: string | null;
  readonly messageId: string | null;
  readonly threadId: string | null;
  readonly error: string | null;
};

function digest(value: string): string {
  return `sha256:${NodeCrypto.createHash("sha256").update(value).digest("hex")}`;
}

function itemDigest(row: ProposalRow): string {
  return digest(
    encodeJson([row.itemId, row.itemUpdatedAt, row.itemStatus, row.itemTitle, row.itemBody]),
  );
}

function conflict(message: string): CommandCenterError {
  return new CommandCenterError({ reason: "conflict", message });
}

function invalid(message: string): CommandCenterError {
  return new CommandCenterError({ reason: "validation", message });
}

export class InboxGmailDrafts extends Context.Service<
  InboxGmailDrafts,
  {
    readonly approve: (
      input: CommandCenterInboxDraftApproveInput,
      actorSubject: string,
    ) => Effect.Effect<CommandCenterInboxDraftReceipt, CommandCenterError>;
    readonly receipt: (
      input: CommandCenterInboxDraftReceiptInput,
    ) => Effect.Effect<CommandCenterInboxDraftReceipt | null, CommandCenterError>;
    readonly loadForExecution: (input: {
      readonly mutationId: string;
      readonly spaceId: string;
      readonly payloadDigest: string;
    }) => Effect.Effect<
      {
        readonly request: GoogleDraftCreateRequest;
        readonly accountAlias: string;
        readonly status: DraftRow["status"];
        readonly receipt: CommandCenterInboxDraftReceipt;
      },
      CommandCenterError
    >;
    readonly claim: (mutationId: string) => Effect.Effect<void, CommandCenterError>;
    readonly complete: (
      mutationId: string,
      result: { readonly draftId: string; readonly messageId?: string; readonly threadId?: string },
    ) => Effect.Effect<CommandCenterInboxDraftReceipt, CommandCenterError>;
    readonly uncertain: (mutationId: string, message: string) => Effect.Effect<void>;
  }
>()("@awtprod/command-center/command-center/InboxGmailDrafts") {}

export const layer = Layer.effect(
  InboxGmailDrafts,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const commandCenter = yield* CommandCenter.CommandCenterService;
    const config = yield* CommandCenterConfig.CommandCenterConfig;

    const loadProposal = Effect.fn("InboxGmailDrafts.loadProposal")(function* (
      spaceId: string,
      itemId: string,
      revisionId: string,
    ) {
      const rows = yield* sql<ProposalRow>`
        SELECT item.id AS "itemId", item.space_id AS "spaceId", item.updated_at AS "itemUpdatedAt",
          item.status AS "itemStatus", item.title AS "itemTitle", item.body AS "itemBody",
          inbox.version, inbox.lifecycle, inbox.subject_kind AS "subjectKind", inbox.subject_id AS "subjectId",
          inbox.current_revision_id AS "currentRevisionId", revision.status AS "revisionStatus",
          revision.payload_json AS "payloadJson", revision.evidence_json AS "evidenceJson",
          (SELECT COUNT(*) FROM command_center_inbox_discussion discussion
            WHERE discussion.item_id = item.id AND discussion.kind = 'change-request'
              AND discussion.resolved_at IS NULL) AS "unresolvedChanges",
          (SELECT COUNT(*) FROM command_center_inbox_revisions candidate
            WHERE candidate.item_id = item.id AND candidate.status = 'candidate') AS "candidateCount"
        FROM command_center_items item
        JOIN command_center_spaces space ON space.id = item.space_id AND space.lifecycle = 'active'
        JOIN command_center_inbox_state inbox ON inbox.item_id = item.id
        JOIN command_center_inbox_revisions revision ON revision.id = ${revisionId}
          AND revision.item_id = item.id
        WHERE item.id = ${itemId} AND item.space_id = ${spaceId}
        LIMIT 1
      `;
      const row = rows[0];
      if (row === undefined)
        return yield* invalid("The accepted Inbox revision is unavailable in this Space.");
      return row;
    });

    const decodeAccepted = Effect.fn("InboxGmailDrafts.decodeAccepted")(function* (
      row: ProposalRow,
    ) {
      if (
        row.currentRevisionId === null ||
        row.revisionStatus !== "current" ||
        row.lifecycle !== "open" ||
        row.unresolvedChanges > 0 ||
        row.candidateCount > 0 ||
        row.itemStatus === "done" ||
        row.itemStatus === "canceled"
      ) {
        return yield* conflict("The Inbox proposal is no longer current and eligible for a draft.");
      }
      const payload = yield* decodeProposal(yield* decodeJson(row.payloadJson)).pipe(
        Effect.mapError(() => invalid("The accepted proposal payload is invalid.")),
      );
      if (
        payload.kind !== "prepared-action" ||
        payload.actionKind !== "gmail.draft.create" ||
        payload.target.kind !== row.subjectKind ||
        payload.target.id !== row.subjectId
      ) {
        return yield* invalid("The accepted proposal is not a draft for this Inbox subject.");
      }
      if (Object.keys(payload.parameters).some((key) => !DRAFT_REQUEST_KEYS.has(key))) {
        return yield* invalid("The Gmail draft proposal contains unsupported fields.");
      }
      const request = yield* decodeDraft(payload.parameters).pipe(
        Effect.mapError(() => invalid("The accepted Gmail draft request is invalid.")),
      );
      if (
        request.spaceId !== row.spaceId ||
        request.operation !== "gmail.draft.create" ||
        request.to.length === 0 ||
        request.to.length > 20 ||
        (request.attachmentArtifactIds?.length ?? 0) > 20
      ) {
        return yield* invalid("The Gmail draft request exceeds its bound or Space.");
      }
      const evidence = yield* decodeJson(row.evidenceJson).pipe(
        Effect.mapError(() => invalid("The accepted evidence identity is invalid.")),
      );
      if (
        typeof evidence !== "object" ||
        evidence === null ||
        Array.isArray(evidence) ||
        !("source" in evidence) ||
        evidence.source !== "command-center-item" ||
        !("subjectId" in evidence) ||
        evidence.subjectId !== row.itemId ||
        !("version" in evidence) ||
        evidence.version !== row.itemUpdatedAt ||
        ("digest" in evidence && evidence.digest !== itemDigest(row))
      ) {
        return yield* conflict("The accepted proposal evidence no longer matches this Item.");
      }
      return { request, payloadDigest: digest(row.payloadJson), evidenceDigest: itemDigest(row) };
    });

    const loadRow = Effect.fn("InboxGmailDrafts.loadRow")(function* (mutationId: string) {
      const rows = yield* sql<DraftRow>`
        SELECT mutation_id AS "mutationId", item_id AS "itemId", space_id AS "spaceId",
          revision_id AS "revisionId", expected_version AS "expectedVersion",
          actor_subject AS "actorSubject", request_digest AS "requestDigest",
          payload_digest AS "payloadDigest", evidence_digest AS "evidenceDigest",
          connection_id AS "connectionId", account_alias AS "accountAlias", status,
          draft_id AS "draftId", message_id AS "messageId", thread_id AS "threadId", error
        FROM command_center_inbox_gmail_drafts WHERE mutation_id = ${mutationId} LIMIT 1
      `;
      return rows[0] ?? null;
    });

    const asReceipt = Effect.fn("InboxGmailDrafts.asReceipt")(function* (row: DraftRow) {
      return yield* decodeReceipt({
        mutationId: row.mutationId,
        itemId: row.itemId,
        spaceId: row.spaceId,
        expectedVersion: row.expectedVersion,
        revisionId: row.revisionId,
        payloadDigest: row.payloadDigest,
        connectionId: row.connectionId,
        accountAlias: row.accountAlias,
        status: row.status,
        ...(row.draftId === null ? {} : { draftId: row.draftId }),
        ...(row.messageId === null ? {} : { messageId: row.messageId }),
        ...(row.threadId === null ? {} : { threadId: row.threadId }),
        ...(row.error === null ? {} : { error: row.error }),
      }).pipe(Effect.mapError(() => invalid("The stored Gmail draft receipt is invalid.")));
    });

    const checkConnection = Effect.fn("InboxGmailDrafts.checkConnection")(function* (
      request: GoogleDraftCreateRequest,
      expectedAccountAlias?: string,
    ) {
      const connections = (yield* commandCenter.queryConnections({ spaceId: request.spaceId }))
        .connections;
      const connection = connections.find(
        (candidate) =>
          candidate.id === request.connectionId &&
          candidate.kind === "google" &&
          candidate.capabilities.includes(googleCapabilityForDraft(request.operation)),
      );
      if (connection === undefined)
        return yield* conflict("The Gmail draft connection no longer grants draft creation.");
      const account = yield* config.resolveGoogleAccount({
        spaceId: request.spaceId,
        connectionId: request.connectionId,
      });
      if (expectedAccountAlias !== undefined && account.accountAlias !== expectedAccountAlias) {
        return yield* conflict("The Gmail draft connection now resolves to another account.");
      }
      return account.accountAlias;
    });

    const approve = Effect.fn("InboxGmailDrafts.approve")(function* (
      input: CommandCenterInboxDraftApproveInput,
      actorSubject: string,
    ) {
      const requestDigest = digest(
        encodeJson([
          input.spaceId,
          input.itemId,
          input.revisionId,
          input.expectedVersion,
          actorSubject,
        ]),
      );
      const previous = yield* loadRow(input.mutationId);
      if (previous !== null) {
        if (previous.requestDigest !== requestDigest || previous.actorSubject !== actorSubject) {
          return yield* conflict("The Gmail draft approval ID was used for another request.");
        }
        return yield* asReceipt(previous);
      }
      const row = yield* loadProposal(input.spaceId, input.itemId, input.revisionId);
      if (row.version !== input.expectedVersion || row.currentRevisionId !== input.revisionId) {
        return yield* conflict("The Inbox revision changed before draft approval.");
      }
      const accepted = yield* decodeAccepted(row);
      const accountAlias = yield* checkConnection(accepted.request);
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO command_center_inbox_gmail_drafts (
          mutation_id, item_id, space_id, revision_id, expected_version,
          actor_subject, request_digest, payload_digest, evidence_digest,
          connection_id, account_alias, status, created_at, updated_at
        ) VALUES (
          ${input.mutationId}, ${input.itemId}, ${input.spaceId}, ${input.revisionId},
          ${input.expectedVersion}, ${actorSubject}, ${requestDigest}, ${accepted.payloadDigest},
          ${accepted.evidenceDigest}, ${accepted.request.connectionId}, ${accountAlias},
          'approved', ${now}, ${now}
        )
      `;
      const stored = yield* loadRow(input.mutationId);
      if (stored === null) return yield* invalid("The draft approval receipt was not stored.");
      return yield* asReceipt(stored);
    });

    const receipt = Effect.fn("InboxGmailDrafts.receipt")(function* (
      input: CommandCenterInboxDraftReceiptInput,
    ) {
      const rows = yield* sql<{ readonly mutationId: string }>`
        SELECT mutation_id AS "mutationId" FROM command_center_inbox_gmail_drafts
        WHERE item_id = ${input.itemId} AND space_id = ${input.spaceId}
        ORDER BY created_at DESC LIMIT 1
      `;
      const id = rows[0]?.mutationId;
      if (id === undefined) return null;
      const row = yield* loadRow(id);
      return row === null ? null : yield* asReceipt(row);
    });

    const loadForExecution = Effect.fn("InboxGmailDrafts.loadForExecution")(function* (input: {
      readonly mutationId: string;
      readonly spaceId: string;
      readonly payloadDigest: string;
    }) {
      const receipt = yield* loadRow(input.mutationId);
      if (
        receipt === null ||
        receipt.spaceId !== input.spaceId ||
        receipt.payloadDigest !== input.payloadDigest
      ) {
        return yield* conflict("The Gmail draft approval does not match this automation Run.");
      }
      if (receipt.status === "uncertain" || receipt.status === "creating") {
        return yield* conflict("Gmail draft creation needs reconciliation before another attempt.");
      }
      const row = yield* loadProposal(receipt.spaceId, receipt.itemId, receipt.revisionId);
      if (row.currentRevisionId !== receipt.revisionId || row.version !== receipt.expectedVersion) {
        return yield* conflict("The Gmail draft approval is stale after an Inbox revision change.");
      }
      const accepted = yield* decodeAccepted(row);
      if (
        accepted.payloadDigest !== receipt.payloadDigest ||
        accepted.evidenceDigest !== receipt.evidenceDigest ||
        accepted.request.connectionId !== receipt.connectionId
      ) {
        return yield* conflict("The accepted Gmail draft payload or evidence changed.");
      }
      yield* checkConnection(accepted.request, receipt.accountAlias);
      return {
        request: accepted.request,
        accountAlias: receipt.accountAlias,
        status: receipt.status,
        receipt: yield* asReceipt(receipt),
      };
    });

    const claim = Effect.fn("InboxGmailDrafts.claim")(function* (mutationId: string) {
      const updated = yield* sql<{ readonly mutationId: string }>`
        UPDATE command_center_inbox_gmail_drafts SET status = 'creating',
          updated_at = ${DateTime.formatIso(yield* DateTime.now)}
        WHERE mutation_id = ${mutationId} AND status = 'approved'
          AND EXISTS (
            SELECT 1 FROM command_center_inbox_state inbox
            JOIN command_center_items item ON item.id = inbox.item_id
            WHERE inbox.item_id = command_center_inbox_gmail_drafts.item_id
              AND inbox.space_id = command_center_inbox_gmail_drafts.space_id
              AND inbox.current_revision_id = command_center_inbox_gmail_drafts.revision_id
              AND inbox.version = command_center_inbox_gmail_drafts.expected_version
              AND inbox.lifecycle = 'open'
              AND item.status NOT IN ('done', 'canceled')
              AND NOT EXISTS (
                SELECT 1 FROM command_center_inbox_discussion discussion
                WHERE discussion.item_id = inbox.item_id AND discussion.kind = 'change-request'
                  AND discussion.resolved_at IS NULL
              )
              AND NOT EXISTS (
                SELECT 1 FROM command_center_inbox_revisions candidate
                WHERE candidate.item_id = inbox.item_id AND candidate.status = 'candidate'
              )
          )
        RETURNING mutation_id AS "mutationId"
      `;
      if (updated.length !== 1)
        return yield* conflict("The Gmail draft approval was already consumed.");
    });

    const complete = Effect.fn("InboxGmailDrafts.complete")(function* (
      mutationId: string,
      result: { readonly draftId: string; readonly messageId?: string; readonly threadId?: string },
    ) {
      const updated = yield* sql<{ readonly mutationId: string }>`
        UPDATE command_center_inbox_gmail_drafts SET status = 'created',
          draft_id = ${result.draftId}, message_id = ${result.messageId ?? null},
          thread_id = ${result.threadId ?? null}, error = NULL,
          updated_at = ${DateTime.formatIso(yield* DateTime.now)}
        WHERE mutation_id = ${mutationId} AND status = 'creating'
        RETURNING mutation_id AS "mutationId"
      `;
      if (updated.length !== 1)
        return yield* conflict("The Gmail draft outcome needs reconciliation.");
      const row = yield* loadRow(mutationId);
      if (row === null) return yield* invalid("The Gmail draft receipt disappeared.");
      return yield* asReceipt(row);
    });

    const uncertain: InboxGmailDrafts["Service"]["uncertain"] = Effect.fn(
      "InboxGmailDrafts.uncertain",
    )(function* (mutationId, message) {
      yield* sql`
        UPDATE command_center_inbox_gmail_drafts SET status = 'uncertain',
          error = ${message.slice(0, 500)}, updated_at = ${DateTime.formatIso(yield* DateTime.now)}
        WHERE mutation_id = ${mutationId} AND status = 'creating'
      `;
    }, Effect.orDie);

    const safe = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError((error) =>
          isCommandCenterError(error)
            ? error
            : invalid("The Gmail draft state could not be read or written."),
        ),
      );
    return InboxGmailDrafts.of({
      approve: (input, actor) => safe(approve(input, actor)),
      receipt: (input) => safe(receipt(input)),
      loadForExecution: (input) => safe(loadForExecution(input)),
      claim: (mutationId) => safe(claim(mutationId)),
      complete: (mutationId, result) => safe(complete(mutationId, result)),
      uncertain,
    });
  }),
);
