/**
 * GmailDrafts - Gmail drafts a Space agent leaves for the owner
 * (`cc_google_draft_create`). It never sends: drafts go through
 * `GoogleReadConnector.createDraft` (gog with the draft-only command allowlist
 * and `--gmail-no-send`), and the owner sends them from Gmail.
 *
 * There is no approval step, because a draft is a visible, deletable write to
 * the owner's own mailbox. Instead a Space may attempt at most
 * `GMAIL_DRAFT_LIMIT` drafts in any rolling 24 hours. Each attempt first
 * appends a `cc.connections.google.gmail.draft.requested` audit event (the
 * reservation), and the limit counts those. The audit log is append-only and
 * never pruned, so nothing that happens after the reservation (gog failing, or
 * the bookkeeping below failing) can free its slot. A failed attempt uses a
 * slot too, on purpose: whether gog left a draft behind is not knowable.
 *
 * After gog reports a draft, a Space activity row (`gmail-draft:<draftId>`,
 * the owner's notice) and a `…draft.created` audit event are written in one
 * transaction. If that fails the draft still exists, so the call still
 * succeeds (`recorded: false`) and a warning is logged. Neither the events nor
 * the row carry addresses or the body.
 *
 * @module GmailDrafts
 */
import { CommandCenterError, type GoogleDraftCreateRequest } from "@t3tools/contracts";
import { truncate } from "@t3tools/shared/String";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
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
const GMAIL_DRAFT_REQUESTED_ACTION = "cc.connections.google.gmail.draft.requested";
const GMAIL_DRAFT_SOURCE_PREFIX = "gmail-draft:";

/**
 * Reservation event ids are `<action>:<spaceId>:<ISO time>:<nonce>`. The audit
 * table has no index on Space or time, but `event_id` is UNIQUE, so the count
 * is an index range scan over one Space's recent reservations. ISO instants
 * sort as text in time order; the Space id is URI-encoded so it holds no `:`.
 */
const reservationKeyPrefix = (spaceId: string) =>
  `${GMAIL_DRAFT_REQUESTED_ACTION}:${encodeURIComponent(spaceId)}:`;

/** Opens the draft in Gmail's default signed-in account (the server knows no account index). */
const gmailDraftUrl = (messageId: string) =>
  `https://mail.google.com/mail/#drafts?compose=${encodeURIComponent(messageId)}`;

export class GmailDrafts extends Context.Service<
  GmailDrafts,
  {
    /**
     * Create one draft in `request.spaceId`'s mailbox, attributed to the agent
     * thread. At the Space's 24-hour limit it fails without calling Gmail.
     * `recorded` is false when the draft exists but its activity row and
     * audit event could not be written.
     */
    readonly createForSpace: (input: {
      readonly request: GoogleDraftCreateRequest;
      readonly agentThreadId: string;
    }) => Effect.Effect<
      {
        readonly draftId: string;
        readonly messageId?: string;
        readonly threadId?: string;
        readonly recorded: boolean;
      },
      CommandCenterError
    >;
  }
>()("@awtprod/command-center/command-center/GmailDrafts") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const connector = yield* GoogleReadConnector;
  const activity = yield* SpaceActivity;
  const audit = yield* makeCommandCenterAuditLog;
  // Count, reserve, and create run one draft at a time, so parallel calls
  // cannot pass the limit together. Drafts are rare; a gog call holds it for seconds.
  const lock = yield* Semaphore.make(1);

  const countReservationsSince = (spaceId: string, since: string) => {
    const prefix = reservationKeyPrefix(spaceId);
    return sql<{ readonly reservations: number }>`
      SELECT COUNT(*) AS reservations
      FROM command_center_audit_events
      WHERE event_id >= ${`${prefix}${since}`}
        AND event_id < ${`${prefix.slice(0, -1)};`}
        AND space_id = ${spaceId}
        AND action = ${GMAIL_DRAFT_REQUESTED_ACTION}
    `.pipe(
      Effect.map((rows) => rows[0]?.reservations ?? 0),
      Effect.mapError(
        (cause) =>
          new CommandCenterError({
            reason: "persistence",
            message: "Could not count this Space's recent Gmail drafts.",
            cause,
          }),
      ),
    );
  };

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
        const occurredAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
        const since = DateTime.formatIso(DateTime.makeUnsafe(nowMs - GMAIL_DRAFT_WINDOW_MS));
        if ((yield* countReservationsSince(request.spaceId, since)) >= GMAIL_DRAFT_LIMIT) {
          return yield* new CommandCenterError({
            reason: "validation",
            message: `This Space reached its limit of ${GMAIL_DRAFT_LIMIT} Gmail drafts in 24 hours; no draft was created.`,
          });
        }
        const recipients = request.to.length + (request.cc?.length ?? 0);
        const reply = request.threadId !== undefined || request.replyToMessageId !== undefined;
        const nonce = yield* crypto.randomUUIDv4().pipe(
          Effect.mapError(
            (cause) =>
              new CommandCenterError({
                reason: "persistence",
                message: "Could not reserve a Gmail draft; no draft was created.",
                cause,
              }),
          ),
        );
        yield* audit
          .append({
            eventId: `${reservationKeyPrefix(request.spaceId)}${occurredAt}:${nonce}`,
            actorKind: "agent",
            action: GMAIL_DRAFT_REQUESTED_ACTION,
            spaceId: request.spaceId,
            payload: {
              spaceId: request.spaceId,
              connectionId: request.connectionId,
              recipients,
              reply,
              agentThreadId,
              nonce,
            },
            occurredAt,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new CommandCenterError({
                  reason: "persistence",
                  message: "Could not reserve a Gmail draft; no draft was created.",
                  cause,
                }),
            ),
          );
        const created = yield* createDraft(request, []).pipe(
          Effect.mapError(
            (cause) =>
              new CommandCenterError({ reason: "connector", message: cause.message, cause }),
          ),
        );
        const recorded = yield* sql
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
                  reply,
                  agentThreadId,
                  nonce,
                },
                occurredAt,
              });
            }),
          )
          .pipe(
            Effect.as(true),
            Effect.catch((cause) =>
              Effect.logWarning("gmail draft saved but not recorded", {
                spaceId: request.spaceId,
                draftId: created.draftId,
                nonce,
                reason: cause.message,
              }).pipe(Effect.as(false)),
            ),
          );
        return {
          draftId: created.draftId,
          ...(created.messageId === undefined ? {} : { messageId: created.messageId }),
          ...(created.threadId === undefined ? {} : { threadId: created.threadId }),
          recorded,
        };
      }),
    );

  return GmailDrafts.of({ createForSpace });
});

export const layer = Layer.effect(GmailDrafts, make);
