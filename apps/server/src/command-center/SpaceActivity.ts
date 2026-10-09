/**
 * SpaceActivity - the per-Space "what happened" feed.
 *
 * Most work happens in ordinary threads, which carry no Space id. A thread
 * belongs to a project, and a Space binds repositories, so a thread maps to
 * every active Space whose repository binding matches its project (by
 * configured project id or canonical git remote; see
 * `resolveSpaceIdsForProject`). `SpaceActivityReactor` appends one bounded row per
 * finished turn or Run to `command_center_space_activity`; the Space agent
 * reads it through `recent` (brief and the `cc_space_activity` MCP tool).
 *
 * @module SpaceActivity
 */
import { CommandCenterError } from "@t3tools/contracts";
import type { RepositoryBinding } from "@command-center/core";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import { truncate } from "@t3tools/shared/String";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Thread ids of the Space agents themselves; their turns are never activity. */
export const SPACE_AGENT_THREAD_ID_PREFIX = "cc-space-agent-";

export const isSpaceAgentThreadId = (threadId: string): boolean =>
  threadId.startsWith(SPACE_AGENT_THREAD_ID_PREFIX);

export const SPACE_ACTIVITY_SUMMARY_CHARS = 1_000;
export const SPACE_ACTIVITY_TITLE_CHARS = 200;
/** Rows kept per Space; older rows are pruned on insert. */
export const SPACE_ACTIVITY_RETENTION = 500;
export const SPACE_ACTIVITY_MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
/** The PR search only looks at the tail of a message, so it stays bounded. */
const PULL_REQUEST_SCAN_CHARS = 20_000;
const PULL_REQUEST_URL =
  /https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/pull\/\d{1,10}/g;

/** A project as the activity resolver sees it. */
export interface SpaceActivityProject {
  readonly id: string;
  /**
   * Canonical keys of every fetch remote of the project's workspace, from
   * `RepositoryIdentityResolver.resolveRemoteKeys` (cached, short TTL).
   */
  readonly remoteKeys: ReadonlyArray<string>;
}

/**
 * Every active Space with a repository binding that matches `project`; a
 * project no binding matches maps to nothing.
 *
 * Same rules as Run dispatch's `findRepositoryProject`, with one difference:
 * the binding's remote may equal ANY fetch remote of the project, not only the
 * primary one. Dispatch's primary remote prefers `upstream`, so a fork such as
 * awtprod/t3-code (upstream pingdotgg/t3code) would otherwise never match its
 * own binding. A configured project id still matches only that project, and
 * only when its remotes agree with the binding's remote.
 */
export const resolveSpaceIdsForProject = (
  project: SpaceActivityProject,
  spaces: ReadonlyArray<{
    readonly id: string;
    readonly lifecycle: string;
    readonly repositories: ReadonlyArray<RepositoryBinding>;
  }>,
): ReadonlyArray<string> =>
  spaces
    .filter(
      (space) =>
        space.lifecycle === "active" &&
        space.repositories.some((binding) => bindingMatchesProject(binding, project)),
    )
    .map((space) => space.id);

const bindingMatchesProject = (
  binding: RepositoryBinding,
  project: SpaceActivityProject,
): boolean => {
  const remote = binding.remoteRef === undefined ? "" : normalizeGitRemoteUrl(binding.remoteRef);
  const remoteMatches = remote.length > 0 && project.remoteKeys.includes(remote);
  return binding.projectId === undefined
    ? remoteMatches
    : binding.projectId === project.id && (remote.length === 0 || remoteMatches);
};

/** The newest GitHub pull request URL in `text`, if any. */
export const findPullRequestUrl = (text: string): string | undefined =>
  text.slice(-PULL_REQUEST_SCAN_CHARS).match(PULL_REQUEST_URL)?.at(-1);

export const clipSummary = (text: string | null | undefined): string =>
  truncate(text ?? "", SPACE_ACTIVITY_SUMMARY_CHARS - 3);

const clipTitle = (text: string): string => {
  const title = truncate(text, SPACE_ACTIVITY_TITLE_CHARS - 3);
  return title.length === 0 ? "Untitled" : title;
};

export type SpaceActivitySourceKind = "thread" | "run";

/** One feed entry. The first five fields are the Space brief's activity input. */
export interface SpaceActivityEntry {
  readonly occurredAt: string;
  readonly title: string;
  readonly status: string;
  readonly summary: string;
  readonly url?: string;
  readonly sourceKind: SpaceActivitySourceKind;
  readonly sourceId: string;
}

export interface SpaceActivityRecord {
  readonly spaceId: string;
  readonly occurredAt: string;
  readonly sourceKind: SpaceActivitySourceKind;
  readonly sourceId: string;
  readonly projectId: string | null;
  readonly title: string;
  readonly status: string;
  /** Raw message text; clipped and searched for a PR URL here. */
  readonly text: string | null;
  readonly eventSequence: number;
}

export interface SpaceActivityShape {
  /** Newest first. `limit` is clamped to 1..50 (default 20). */
  readonly recent: (input: {
    readonly spaceId: string;
    readonly since?: string;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<SpaceActivityEntry>, CommandCenterError>;
  /**
   * Append one row unless (source, event sequence, Space) is already present,
   * then prune the Space to its newest rows. Returns whether a row was added.
   */
  readonly record: (input: SpaceActivityRecord) => Effect.Effect<boolean, CommandCenterError>;
  /** Highest event sequence recorded for a source kind; the reactor's resume cursor. */
  readonly latestEventSequence: (
    sourceKind: SpaceActivitySourceKind,
  ) => Effect.Effect<number | undefined, CommandCenterError>;
  /**
   * Whether a non-`settled` thread row for `threadId` occurred at or after
   * `since`. Lets low-signal rows (a settle right after the turn end) skip.
   */
  readonly hasRecentTurnRow: (
    threadId: string,
    since: string,
  ) => Effect.Effect<boolean, CommandCenterError>;
}

export class SpaceActivity extends Context.Service<SpaceActivity, SpaceActivityShape>()(
  "@awtprod/command-center/command-center/SpaceActivity",
) {}

interface ActivityRow {
  readonly occurredAt: string;
  readonly title: string;
  readonly status: string;
  readonly summary: string;
  readonly url: string | null;
  readonly sourceKind: SpaceActivitySourceKind;
  readonly sourceId: string;
}

const persistenceError = (message: string) => (cause: unknown) =>
  new CommandCenterError({ reason: "persistence", message, cause });

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const recent: SpaceActivityShape["recent"] = (input) => {
    const limit = Math.min(
      SPACE_ACTIVITY_MAX_LIMIT,
      Math.max(1, Math.floor(input.limit ?? DEFAULT_LIMIT)),
    );
    // Rows store canonical ISO instants, so `since` is normalized to compare.
    const sinceTime = input.since === undefined ? undefined : DateTime.make(input.since);
    if (sinceTime !== undefined && Option.isNone(sinceTime)) {
      return Effect.fail(
        new CommandCenterError({ reason: "validation", message: "`since` is not a timestamp." }),
      );
    }
    const since = sinceTime === undefined ? null : DateTime.formatIso(sinceTime.value);
    return sql<ActivityRow>`
      SELECT occurred_at AS "occurredAt", title, status, summary, url,
        source_kind AS "sourceKind", source_id AS "sourceId"
      FROM command_center_space_activity
      WHERE space_id = ${input.spaceId}
        AND (${since} IS NULL OR occurred_at > ${since})
      ORDER BY occurred_at DESC, id DESC
      LIMIT ${limit}
    `.pipe(
      Effect.map((rows) => rows.map(({ url, ...row }) => (url === null ? row : { ...row, url }))),
      Effect.mapError(persistenceError("Could not read Space activity.")),
    );
  };

  const record: SpaceActivityShape["record"] = (input) => {
    const text = input.text ?? "";
    const url = findPullRequestUrl(text) ?? null;
    return sql
      .withTransaction(
        Effect.gen(function* () {
          const inserted = yield* sql<{ readonly id: number }>`
            INSERT INTO command_center_space_activity (
              space_id, occurred_at, source_kind, source_id, project_id,
              title, status, summary, url, event_sequence
            ) VALUES (
              ${input.spaceId}, ${input.occurredAt}, ${input.sourceKind}, ${input.sourceId},
              ${input.projectId}, ${clipTitle(input.title)}, ${input.status},
              ${clipSummary(text)}, ${url}, ${input.eventSequence}
            )
            ON CONFLICT (source_kind, source_id, event_sequence, space_id) DO NOTHING
            RETURNING id
          `;
          if (inserted.length === 0) return false;
          yield* sql`
            DELETE FROM command_center_space_activity
            WHERE space_id = ${input.spaceId}
              AND id NOT IN (
                SELECT id FROM command_center_space_activity
                WHERE space_id = ${input.spaceId}
                ORDER BY occurred_at DESC, id DESC
                LIMIT ${SPACE_ACTIVITY_RETENTION}
              )
          `;
          return true;
        }),
      )
      .pipe(Effect.mapError(persistenceError("Could not record Space activity.")));
  };

  const latestEventSequence: SpaceActivityShape["latestEventSequence"] = (sourceKind) =>
    sql<{ readonly sequence: number | null }>`
      SELECT MAX(event_sequence) AS sequence
      FROM command_center_space_activity
      WHERE source_kind = ${sourceKind}
    `.pipe(
      Effect.map((rows) => rows[0]?.sequence ?? undefined),
      Effect.mapError(persistenceError("Could not read the Space activity cursor.")),
    );

  const hasRecentTurnRow: SpaceActivityShape["hasRecentTurnRow"] = (threadId, since) =>
    sql<{ readonly found: number }>`
      SELECT 1 AS found
      FROM command_center_space_activity
      WHERE source_kind = 'thread' AND source_id = ${threadId}
        AND status <> 'settled' AND occurred_at >= ${since}
      LIMIT 1
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(persistenceError("Could not read Space activity.")),
    );

  return SpaceActivity.of({ recent, record, latestEventSequence, hasRecentTurnRow });
});

export const layer = Layer.effect(SpaceActivity, make);
