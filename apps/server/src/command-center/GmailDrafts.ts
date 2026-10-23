/**
 * GmailDrafts - Gmail drafts a Space agent leaves for the owner
 * (`cc_google_draft_create`). It never sends: drafts go through
 * `GoogleReadConnector.createDraft` (gog with the draft-only command allowlist
 * and `--gmail-no-send`), and the owner sends them from Gmail.
 *
 * There is no approval step, because a draft is a visible, deletable write to
 * the owner's own mailbox. Instead a Space may create at most
 * `GMAIL_DRAFT_LIMIT` drafts in any rolling 24 hours, counted from its
 * `gmail-draft:<draftId>` Space activity rows. Each draft writes that row (the
 * owner's notice and the limit's counter) and an agent audit event in one
 * transaction; neither carries addresses or the body.
 *
 * @module GmailDrafts
 */
import { CommandCenterError, type GoogleDraftCreateRequest } from "@t3tools/contracts";
import { truncate } from "@t3tools/shared/String";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import { makeCommandCenterAuditLog } from "./AuditLog.ts";
import { GoogleReadConnector } from "./GoogleReadConnector.ts";
import { SPACE_ACTIVITY_EXTERNAL_EVENT_SEQUENCE, SpaceActivity } from "./SpaceActivity.ts";

const GMAIL_DRAFT_LIMIT = 10;
const GMAIL_DRAFT_WINDOW_MS = 24 * 60 * 60 * 1000;
const GMAIL_DRAFT_SOURCE_PREFIX = "gmail-draft:";

/** Opens the draft in Gmail's default signed-in account (the server knows no account index). */
const gmailDraftUrl = (messageId: string) =>
  `https://mail.google.com/mail/#drafts?compose=${encodeURIComponent(messageId)}`;

export class GmailDrafts extends Context.Service<
  GmailDrafts,
  {
    /**
     * Create one draft in `request.spaceId`'s mailbox, attributed to the agent
     * thread. At the Space's 24-hour limit it fails without calling Gmail.
     */
    readonly createForSpace: (input: {
      readonly request: GoogleDraftCreateRequest;
      readonly agentThreadId: string;
    }) => Effect.Effect<
      { readonly draftId: string; readonly messageId?: string; readonly threadId?: string },
      CommandCenterError
    >;
  }
>()("@awtprod/command-center/command-center/GmailDrafts") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const connector = yield* GoogleReadConnector;
  const activity = yield* SpaceActivity;
  const audit = yield* makeCommandCenterAuditLog;
  // Count, create, and record run one draft at a time, so parallel calls
  // cannot pass the limit together. Drafts are rare; a gog call holds it for seconds.
  const lock = yield* Semaphore.make(1);

  const countSince = (spaceId: string, since: string) =>
    sql<{ readonly drafts: number }>`
      SELECT COUNT(*) AS drafts
      FROM command_center_space_activity
      WHERE space_id = ${spaceId}
        AND source_kind = 'run'
        AND source_id LIKE ${`${GMAIL_DRAFT_SOURCE_PREFIX}%`}
        AND occurred_at >= ${since}
    `.pipe(
      Effect.map((rows) => rows[0]?.drafts ?? 0),
      Effect.mapError(
        (cause) =>
          new CommandCenterError({
            reason: "persistence",
            message: "Could not count this Space's recent Gmail drafts.",
            cause,
          }),
      ),
    );

  const createForSpace: GmailDrafts["Service"]["createForSpace"] = ({ request, agentThreadId }) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const createDraft = connector.createDraft;
        if (createDraft === undefined) {
          return yield* new CommandCenterError({
            reason: "config",
            message: "Gmail draft creation is not configured on this server.",
          });
        }
        const nowMs = yield* Clock.currentTimeMillis;
        const since = DateTime.formatIso(DateTime.makeUnsafe(nowMs - GMAIL_DRAFT_WINDOW_MS));
        if ((yield* countSince(request.spaceId, since)) >= GMAIL_DRAFT_LIMIT) {
          return yield* new CommandCenterError({
            reason: "validation",
            message: `This Space reached its limit of ${GMAIL_DRAFT_LIMIT} Gmail drafts in 24 hours; no draft was created.`,
          });
        }
        const created = yield* createDraft(request, []).pipe(
          Effect.mapError(
            (cause) =>
              new CommandCenterError({ reason: "connector", message: cause.message, cause }),
          ),
        );
        const recipients = request.to.length + (request.cc?.length ?? 0);
        const occurredAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* activity.record({
                spaceId: request.spaceId,
                occurredAt,
                sourceKind: "run",
                sourceId: `${GMAIL_DRAFT_SOURCE_PREFIX}${created.draftId}`,
                projectId: null,
                title: `Draft saved: ${truncate(request.subject, 117)}`,
                status: "draft",
                text: `to ${recipients} recipient${recipients === 1 ? "" : "s"}`,
                eventSequence: SPACE_ACTIVITY_EXTERNAL_EVENT_SEQUENCE,
                ...(created.messageId === undefined
                  ? {}
                  : { url: gmailDraftUrl(created.messageId) }),
              });
              yield* audit.append({
                actorKind: "agent",
                action: "cc.connections.google.gmail.draft.created",
                spaceId: request.spaceId,
                payload: {
                  draftId: created.draftId,
                  connectionId: request.connectionId,
                  recipients,
                  reply: request.threadId !== undefined || request.replyToMessageId !== undefined,
                  agentThreadId,
                },
                occurredAt,
              });
            }),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new CommandCenterError({
                  reason: "persistence",
                  message: `The draft was saved in Gmail (draft ${created.draftId}) but could not be recorded; do not create it again.`,
                  cause,
                }),
            ),
          );
        return {
          draftId: created.draftId,
          ...(created.messageId === undefined ? {} : { messageId: created.messageId }),
          ...(created.threadId === undefined ? {} : { threadId: created.threadId }),
        };
      }),
    );

  return GmailDrafts.of({ createForSpace });
});

export const layer = Layer.effect(GmailDrafts, make);
