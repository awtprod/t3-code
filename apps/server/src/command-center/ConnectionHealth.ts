import type { Connection as ConnectionType } from "@command-center/core";
import { CommandCenterError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export interface ConnectionSelection {
  readonly spaceId: ConnectionType["spaceId"];
  readonly connectionId: ConnectionType["id"];
}

interface StoredConnectionIdentity {
  readonly id: string;
  readonly spaceId: string;
  readonly kind: string;
}

export interface ConnectionHealthShape {
  /**
   * Reconcile the non-secret runtime projection with the enabled private
   * configuration. Existing health is retained only while the connection's
   * stable Space/kind identity remains unchanged. Display labels and declared
   * capabilities may change without erasing a successful runtime check.
   */
  readonly syncConfigured: (
    connections: ReadonlyArray<ConnectionType>,
  ) => Effect.Effect<void, CommandCenterError>;
  readonly markConnected: (
    connection: ConnectionSelection,
  ) => Effect.Effect<void, CommandCenterError>;
  readonly markDegraded: (
    connection: ConnectionSelection,
  ) => Effect.Effect<void, CommandCenterError>;
  readonly markDisconnected: (
    connection: ConnectionSelection,
  ) => Effect.Effect<void, CommandCenterError>;
}

export class ConnectionHealth extends Context.Service<ConnectionHealth, ConnectionHealthShape>()(
  "t3/command-center/ConnectionHealth",
) {}

const persistenceError = (cause: unknown) =>
  new CommandCenterError({
    reason: "persistence",
    message: "Could not update Command Center connection health.",
    cause,
  });

const stringify = (value: unknown): string => JSON.stringify(value);

export const layer = Layer.effect(
  ConnectionHealth,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const syncConfigured = Effect.fn("ConnectionHealth.syncConfigured")(function* (
      connections: ReadonlyArray<ConnectionType>,
    ) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const stored = yield* sql<StoredConnectionIdentity>`
              SELECT id, space_id AS "spaceId", kind
              FROM command_center_connections
            `;
          const configuredById = new Map<string, ConnectionType>(
            connections.map((connection) => [connection.id, connection]),
          );

          // Removing an unavailable connection is safer than leaving a stale,
          // apparently healthy account in bootstrap. A reassigned identity is
          // removed first so its prior health cannot cross a Space boundary.
          for (const current of stored) {
            const configured = configuredById.get(current.id);
            const identityChanged =
              configured !== undefined &&
              (configured.spaceId !== current.spaceId || configured.kind !== current.kind);
            if (configured === undefined || identityChanged) {
              yield* sql`DELETE FROM command_center_connections WHERE id = ${current.id}`;
            }
          }

          for (const connection of connections) {
            yield* sql`
                INSERT INTO command_center_connections (
                  id, space_id, kind, account_label, capabilities_json, health, checked_at
                ) VALUES (
                  ${connection.id}, ${connection.spaceId}, ${connection.kind}, ${connection.label},
                  ${stringify(connection.capabilities)}, 'disconnected', NULL
                )
                ON CONFLICT(id) DO UPDATE SET
                  space_id = excluded.space_id,
                  kind = excluded.kind,
                  account_label = excluded.account_label,
                  capabilities_json = excluded.capabilities_json
              `;
          }
        }),
      );
    }, Effect.mapError(persistenceError));

    const setHealth = Effect.fn("ConnectionHealth.setHealth")(function* (
      connection: ConnectionSelection,
      health: "connected" | "degraded" | "disconnected",
    ) {
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      // Both identifiers are required. A request scoped to the wrong Space
      // must never modify the health of the correctly scoped connection.
      yield* sql`
          UPDATE command_center_connections
          SET health = ${health}, checked_at = ${checkedAt}
          WHERE id = ${connection.connectionId}
            AND space_id = ${connection.spaceId}
            AND kind = 'google'
        `;
    }, Effect.mapError(persistenceError));

    return ConnectionHealth.of({
      syncConfigured,
      markConnected: (connection) => setHealth(connection, "connected"),
      markDegraded: (connection) => setHealth(connection, "degraded"),
      markDisconnected: (connection) => setHealth(connection, "disconnected"),
    });
  }),
);
