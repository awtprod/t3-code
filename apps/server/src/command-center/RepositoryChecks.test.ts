import { SpaceId } from "@command-center/core";
import { CommandCenterError } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
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
