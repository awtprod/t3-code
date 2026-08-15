import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as NetService from "@t3tools/shared/Net";
import * as Crypto from "effect/Crypto";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import { installDesktopIpcHandlers } from "../ipc/DesktopIpcHandlers.ts";
import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";
import * as DesktopClerk from "./DesktopClerk.ts";
import * as DesktopApplicationMenu from "../window/DesktopApplicationMenu.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopLinuxUrlHandler from "./DesktopLinuxUrlHandler.ts";
import * as DesktopObservability from "./DesktopObservability.ts";
import * as DesktopPreReadyPlatform from "./DesktopPreReadyPlatform.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopWslBackend from "../wsl/DesktopWslBackend.ts";
import { waitForHttpReady } from "@t3tools/shared/httpReadiness";

const DEFAULT_DESKTOP_BACKEND_PORT = 3773;
const MAX_TCP_PORT = 65_535;
const DESKTOP_BACKEND_PORT_PROBE_HOSTS = ["127.0.0.1", "0.0.0.0", "::"] as const;

const makeDesktopRunId = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.map((value) => value.replaceAll("-", "").slice(0, 12)),
);

export class DesktopBackendPortUnavailableError extends Schema.TaggedErrorClass<DesktopBackendPortUnavailableError>()(
  "DesktopBackendPortUnavailableError",
  {
    startPort: Schema.Int,
    maxPort: Schema.Int,
    hosts: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `No desktop backend port is available on hosts ${this.hosts.join(", ")} between ${this.startPort} and ${this.maxPort}.`;
  }
}

export class DesktopDevelopmentBackendPortRequiredError extends Schema.TaggedErrorClass<DesktopDevelopmentBackendPortRequiredError>()(
  "DesktopDevelopmentBackendPortRequiredError",
  {},
) {
  override get message(): string {
    return "T3CODE_PORT is required in desktop development.";
  }
}

export class DesktopRemoteBackendUnavailableError extends Schema.TaggedErrorClass<DesktopRemoteBackendUnavailableError>()(
  "DesktopRemoteBackendUnavailableError",
  { endpoint: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Remote Command Center is unavailable at ${this.endpoint}.`;
  }
}

const { logInfo: logBootstrapInfo, logWarning: logBootstrapWarning } =
  DesktopObservability.makeComponentLogger("desktop-bootstrap");

const { logInfo: logStartupInfo, logError: logStartupError } =
  DesktopObservability.makeComponentLogger("desktop-startup");

const resolveDesktopBackendPort = Effect.fn("resolveDesktopBackendPort")(function* (
  configuredPort: Option.Option<number>,
) {
  if (Option.isSome(configuredPort)) {
    return {
      port: configuredPort.value,
      selectedByScan: false,
    } as const;
  }

  const net = yield* NetService.NetService;
  for (let port = DEFAULT_DESKTOP_BACKEND_PORT; port <= MAX_TCP_PORT; port += 1) {
    let availableOnEveryHost = true;

    for (const host of DESKTOP_BACKEND_PORT_PROBE_HOSTS) {
      if (!(yield* net.canListenOnHost(port, host))) {
        availableOnEveryHost = false;
        break;
      }
    }

    if (availableOnEveryHost) {
      return {
        port,
        selectedByScan: true,
      } as const;
    }
  }

  return yield* new DesktopBackendPortUnavailableError({
    startPort: DEFAULT_DESKTOP_BACKEND_PORT,
    maxPort: MAX_TCP_PORT,
    hosts: DESKTOP_BACKEND_PORT_PROBE_HOSTS,
  });
});

const handleFatalStartupError = Effect.fn("desktop.startup.handleFatalStartupError")(function* (
  stage: string,
  error: unknown,
): Effect.fn.Return<
  void,
  never,
  | DesktopShutdown.DesktopShutdown
  | DesktopState.DesktopState
  | ElectronApp.ElectronApp
  | ElectronDialog.ElectronDialog
> {
  const shutdown = yield* DesktopShutdown.DesktopShutdown;
  const state = yield* DesktopState.DesktopState;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const message = error instanceof Error ? error.message : String(error);
  const detail =
    error instanceof Error && typeof error.stack === "string" ? `\n${error.stack}` : "";
  yield* logStartupError("fatal startup error", {
    stage,
    message,
    ...(detail.length > 0 ? { detail } : {}),
  });
  const wasQuitting = yield* Ref.getAndSet(state.quitting, true);
  if (!wasQuitting) {
    yield* electronDialog.showErrorBox(
      "Command Center failed to start",
      `Stage: ${stage}\n${message}${detail}`,
    );
  }
  yield* shutdown.request;
  yield* electronApp.quit;
});

const fatalStartupCause = <E>(stage: string, cause: Cause.Cause<E>) =>
  handleFatalStartupError(stage, Cause.pretty(cause)).pipe(Effect.andThen(Effect.failCause(cause)));

type RemoteRecoveryAction =
  | { readonly action: "retry" | "local" | "quit" }
  | { readonly action: "edit"; readonly endpoint: string };

function remoteRecoveryHtml(endpoint: string, detail: string): string {
  const escape = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="dark light"><style>
body{font:14px system-ui;margin:0;padding:28px;background:#151515;color:#f4f4f4}main{max-width:560px;margin:auto}h1{font-size:22px}p{line-height:1.5;color:#c9c9c9}code{word-break:break-all}input{box-sizing:border-box;width:100%;padding:10px;margin:8px 0 16px;border:1px solid #555;border-radius:6px;background:#222;color:#fff}.actions{display:flex;gap:8px;flex-wrap:wrap}a,button{display:inline-block;padding:9px 13px;border:1px solid #666;border-radius:6px;background:#292929;color:#fff;text-decoration:none;cursor:pointer}.primary{background:#1769e0;border-color:#1769e0}.warning{background:#8a4b08;border-color:#a65d0b}.detail{font-size:12px;color:#999}</style></head><body><main>
<h1>Remote Command Center is unavailable</h1><p>Windows local execution has not been started. Retry the Linux server, edit its endpoint, intentionally start Windows execution for this launch, or quit.</p>
<p class="detail">${escape(detail)}</p>
<form action="commandcenter-recovery://edit" method="get"><label for="endpoint">Remote endpoint</label><input id="endpoint" name="endpoint" type="url" required value="${escape(endpoint)}"><div class="actions"><a class="primary" href="commandcenter-recovery://retry/">Retry</a><button type="submit">Save endpoint and retry</button><a class="warning" href="commandcenter-recovery://local/">Start local for this launch</a><a href="commandcenter-recovery://quit/">Quit</a></div></form>
</main></body></html>`;
}

const showRemoteRecovery = Effect.fn("desktop.startup.showRemoteRecovery")(function* (
  endpoint: string,
  detail: string,
) {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const recoveryWindow = yield* electronWindow.create({
    width: 640,
    height: 390,
    resizable: false,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    center: true,
    show: false,
    title: "Command Center recovery",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  return yield* Effect.tryPromise({
    try: () =>
      new Promise<RemoteRecoveryAction>((resolve) => {
        let settled = false;
        const finish = (action: RemoteRecoveryAction) => {
          if (settled) return;
          settled = true;
          if (!recoveryWindow.isDestroyed()) recoveryWindow.close();
          resolve(action);
        };
        recoveryWindow.webContents.on("will-navigate", (event, target) => {
          const url = new URL(target);
          if (url.protocol !== "commandcenter-recovery:") return;
          event.preventDefault();
          if (url.hostname === "edit") {
            finish({ action: "edit", endpoint: url.searchParams.get("endpoint") ?? "" });
          } else if (
            url.hostname === "retry" ||
            url.hostname === "local" ||
            url.hostname === "quit"
          ) {
            finish({ action: url.hostname });
          }
        });
        recoveryWindow.once("closed", () => finish({ action: "quit" }));
        recoveryWindow.once("ready-to-show", () => recoveryWindow.show());
        void recoveryWindow.loadURL(
          `data:text/html;charset=utf-8,${encodeURIComponent(remoteRecoveryHtml(endpoint, detail))}`,
        );
      }),
    catch: (cause) => new DesktopRemoteBackendUnavailableError({ endpoint, cause }),
  });
});

const bootstrap = Effect.gen(function* () {
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const state = yield* DesktopState.DesktopState;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
  const wslBackend = yield* DesktopWslBackend.DesktopWslBackend;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* logBootstrapInfo("bootstrap start");

  if (environment.remoteOnlyBuild) {
    const electronProtocol = yield* ElectronProtocol.ElectronProtocol;
    yield* installDesktopIpcHandlers();
    const staticClientOrigin = new URL("https://remote-only-client.invalid/");
    yield* electronProtocol.registerDesktopProtocol({
      scheme: ElectronProtocol.getDesktopScheme(environment.isDevelopment),
      targetOrigin: staticClientOrigin,
      backendOrigin: staticClientOrigin,
      clerkFrontendApiHostname: DesktopClerk.desktopClerkFrontendApiHostname,
      staticClientRoot: environment.localClientRoot,
    });
    yield* logBootstrapInfo("bootstrap remote-only shell ready");
    yield* desktopWindow.handleBackendReady(staticClientOrigin);
    return;
  }

  const settings = yield* desktopSettings.get;
  const startupPlan = DesktopAppSettings.resolveDesktopStartupPlan(settings);
  if (startupPlan.remoteOnly) {
    let normalizedRemoteUrl = DesktopAppSettings.normalizeRemoteBackendUrl(
      settings.remoteBackendUrl,
    );
    const electronProtocol = yield* ElectronProtocol.ElectronProtocol;
    yield* installDesktopIpcHandlers();
    if (!(yield* Ref.get(state.quitting))) {
      yield* desktopWindow.showConnectingSplash;
      while (true) {
        const recoveryEndpoint = normalizedRemoteUrl ?? settings.remoteBackendUrl ?? "";
        const readiness =
          normalizedRemoteUrl === null
            ? Result.fail(
                new DesktopRemoteBackendUnavailableError({
                  endpoint: recoveryEndpoint,
                  cause: "A valid HTTP or HTTPS endpoint is required.",
                }),
              )
            : yield* Effect.result(
                waitForHttpReady({
                  baseUrl: normalizedRemoteUrl,
                  path: "/.well-known/t3/environment",
                  timeoutMs: 15_000,
                  intervalMs: 500,
                  probeTimeoutMs: 2_000,
                  makeError: ({ cause }) =>
                    new DesktopRemoteBackendUnavailableError({
                      endpoint: normalizedRemoteUrl!,
                      cause,
                    }),
                }),
              );
        if (Result.isSuccess(readiness)) {
          if (normalizedRemoteUrl !== null) break;
          continue;
        }
        const recovery = yield* showRemoteRecovery(recoveryEndpoint, readiness.failure.message);
        if (recovery.action === "retry") continue;
        if (recovery.action === "edit") {
          const edited = DesktopAppSettings.normalizeRemoteBackendUrl(recovery.endpoint);
          if (edited === null) continue;
          normalizedRemoteUrl = edited;
          yield* desktopSettings.setPrimaryBackend({
            mode: "remote",
            remoteBackendUrl: edited,
          });
          continue;
        }
        if (recovery.action === "local") {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.relaunch("local-execution-once", ["--local-execution-once"]);
          return;
        }
        const electronApp = yield* ElectronApp.ElectronApp;
        const shutdown = yield* DesktopShutdown.DesktopShutdown;
        yield* shutdown.request;
        yield* electronApp.quit;
        return;
      }
      const remoteHttpBaseUrl = new URL(
        Option.getOrThrow(Option.fromNullishOr(normalizedRemoteUrl)),
      );
      const rendererTarget = environment.isDevelopment
        ? Option.getOrThrow(environment.devServerUrl)
        : remoteHttpBaseUrl;
      yield* electronProtocol.registerDesktopProtocol({
        scheme: ElectronProtocol.getDesktopScheme(environment.isDevelopment),
        targetOrigin: rendererTarget,
        backendOrigin: remoteHttpBaseUrl,
        clerkFrontendApiHostname: DesktopClerk.desktopClerkFrontendApiHostname,
      });
      yield* logBootstrapInfo("bootstrap remote-only endpoint ready", {
        baseUrl: remoteHttpBaseUrl.href,
      });
      yield* desktopWindow.handleBackendReady(remoteHttpBaseUrl);

      // Keep the native Windows backend available as a secondary environment
      // while the remote server remains the renderer's primary backend.
      const localBackend = yield* pool.get(DesktopBackendPool.WINDOWS_SECONDARY_INSTANCE_ID);
      if (Option.isSome(localBackend)) {
        const backendPortSelection = yield* resolveDesktopBackendPort(
          environment.configuredBackendPort,
        );
        yield* serverExposure.configureFromSettings({ port: backendPortSelection.port });
        yield* localBackend.value.start;
        yield* logBootstrapInfo("bootstrap Windows secondary start requested", {
          port: backendPortSelection.port,
        });
      }
    }
    return;
  }

  const primaryBackend = Option.getOrThrow(yield* pool.primary);

  if (environment.isDevelopment && Option.isNone(environment.configuredBackendPort)) {
    return yield* new DesktopDevelopmentBackendPortRequiredError();
  }

  const backendPortSelection = yield* resolveDesktopBackendPort(environment.configuredBackendPort);
  const backendPort = backendPortSelection.port;
  yield* logBootstrapInfo(
    backendPortSelection.selectedByScan
      ? "selected backend port via sequential scan"
      : "using configured backend port",
    {
      port: backendPort,
      ...(backendPortSelection.selectedByScan ? { startPort: DEFAULT_DESKTOP_BACKEND_PORT } : {}),
    },
  );

  if (settings.serverExposureMode !== environment.defaultDesktopSettings.serverExposureMode) {
    yield* logBootstrapInfo("bootstrap restoring persisted server exposure mode", {
      mode: settings.serverExposureMode,
    });
  }
  const serverExposureState = yield* serverExposure.configureFromSettings({ port: backendPort });
  const backendConfig = yield* serverExposure.backendConfig;
  const electronProtocol = yield* ElectronProtocol.ElectronProtocol;
  const rendererTarget = environment.isDevelopment
    ? Option.getOrThrow(environment.devServerUrl)
    : backendConfig.httpBaseUrl;
  yield* electronProtocol.registerDesktopProtocol({
    scheme: ElectronProtocol.getDesktopScheme(environment.isDevelopment),
    targetOrigin: rendererTarget,
    backendOrigin: backendConfig.httpBaseUrl,
    clerkFrontendApiHostname: DesktopClerk.desktopClerkFrontendApiHostname,
  });
  yield* logBootstrapInfo("bootstrap resolved backend endpoint", {
    baseUrl: backendConfig.httpBaseUrl.href,
  });
  if (serverExposureState.endpointUrl) {
    yield* logBootstrapInfo("bootstrap enabled network access", {
      endpointUrl: serverExposureState.endpointUrl,
    });
  } else if (settings.serverExposureMode === "network-accessible") {
    yield* logBootstrapWarning(
      "bootstrap fell back to local-only because no advertised network host was available",
    );
  }

  yield* installDesktopIpcHandlers();
  yield* logBootstrapInfo("bootstrap ipc handlers registered");

  if (!(yield* Ref.get(state.quitting))) {
    // In wsl-only mode the renderer is served by the WSL backend, which can be
    // slow to cold-boot — show a "Connecting to WSL" splash immediately so the
    // app feels responsive instead of presenting no window until WSL is ready.
    // (Dual mode opens fast off the Windows primary, so no splash there.)
    if (settings.wslOnly === true && settings.wslBackendEnabled === true) {
      yield* desktopWindow.showConnectingSplash;
    }
    yield* primaryBackend.start;
    yield* logBootstrapInfo("bootstrap backend start requested");
    // Bring up the WSL backend if the user previously enabled it. The
    // primary is already starting; reconcile fires off the WSL register
    // in parallel rather than blocking primary readiness on a possibly
    // slow first wsl.exe spawn.
    yield* Effect.forkScoped(wslBackend.reconcile);
  }
}).pipe(Effect.withSpan("desktop.bootstrap"));

const startup = Effect.gen(function* () {
  const appIdentity = yield* DesktopAppIdentity.DesktopAppIdentity;
  const applicationMenu = yield* DesktopApplicationMenu.DesktopApplicationMenu;
  const electronApp = yield* ElectronApp.ElectronApp;
  const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
  const linuxUrlHandler = yield* DesktopLinuxUrlHandler.DesktopLinuxUrlHandler;
  const clerk = yield* DesktopClerk.DesktopClerk;
  const shellEnvironment = yield* DesktopShellEnvironment.DesktopShellEnvironment;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const preReadyElectronOptions = yield* DesktopPreReadyPlatform.DesktopPreReadyElectronOptions;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;

  const settings = yield* desktopSettings.load;
  const startupPlan = DesktopAppSettings.resolveDesktopStartupPlan(settings);
  if (!environment.remoteOnlyBuild && !startupPlan.remoteOnly) {
    yield* shellEnvironment.installIntoProcess;
  }
  const hasCommandLinePasswordStore =
    preReadyElectronOptions.linuxPasswordStoreCommandLine !== null;
  const linuxElectronOptions =
    environment.platform === "linux" && !hasCommandLinePasswordStore
      ? DesktopPreReadyPlatform.resolveEarlyLinuxElectronOptionsFromProcess()
      : preReadyElectronOptions.linux;
  if (linuxElectronOptions !== null && !hasCommandLinePasswordStore) {
    if (
      linuxElectronOptions.passwordStore !== null ||
      preReadyElectronOptions.linux?.passwordStore !== null
    ) {
      yield* electronApp.removeCommandLineSwitch("password-store");
    }
    if (linuxElectronOptions.passwordStore !== null) {
      yield* electronApp.appendCommandLineSwitch(
        "password-store",
        linuxElectronOptions.passwordStore,
      );
    }
  }
  const userDataPath = yield* appIdentity.resolveUserDataPath;
  yield* electronApp.setPath("userData", userDataPath);
  yield* logStartupInfo("runtime logging configured", { logDir: environment.logDir });

  if (linuxElectronOptions !== null) {
    yield* logStartupInfo("linux password store configured", {
      passwordStore: hasCommandLinePasswordStore
        ? "command-line"
        : (linuxElectronOptions.passwordStore ?? "electron-default"),
      xdgCurrentDesktop: process.env.XDG_CURRENT_DESKTOP ?? null,
      xdgSessionDesktop: process.env.XDG_SESSION_DESKTOP ?? null,
    });
  }

  yield* appIdentity.configure;
  yield* lifecycle.register;
  yield* clerk.configure;

  yield* electronApp.whenReady.pipe(
    Effect.withSpan("desktop.electron.whenReady"),
    Effect.catchCause((cause) => fatalStartupCause("whenReady", cause)),
  );
  yield* logStartupInfo("app ready");
  if (environment.platform === "linux") {
    const selectedBackend = yield* safeStorage.selectedStorageBackend;
    yield* logStartupInfo("safe storage ready", {
      backend: Option.getOrElse(selectedBackend, () => "unknown"),
    });
  }
  yield* appIdentity.configure;
  yield* applicationMenu.configure;
  yield* updates.configure;
  yield* linuxUrlHandler.register;
  yield* bootstrap.pipe(Effect.catchCause((cause) => fatalStartupCause("bootstrap", cause)));
}).pipe(Effect.withSpan("desktop.startup"));

const scopedProgram = Effect.scoped(
  Effect.gen(function* () {
    const runId = yield* makeDesktopRunId;
    yield* Effect.annotateLogsScoped({ scope: "desktop", runId });
    yield* Effect.annotateCurrentSpan({ scope: "desktop", runId });

    const shutdown = yield* DesktopShutdown.DesktopShutdown;

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const pool = yield* DesktopBackendPool.DesktopBackendPool;
        // Stop every backend in the pool, not just the primary. The
        // electronApp.quit() path can race ahead of the layer-scope
        // cascade, so leaving the WSL instance for its parent scope
        // finalizer means it gets hard-killed by the OS instead of
        // receiving SIGTERM + grace. Stops run concurrently.
        const instances = yield* pool.list;
        yield* Effect.forEach(instances, (instance) => instance.stop(), {
          concurrency: "unbounded",
        });
      }).pipe(Effect.ensuring(shutdown.markComplete)),
    );

    yield* startup;
    yield* shutdown.awaitRequest;
  }),
);

export const program = scopedProgram.pipe(Effect.withSpan("desktop.app"));
