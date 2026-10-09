import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Space agent reply loop.
 *
 * - `command_center_space_agent_replies`: the user's comments, change
 *   requests, dismissals, and status decisions on Items a Space agent created.
 *   A row stays pending (`delivered_at IS NULL`) until a wake turn carries it,
 *   so a busy agent, a pause, or quiet hours never lose a reply.
 * - `command_center_space_agent_state` is rebuilt so `last_wake_reason` also
 *   accepts `reply` (SQLite cannot alter a CHECK constraint in place).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE command_center_space_agent_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      space_id TEXT NOT NULL REFERENCES command_center_spaces(id),
      source_id TEXT NOT NULL UNIQUE,
      item_id TEXT NOT NULL,
      item_title TEXT NOT NULL CHECK (length(item_title) <= 200),
      kind TEXT NOT NULL CHECK (kind IN ('comment', 'change-request', 'dismissed', 'status')),
      body TEXT NOT NULL CHECK (length(body) <= 2000),
      occurred_at TEXT NOT NULL,
      delivered_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX idx_command_center_space_agent_replies_pending
    ON command_center_space_agent_replies(space_id, delivered_at, id)
  `;
  yield* sql`
    CREATE TABLE command_center_space_agent_state_next (
      space_id TEXT PRIMARY KEY REFERENCES command_center_spaces(id),
      last_wake_at TEXT,
      last_wake_reason TEXT CHECK (
        last_wake_reason IS NULL OR last_wake_reason IN ('event', 'check-in', 'manual', 'reply')
      ),
      wake_day TEXT,
      wakes_today INTEGER NOT NULL DEFAULT 0 CHECK (wakes_today >= 0),
      event_wakes_today INTEGER NOT NULL DEFAULT 0 CHECK (event_wakes_today >= 0),
      activity_cursor INTEGER NOT NULL DEFAULT 0 CHECK (activity_cursor >= 0),
      pending_since TEXT,
      last_check_in_slot TEXT,
      paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    INSERT INTO command_center_space_agent_state_next (
      space_id, last_wake_at, last_wake_reason, wake_day, wakes_today, event_wakes_today,
      activity_cursor, pending_since, last_check_in_slot, paused, updated_at
    )
    SELECT space_id, last_wake_at, last_wake_reason, wake_day, wakes_today, event_wakes_today,
      activity_cursor, pending_since, last_check_in_slot, paused, updated_at
    FROM command_center_space_agent_state
  `;
  yield* sql`DROP TABLE command_center_space_agent_state`;
  yield* sql`
    ALTER TABLE command_center_space_agent_state_next RENAME TO command_center_space_agent_state
  `;
});
