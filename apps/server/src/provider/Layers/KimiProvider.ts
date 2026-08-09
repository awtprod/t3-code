import {
  type KimiSettings,
  type ModelCapabilities,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  isSupportedKimiVersion,
  parseKimiVersion,
  type KimiRuntimeClient,
} from "../kimiRuntime.ts";

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const DEFAULT_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "kimi-code/k3",
    name: "Kimi K3",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];
const PRESENTATION = {
  displayName: "Kimi",
  showInteractionModeToggle: true,
  requiresNewThreadForModelChange: true,
} as const;

/**
 * Read-only mounts the isolation smoke test needs to exec anything at all.
 * Must stay in sync with the equivalent binds in `buildKimiAutomationBwrapArgs`:
 * on usrmerged systems /lib and /lib64 are symlinks into /usr, so omitting them
 * leaves the ELF loader unreachable and the probe fails a sandbox the real
 * launcher would have run successfully.
 */
export const KIMI_ISOLATION_PROBE_ROOT_BINDS: ReadonlyArray<string> = [
  "--ro-bind",
  "/usr",
  "/usr",
  "--ro-bind-try",
  "/bin",
  "/bin",
  "--ro-bind-try",
  "/lib",
  "/lib",
  "--ro-bind-try",
  "/lib64",
  "/lib64",
];

export const probeKimiCommandCenterIsolation = Effect.fn("probeKimiCommandCenterIsolation")(
  function* (settings: KimiSettings, environment: NodeJS.ProcessEnv) {
    if (NodeProcess.platform !== "linux") return false;
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* Effect.gen(function* () {
      const executable = yield* resolveCommandPath(settings.binaryPath, {
        env: environment,
        extendEnv: false,
      }).pipe(Effect.flatMap(fileSystem.realPath));
      const executableInfo = yield* fileSystem.stat(executable);
      if (
        executableInfo.type !== "File" ||
        (executableInfo.mode & 0o111) === 0 ||
        (executableInfo.mode & 0o022) !== 0 ||
        Option.getOrElse(executableInfo.nlink, () => 1) !== 1
      )
        return false;
      const header = yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fileSystem.open(executable, { flag: "r" });
          return yield* file.readAlloc(4);
        }),
      );
      if (
        Option.isNone(header) ||
        header.value[0] !== 0x7f ||
        header.value[1] !== 0x45 ||
        header.value[2] !== 0x4c ||
        header.value[3] !== 0x46
      )
        return false;
      const bwrap = yield* fileSystem.realPath("/usr/bin/bwrap");
      if (bwrap !== "/usr/bin/bwrap") return false;
      const bwrapInfo = yield* fileSystem.stat(bwrap);
      if (bwrapInfo.type !== "File" || (bwrapInfo.mode & 0o022) !== 0) return false;
      const result = yield* spawnAndCollect(
        bwrap,
        ChildProcess.make(
          bwrap,
          [
            "--unshare-user",
            "--unshare-pid",
            "--unshare-ipc",
            "--unshare-uts",
            "--unshare-cgroup-try",
            "--disable-userns",
            "--die-with-parent",
            "--cap-drop",
            "ALL",
            "--clearenv",
            ...KIMI_ISOLATION_PROBE_ROOT_BINDS,
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--",
            "/usr/bin/true",
          ],
          { env: environment },
        ),
      ).pipe(Effect.scoped);
      return result.code === 0;
    }).pipe(Effect.orElseSucceed(() => false));
  },
);

function fallbackModels(settings: KimiSettings): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(DEFAULT_MODELS, settings.customModels, EMPTY_CAPABILITIES);
}

function discoveredModels(
  value: unknown,
  settings: KimiSettings,
): ReadonlyArray<ServerProviderModel> {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const items = Array.isArray(record.items) ? record.items : Array.isArray(value) ? value : [];
  const models = items.flatMap((item): Array<ServerProviderModel> => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Record<string, unknown>;
    const slug = candidate.id ?? candidate.model ?? candidate.slug;
    if (typeof slug !== "string" || !slug.trim()) return [];
    return [
      {
        slug: slug.trim(),
        name:
          typeof candidate.name === "string" && candidate.name.trim()
            ? candidate.name.trim()
            : slug.trim(),
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      },
    ];
  });
  return providerModelsFromSettings(
    models.length > 0 ? models : DEFAULT_MODELS,
    settings.customModels,
    EMPTY_CAPABILITIES,
  );
}

export const makePendingKimiProvider = Effect.fn("makePendingKimiProvider")(function* (
  settings: KimiSettings,
): Effect.fn.Return<ServerProviderDraft> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return buildServerProvider({
    presentation: PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: fallbackModels(settings),
    probe: {
      installed: settings.enabled,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: settings.enabled
        ? "Checking Kimi Code availability..."
        : "Kimi is disabled in Command Center settings.",
    },
  });
});

export const checkKimiProviderStatus = Effect.fn("checkKimiProviderStatus")(function* (
  settings: KimiSettings,
  runtime: KimiRuntimeClient,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) return yield* makePendingKimiProvider(settings);

  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const versionResult = yield* Effect.gen(function* () {
    const command = yield* resolveSpawnCommand(settings.binaryPath, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      settings.binaryPath,
      ChildProcess.make(command.command, command.args, {
        shell: command.shell,
        env: environment,
      }),
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
  }).pipe(Effect.scoped, Effect.option);
  if (versionResult._tag === "None") {
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels(settings),
      probe: {
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Kimi Code is not installed or could not be executed.",
      },
    });
  }
  const version = parseKimiVersion(`${versionResult.value.stdout}\n${versionResult.value.stderr}`);
  if (!version || !isSupportedKimiVersion(version)) {
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels(settings),
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Kimi Code 0.31.1 or newer is required.",
      },
    });
  }

  const status = yield* Effect.all({
    auth: runtime.request<Record<string, unknown>>("/auth").pipe(Effect.option),
    models: runtime.request<unknown>("/models").pipe(Effect.option),
  });
  const authRecord = status.auth._tag === "Some" ? status.auth.value : undefined;
  const authenticated =
    authRecord !== undefined &&
    (authRecord.ready === true ||
      authRecord.authenticated === true ||
      authRecord.logged_in === true ||
      authRecord.status === "authenticated");
  const commandCenterAutomation = yield* probeKimiCommandCenterIsolation(settings, environment);
  return buildServerProvider({
    presentation: PRESENTATION,
    enabled: true,
    checkedAt,
    models:
      status.models._tag === "Some"
        ? discoveredModels(status.models.value, settings)
        : fallbackModels(settings),
    probe: {
      installed: true,
      version,
      status: authenticated ? "ready" : "warning",
      auth: { status: authenticated ? "authenticated" : "unauthenticated" },
      message: authenticated
        ? "Kimi Code is ready. Prompt cache telemetry and native subagents are available."
        : "Sign in with Kimi Code before starting a thread.",
    },
    capabilities: {
      cacheTelemetry: "read-write",
      nativeSubagents: true,
      usageTelemetry: true,
      commandCenterAutomation,
    },
  });
});
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeProcess from "node:process";
