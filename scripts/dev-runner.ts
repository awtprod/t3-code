#!/usr/bin/env node

import * as NodeOS from "node:os";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Hash from "effect/Hash";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { ChildProcess } from "effect/unstable/process";

import * as DevProcessGuard from "./lib/dev-process-guard.ts";
import { loadRepoEnv } from "./lib/public-config.ts";

Object.assign(process.env, loadRepoEnv());

const BASE_SERVER_PORT = 13773;
const BASE_WEB_PORT = 5733;
const MAX_HASH_OFFSET = 3000;
const MAX_PORT = 65535;
const DESKTOP_DEV_LOOPBACK_HOST = "127.0.0.1";
const DEV_PORT_PROBE_HOSTS = ["127.0.0.1", "0.0.0.0", "::1", "::"] as const;

export const DEFAULT_T3_HOME = Effect.map(Effect.service(Path.Path), (path) =>
  path.join(NodeOS.homedir(), ".command-center"),
);

const MODE_ARGS = {
  dev: [
    "run",
    "--filter=@t3tools/contracts",
    "--filter=@t3tools/web",
    "--filter=@awtprod/command-center",
    "--parallel",
    "dev",
  ],
  "dev:server": ["run", "--filter=@awtprod/command-center", "dev"],
  "dev:web": ["run", "--filter=@t3tools/web", "dev"],
  "dev:desktop": ["run", "--filter=@t3tools/desktop", "--filter=@t3tools/web", "dev"],
  // Production-build daily driver: no Vite dev server at all. The backend
  // serves apps/web/dist itself (see resolveStaticDir/staticAndDevRouteLayer),
  // so app, /api, and /ws share one origin.
  serve: ["run", "--filter=@awtprod/command-center", "dev"],
} as const satisfies Record<string, ReadonlyArray<string>>;

/** Web build that `serve` mode runs before starting the backend. */
const SERVE_BUILD_ARGS = ["run", "--filter=@t3tools/web", "build"] as const;

type DevMode = keyof typeof MODE_ARGS;
type PortAvailabilityCheck<R = never> = (port: number) => Effect.Effect<boolean, never, R>;

const DEV_RUNNER_MODES = Object.keys(MODE_ARGS) as Array<DevMode>;

export function getDevRunnerModeArgs(mode: DevMode): ReadonlyArray<string> {
  return MODE_ARGS[mode];
}

export class DevRunnerConfigurationError extends Schema.TaggedErrorClass<DevRunnerConfigurationError>()(
  "DevRunnerConfigurationError",
  {
    configKeys: Schema.Array(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read dev-runner configuration: ${this.configKeys.join(", ")}.`;
  }
}

export class DevRunnerInvalidPortOffsetError extends Schema.TaggedErrorClass<DevRunnerInvalidPortOffsetError>()(
  "DevRunnerInvalidPortOffsetError",
  {
    configKey: Schema.Literal("T3CODE_PORT_OFFSET"),
    portOffset: Schema.Number,
    minimum: Schema.Number,
  },
) {
  override get message(): string {
    return `${this.configKey} must be at least ${this.minimum}; received ${this.portOffset}.`;
  }
}

export class DevRunnerPortExhaustedError extends Schema.TaggedErrorClass<DevRunnerPortExhaustedError>()(
  "DevRunnerPortExhaustedError",
  {
    startOffset: Schema.Number,
    requireServerPort: Schema.Boolean,
    requireWebPort: Schema.Boolean,
    baseServerPort: Schema.Number,
    baseWebPort: Schema.Number,
    maximumPort: Schema.Number,
  },
) {
  override get message(): string {
    return `No required dev ports were available from offset ${this.startOffset} through maximum port ${this.maximumPort}.`;
  }
}

export class DevRunnerProcessError extends Schema.TaggedErrorClass<DevRunnerProcessError>()(
  "DevRunnerProcessError",
  {
    operation: Schema.Literals(["spawn", "wait-for-exit"]),
    mode: Schema.Literals(["dev", "dev:server", "dev:web", "dev:desktop", "serve"]),
    executable: Schema.Literal("vp"),
    argumentCount: Schema.Number,
    shell: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Dev-runner process operation "${this.operation}" failed for mode "${this.mode}".`;
  }
}

export class DevRunnerProcessExitError extends Schema.TaggedErrorClass<DevRunnerProcessExitError>()(
  "DevRunnerProcessExitError",
  {
    mode: Schema.Literals(["dev", "dev:server", "dev:web", "dev:desktop", "serve"]),
    executable: Schema.Literal("vp"),
    argumentCount: Schema.Number,
    shell: Schema.Boolean,
    exitCode: Schema.Number,
  },
) {
  override get message(): string {
    return `Dev-runner process exited with code ${this.exitCode} in mode "${this.mode}".`;
  }
}

export const DevRunnerError = Schema.Union([
  DevRunnerConfigurationError,
  DevRunnerInvalidPortOffsetError,
  DevRunnerPortExhaustedError,
  DevRunnerProcessError,
  DevRunnerProcessExitError,
]);
export type DevRunnerError = typeof DevRunnerError.Type;
export const isDevRunnerError = Schema.is(DevRunnerError);

const optionalStringConfig = (name: string): Config.Config<string | undefined> =>
  Config.string(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );
const optionalBooleanConfig = (name: string): Config.Config<boolean | undefined> =>
  Config.boolean(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );
const optionalPortConfig = (name: string): Config.Config<number | undefined> =>
  Config.port(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );
const optionalIntegerConfig = (name: string): Config.Config<number | undefined> =>
  Config.int(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );
const OffsetConfig = Config.all({
  portOffset: optionalIntegerConfig("T3CODE_PORT_OFFSET"),
  devInstance: optionalStringConfig("T3CODE_DEV_INSTANCE"),
});

export function resolveOffset(config: {
  readonly portOffset: number | undefined;
  readonly devInstance: string | undefined;
}): Effect.Effect<
  { readonly offset: number; readonly source: string },
  DevRunnerInvalidPortOffsetError
> {
  if (config.portOffset !== undefined) {
    if (config.portOffset < 0) {
      return Effect.fail(
        new DevRunnerInvalidPortOffsetError({
          configKey: "T3CODE_PORT_OFFSET",
          portOffset: config.portOffset,
          minimum: 0,
        }),
      );
    }
    return Effect.succeed({
      offset: config.portOffset,
      source: `T3CODE_PORT_OFFSET=${config.portOffset}`,
    });
  }

  const seed = config.devInstance?.trim();
  if (!seed) {
    return Effect.succeed({ offset: 0, source: "default ports" });
  }

  if (/^\d+$/.test(seed)) {
    return Effect.succeed({
      offset: Number(seed),
      source: `numeric T3CODE_DEV_INSTANCE=${seed}`,
    });
  }

  const offset = ((Hash.string(seed) >>> 0) % MAX_HASH_OFFSET) + 1;
  return Effect.succeed({ offset, source: `hashed T3CODE_DEV_INSTANCE=${seed}` });
}

function resolveBaseDir(baseDir: string | undefined): Effect.Effect<string, never, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const configured = baseDir?.trim();

    if (configured) {
      return path.resolve(configured);
    }

    return yield* DEFAULT_T3_HOME;
  });
}

interface CreateDevRunnerEnvInput {
  readonly mode: DevMode;
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly serverOffset: number;
  readonly webOffset: number;
  readonly t3Home: string | undefined;
  readonly browser: boolean | undefined;
  readonly autoBootstrapProjectFromCwd: boolean | undefined;
  readonly logWebSocketEvents: boolean | undefined;
  readonly host: string | undefined;
  readonly port: number | undefined;
  readonly devUrl: URL | undefined;
  readonly tailscaleServe: boolean | undefined;
}

export function createDevRunnerEnv({
  mode,
  baseEnv,
  serverOffset,
  webOffset,
  t3Home,
  browser,
  autoBootstrapProjectFromCwd,
  logWebSocketEvents,
  host,
  port,
  devUrl,
  tailscaleServe,
}: CreateDevRunnerEnvInput): Effect.Effect<NodeJS.ProcessEnv, never, Path.Path> {
  return Effect.gen(function* () {
    const serverPort = port ?? BASE_SERVER_PORT + serverOffset;
    const webPort = BASE_WEB_PORT + webOffset;
    const configuredBaseDir = t3Home?.trim() || baseEnv.T3CODE_HOME?.trim() || undefined;
    const resolvedBaseDir = yield* resolveBaseDir(configuredBaseDir);
    const isDesktopMode = mode === "dev:desktop";
    const isServeMode = mode === "serve";

    const output: NodeJS.ProcessEnv = {
      ...baseEnv,
      PORT: String(webPort),
      VITE_DEV_SERVER_URL:
        devUrl?.toString() ??
        `http://${isDesktopMode ? DESKTOP_DEV_LOOPBACK_HOST : "localhost"}:${webPort}`,
    };

    // `serve` runs the built app straight off the backend. VITE_DEV_SERVER_URL
    // must be absent or the server 302-redirects every request to a dev server
    // that isn't running (apps/server/src/http.ts) and never resolves staticDir
    // (apps/server/src/cli/config.ts). VITE_HTTP_URL/VITE_WS_URL must be absent
    // too: they are baked into the bundle at build time, and a hardcoded
    // `localhost:<port>` target would break every non-loopback client (Tailscale,
    // LAN). With all three unset the app falls back to its own window origin, so
    // app + /api + /ws are same-origin from wherever it is reached.
    if (isServeMode) {
      delete output.VITE_DEV_SERVER_URL;
      delete output.VITE_HTTP_URL;
      delete output.VITE_WS_URL;
      delete output.PORT;
    }

    if (configuredBaseDir !== undefined) {
      output.T3CODE_HOME = resolvedBaseDir;
    } else {
      delete output.T3CODE_HOME;
    }

    if (isServeMode) {
      output.T3CODE_PORT = String(serverPort);
    } else if (!isDesktopMode) {
      output.T3CODE_PORT = String(serverPort);
      output.VITE_HTTP_URL = `http://localhost:${serverPort}`;
      output.VITE_WS_URL = `ws://localhost:${serverPort}`;
    } else {
      output.T3CODE_PORT = String(serverPort);
      output.VITE_HTTP_URL = `http://${DESKTOP_DEV_LOOPBACK_HOST}:${serverPort}`;
      output.VITE_WS_URL = `ws://${DESKTOP_DEV_LOOPBACK_HOST}:${serverPort}`;
      delete output.T3CODE_MODE;
      delete output.T3CODE_NO_BROWSER;
      delete output.T3CODE_HOST;
    }

    if (!isDesktopMode && host !== undefined) {
      output.T3CODE_HOST = host;
    }

    if (!isDesktopMode) {
      output.T3CODE_NO_BROWSER = browser === true ? "0" : "1";
    }

    if (autoBootstrapProjectFromCwd !== undefined) {
      output.T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD = autoBootstrapProjectFromCwd ? "1" : "0";
    } else {
      delete output.T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD;
    }

    if (logWebSocketEvents !== undefined) {
      output.T3CODE_LOG_WS_EVENTS = logWebSocketEvents ? "1" : "0";
    } else {
      delete output.T3CODE_LOG_WS_EVENTS;
    }

    if (mode === "dev") {
      output.T3CODE_MODE = "web";
      delete output.T3CODE_DESKTOP_WS_URL;
    }

    if (mode === "dev:server" || mode === "dev:web" || isServeMode) {
      output.T3CODE_MODE = "web";
      delete output.T3CODE_DESKTOP_WS_URL;
    }

    // The server points Tailscale Serve at whatever port it listens on
    // (apps/server/src/server.ts), so enabling it here is what moves the
    // tailnet origin off the Vite port and onto the backend — the whole point
    // of serve mode being same-origin.
    if (tailscaleServe !== undefined) {
      output.T3CODE_TAILSCALE_SERVE = tailscaleServe ? "1" : "0";
    }

    if (isDesktopMode) {
      output.HOST = DESKTOP_DEV_LOOPBACK_HOST;
      delete output.T3CODE_DESKTOP_WS_URL;
    }

    return output;
  });
}

/**
 * Environment for the `serve` web build. Sourcemaps default to `hidden` here:
 * a full sourcemap build is 37 MB of `.map` next to 17 MB of JS, all of which
 * `apps/web/dist` then carries around for a build nobody debugs from source.
 * `T3CODE_WEB_SOURCEMAP` still wins when set explicitly.
 */
export function serveBuildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    T3CODE_WEB_SOURCEMAP: env.T3CODE_WEB_SOURCEMAP?.trim() || "hidden",
  };
}

function portPairForOffset(offset: number): {
  readonly serverPort: number;
  readonly webPort: number;
} {
  return {
    serverPort: BASE_SERVER_PORT + offset,
    webPort: BASE_WEB_PORT + offset,
  };
}

export function checkPortAvailabilityOnHosts<R>(
  port: number,
  hosts: ReadonlyArray<string>,
  canListenOnHost: (port: number, host: string) => Effect.Effect<boolean, never, R>,
): Effect.Effect<boolean, never, R> {
  return Effect.gen(function* () {
    for (const host of hosts) {
      if (!(yield* canListenOnHost(port, host))) {
        return false;
      }
    }

    return true;
  });
}

const defaultCheckPortAvailability: PortAvailabilityCheck<NetService.NetService> = (port) =>
  Effect.gen(function* () {
    const net = yield* NetService.NetService;
    return yield* checkPortAvailabilityOnHosts(port, DEV_PORT_PROBE_HOSTS, (candidatePort, host) =>
      net.canListenOnHost(candidatePort, host),
    );
  });

interface FindFirstAvailableOffsetInput<R = NetService.NetService> {
  readonly startOffset: number;
  readonly requireServerPort: boolean;
  readonly requireWebPort: boolean;
  readonly checkPortAvailability?: PortAvailabilityCheck<R>;
}

export function findFirstAvailableOffset<R = NetService.NetService>({
  startOffset,
  requireServerPort,
  requireWebPort,
  checkPortAvailability,
}: FindFirstAvailableOffsetInput<R>): Effect.Effect<number, DevRunnerPortExhaustedError, R> {
  return Effect.gen(function* () {
    const checkPort = (checkPortAvailability ??
      defaultCheckPortAvailability) as PortAvailabilityCheck<R>;

    for (let candidate = startOffset; ; candidate += 1) {
      const { serverPort, webPort } = portPairForOffset(candidate);
      const serverPortOutOfRange = serverPort > MAX_PORT;
      const webPortOutOfRange = webPort > MAX_PORT;

      if (
        (requireServerPort && serverPortOutOfRange) ||
        (requireWebPort && webPortOutOfRange) ||
        (!requireServerPort && !requireWebPort && (serverPortOutOfRange || webPortOutOfRange))
      ) {
        break;
      }

      const checks: Array<Effect.Effect<boolean, never, R>> = [];
      if (requireServerPort) {
        checks.push(checkPort(serverPort));
      }
      if (requireWebPort) {
        checks.push(checkPort(webPort));
      }

      if (checks.length === 0) {
        return candidate;
      }

      const availability = yield* Effect.all(checks);
      if (availability.every(Boolean)) {
        return candidate;
      }
    }

    return yield* new DevRunnerPortExhaustedError({
      startOffset,
      requireServerPort,
      requireWebPort,
      baseServerPort: BASE_SERVER_PORT,
      baseWebPort: BASE_WEB_PORT,
      maximumPort: MAX_PORT,
    });
  });
}

interface ResolveModePortOffsetsInput<R = NetService.NetService> {
  readonly mode: DevMode;
  readonly startOffset: number;
  readonly hasExplicitServerPort: boolean;
  readonly hasExplicitDevUrl: boolean;
  readonly checkPortAvailability?: PortAvailabilityCheck<R>;
}

export function resolveModePortOffsets<R = NetService.NetService>({
  mode,
  startOffset,
  hasExplicitServerPort,
  hasExplicitDevUrl,
  checkPortAvailability,
}: ResolveModePortOffsetsInput<R>): Effect.Effect<
  { readonly serverOffset: number; readonly webOffset: number },
  DevRunnerPortExhaustedError,
  R
> {
  return Effect.gen(function* () {
    const checkPort = (checkPortAvailability ??
      defaultCheckPortAvailability) as PortAvailabilityCheck<R>;

    if (mode === "dev:web") {
      if (hasExplicitDevUrl) {
        return { serverOffset: startOffset, webOffset: startOffset };
      }

      const webOffset = yield* findFirstAvailableOffset({
        startOffset,
        requireServerPort: false,
        requireWebPort: true,
        checkPortAvailability: checkPort,
      });
      return { serverOffset: startOffset, webOffset };
    }

    // `serve` runs no Vite dev server, so like `dev:server` it only needs the
    // backend port to be free.
    if (mode === "dev:server" || mode === "serve") {
      if (hasExplicitServerPort) {
        return { serverOffset: startOffset, webOffset: startOffset };
      }

      const serverOffset = yield* findFirstAvailableOffset({
        startOffset,
        requireServerPort: true,
        requireWebPort: false,
        checkPortAvailability: checkPort,
      });
      return { serverOffset, webOffset: serverOffset };
    }

    const sharedOffset = yield* findFirstAvailableOffset({
      startOffset,
      requireServerPort: !hasExplicitServerPort,
      requireWebPort: !hasExplicitDevUrl,
      checkPortAvailability: checkPort,
    });

    return { serverOffset: sharedOffset, webOffset: sharedOffset };
  });
}

interface DevRunnerCliInput {
  readonly mode: DevMode;
  readonly t3Home: string | undefined;
  readonly browser: boolean | undefined;
  readonly autoBootstrapProjectFromCwd: boolean | undefined;
  readonly logWebSocketEvents: boolean | undefined;
  readonly host: string | undefined;
  readonly port: number | undefined;
  readonly devUrl: URL | undefined;
  readonly dryRun: boolean;
  readonly skipBuild: boolean;
  readonly tailscaleServe: boolean | undefined;
  readonly runArgs: ReadonlyArray<string>;
}

export function runDevRunnerWithInput(input: DevRunnerCliInput) {
  return Effect.gen(function* () {
    const { portOffset, devInstance } = yield* OffsetConfig.pipe(
      Effect.mapError(
        (cause) =>
          new DevRunnerConfigurationError({
            configKeys: ["T3CODE_PORT_OFFSET", "T3CODE_DEV_INSTANCE"],
            cause,
          }),
      ),
    );

    const { offset, source } = yield* resolveOffset({ portOffset, devInstance });

    const { serverOffset, webOffset } = yield* resolveModePortOffsets({
      mode: input.mode,
      startOffset: offset,
      hasExplicitServerPort: input.port !== undefined,
      hasExplicitDevUrl: input.devUrl !== undefined,
    });

    const hostEnvironment = yield* HostProcessEnvironment;
    const env = yield* createDevRunnerEnv({
      mode: input.mode,
      baseEnv: hostEnvironment,
      serverOffset,
      webOffset,
      t3Home: input.t3Home,
      browser: input.browser,
      autoBootstrapProjectFromCwd: input.autoBootstrapProjectFromCwd,
      logWebSocketEvents: input.logWebSocketEvents,
      host: input.host,
      port: input.port,
      devUrl: input.devUrl,
      tailscaleServe: input.tailscaleServe,
    });

    const selectionSuffix =
      serverOffset !== offset || webOffset !== offset
        ? ` selectedOffset(server=${serverOffset},web=${webOffset})`
        : "";
    const baseDir = env.T3CODE_HOME ?? (yield* DEFAULT_T3_HOME);

    yield* Effect.logInfo(
      `[dev-runner] mode=${input.mode} source=${source}${selectionSuffix} serverPort=${String(env.T3CODE_PORT)} webPort=${String(env.PORT)} baseDir=${baseDir}`,
    );

    // deriveServerPaths (apps/server/src/config.ts) picks `dev/` vs `userdata/`
    // from whether a dev URL is set, unless the base dir is explicit. `serve`
    // sets no dev URL, so without an explicit base dir it silently reads a
    // different SQLite database than `pnpm dev` does. Say so rather than let a
    // user wonder where their threads went.
    if (input.mode === "serve" && env.T3CODE_HOME === undefined) {
      yield* Effect.logWarning(
        `[dev-runner] serve mode has no explicit --home-dir/T3CODE_HOME, so it uses ${baseDir}/userdata — ` +
          `\`pnpm dev\` without one uses ${baseDir}/dev. Pass --home-dir to share a single data directory.`,
      );
    }

    if (input.dryRun) {
      return;
    }

    // Reap a stale dev tree for this same data directory before launching a new
    // one. Without this, killing only the previous dev-runner pid leaves its
    // `node --watch` watcher orphaned, respawning a server against this DB — the
    // source of duplicate/leaked dev servers. Same-home only: a runner on a
    // different --home-dir is a different DB and is left alone (its lock lives
    // under its own userdata). See scripts/lib/dev-process-guard.ts.
    const lockPath = DevProcessGuard.devRunnerLockPath(baseDir);
    const staleLock = yield* Effect.sync(() => {
      const existing = DevProcessGuard.readLock(lockPath);
      return existing === undefined ? undefined : DevProcessGuard.staleRunnerFromLock(existing);
    });
    if (staleLock !== undefined) {
      yield* Effect.logInfo(
        `[dev-runner] reaping stale dev tree pgid=${staleLock.pgid} pid=${staleLock.pid} for ${baseDir}`,
      );
      yield* Effect.promise(() => DevProcessGuard.reapProcessGroup(staleLock.pgid));
    }
    yield* Effect.sync(() =>
      DevProcessGuard.writeLock(lockPath, {
        pid: process.pid,
        pgid: DevProcessGuard.currentProcessGroupId(),
        homeDir: baseDir,
        startedAt: DevProcessGuard.nowIso(),
      }),
    );

    const spawnAndWait = (args: ReadonlyArray<string>, spawnEnv: NodeJS.ProcessEnv) =>
      Effect.gen(function* () {
        const spawnCommand = yield* resolveSpawnCommand("vp", args, { env: spawnEnv });
        const processContext = {
          mode: input.mode,
          executable: "vp" as const,
          argumentCount: spawnCommand.args.length,
          shell: spawnCommand.shell,
        } as const;
        const child = yield* ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
          env: spawnEnv,
          extendEnv: false,
          shell: spawnCommand.shell,
          // Keep Vite+ in the same process group so terminal signals (Ctrl+C)
          // reach it directly. Effect defaults to detached: true on non-Windows,
          // which would put the runner in a new group and require manual forwarding.
          detached: false,
          forceKillAfter: "1500 millis",
        }).pipe(
          Effect.mapError(
            (cause) =>
              new DevRunnerProcessError({
                ...processContext,
                operation: "spawn",
                cause,
              }),
          ),
        );

        const exitCode = yield* child.exitCode.pipe(
          Effect.mapError(
            (cause) =>
              new DevRunnerProcessError({
                ...processContext,
                operation: "wait-for-exit",
                cause,
              }),
          ),
        );
        if (exitCode !== 0) {
          return yield* new DevRunnerProcessExitError({
            ...processContext,
            exitCode,
          });
        }
      });

    const launch = Effect.gen(function* () {
      if (input.mode === "serve" && !input.skipBuild) {
        yield* Effect.logInfo("[dev-runner] building apps/web for static serving…");
        yield* spawnAndWait(SERVE_BUILD_ARGS, serveBuildEnv(env));
      }
      yield* spawnAndWait([...MODE_ARGS[input.mode], ...input.runArgs], env);
    });

    // Drop our lock whenever this launch ends — clean exit, error, or interrupt —
    // so a stale record never points a future launch at a pid we no longer own.
    yield* launch.pipe(Effect.ensuring(Effect.sync(() => DevProcessGuard.removeLock(lockPath))));
  });
}

const devRunnerCli = Command.make("dev-runner", {
  mode: Argument.choice("mode", DEV_RUNNER_MODES).pipe(
    Argument.withDescription("Development mode to run."),
  ),
  t3Home: Flag.string("home-dir").pipe(
    Flag.withDescription(
      "Explicit T3 Code data directory; runtime state is stored under userdata (equivalent to T3CODE_HOME).",
    ),
    Flag.withFallbackConfig(optionalStringConfig("T3CODE_HOME")),
  ),
  browser: Flag.boolean("browser").pipe(
    Flag.withDescription("Open a browser automatically (disabled by default for web dev)."),
  ),
  autoBootstrapProjectFromCwd: Flag.boolean("auto-bootstrap-project-from-cwd").pipe(
    Flag.withDescription(
      "Auto-bootstrap toggle (equivalent to T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD).",
    ),
    Flag.withFallbackConfig(optionalBooleanConfig("T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD")),
  ),
  logWebSocketEvents: Flag.boolean("log-websocket-events").pipe(
    Flag.withDescription("WebSocket event logging toggle (equivalent to T3CODE_LOG_WS_EVENTS)."),
    Flag.withAlias("log-ws-events"),
    Flag.withFallbackConfig(optionalBooleanConfig("T3CODE_LOG_WS_EVENTS")),
  ),
  host: Flag.string("host").pipe(
    Flag.withDescription("Server host/interface override (forwards to T3CODE_HOST)."),
    Flag.withFallbackConfig(optionalStringConfig("T3CODE_HOST")),
  ),
  port: Flag.integer("port").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
    Flag.withDescription("Server port override (forwards to T3CODE_PORT)."),
    Flag.withFallbackConfig(optionalPortConfig("T3CODE_PORT")),
  ),
  devUrl: Flag.string("dev-url").pipe(
    Flag.withSchema(Schema.URLFromString),
    Flag.withDescription(
      "Explicit web dev URL override (forwards to VITE_DEV_SERVER_URL). Ambient VITE_DEV_SERVER_URL values are ignored so a parent dev app cannot redirect the child runner.",
    ),
    Flag.optional,
    Flag.map(Option.getOrUndefined),
  ),
  dryRun: Flag.boolean("dry-run").pipe(
    Flag.withDescription("Resolve mode/ports/env and print, but do not spawn Vite+."),
    Flag.withDefault(false),
  ),
  tailscaleServe: Flag.boolean("tailscale-serve").pipe(
    Flag.withDescription(
      "Point Tailscale Serve at this server's port (forwards to T3CODE_TAILSCALE_SERVE). Use with `serve` so the tailnet origin carries app, /api, and /ws together.",
    ),
    Flag.withFallbackConfig(optionalBooleanConfig("T3CODE_TAILSCALE_SERVE")),
  ),
  skipBuild: Flag.boolean("skip-build").pipe(
    Flag.withDescription(
      "In `serve` mode, start the server against the existing apps/web/dist instead of rebuilding first.",
    ),
    Flag.withDefault(false),
  ),
  runArgs: Argument.string("run-arg").pipe(
    Argument.withDescription("Additional Vite+ run args (pass after `--`)."),
    Argument.variadic(),
  ),
}).pipe(
  Command.withDescription("Run monorepo development modes with deterministic port/env wiring."),
  Command.withHandler((input) => runDevRunnerWithInput(input)),
);

const cliRuntimeLayer = Layer.mergeAll(
  Logger.layer([Logger.consolePretty()]),
  NodeServices.layer,
  NetService.layer,
);

if (import.meta.main) {
  Command.run(devRunnerCli, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(cliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
