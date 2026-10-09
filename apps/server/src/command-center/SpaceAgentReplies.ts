/**
 * SpaceAgentReplies - the pending reply queue (`command_center_space_agent_replies`).
 *
 * When the user comments on, requests changes to, dismisses, or decides
 * (changes the status of) an Item a Space agent created (`metadata.spaceAgent`),
 * the reply is recorded here inside the same transaction as the change. The
 * `SpaceAgentWaker` delivers pending replies on its next tick and marks them
 * delivered only after the turn was accepted, so a busy, paused, or quiet-hours
 * agent sees every reply once it can wake.
 *
 * @module SpaceAgentReplies
 */
import { CommandCenterError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

export type SpaceAgentReplyKind = "comment" | "change-request" | "dismissed" | "status";

export interface SpaceAgentReplyRow {
  readonly id: number;
  readonly spaceId: string;
  readonly itemId: string;
  readonly itemTitle: string;
  readonly kind: SpaceAgentReplyKind;
  readonly body: string;
  readonly occurredAt: string;
}

const MAX_TITLE = 200;
const MAX_BODY = 2000;

const decodeMetadataJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** Whether an Item's stored metadata JSON marks it as created by a Space agent. */
export const isSpaceAgentItemMetadata = (metadata: unknown): boolean => {
  const value =
    typeof metadata === "string" ? Option.getOrUndefined(decodeMetadataJson(metadata)) : metadata;
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)["spaceAgent"] === true
  );
};

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/**
 * Queue a reply. `sourceId` makes the write idempotent (a replayed mutation
 * records nothing new). Callers run this inside their own transaction.
 */
export const recordSpaceAgentReply = (
  sql: SqlClient.SqlClient,
  input: {
    readonly sourceId: string;
    readonly spaceId: string;
    readonly itemId: string;
    readonly itemTitle: string;
    readonly kind: SpaceAgentReplyKind;
    readonly body: string;
    readonly occurredAt: string;
  },
): Effect.Effect<void, SqlError> =>
  Effect.asVoid(
    sql`
      INSERT INTO command_center_space_agent_replies (
        space_id, source_id, item_id, item_title, kind, body, occurred_at
      ) VALUES (
        ${input.spaceId}, ${input.sourceId}, ${input.itemId},
        ${clip(input.itemTitle, MAX_TITLE)}, ${input.kind}, ${clip(input.body, MAX_BODY)},
        ${input.occurredAt}
      )
      ON CONFLICT (source_id) DO NOTHING
    `,
  );

const persistenceError = (message: string) => (cause: unknown) =>
  new CommandCenterError({ reason: "persistence", message, cause });

/** Undelivered replies of a Space, oldest first. */
export const pendingSpaceAgentReplies = (
  spaceId: string,
  limit = 50,
): Effect.Effect<ReadonlyArray<SpaceAgentReplyRow>, CommandCenterError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<SpaceAgentReplyRow>`
      SELECT id, space_id AS "spaceId", item_id AS "itemId", item_title AS "itemTitle",
        kind, body, occurred_at AS "occurredAt"
      FROM command_center_space_agent_replies
      WHERE space_id = ${spaceId} AND delivered_at IS NULL
      ORDER BY id ASC
      LIMIT ${limit}
    `.pipe(Effect.mapError(persistenceError("Could not read Space agent replies.")));
  });

/** Mark replies up to and including `throughId` delivered. */
export const markSpaceAgentRepliesDelivered = (
  spaceId: string,
  throughId: number,
  now: string,
): Effect.Effect<void, CommandCenterError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE command_center_space_agent_replies
      SET delivered_at = ${now}
      WHERE space_id = ${spaceId} AND delivered_at IS NULL AND id <= ${throughId}
    `.pipe(Effect.mapError(persistenceError("Could not mark Space agent replies delivered.")));
  });
