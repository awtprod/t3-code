import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * One wake ledger row per Space agent, written by `SpaceAgentWaker`: the last
 * wake, the local-day wake counters, the activity cursor (the newest
 * `command_center_space_activity.id` delivered), the first undelivered event
 * (debounce anchor), the last check-in slot fired, and the pause switch.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE command_center_space_agent_state (
      space_id TEXT PRIMARY KEY REFERENCES command_center_spaces(id),
      last_wake_at TEXT,
      last_wake_reason TEXT CHECK (
        last_wake_reason IS NULL OR last_wake_reason IN ('event', 'check-in', 'manual')
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
});
