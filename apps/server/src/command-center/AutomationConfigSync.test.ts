import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Automation, CAPABILITY_NAMES, Space } from "@command-center/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CommandCenterConfig, type LoadedCommandCenterConfig } from "./Config.ts";
import * as ConnectionHealth from "./ConnectionHealth.ts";
import { CommandCenterService, layer as commandCenterServiceLayer } from "./Service.ts";

const timestamp = "2026-01-01T12:00:00.000Z";
const commitSha = "1234567890abcdef1234567890abcdef12345678";
const definitionDigest = `sha256:${"a".repeat(64)}`;
const decodeSpace = Schema.decodeUnknownSync(Space);
const decodeAutomation = Schema.decodeUnknownSync(Automation);

const space = decodeSpace({
  id: "sample-space",
  slug: "sample-space",
  displayName: "Sample Space",
  kind: "business",
  instructions: "Use sample fixtures.",
  policy: {
    allowedCapabilities: CAPABILITY_NAMES,
    autoRunRiskLevels: ["low", "reversible"],
  },
  connectionIds: [],
  repositories: [],
  aliases: [],
  lifecycle: "active",
  createdAt: timestamp,
  updatedAt: timestamp,
});

const automation = decodeAutomation({
  id: "sample-automation",
  spaceId: space.id,
  name: "Sample automation",
  version: 1,
  enabled: true,
  trigger: { type: "manual" },
  nodes: [
    {
      id: "summarize",
      kind: "transform",
      config: { template: "Summarize sample input." },
      position: { x: 0, y: 0 },
    },
  ],
  edges: [],
  definitionDigest,
  configCommit: commitSha,
  createdAt: timestamp,
  updatedAt: timestamp,
});

const validConfig = {
  spaces: [space],
  connections: [],
  automations: [automation],
  timezone: "Etc/UTC",
  routing: {
    mode: "auto",
    showPreview: true,
    explicitSelectionWins: true,
    providerFallback: "first-healthy-compatible",
  },
  health: { status: "loaded", configDirectory: "sample-config" },
} satisfies LoadedCommandCenterConfig;

it.effect("caches reads and keeps the last valid projection when config becomes invalid", () => {
  let current: LoadedCommandCenterConfig = validConfig;
  let loadCount = 0;
  const configLayer = Layer.succeed(
    CommandCenterConfig,
    CommandCenterConfig.of({
      configDirectory: "sample-config",
      load: Effect.sync(() => {
        loadCount += 1;
        return current;
      }),
      resolveGoogleAccount: () => Effect.die("Google account resolution is not used here."),
    }),
  );
  const testLayer = commandCenterServiceLayer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(ConnectionHealth.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const service = yield* CommandCenterService;
    const sql = yield* SqlClient.SqlClient;

    const loaded = yield* service.bootstrap;
    expect(loaded.automations).toEqual([automation]);
    yield* Effect.all([service.bootstrap, service.bootstrap, service.querySpaces({})]);
    expect(loadCount).toBe(1);
    expect(
      yield* sql<{
        readonly enabled: number;
        readonly commitSha: string;
        readonly definitionDigest: string;
      }>`
        SELECT enabled, commit_sha AS "commitSha", definition_digest AS "definitionDigest"
        FROM command_center_automations
        WHERE id = ${automation.id}
      `,
    ).toEqual([{ enabled: 1, commitSha, definitionDigest }]);

    current = {
      spaces: [],
      connections: [],
      automations: [],
      timezone: null,
      routing: null,
      health: {
        status: "invalid",
        configDirectory: "sample-config",
        message: "A committed graph is invalid.",
      },
    };
    yield* service.syncConfiguration({ force: true });
    const invalid = yield* service.bootstrap;
    expect(invalid.configHealth.status).toBe("invalid");
    expect(invalid.automations).toEqual([automation]);
    expect(loadCount).toBe(2);
    expect(
      yield* sql<{ readonly enabled: number }>`
        SELECT enabled FROM command_center_automations WHERE id = ${automation.id}
      `,
    ).toEqual([{ enabled: 1 }]);
  }).pipe(Effect.provide(testLayer));
});
