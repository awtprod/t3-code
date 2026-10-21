/**
 * Space agent questions: Items a Space agent creates that need the user. The
 * agent's wakes are otherwise silent, so these are how it reaches the user.
 * Web push rings on them (`LocalWebPushNotifier`), and desktop clients follow
 * them through `cc.spaceAgent.questions.subscribe`.
 *
 * @module SpaceAgentQuestions
 */
import {
  type CommandCenterEventEnvelope,
  CommandCenterEventStreamError,
  type CommandCenterSpaceAgentQuestion,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { isSpaceAgentQuestion } from "../webPush/notifierDecision.ts";
import type { CommandCenterEventStreamShape } from "./EventStream.ts";
import { spaceAgentThreadId } from "./SpaceAgentIds.ts";

const decodeMetadataJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** Questions are rare and not urgent to the second: one indexed audit read per follower. */
export const SPACE_AGENT_QUESTION_POLL_MS = 5_000;

/**
 * The question behind a Command Center event, when the event is a Space agent
 * creating an Item that lands in Needs You. Reads the stored Item, because the
 * event carries neither its priority nor its agent metadata.
 */
export const readSpaceAgentQuestion = Effect.fn("SpaceAgentQuestions.read")(function* (
  event: CommandCenterEventEnvelope,
) {
  if (
    event._tag !== "ItemChanged" ||
    event.payload.change !== "created" ||
    event.actorKind !== "agent" ||
    event.spaceId === null
  ) {
    return Option.none<CommandCenterSpaceAgentQuestion>();
  }
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly kind: string;
    readonly status: string;
    readonly priority: string;
    readonly title: string;
    readonly metadataJson: string;
  }>`
    SELECT kind, status, priority, title, metadata_json AS "metadataJson"
    FROM command_center_items
    WHERE id = ${event.payload.itemId} AND space_id = ${event.spaceId}
    LIMIT 1
  `;
  const row = rows[0];
  if (row === undefined) return Option.none<CommandCenterSpaceAgentQuestion>();
  const metadata = decodeMetadataJson(row.metadataJson);
  if (Option.isNone(metadata) || !isSpaceAgentQuestion({ ...row, metadata: metadata.value })) {
    return Option.none<CommandCenterSpaceAgentQuestion>();
  }
  return Option.some<CommandCenterSpaceAgentQuestion>({
    spaceId: event.spaceId,
    itemId: event.payload.itemId,
    threadId: ThreadId.make(spaceAgentThreadId(event.spaceId)),
    title: row.title,
    occurredAt: event.occurredAt,
  });
});

/** The newest audit sequence: following from it never replays older events. */
export const readAuditHeadSequence = Effect.fn("SpaceAgentQuestions.readAuditHead")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const head = yield* sql<{ readonly sequence: number }>`
    SELECT COALESCE(MAX(sequence), 0) AS sequence FROM command_center_audit_events
  `;
  return head[0]?.sequence ?? 0;
});

/**
 * Questions asked from now on. An Item that cannot be read is logged and
 * skipped, so one bad row does not end a client's subscription.
 */
export const streamSpaceAgentQuestions = (input: {
  readonly events: CommandCenterEventStreamShape;
  readonly pollIntervalMs: number;
}) =>
  Stream.unwrap(
    readAuditHeadSequence().pipe(
      Effect.mapError(
        (cause) =>
          new CommandCenterEventStreamError({
            reason: "query",
            message: "The Command Center event head could not be read.",
            cause,
          }),
      ),
      Effect.map((afterSequence) =>
        input.events.changes({ afterSequence, pollIntervalMs: input.pollIntervalMs }).pipe(
          Stream.mapEffect((event) =>
            readSpaceAgentQuestion(event).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Space agent question lookup failed", {
                  sequence: event.sequence,
                  cause: Cause.pretty(cause),
                }).pipe(Effect.as(Option.none<CommandCenterSpaceAgentQuestion>())),
              ),
            ),
          ),
          Stream.filterMap((question) =>
            Option.isSome(question) ? Result.succeed(question.value) : Result.failVoid,
          ),
        ),
      ),
    ),
  );
