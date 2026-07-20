import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Connection } from "@command-center/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ConnectionHealth, layer as connectionHealthLayer } from "./ConnectionHealth.ts";

interface ConnectionRow {
  readonly id: string;
  readonly spaceId: string;
  readonly accountLabel: string;
  readonly health: string;
  readonly checkedAt: string | null;
}

const decodeConnection = Schema.decodeUnknownSync(Connection);
const connection = decodeConnection({
  id: "google-primary",
  spaceId: "example-space",
  kind: "google",
  label: "Primary account",
  capabilities: ["cc.connections.google.read"],
  health: "disconnected",
});

const testLayer = connectionHealthLayer.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const addSpace = (sql: SqlClient.SqlClient, id: string) =>
  sql`
    INSERT INTO command_center_spaces (
      id, slug, name, kind, instructions, policy_json, model_defaults_json,
      connections_json, repositories_json, aliases_json, lifecycle, created_at, updated_at
    ) VALUES (
      ${id}, ${id}, ${id}, 'personal', '', '{}', '{}', '[]', '[]', '[]',
      'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    )
  `;

const rows = (sql: SqlClient.SqlClient) =>
  sql<ConnectionRow>`
    SELECT id, space_id AS "spaceId", account_label AS "accountLabel",
      health, checked_at AS "checkedAt"
    FROM command_center_connections
    ORDER BY id
  `;

const selection = {
  spaceId: connection.spaceId,
  connectionId: connection.id,
};

it.effect("preserves health for an unchanged enabled connection", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const health = yield* ConnectionHealth;
    yield* addSpace(sql, "example-space");
    yield* health.syncConfigured([connection]);
    yield* health.markConnected(selection);
    const connected = yield* rows(sql);

    yield* health.syncConfigured([
      decodeConnection({
        ...connection,
        label: "Renamed primary account",
        capabilities: [],
        health: "degraded",
      }),
    ]);
    const reconciled = yield* rows(sql);

    expect(connected[0]?.health).toBe("connected");
    expect(connected[0]?.checkedAt).not.toBeNull();
    expect(reconciled[0]?.health).toBe("connected");
    expect(reconciled[0]?.checkedAt).toBe(connected[0]?.checkedAt);
    expect(reconciled[0]?.accountLabel).toBe("Renamed primary account");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("removes missing connections and resets reassigned identities", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const health = yield* ConnectionHealth;
    yield* addSpace(sql, "example-space");
    yield* addSpace(sql, "other-space");
    yield* health.syncConfigured([connection]);
    yield* health.markConnected(selection);

    const reassigned = decodeConnection({
      ...connection,
      spaceId: "other-space",
      health: "connected",
    });
    yield* health.syncConfigured([reassigned]);
    expect(yield* rows(sql)).toEqual([
      expect.objectContaining({
        id: "google-primary",
        spaceId: "other-space",
        health: "disconnected",
        checkedAt: null,
      }),
    ]);

    yield* health.syncConfigured([]);
    expect(yield* rows(sql)).toEqual([]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("records exact-Space success and failure health without exposing credentials", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const health = yield* ConnectionHealth;
    yield* addSpace(sql, "example-space");
    yield* health.syncConfigured([connection]);

    yield* health.markConnected({
      connectionId: connection.id,
      spaceId: "wrong-space" as never,
    });
    expect((yield* rows(sql))[0]?.health).toBe("disconnected");

    yield* health.markConnected(selection);
    expect((yield* rows(sql))[0]?.health).toBe("connected");
    yield* health.markDegraded(selection);
    expect((yield* rows(sql))[0]?.health).toBe("degraded");
    yield* health.markDisconnected(selection);
    const disconnected = (yield* rows(sql))[0];
    expect(disconnected?.health).toBe("disconnected");
    expect(disconnected?.checkedAt).not.toBeNull();

    const schema = yield* sql<{
      readonly name: string;
    }>`PRAGMA table_info(command_center_connections)`;
    expect(schema.map((column) => column.name)).not.toContain("credential_ref");
  }).pipe(Effect.provide(testLayer)),
);
