import { SpaceId } from "@command-center/core";
import { CommandCenterError } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  makeClosedPullRequestReconciler,
  makeRepositoryCheckRecorder,
  type RepositoryCheckObservation,
} from "./RepositoryChecks.ts";

it.effect("records one failing required check per head across repeated polls", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const timestamp = "2026-09-28T00:00:00.000Z";
    yield* sql`
      INSERT INTO command_center_spaces (id, slug, name, kind, created_at, updated_at)
      VALUES ('coding', 'coding', 'Coding', 'business', ${timestamp}, ${timestamp})
    `;
    let creations = 0;
    const record = makeRepositoryCheckRecorder({
      sql,
      createItem: (input) =>
        Effect.gen(function* () {
          creations += 1;
          yield* sql`
            INSERT INTO command_center_items (
              id, space_id, kind, status, title, body, priority,
              created_at, updated_at
            ) VALUES (
              ${input.requestId}, ${input.spaceId}, ${input.kind}, 'captured',
              ${input.title}, ${input.description ?? null}, ${input.priority},
              ${timestamp}, ${timestamp}
            ) ON CONFLICT(id) DO NOTHING
          `;
          return { id: input.requestId };
        }).pipe(
          Effect.mapError(
            (cause) =>
              new CommandCenterError({
                reason: "persistence",
                message: "Test insert failed.",
                cause,
              }),
          ),
        ),
      retireItem: (input) =>
        sql`
        UPDATE command_center_items SET status = 'done'
        WHERE id = ${input.itemId} AND space_id = ${input.spaceId}
      `.pipe(
          Effect.asVoid,
          Effect.mapError(
            (cause) =>
              new CommandCenterError({
                reason: "persistence",
                message: "Test update failed.",
                cause,
              }),
          ),
        ),
    });
    const base = {
      repositoryKey: "github.com/t3tools/t3code",
      repositoryId: "t3code",
      spaceId: SpaceId.make("coding"),
      pullRequest: {
        number: 42,
        url: "https://github.com/t3tools/t3code/pull/42",
        headRefOid: "a".repeat(40),
        isDraft: false,
      },
      check: {
        name: "required/build",
        bucket: "fail",
        completedAt: timestamp,
        link: "https://github.com/t3tools/t3code/actions/runs/1",
      },
      observedAt: timestamp,
    } satisfies RepositoryCheckObservation;
    expect(yield* record(base)).toBe(true);
    expect(yield* record(base)).toBe(false);
    expect(creations).toBe(1);
    const nextHead = {
      ...base,
      pullRequest: { ...base.pullRequest, headRefOid: "b".repeat(40) },
    } satisfies RepositoryCheckObservation;
    expect(yield* record(nextHead)).toBe(true);
    expect(yield* record(nextHead)).toBe(false);
    expect(creations).toBe(2);
    const rows = yield* sql<{
      readonly id: string;
      readonly body: string;
      readonly status: string;
    }>`
      SELECT id, body, status FROM command_center_items ORDER BY id
    `;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.body).toContain("https://github.com/t3tools/t3code/pull/42");
    expect(rows[0]?.body).toContain("required/build");
    expect(rows[0]?.body).toContain("Head SHA:");
    expect(rows.map((row) => row.status).sort()).toEqual(["captured", "done"]);

    expect(yield* record({ ...nextHead, check: { ...nextHead.check, bucket: "pass" } })).toBe(
      false,
    );
    expect(
      yield* record({
        ...nextHead,
        check: { ...nextHead.check, completedAt: "2026-09-28T01:00:00.000Z" },
      }),
    ).toBe(true);
    expect(creations).toBe(3);
    const current = yield* sql<{ readonly status: string }>`
      SELECT status FROM command_center_items WHERE status != 'done'
    `;
    expect(current).toHaveLength(1);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("retires Inbox items for PRs confirmed closed after leaving the open list", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const timestamp = "2026-09-28T00:00:00.000Z";
    const repositoryKey = "github.com/t3tools/t3code";
    const spaceId = SpaceId.make("coding");
    yield* sql`
      INSERT INTO command_center_spaces (id, slug, name, kind, created_at, updated_at)
      VALUES ('coding', 'coding', 'Coding', 'business', ${timestamp}, ${timestamp})
    `;
    // PR 7 closed, PR 9 cannot be looked up at first, PR 8 is open on another page, and PR 10 is
    // on the polled page. Older observations are looked up first.
    const seeded = [
      { prNumber: 7, observedAt: "2026-09-28T01:00:00.000Z" },
      { prNumber: 9, observedAt: "2026-09-28T02:00:00.000Z" },
      { prNumber: 8, observedAt: "2026-09-28T03:00:00.000Z" },
      { prNumber: 10, observedAt: "2026-09-28T00:30:00.000Z" },
    ];
    for (const { prNumber, observedAt } of seeded) {
      const itemId = `repository-check:pr-${prNumber}`;
      yield* sql`
        INSERT INTO command_center_items (
          id, space_id, kind, status, title, body, priority, created_at, updated_at
        ) VALUES (
          ${itemId}, 'coding', 'decision', 'captured', ${`Required CI failed on PR #${prNumber}`},
          NULL, 'high', ${timestamp}, ${timestamp}
        )
      `;
      yield* sql`
        INSERT INTO command_center_repository_check_signals (
          repository_key, space_id, repository_id, pr_number, head_sha,
          check_name, bucket, completed_at, item_id, observed_at
        ) VALUES (
          ${repositoryKey}, 'coding', 't3code', ${prNumber}, ${"a".repeat(40)},
          'required/build', 'fail', ${timestamp}, ${itemId}, ${observedAt}
        )
      `;
    }
    const states = new Map<number, string>([
      [7, "CLOSED"],
      [8, "OPEN"],
    ]);
    const lookups: Array<number> = [];
    const reconcile = makeClosedPullRequestReconciler({
      sql,
      lookupState: (prNumber) => {
        lookups.push(prNumber);
        const state = states.get(prNumber);
        return state === undefined ? Effect.fail("GitHub read failed.") : Effect.succeed(state);
      },
      retireItem: (input) =>
        sql`
          UPDATE command_center_items SET status = 'done'
          WHERE id = ${input.itemId} AND space_id = ${input.spaceId}
            AND updated_at = ${input.expectedUpdatedAt}
        `.pipe(
          Effect.asVoid,
          Effect.mapError(
            (cause) =>
              new CommandCenterError({
                reason: "persistence",
                message: "Test update failed.",
                cause,
              }),
          ),
        ),
    });
    const activeItems = sql<{ readonly id: string }>`
      SELECT id FROM command_center_items WHERE status NOT IN ('done', 'canceled') ORDER BY id
    `;

    expect(
      yield* reconcile({
        repositoryKey,
        spaceId,
        polledPrNumbers: [10],
        observedAt: "2026-09-28T04:00:00.000Z",
      }),
    ).toBe(1);
    // The lookup error on PR 9 retires nothing and stops further lookups for this poll.
    expect(lookups).toEqual([7, 9]);
    expect((yield* activeItems).map((row) => row.id)).toEqual([
      "repository-check:pr-10",
      "repository-check:pr-8",
      "repository-check:pr-9",
    ]);

    states.set(9, "MERGED");
    lookups.length = 0;
    expect(
      yield* reconcile({
        repositoryKey,
        spaceId,
        polledPrNumbers: [10],
        observedAt: "2026-09-28T05:00:00.000Z",
      }),
    ).toBe(1);
    expect(lookups).toEqual([9, 8]);
    expect((yield* activeItems).map((row) => row.id)).toEqual([
      "repository-check:pr-10",
      "repository-check:pr-8",
    ]);
    const touched = yield* sql<{ readonly observedAt: string }>`
      SELECT observed_at AS "observedAt" FROM command_center_repository_check_signals
      WHERE pr_number = 8
    `;
    expect(touched).toEqual([{ observedAt: "2026-09-28T05:00:00.000Z" }]);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
