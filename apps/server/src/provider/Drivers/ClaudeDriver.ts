/**
 * ClaudeDriver — `ProviderDriver` for the Claude Agent SDK runtime.
 *
 * Mirrors `CodexDriver`: a plain value whose `create()` returns one
 * `ProviderInstance` bundling `snapshot` / `adapter` / `textGeneration`
 * closures captured over the per-instance `ClaudeSettings`.
 *
 * Unlike Codex, the Claude snapshot probe may invoke a secondary probe
 * (`probeClaudeCapabilities`) to read Anthropic account + slash-command
 * metadata. That probe is per-instance and keyed by binary + resolved HOME so
 * two concurrent Claude instances don't cross-contaminate account metadata.
 *
 * @module provider/Drivers/ClaudeDriver
 */
import { ClaudeSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeClaudeTextGeneration } from "../../textGeneration/ClaudeTextGeneration.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  DEFAULT_SIEVE_SETTINGS,
  sieveToolResult,
  type JudgeLike,
  type SieveSettings,
} from "../../efficiency/ToolResultSieve.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeClaudeAdapter, type ToolResultSieveHookInput } from "../Layers/ClaudeAdapter.ts";
import {
  checkClaudeProviderStatus,
  makePendingClaudeProvider,
  probeClaudeCapabilities,
} from "../Layers/ClaudeProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { resolveClaudeModelCatalog } from "../ClaudeModelCatalog.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import * as ModelManifest from "../ModelManifest.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { makeClaudeCapabilitiesCacheKey, makeClaudeContinuationGroupKey } from "./ClaudeHome.ts";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
const CAPABILITIES_PROBE_TTL = Duration.minutes(5);

const DEFAULT_JUDGE_TIMEOUT_MS = 15_000;

/**
 * Read `efficiency.sieve` from server settings and fill DESIGN defaults.
 *
 * TEMPORARY: slice A owns the typed `ServerSettings.efficiency.sieve` contract
 * key. Until it lands this reads through an `as` cast. DELETE this shim and read
 * the typed field once A's contract is merged.
 */
function readSieveSettings(settings: unknown): SieveSettings {
  const raw = (settings as { efficiency?: { sieve?: Partial<SieveSettings> } } | undefined)
    ?.efficiency?.sieve;
  if (!raw || typeof raw !== "object") return DEFAULT_SIEVE_SETTINGS;
  return {
    mode: raw.mode ?? DEFAULT_SIEVE_SETTINGS.mode,
    tools: raw.tools ?? DEFAULT_SIEVE_SETTINGS.tools,
    minChars: raw.minChars ?? DEFAULT_SIEVE_SETTINGS.minChars,
    blockLines: raw.blockLines ?? DEFAULT_SIEVE_SETTINGS.blockLines,
    maxBlocks: raw.maxBlocks ?? DEFAULT_SIEVE_SETTINGS.maxBlocks,
    dropBelow: raw.dropBelow ?? DEFAULT_SIEVE_SETTINGS.dropBelow,
    keepAbove: raw.keepAbove ?? DEFAULT_SIEVE_SETTINGS.keepAbove,
    minPruneRatio: raw.minPruneRatio ?? DEFAULT_SIEVE_SETTINGS.minPruneRatio,
  };
}

/** Judge request timeout from settings (same `as`-cast shim caveat as above). */
function readJudgeTimeoutMs(settings: unknown): number {
  const timeoutMs = (settings as { efficiency?: { judge?: { timeoutMs?: number } } } | undefined)
    ?.efficiency?.judge?.timeoutMs;
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_JUDGE_TIMEOUT_MS;
}

/**
 * Placeholder Judge until slice A's `Judge` service lands. Disabled, so the
 * sieve always falls through to today's behaviour (no rewrite). Swap for the
 * real `Judge` service (yielded from context) on rebase.
 */
const DISABLED_JUDGE_STUB: JudgeLike = {
  enabled: false,
  ask: () => Effect.fail({ _tag: "JudgeDisabled", reason: "judge disabled (stub)" }),
};

function isClaudeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.local/bin/claude") ||
    normalized.endsWith("/.local/bin/claude.exe") ||
    normalized.includes("/.local/share/claude/")
  );
}

const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "@anthropic-ai/claude-code",
  homebrewFormula: "claude-code",
  nativeUpdate: {
    executable: "claude",
    args: ["update"],
    lockKey: "claude-native",
    isCommandPath: isClaudeNativeCommandPath,
  },
});

export type ClaudeDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ModelManifest.ModelManifest
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
    capabilities: { cacheTelemetry: "read-write", nativeSubagents: true, usageTelemetry: true },
  });

export const ClaudeDriver: ProviderDriver<ClaudeSettings, ClaudeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Claude",
    supportsMultipleInstances: true,
  },
  configSchema: ClaudeSettings,
  defaultConfig: (): ClaudeSettings => decodeClaudeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { cwd } = yield* ServerConfig;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const modelManifest = yield* ModelManifest.ModelManifest;
      const modelCatalog = modelManifest.current.pipe(Effect.map(resolveClaudeModelCatalog));
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const fallbackContinuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const effectiveConfig = { ...config, enabled } satisfies ClaudeSettings;
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      });
      const continuationGroupKey = yield* makeClaudeContinuationGroupKey(effectiveConfig);
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey,
      });

      // Tool-result sieve (slice B). Register the adapter hook only when the
      // sieve is enabled at instance-creation time; the callback re-reads live
      // settings each invocation so a runtime flip to `off` makes it inert, and
      // it binds to a disabled stub judge until slice A's Judge service lands
      // (so today it never rewrites — behaviour stays identical).
      const initialSieveSettings = readSieveSettings(
        yield* serverSettings.getSettings.pipe(Effect.catch(() => Effect.succeed(undefined))),
      );
      const toolResultSieve =
        initialSieveSettings.mode === "off"
          ? undefined
          : (input: ToolResultSieveHookInput): Effect.Effect<unknown | undefined> =>
              Effect.gen(function* () {
                const settings = yield* serverSettings.getSettings;
                const outcome = yield* sieveToolResult(
                  {
                    judge: DISABLED_JUDGE_STUB,
                    settings: readSieveSettings(settings),
                    timeoutMs: readJudgeTimeoutMs(settings),
                  },
                  input,
                );
                if (outcome.decision) {
                  yield* Effect.logDebug("tool-result sieve decision", {
                    tool: outcome.decision.tool,
                    mode: outcome.decision.mode,
                    rewritten: outcome.decision.rewritten,
                    blockCount: outcome.decision.blockCount,
                    hiddenBlockIds: outcome.decision.hiddenBlockIds,
                    uncertainBlockIds: outcome.decision.uncertainBlockIds,
                    hiddenRanges: outcome.decision.hiddenRanges,
                    charsBefore: outcome.decision.charsBefore,
                    charsAfter: outcome.decision.charsAfter,
                    prunedRatio: outcome.decision.prunedRatio,
                    reason: outcome.decision.reason,
                    latencyMs: outcome.decision.latencyMs,
                    inputSummary: outcome.decision.inputSummary,
                  });
                }
                return outcome.updatedToolOutput;
              }).pipe(Effect.catch(() => Effect.succeed(undefined)));

      const adapterOptions = {
        instanceId,
        environment: processEnv,
        modelCatalog,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        ...(toolResultSieve ? { toolResultSieve } : {}),
      };
      const adapter = yield* makeClaudeAdapter(effectiveConfig, adapterOptions);
      const textGeneration = yield* makeClaudeTextGeneration(
        effectiveConfig,
        processEnv,
        modelCatalog,
      );

      // Per-instance capabilities cache: keyed on binary + resolved HOME so
      // account-specific probes never share auth metadata across instances.
      const capabilitiesProbeCache = yield* Cache.make({
        capacity: 1,
        timeToLive: CAPABILITIES_PROBE_TTL,
        lookup: () =>
          probeClaudeCapabilities(effectiveConfig, processEnv, cwd).pipe(
            Effect.provideService(Path.Path, path),
          ),
      });
      const capabilitiesCacheKey = yield* makeClaudeCapabilitiesCacheKey(effectiveConfig, cwd);

      // Start the TTL-gated refresh without delaying provider readiness. The
      // next check observes a remote manifest after the background fetch lands.
      const checkProvider = modelManifest.refreshInBackground.pipe(
        Effect.andThen(
          modelManifest.current.pipe(
            Effect.flatMap((manifest) =>
              checkClaudeProviderStatus(
                effectiveConfig,
                () => Cache.get(capabilitiesProbeCache, capabilitiesCacheKey),
                processEnv,
                cwd,
                resolveClaudeModelCatalog(manifest),
              ),
            ),
            Effect.map(stampIdentity),
          ),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<ClaudeSettings>>({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          modelManifest.current.pipe(
            Effect.flatMap((manifest) =>
              makePendingClaudeProvider(settings.provider, resolveClaudeModelCatalog(manifest)),
            ),
            Effect.map(stampIdentity),
          ),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
          enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
            enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
          }).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Claude snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity: {
          ...fallbackContinuationIdentity,
          continuationKey: continuationGroupKey,
        },
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
