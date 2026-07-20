import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  CommandCenterConfig,
  googleAccountAliasFromCredentialRef,
  layer as commandCenterConfigLayer,
} from "./Config.ts";

const encodeJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

const configTestLayer = commandCenterConfigLayer.pipe(
  Layer.provide(
    Layer.mock(ProcessRunner.ProcessRunner)({
      run: () =>
        Effect.succeed({
          stdout: "",
          stderr: "not a Git checkout",
          code: ChildProcessSpawner.ExitCode(1),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
    }),
  ),
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "command-center-config-resolution-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it("accepts only bounded runtime Google credential references", () => {
  expect(googleAccountAliasFromCredentialRef("runtime:google/primary-account")).toBe(
    "primary-account",
  );
  expect(googleAccountAliasFromCredentialRef("runtime:google/user@example.test")).toBe(
    "user@example.test",
  );
  expect(googleAccountAliasFromCredentialRef("runtime:google/../../other-account")).toBeUndefined();
  expect(googleAccountAliasFromCredentialRef("host:google/primary-account")).toBeUndefined();
});

it.effect("resolves an enabled Google alias only through its exact private Space binding", () =>
  Effect.gen(function* () {
    const config = yield* CommandCenterConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.join(config.configDirectory, "spaces"), { recursive: true });
    yield* fs.writeFileString(
      path.join(config.configDirectory, "command-center.json"),
      encodeJson({
        schemaVersion: 1,
        timezone: "Etc/UTC",
        routing: {
          mode: "auto",
          showPreview: true,
          explicitSelectionWins: true,
          providerFallback: "first-healthy-compatible",
        },
        spaces: [{ id: "example-space", configPath: "spaces/example.json" }],
        connections: [
          {
            id: "google-primary",
            kind: "google",
            accountLabel: "Primary account",
            credentialRef: "runtime:google/configured-account",
            capabilities: ["gmail.read", "calendar.read", "drive.read"],
            enabled: true,
          },
        ],
      }),
    );
    yield* fs.writeFileString(
      path.join(config.configDirectory, "spaces/example.json"),
      encodeJson({
        schemaVersion: 1,
        id: "example-space",
        name: "Example Space",
        kind: "personal",
        aliases: [],
        instructionsFile: "spaces/example.md",
        repositories: [],
        connectionIds: ["google-primary"],
        routing: { provider: "auto", model: "auto" },
      }),
    );

    expect(
      yield* config.resolveGoogleAccount({
        spaceId: "example-space",
        connectionId: "google-primary",
      }),
    ).toEqual({ accountAlias: "configured-account", label: "Primary account" });
    expect(
      yield* config
        .resolveGoogleAccount({
          spaceId: "other-space",
          connectionId: "google-primary",
        })
        .pipe(Effect.flip),
    ).toMatchObject({ reason: "config" });
  }).pipe(Effect.provide(configTestLayer)),
);

it.effect("retains disabled connection assignments without projecting an active Connection", () =>
  Effect.gen(function* () {
    const config = yield* CommandCenterConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.join(config.configDirectory, "spaces"), { recursive: true });
    yield* fs.writeFileString(
      path.join(config.configDirectory, "command-center.json"),
      encodeJson({
        schemaVersion: 1,
        timezone: "Etc/UTC",
        routing: {
          mode: "auto",
          showPreview: true,
          explicitSelectionWins: true,
          providerFallback: "first-healthy-compatible",
        },
        spaces: [{ id: "example-space", configPath: "spaces/example.json" }],
        connections: [
          {
            id: "google-enabled",
            kind: "google",
            accountLabel: "Enabled account",
            credentialRef: "runtime:google/enabled-account",
            capabilities: ["gmail.read"],
            enabled: true,
          },
          {
            id: "google-disabled",
            kind: "google",
            accountLabel: "Disabled account",
            credentialRef: "runtime:google/disabled-account",
            capabilities: ["gmail.read"],
            enabled: false,
          },
        ],
      }),
    );
    yield* fs.writeFileString(
      path.join(config.configDirectory, "spaces/example.json"),
      encodeJson({
        schemaVersion: 1,
        id: "example-space",
        name: "Example Space",
        kind: "personal",
        aliases: [],
        instructionsFile: "spaces/example.md",
        repositories: [],
        connectionIds: ["google-enabled", "google-disabled"],
        routing: { provider: "auto", model: "auto" },
      }),
    );
    yield* fs.writeFileString(path.join(config.configDirectory, "spaces/example.md"), "Example.");

    const loaded = yield* config.load;
    expect(loaded.health.status).toBe("loaded");
    expect(loaded.spaces[0]?.connectionIds).toEqual(["google-enabled", "google-disabled"]);
    expect(loaded.connections.map((candidate) => candidate.id)).toEqual(["google-enabled"]);
  }).pipe(Effect.provide(configTestLayer)),
);

it.effect("rejects a root config symlink that resolves outside the private checkout", () =>
  Effect.gen(function* () {
    const config = yield* CommandCenterConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const outside = yield* fs.makeTempDirectoryScoped({ prefix: "command-center-config-escape-" });
    const outsideRoot = path.join(outside, "command-center.json");
    yield* fs.writeFileString(
      outsideRoot,
      encodeJson({
        schemaVersion: 1,
        timezone: "Etc/UTC",
        routing: {
          mode: "auto",
          showPreview: true,
          explicitSelectionWins: true,
          providerFallback: "first-healthy-compatible",
        },
        spaces: [],
        connections: [],
      }),
    );
    yield* fs.makeDirectory(config.configDirectory, { recursive: true });
    yield* fs.symlink(outsideRoot, path.join(config.configDirectory, "command-center.json"));

    const loaded = yield* config.load;

    expect(loaded.health.status).toBe("invalid");
    expect(loaded.health.message).toContain("resolves outside the private config directory");
  }).pipe(Effect.provide(configTestLayer)),
);

it.effect("rejects Space config and instruction symlinks that escape the private checkout", () =>
  Effect.gen(function* () {
    const config = yield* CommandCenterConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const outside = yield* fs.makeTempDirectoryScoped({ prefix: "command-center-space-escape-" });
    const spacesDirectory = path.join(config.configDirectory, "spaces");
    const rootPath = path.join(config.configDirectory, "command-center.json");
    const spacePath = path.join(spacesDirectory, "example.json");
    const instructionsPath = path.join(spacesDirectory, "example.md");
    const root = {
      schemaVersion: 1,
      timezone: "Etc/UTC",
      routing: {
        mode: "auto",
        showPreview: true,
        explicitSelectionWins: true,
        providerFallback: "first-healthy-compatible",
      },
      spaces: [{ id: "example-space", configPath: "spaces/example.json" }],
      connections: [],
    } as const;
    const space = {
      schemaVersion: 1,
      id: "example-space",
      name: "Example Space",
      kind: "personal",
      aliases: [],
      instructionsFile: "spaces/example.md",
      repositories: [],
      connectionIds: [],
      routing: { provider: "auto", model: "auto" },
    } as const;
    yield* fs.makeDirectory(spacesDirectory, { recursive: true });
    yield* fs.writeFileString(rootPath, encodeJson(root));

    const outsideSpace = path.join(outside, "example.json");
    yield* fs.writeFileString(outsideSpace, encodeJson(space));
    yield* fs.symlink(outsideSpace, spacePath);
    const escapedSpace = yield* config.load;
    expect(escapedSpace.health.status).toBe("invalid");
    expect(escapedSpace.health.message).toContain("resolves outside the private config directory");

    yield* fs.remove(spacePath);
    yield* fs.writeFileString(spacePath, encodeJson(space));
    const outsideInstructions = path.join(outside, "example.md");
    yield* fs.writeFileString(outsideInstructions, "Outside instructions must not be loaded.");
    yield* fs.symlink(outsideInstructions, instructionsPath);
    const escapedInstructions = yield* config.load;
    expect(escapedInstructions.health.status).toBe("invalid");
    expect(escapedInstructions.health.message).toContain(
      "resolves outside the private config directory",
    );
  }).pipe(Effect.provide(configTestLayer)),
);
