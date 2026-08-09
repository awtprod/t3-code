import {
  ACTIVE_CAPABILITY_NAMES,
  type Automation as AutomationType,
  CapabilityName,
  Connection,
  Space,
  type Connection as ConnectionType,
  type Space as SpaceType,
} from "@command-center/core";
import { CommandCenterError, type CommandCenterConfigHealth } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ProcessRunner } from "../processRunner.ts";
import { loadCommittedAutomations } from "./automation/index.ts";
import {
  expandLegacyGoogleCapabilities,
  googleCapabilitiesFromConfig,
} from "./GoogleCapabilities.ts";

const NonEmpty = Schema.String.check(Schema.isNonEmpty());

const RootConfigFile = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  timezone: NonEmpty,
  routing: Schema.Struct({
    mode: Schema.Literal("auto"),
    showPreview: Schema.Boolean,
    explicitSelectionWins: Schema.Boolean,
    providerFallback: Schema.Literal("first-healthy-compatible"),
  }),
  spaces: Schema.Array(
    Schema.Struct({
      id: NonEmpty,
      configPath: NonEmpty,
    }),
  ),
  connections: Schema.Array(
    Schema.Struct({
      id: NonEmpty,
      kind: Schema.Literal("google"),
      accountLabel: NonEmpty,
      credentialRef: NonEmpty,
      capabilities: Schema.Array(
        Schema.Literals(["gmail.read", "gmail.drafts.create", "calendar.read", "drive.read"]),
      ).check(Schema.isNonEmpty()),
      enabled: Schema.Boolean,
    }),
  ),
});

const SpaceConfigFile = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  id: NonEmpty,
  name: NonEmpty,
  kind: Schema.Literals(["personal", "business", "system"]),
  aliases: Schema.Array(NonEmpty),
  instructionsFile: NonEmpty,
  repositories: Schema.Array(
    Schema.Struct({
      id: NonEmpty,
      remote: NonEmpty,
      aliases: Schema.Array(NonEmpty),
    }),
  ),
  connectionIds: Schema.Array(NonEmpty),
  policy: Schema.optional(
    Schema.Struct({
      allowedCapabilities: Schema.Array(CapabilityName),
      autoRunRiskLevels: Schema.Array(Schema.Literals(["low", "reversible"])),
    }),
  ),
  routing: Schema.Struct({
    provider: NonEmpty,
    model: NonEmpty,
  }),
});

const RuntimeGoogleConnectionsFile = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  connections: Schema.Array(
    Schema.Struct({
      id: NonEmpty,
      spaceId: NonEmpty,
      accountLabel: NonEmpty,
      credentialRef: NonEmpty,
      capabilities: Schema.Array(
        Schema.Literals(["gmail.read", "gmail.drafts.create", "calendar.read", "drive.read"]),
      ).check(Schema.isNonEmpty()),
      enabled: Schema.Boolean,
    }),
  ),
});

type RootConfigFile = typeof RootConfigFile.Type;
type SpaceConfigFile = typeof SpaceConfigFile.Type;
type RuntimeGoogleConnectionsFile = typeof RuntimeGoogleConnectionsFile.Type;
export type GoogleConnectionConfigCapability =
  RootConfigFile["connections"][number]["capabilities"][number];

export const RUNTIME_GOOGLE_CONNECTIONS_FILE = "command-center-google-connections.json";

export interface LoadedCommandCenterConfig {
  readonly spaces: ReadonlyArray<SpaceType>;
  readonly connections: ReadonlyArray<ConnectionType>;
  readonly automations: ReadonlyArray<AutomationType>;
  readonly timezone: string | null;
  readonly routing: RootConfigFile["routing"] | null;
  readonly health: CommandCenterConfigHealth;
}

export interface CommandCenterConfigShape {
  readonly configDirectory: string;
  readonly load: Effect.Effect<LoadedCommandCenterConfig>;
  readonly resolveGoogleAccount: (input: {
    readonly spaceId: string;
    readonly connectionId: string;
  }) => Effect.Effect<
    { readonly accountAlias: string; readonly label: string },
    CommandCenterError
  >;
  readonly upsertRuntimeGoogleConnection?: (input: {
    readonly spaceId: string;
    readonly accountAlias: string;
    readonly accountLabel: string;
    readonly capabilities: ReadonlyArray<GoogleConnectionConfigCapability>;
  }) => Effect.Effect<{ readonly connectionId: string }, CommandCenterError>;
  readonly removeRuntimeGoogleConnection?: (input: {
    readonly spaceId: string;
    readonly connectionId: string;
  }) => Effect.Effect<{ readonly removed: true }, CommandCenterError>;
}

export class CommandCenterConfig extends Context.Service<
  CommandCenterConfig,
  CommandCenterConfigShape
>()("@awtprod/command-center/command-center/Config/CommandCenterConfig") {}

const decodeRoot = Schema.decodeUnknownEffect(RootConfigFile);
const decodeSpace = Schema.decodeUnknownEffect(SpaceConfigFile);
const decodeRuntimeGoogleConnections = Schema.decodeUnknownEffect(RuntimeGoogleConnectionsFile);
const decodeCanonicalSpace = Schema.decodeUnknownEffect(Space);
const decodeCanonicalConnection = Schema.decodeUnknownEffect(Connection);
const decodeUnknownJsonString = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const encodeRuntimeGoogleConnections = Schema.encodeSync(
  Schema.fromJsonString(RuntimeGoogleConnectionsFile),
);

const configError = (message: string, cause?: unknown) =>
  new CommandCenterError({
    reason: "config",
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const parseJson = Effect.fn("CommandCenterConfig.parseJson")(function* (
  contents: string,
  source: string,
) {
  return yield* decodeUnknownJsonString(contents).pipe(
    Effect.mapError((cause) =>
      configError(`Command Center config is not valid JSON: ${source}`, cause),
    ),
  );
});

const titleFromId = (id: string): string =>
  id
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");

export const googleAccountAliasFromCredentialRef = (credentialRef: string): string | undefined => {
  const matched = /^runtime:google\/([a-zA-Z0-9][a-zA-Z0-9._@+-]{0,254})$/u.exec(credentialRef);
  return matched?.[1];
};

export const layer = Layer.effect(
  CommandCenterConfig,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processRunner = yield* ProcessRunner;
    const serverConfig = yield* ServerConfig;
    const configDirectory = path.resolve(
      serverConfig.commandCenterConfigDir ?? `${serverConfig.baseDir}-config`,
    );
    const runtimeGoogleConnectionsPath = path.join(
      serverConfig.secretsDir,
      RUNTIME_GOOGLE_CONNECTIONS_FILE,
    );

    const canonicalizeConfigDirectory = Effect.fn("CommandCenterConfig.canonicalizeDirectory")(
      function* () {
        return yield* fs
          .realPath(configDirectory)
          .pipe(
            Effect.mapError((cause) =>
              configError("Could not canonicalize the private config directory.", cause),
            ),
          );
      },
    );

    const resolveInsideConfig = (
      relativePath: string,
      canonicalConfigDirectory: string,
    ): Effect.Effect<string, CommandCenterError> =>
      Effect.gen(function* () {
        const candidate = path.resolve(configDirectory, relativePath);
        const relative = path.relative(configDirectory, candidate);
        if (
          relative === ".." ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        ) {
          return yield* configError(
            `Config path escapes the private config directory: ${relativePath}`,
          );
        }
        const canonicalCandidate = yield* fs
          .realPath(candidate)
          .pipe(
            Effect.mapError((cause) =>
              configError(`Could not canonicalize config path: ${relativePath}`, cause),
            ),
          );
        const canonicalRelative = path.relative(canonicalConfigDirectory, canonicalCandidate);
        if (
          canonicalRelative === ".." ||
          canonicalRelative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(canonicalRelative)
        ) {
          return yield* configError(
            `Config path resolves outside the private config directory: ${relativePath}`,
          );
        }
        return canonicalCandidate;
      });

    const readJson = Effect.fn("CommandCenterConfig.readJson")(function* <A>(
      filePath: string,
      decode: (input: unknown) => Effect.Effect<A, Schema.SchemaError>,
    ) {
      const contents = yield* fs
        .readFileString(filePath)
        .pipe(
          Effect.mapError((cause) => configError(`Could not read config file: ${filePath}`, cause)),
        );
      const raw = yield* parseJson(contents, filePath);
      return yield* decode(raw).pipe(
        Effect.mapError((cause) =>
          configError(`Config file has an invalid shape: ${filePath}`, cause),
        ),
      );
    });

    const readRuntimeGoogleConnections = Effect.fn(
      "CommandCenterConfig.readRuntimeGoogleConnections",
    )(function* () {
      if (
        !(yield* fs.exists(runtimeGoogleConnectionsPath).pipe(Effect.orElseSucceed(() => false)))
      ) {
        return { schemaVersion: 1, connections: [] } satisfies RuntimeGoogleConnectionsFile;
      }
      return yield* readJson(runtimeGoogleConnectionsPath, decodeRuntimeGoogleConnections);
    });

    const writeRuntimeGoogleConnections = Effect.fn(
      "CommandCenterConfig.writeRuntimeGoogleConnections",
    )(function* (runtime: RuntimeGoogleConnectionsFile) {
      yield* writeFileStringAtomically({
        filePath: runtimeGoogleConnectionsPath,
        contents: `${encodeRuntimeGoogleConnections(runtime)}\n`,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.andThen(fs.chmod(runtimeGoogleConnectionsPath, 0o600)),
        Effect.mapError((cause) =>
          configError("Could not store the Google connection binding.", cause),
        ),
      );
    });

    const loadCanonicalSpace = Effect.fn("CommandCenterConfig.loadSpace")(function* (
      reference: RootConfigFile["spaces"][number],
      root: RootConfigFile,
      now: string,
      canonicalConfigDirectory: string,
    ) {
      const spacePath = yield* resolveInsideConfig(reference.configPath, canonicalConfigDirectory);
      const raw = yield* readJson(spacePath, decodeSpace);
      if (raw.id !== reference.id) {
        return yield* configError(
          `Space id '${raw.id}' does not match root reference '${reference.id}'.`,
        );
      }
      const instructionsPath = yield* resolveInsideConfig(
        raw.instructionsFile,
        canonicalConfigDirectory,
      );
      const instructions = yield* fs
        .readFileString(instructionsPath)
        .pipe(
          Effect.mapError((cause) =>
            configError(`Could not read Space instructions: ${raw.instructionsFile}`, cause),
          ),
        );

      const allowedConnectionIds = new Set(root.connections.map((connection) => connection.id));
      for (const connectionId of raw.connectionIds) {
        if (!allowedConnectionIds.has(connectionId)) {
          return yield* configError(
            `Space '${raw.id}' references unknown connection '${connectionId}'.`,
          );
        }
      }

      return yield* decodeCanonicalSpace({
        id: raw.id,
        slug: raw.id,
        displayName: raw.name,
        kind: raw.kind,
        instructions,
        policy: {
          allowedCapabilities: expandLegacyGoogleCapabilities(
            raw.policy?.allowedCapabilities ?? ACTIVE_CAPABILITY_NAMES,
          ),
          autoRunRiskLevels: raw.policy?.autoRunRiskLevels ?? ["low", "reversible"],
        },
        modelDefaults:
          raw.routing.provider === "auto" || raw.routing.model === "auto"
            ? undefined
            : {
                providerId: raw.routing.provider,
                modelId: raw.routing.model,
              },
        // Keep the configured assignment on the Space even while a Connection
        // is disabled. Routing may use this non-secret metadata to select the
        // intended Space, but only enabled Connections are projected below and
        // can ever provide a capability.
        connectionIds: raw.connectionIds,
        repositories: raw.repositories.map((repository) => ({
          id: repository.id,
          displayName: titleFromId(repository.id),
          aliases: repository.aliases,
          remoteRef: repository.remote,
        })),
        aliases: raw.aliases,
        lifecycle: "active",
        createdAt: now,
        updatedAt: now,
      }).pipe(
        Effect.mapError((cause) => configError(`Could not normalize Space '${raw.id}'.`, cause)),
      );
    });

    const load = Effect.gen(function* () {
      const rootPath = path.join(configDirectory, "command-center.json");
      if (!(yield* fs.exists(rootPath).pipe(Effect.orElseSucceed(() => false)))) {
        return {
          spaces: [],
          connections: [],
          automations: [],
          timezone: null,
          routing: null,
          health: {
            status: "missing",
            configDirectory,
            message: "Clone the private configuration repository into this directory.",
          },
        } satisfies LoadedCommandCenterConfig;
      }

      return yield* Effect.gen(function* () {
        const canonicalConfigDirectory = yield* canonicalizeConfigDirectory();
        const canonicalRootPath = yield* resolveInsideConfig(
          "command-center.json",
          canonicalConfigDirectory,
        );
        const root = yield* readJson(canonicalRootPath, decodeRoot);
        const now = DateTime.formatIso(yield* DateTime.now);
        const configuredSpaces = yield* Effect.forEach(root.spaces, (reference) =>
          loadCanonicalSpace(reference, root, now, canonicalConfigDirectory),
        );
        const runtime = yield* readRuntimeGoogleConnections();
        const configuredSpaceIds = new Set<string>(configuredSpaces.map((space) => space.id));
        for (const connection of runtime.connections) {
          if (!configuredSpaceIds.has(connection.spaceId)) {
            return yield* configError(
              `Runtime connection '${connection.id}' references unknown Space '${connection.spaceId}'.`,
            );
          }
        }
        const spaces = yield* Effect.forEach(configuredSpaces, (space) =>
          decodeCanonicalSpace({
            ...space,
            connectionIds: [
              ...space.connectionIds,
              ...runtime.connections
                .filter((connection) => connection.enabled && connection.spaceId === space.id)
                .map((connection) => connection.id),
            ],
          }).pipe(
            Effect.mapError((cause) =>
              configError(`Could not attach runtime connections to Space '${space.id}'.`, cause),
            ),
          ),
        );
        const spaceByConnection = new Map<string, SpaceType>();
        for (const space of configuredSpaces) {
          for (const connectionId of space.connectionIds) {
            spaceByConnection.set(connectionId, space);
          }
        }
        const configuredConnections = [
          ...root.connections.map((connection) => ({
            ...connection,
            spaceId: spaceByConnection.get(connection.id)?.id,
          })),
          ...runtime.connections.map((connection) => ({ ...connection, kind: "google" as const })),
        ];
        const connectionIds = new Set<string>();
        for (const connection of configuredConnections) {
          if (connectionIds.has(connection.id)) {
            return yield* configError(`Google connection id '${connection.id}' is duplicated.`);
          }
          connectionIds.add(connection.id);
        }
        const connections = yield* Effect.forEach(
          configuredConnections.filter((connection) => connection.enabled),
          (connection) => {
            const space = spaces.find((candidate) => candidate.id === connection.spaceId);
            if (space === undefined) {
              return Effect.fail(
                configError(`Enabled connection '${connection.id}' is not assigned to a Space.`),
              );
            }
            return decodeCanonicalConnection({
              id: connection.id,
              spaceId: space.id,
              kind: connection.kind,
              label: connection.accountLabel,
              capabilities: googleCapabilitiesFromConfig(connection.capabilities),
              health: "disconnected",
            }).pipe(
              Effect.mapError((cause) =>
                configError(`Could not normalize connection '${connection.id}'.`, cause),
              ),
            );
          },
        );
        const committed = yield* loadCommittedAutomations(canonicalConfigDirectory, spaces).pipe(
          Effect.provideService(ProcessRunner, processRunner),
        );
        return {
          spaces,
          connections,
          automations: committed.automations,
          timezone: root.timezone,
          routing: root.routing,
          health: { status: "loaded", configDirectory },
        } satisfies LoadedCommandCenterConfig;
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            spaces: [],
            connections: [],
            automations: [],
            timezone: null,
            routing: null,
            health: {
              status: "invalid",
              configDirectory,
              message: error instanceof Error ? error.message : String(error),
            },
          } satisfies LoadedCommandCenterConfig),
        ),
      );
    });

    const resolveGoogleAccount = Effect.fn("CommandCenterConfig.resolveGoogleAccount")(
      function* (input: { readonly spaceId: string; readonly connectionId: string }) {
        const canonicalConfigDirectory = yield* canonicalizeConfigDirectory();
        const rootPath = yield* resolveInsideConfig(
          "command-center.json",
          canonicalConfigDirectory,
        );
        const root = yield* readJson(rootPath, decodeRoot);
        const runtime = yield* readRuntimeGoogleConnections();
        const configuredConnection = root.connections.find(
          (candidate) =>
            candidate.id === input.connectionId && candidate.kind === "google" && candidate.enabled,
        );
        const spaceReference = root.spaces.find((candidate) => candidate.id === input.spaceId);
        if (spaceReference === undefined) {
          return yield* configError("The requested Google connection Space was not found.");
        }
        const spacePath = yield* resolveInsideConfig(
          spaceReference.configPath,
          canonicalConfigDirectory,
        );
        const space = yield* readJson(spacePath, decodeSpace);
        const runtimeConnection = runtime.connections.find(
          (candidate) =>
            candidate.id === input.connectionId &&
            candidate.spaceId === input.spaceId &&
            candidate.enabled,
        );
        const connection = configuredConnection ?? runtimeConnection;
        if (connection === undefined) {
          return yield* configError("The requested Google connection is not enabled.");
        }
        const assigned =
          configuredConnection === undefined
            ? runtimeConnection?.spaceId === input.spaceId
            : space.connectionIds.includes(configuredConnection.id);
        if (space.id !== input.spaceId || !assigned) {
          return yield* configError(
            "The requested Google connection is not assigned to this Space.",
          );
        }
        const accountAlias = googleAccountAliasFromCredentialRef(connection.credentialRef);
        if (accountAlias === undefined) {
          return yield* configError(
            "The Google connection credential reference does not resolve to a safe runtime alias.",
          );
        }
        return { accountAlias, label: connection.accountLabel };
      },
    );

    const upsertRuntimeGoogleConnection = Effect.fn(
      "CommandCenterConfig.upsertRuntimeGoogleConnection",
    )(function* (input: {
      readonly spaceId: string;
      readonly accountAlias: string;
      readonly accountLabel: string;
      readonly capabilities: ReadonlyArray<GoogleConnectionConfigCapability>;
    }) {
      const canonicalConfigDirectory = yield* canonicalizeConfigDirectory();
      const rootPath = yield* resolveInsideConfig("command-center.json", canonicalConfigDirectory);
      const root = yield* readJson(rootPath, decodeRoot);
      const spaceReference = root.spaces.find((candidate) => candidate.id === input.spaceId);
      if (spaceReference === undefined) {
        return yield* configError("The selected Space was not found.");
      }
      const spacePath = yield* resolveInsideConfig(
        spaceReference.configPath,
        canonicalConfigDirectory,
      );
      const space = yield* readJson(spacePath, decodeSpace);
      const credentialRef = `runtime:google/${input.accountAlias}`;
      const configured = root.connections.find(
        (candidate) =>
          candidate.enabled &&
          candidate.credentialRef === credentialRef &&
          space.connectionIds.includes(candidate.id) &&
          input.capabilities.every((capability) => candidate.capabilities.includes(capability)),
      );
      if (configured !== undefined) return { connectionId: configured.id };

      const runtime = yield* readRuntimeGoogleConnections();
      const existing = runtime.connections.find(
        (candidate) =>
          candidate.spaceId === input.spaceId && candidate.credentialRef === credentialRef,
      );
      const usedIds = new Set([
        ...root.connections.map((connection) => connection.id),
        ...runtime.connections.map((connection) => connection.id),
      ]);
      const slug = (value: string) =>
        value
          .toLowerCase()
          .replaceAll(/[^a-z0-9]+/gu, "-")
          .replaceAll(/^-+|-+$/gu, "")
          .slice(0, 80);
      const baseId = `google-${slug(input.accountAlias)}-${slug(input.spaceId)}`;
      let connectionId = existing?.id ?? baseId;
      let suffix = 2;
      if (existing === undefined) {
        while (usedIds.has(connectionId)) {
          connectionId = `${baseId}-${suffix}`;
          suffix += 1;
        }
      }
      const mergedCapabilities = Array.from(
        new Set([...(existing?.capabilities ?? []), ...input.capabilities]),
      );
      const nextConnection = {
        id: connectionId,
        spaceId: input.spaceId,
        accountLabel: input.accountLabel,
        credentialRef,
        capabilities: mergedCapabilities,
        enabled: true,
      } satisfies RuntimeGoogleConnectionsFile["connections"][number];
      const next = {
        schemaVersion: 1 as const,
        connections: existing
          ? runtime.connections.map((connection) =>
              connection.id === existing.id ? nextConnection : connection,
            )
          : [...runtime.connections, nextConnection],
      };
      yield* writeRuntimeGoogleConnections(next);
      return { connectionId };
    });

    const removeRuntimeGoogleConnection = Effect.fn(
      "CommandCenterConfig.removeRuntimeGoogleConnection",
    )(function* (input: { readonly spaceId: string; readonly connectionId: string }) {
      const runtime = yield* readRuntimeGoogleConnections();
      const matching = runtime.connections.find(
        (connection) =>
          connection.id === input.connectionId && connection.spaceId === input.spaceId,
      );
      if (matching === undefined) {
        return yield* configError("Only Google accounts connected in the app can be removed here.");
      }
      yield* writeRuntimeGoogleConnections({
        schemaVersion: 1,
        connections: runtime.connections.filter(
          (connection) =>
            connection.id !== input.connectionId || connection.spaceId !== input.spaceId,
        ),
      });
      return { removed: true as const };
    });

    return CommandCenterConfig.of({
      configDirectory,
      load,
      resolveGoogleAccount,
      upsertRuntimeGoogleConnection,
      removeRuntimeGoogleConnection,
    });
  }),
);
