import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { make } from "./Digest.ts";

const testLayer = SqlitePersistenceMemory;
const firstAt = "2026-09-28T12:00:00.000Z";
const subject = "andrew";

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO command_center_spaces (id, slug, name, kind, lifecycle, created_at, updated_at)
    VALUES ('space-a', 'a', 'Space A', 'business', 'active', ${firstAt}, ${firstAt}),
      ('space-b', 'b', 'Space B', 'business', 'active', ${firstAt}, ${firstAt})
  `;
  yield* sql`
    INSERT INTO command_center_items (
      id, space_id, kind, status, title, priority, source_json, links_json,
      metadata_json, created_at, updated_at
    ) VALUES
      ('item-a', 'space-a', 'decision', 'review', 'Review A', 'high',
        '{"kind":"user","capturedAt":"2026-09-28T12:00:00.000Z"}', '[]', '{}', ${firstAt}, ${firstAt}),
      ('item-b', 'space-b', 'approval', 'waiting', 'Review B', 'high',
        '{"kind":"user","capturedAt":"2026-09-28T12:00:00.000Z"}', '[]', '{}', ${firstAt}, ${firstAt})
  `;
});

it.effect("persists one cross-Space digest and supersedes only a changed item revision", () =>
  Effect.gen(function* () {
    yield* seed;
    let now = "2026-09-28T13:00:00.000Z";
    const deps = { now: Effect.sync(() => now) };
    const digest = yield* make(deps);
    const initial = yield* digest.query({ recipientSubject: subject, configTimezone: "UTC" });
    expect(initial.notification).toBe("available");
    expect(initial.snapshot?.items.map((item) => [item.spaceId, item.itemId])).toEqual([
      ["space-a", "item-a"],
      ["space-b", "item-b"],
    ]);
    const id = initial.snapshot!.id;
    const reconstructed = yield* make(deps);
    const repeated = yield* reconstructed.query({
      recipientSubject: subject,
      configTimezone: "UTC",
    });
    expect(repeated.snapshot?.id).toBe(id);
    const viewed = yield* reconstructed.markViewed({ recipientSubject: subject, snapshotId: id });
    expect(viewed.viewedAt).not.toBeNull();
    expect(
      (yield* reconstructed.query({ recipientSubject: subject, configTimezone: "UTC" }))
        .notification,
    ).toBe("seen");
    const otherIdentity = yield* reconstructed
      .markViewed({ recipientSubject: "other", snapshotId: id })
      .pipe(Effect.flip);
    expect(otherIdentity.reason).toBe("not_found");
    const otherDigest = yield* reconstructed.query({
      recipientSubject: "other",
      configTimezone: "UTC",
    });
    expect(otherDigest.snapshot?.id).not.toBe(id);
    expect(otherDigest.recipientSubject).toBe("other");

    const sql = yield* SqlClient.SqlClient;
    now = "2026-09-28T14:00:00.000Z";
    yield* sql`UPDATE command_center_items SET title = 'Review A revised', updated_at = ${now} WHERE id = 'item-a'`;
    const revised = yield* reconstructed.query({
      recipientSubject: subject,
      configTimezone: "UTC",
    });
    expect(revised.snapshot?.id).not.toBe(id);
    expect(revised.snapshot?.supersedesId).toBe(id);
    expect(revised.snapshot?.items.find((item) => item.itemId === "item-a")?.itemVersion).toBe(1);
    expect(
      (yield* reconstructed.query({ recipientSubject: subject, configTimezone: "UTC" })).snapshot
        ?.id,
    ).toBe(revised.snapshot?.id);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("quiet hours and empty periods do not create a fresh notification", () =>
  Effect.gen(function* () {
    let now = "2026-09-28T23:00:00.000Z";
    const digest = yield* make({ now: Effect.sync(() => now) });
    const preferences = yield* digest.updatePreferences({
      recipientSubject: subject,
      configTimezone: "UTC",
      preferences: { expectedVersion: 0, timezone: "UTC", quietStart: "22:00", quietEnd: "07:00" },
    });
    expect(preferences.version).toBe(1);
    const staleWrite = yield* digest
      .updatePreferences({
        recipientSubject: subject,
        configTimezone: "UTC",
        preferences: { expectedVersion: 0, timezone: "UTC", quietStart: null, quietEnd: null },
      })
      .pipe(Effect.flip);
    expect(staleWrite.reason).toBe("conflict");
    yield* seed;
    const quiet = yield* digest.query({ recipientSubject: subject, configTimezone: "UTC" });
    expect(quiet.notification).toBe("quiet-hours");
    expect(quiet.snapshot).toBeNull();
    now = "2026-09-29T12:00:00.000Z";
    const empty = yield* digest.query({ recipientSubject: subject, configTimezone: "UTC" });
    expect(empty.notification).toBe("empty");
    expect(empty.snapshot).toBeNull();
  }).pipe(Effect.provide(testLayer)),
);
