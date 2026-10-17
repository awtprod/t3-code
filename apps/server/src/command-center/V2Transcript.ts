/**
 * Command Center reads of thread transcripts from the orchestration V2
 * message projection (`orchestration_v2_projection_messages`), which the V2
 * event sink writes and the V1 importer back-fills for legacy threads.
 *
 * `EventStream` embeds the same "newest finished assistant message" lookup as
 * a correlated subquery over this table; keep the two in step.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Longest assistant message prefix any Command Center reader loads. */
export const ASSISTANT_TEXT_READ_CHARS = 20_000;

/**
 * The newest finished assistant message of a thread, or of one V2 run of it
 * when `runId` is set; `null` when there is none.
 */
export const latestAssistantText = (input: {
  readonly threadId: string;
  readonly runId?: string | undefined;
  readonly maxChars?: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const maxChars = Math.max(
      1,
      Math.min(input.maxChars ?? ASSISTANT_TEXT_READ_CHARS, ASSISTANT_TEXT_READ_CHARS),
    );
    const runId = input.runId ?? null;
    const rows = yield* sql<{ readonly text: string | null }>`
      SELECT substr(json_extract(payload_json, '$.text'), 1, ${maxChars}) AS text
      FROM orchestration_v2_projection_messages
      WHERE thread_id = ${input.threadId}
        AND role = 'assistant'
        AND streaming = 0
        AND (${runId} IS NULL OR run_id = ${runId})
      ORDER BY created_at DESC, message_id DESC
      LIMIT 1
    `;
    const text = rows[0]?.text;
    return typeof text === "string" ? text : null;
  });
