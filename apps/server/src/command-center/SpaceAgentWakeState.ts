/**
 * SpaceAgentWakeState - the per-Space wake ledger (`command_center_space_agent_state`).
 *
 * Kept free of the `SpaceAgent` service so both the agent's `list` and the
 * `SpaceAgentWaker` can read it without an import cycle.
 *
 * @module SpaceAgentWakeState
 */
import type { SpaceAgentConfig } from "@command-center/core";
import { CommandCenterError, type CommandCenterSpaceAgentWakeReason } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { localDateAt } from "./DigestPeriod.ts";

/** Used when neither check-ins nor quiet hours name a timezone. */
export const SPACE_AGENT_DEFAULT_TIMEZONE = "America/New_York";

export interface SpaceAgentWakeStateRow {
  readonly spaceId: string;
  readonly lastWakeAt: string | null;
  readonly lastWakeReason: CommandCenterSpaceAgentWakeReason | null;
  /** Local date (agent timezone) the counters below belong to. */
  readonly wakeDay: string | null;
  /** Wakes of every kind on `wakeDay`. */
  readonly wakesToday: number;
  /** Event wakes on `wakeDay`; only these count against `dailyWakeLimit`. */
  readonly eventWakesToday: number;
  /** Highest `command_center_space_activity.id` already delivered. */
  readonly activityCursor: number;
  /** When the oldest undelivered event happened (debounce anchor), or null. */
  readonly pendingSince: string | null;
  /** The last check-in slot fired (ISO instant), persisted before sending. */
  readonly lastCheckInSlot: string | null;
  readonly paused: boolean;
  readonly updatedAt: string;
}

export interface SpaceAgentWakeStatus {
  readonly paused: boolean;
  readonly lastWakeAt: string | null;
  readonly lastWakeReason: CommandCenterSpaceAgentWakeReason | null;
  readonly wakesToday: number;
  readonly pendingEvents: number;
}

export const EMPTY_SPACE_AGENT_WAKE_STATUS: SpaceAgentWakeStatus = {
  paused: false,
  lastWakeAt: null,
  lastWakeReason: null,
  wakesToday: 0,
  pendingEvents: 0,
};

/** Check-ins timezone, then quiet-hours timezone, then America/New_York. */
export const spaceAgentTimezone = (agent: Pick<SpaceAgentConfig, "checkIns" | "quietHours">) =>
  agent.checkIns?.timezone ?? agent.quietHours?.timezone ?? SPACE_AGENT_DEFAULT_TIMEZONE;

/** The ledger's counters as of `today`; a row from an earlier local day reads as zero. */
export const wakeCountersOn = (
  state: Pick<SpaceAgentWakeStateRow, "wakeDay" | "wakesToday" | "eventWakesToday"> | undefined,
  today: string,
) =>
  state !== undefined && state.wakeDay === today
    ? { wakesToday: state.wakesToday, eventWakesToday: state.eventWakesToday }
    : { wakesToday: 0, eventWakesToday: 0 };

interface RawStateRow extends Omit<SpaceAgentWakeStateRow, "paused"> {
  readonly paused: number;
}

interface RawStatusRow extends RawStateRow {
  readonly pendingEvents: number;
}

const persistenceError = (message: string) => (cause: unknown) =>
  new CommandCenterError({ reason: "persistence", message, cause });

const fromRaw = ({ paused, ...row }: RawStateRow): SpaceAgentWakeStateRow => ({
  ...row,
  paused: paused === 1,
});

/**
 * Every ledger row with its count of undelivered activity rows. The count is
 * bounded by the activity table's per-Space retention.
 */
export const querySpaceAgentWakeStatuses = (input: {
  readonly now: string;
  readonly spaces: ReadonlyArray<{
    readonly id: string;
    readonly agent?: Pick<SpaceAgentConfig, "checkIns" | "quietHours"> | undefined;
  }>;
}): Effect.Effect<
  ReadonlyMap<string, SpaceAgentWakeStatus>,
  CommandCenterError,
  SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<RawStatusRow>`
      SELECT state.space_id AS "spaceId", state.last_wake_at AS "lastWakeAt",
        state.last_wake_reason AS "lastWakeReason", state.wake_day AS "wakeDay",
        state.wakes_today AS "wakesToday", state.event_wakes_today AS "eventWakesToday",
        state.activity_cursor AS "activityCursor", state.pending_since AS "pendingSince",
        state.last_check_in_slot AS "lastCheckInSlot", state.paused, state.updated_at AS "updatedAt",
        (
          SELECT COUNT(*) FROM command_center_space_activity activity
          WHERE activity.space_id = state.space_id AND activity.id > state.activity_cursor
        ) AS "pendingEvents"
      FROM command_center_space_agent_state state
    `.pipe(Effect.mapError(persistenceError("Could not read Space agent wake state.")));
    const byId = new Map(rows.map((row) => [row.spaceId, row]));
    const statuses = new Map<string, SpaceAgentWakeStatus>();
    for (const space of input.spaces) {
      const row = byId.get(space.id);
      if (row === undefined) continue;
      const state = fromRaw(row);
      const today =
        space.agent === undefined ? null : localDateAt(input.now, spaceAgentTimezone(space.agent));
      statuses.set(space.id, {
        paused: state.paused,
        lastWakeAt: state.lastWakeAt,
        lastWakeReason: state.lastWakeReason,
        wakesToday: today === null ? 0 : wakeCountersOn(state, today).wakesToday,
        pendingEvents: row.pendingEvents,
      });
    }
    return statuses;
  });

/**
 * Read a Space's ledger row, creating it first when absent. A new row starts
 * its activity cursor at the Space's newest activity row: history recorded
 * before the agent existed is in the brief, not a wake.
 */
export const ensureSpaceAgentWakeState = (
  spaceId: string,
  now: string,
): Effect.Effect<SpaceAgentWakeStateRow, CommandCenterError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`
      INSERT INTO command_center_space_agent_state (space_id, activity_cursor, updated_at)
      VALUES (
        ${spaceId},
        COALESCE(
          (SELECT MAX(id) FROM command_center_space_activity WHERE space_id = ${spaceId}),
          0
        ),
        ${now}
      )
      ON CONFLICT (space_id) DO NOTHING
    `.pipe(
      Effect.andThen(
        sql<RawStateRow>`
      SELECT space_id AS "spaceId", last_wake_at AS "lastWakeAt",
        last_wake_reason AS "lastWakeReason", wake_day AS "wakeDay",
        wakes_today AS "wakesToday", event_wakes_today AS "eventWakesToday",
        activity_cursor AS "activityCursor", pending_since AS "pendingSince",
        last_check_in_slot AS "lastCheckInSlot", paused, updated_at AS "updatedAt"
      FROM command_center_space_agent_state
      WHERE space_id = ${spaceId}
    `,
      ),
      Effect.mapError(persistenceError("Could not read Space agent wake state.")),
    );
    const row = rows[0];
    if (row === undefined) {
      return yield* new CommandCenterError({
        reason: "persistence",
        message: `The wake state of Space '${spaceId}' could not be created.`,
      });
    }
    return fromRaw(row);
  });
