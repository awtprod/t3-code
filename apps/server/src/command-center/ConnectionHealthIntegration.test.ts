import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { CAPABILITY_NAMES, Connection, Space } from "@command-center/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CommandCenterConfig, type LoadedCommandCenterConfig } from "./Config.ts";
import { ConnectionHealth, layer as connectionHealthLayer } from "./ConnectionHealth.ts";
import { CommandCenterService, layer as commandCenterServiceLayer } from "./Service.ts";

const decodeSpace = Schema.decodeUnknownSync(Space);
const decodeConnection = Schema.decodeUnknownSync(Connection);
const timestamp = "2026-01-01T00:00:00.000Z";

const space = decodeSpace({
  id: "example-personal",
  slug: "example-personal",
  displayName: "Example Personal",
  kind: "personal",
  instructions: "Use read-only connected services.",
  policy: {
    allowedCapabilities: CAPABILITY_NAMES,
    autoRunRiskLevels: ["low", "reversible"],
  },
  connectionIds: ["google-primary"],
  repositories: [],
  aliases: [],
  lifecycle: "active",
  createdAt: timestamp,
  updatedAt: timestamp,
});

const connection = decodeConnection({
  id: "google-primary",
  spaceId: space.id,
  kind: "google",
  label: "Primary account",
  capabilities: ["cc.connections.google.gmail.read"],
  health: "disconnected",
});

const loaded = {
  spaces: [space],
  connections: [connection],
  automations: [],
  timezone: "Etc/UTC",
  routing: {
    mode: "auto",
    showPreview: true,
    explicitSelectionWins: true,
    providerFallback: "first-healthy-compatible",
  },
  health: { status: "loaded", configDirectory: "runtime-config" },
} satisfies LoadedCommandCenterConfig;

it.effect(
  "bootstrap preserves current health but never exposes removed or invalid configuration",
  () => {
    let current: LoadedCommandCenterConfig = loaded;
    const configLayer = Layer.succeed(
      CommandCenterConfig,
      CommandCenterConfig.of({
        configDirectory: "runtime-config",
        load: Effect.sync(() => current),
        resolveGoogleAccount: () => Effect.die("Google account resolution is not used here."),
      }),
    );
    const testLayer = commandCenterServiceLayer.pipe(
      Layer.provideMerge(configLayer),
      Layer.provideMerge(connectionHealthLayer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const service = yield* CommandCenterService;
      const health = yield* ConnectionHealth;

      expect((yield* service.bootstrap).connections[0]?.health).toBe("disconnected");
      yield* health.markConnected({ connectionId: connection.id, spaceId: connection.spaceId });
      const connected = (yield* service.bootstrap).connections[0];
      expect(connected?.health).toBe("connected");
      expect(connected?.lastCheckedAt).toBeDefined();

      current = {
        ...loaded,
        spaces: [{ ...space, connectionIds: [] }],
        connections: [],
      };
      yield* service.syncConfiguration({ force: true });
      expect((yield* service.bootstrap).connections).toEqual([]);

      current = {
        spaces: [],
        connections: [],
        automations: [],
        timezone: null,
        routing: null,
        health: {
          status: "invalid",
          configDirectory: "runtime-config",
          message: "Invalid private configuration.",
        },
      };
      yield* service.syncConfiguration({ force: true });
      expect((yield* service.bootstrap).connections).toEqual([]);
    }).pipe(Effect.provide(testLayer));
  },
);
