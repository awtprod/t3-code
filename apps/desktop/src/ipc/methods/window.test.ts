import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type * as Electron from "electron";

import * as DesktopBackendManager from "../../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import { getLocalEnvironmentBootstraps, getWindowFullscreenState } from "./window.ts";

const readyWslConfig: DesktopBackendManager.DesktopBackendStartConfig = {
  executablePath: "wsl.exe",
  args: ["-d", "Ubuntu", "--", "node", "/app/bin.mjs"],
  entryPath: "/app/bin.mjs",
  cwd: "/app",
  env: {},
  extendEnv: false,
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3774,
    host: "0.0.0.0",
    desktopBootstrapToken: "bootstrap-token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  bootstrapDelivery: "stdin",
  httpBaseUrl: new URL("http://127.0.0.1:3774"),
  captureOutput: true,
  preflightFailure: Option.none(),
  runningDistro: "Ubuntu",
};

const defaultWslInstance: DesktopBackendManager.DesktopBackendInstance = {
  id: DesktopBackendManager.BackendInstanceId("wsl:default"),
  label: Effect.succeed("WSL (default distro)"),
  start: Effect.void,
  stop: () => Effect.void,
  currentConfig: Effect.succeed(Option.some(readyWslConfig)),
  snapshot: Effect.succeed({
    desiredRunning: true,
    ready: true,
    activePid: Option.some(123),
    restartAttempt: 0,
    restartScheduled: false,
  }),
  waitForReady: () => Effect.succeed(true),
};

const { runningDistro: _runningDistro, ...readyConfigWithoutDistro } = readyWslConfig;
const windowsSecondaryInstance: DesktopBackendManager.DesktopBackendInstance = {
  ...defaultWslInstance,
  id: DesktopBackendPool.WINDOWS_SECONDARY_INSTANCE_ID,
  label: Effect.succeed("Windows"),
  currentConfig: Effect.succeed(
    Option.some({
      ...readyConfigWithoutDistro,
      executablePath: "electron.exe",
      args: ["server.mjs"],
      entryPath: "server.mjs",
      bootstrap: {
        ...readyWslConfig.bootstrap,
        port: 3773,
        host: "127.0.0.1",
      },
      httpBaseUrl: new URL("http://127.0.0.1:3773"),
    }),
  ),
};

const desktopSettingsLayer = Layer.succeed(DesktopAppSettings.DesktopAppSettings, {
  get: Effect.succeed(DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS),
} as unknown as DesktopAppSettings.DesktopAppSettings["Service"]);

const withDesktopSettings = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(desktopSettingsLayer));

describe("getLocalEnvironmentBootstraps", () => {
  it.effect("synthesizes the remote primary bootstrap from settings with an empty pool", () => {
    const remoteSettingsLayer = Layer.succeed(DesktopAppSettings.DesktopAppSettings, {
      get: Effect.succeed({
        ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
        primaryBackendMode: "remote",
        remoteBackendUrl: "https://remote.example.test/base/",
      }),
    } as unknown as DesktopAppSettings.DesktopAppSettings["Service"]);
    return Effect.gen(function* () {
      assert.deepEqual(yield* getLocalEnvironmentBootstraps.handler(), [
        {
          id: "primary",
          label: "remote.example.test",
          runningDistro: null,
          httpBaseUrl: "https://remote.example.test/base/",
          wsBaseUrl: "wss://remote.example.test/base/",
        },
      ]);
    }).pipe(Effect.provide(Layer.merge(DesktopBackendPool.layerTest([]), remoteSettingsLayer)));
  });

  it.effect("publishes Windows as a secondary while the remote server remains primary", () => {
    const remoteSettingsLayer = Layer.succeed(DesktopAppSettings.DesktopAppSettings, {
      get: Effect.succeed({
        ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
        primaryBackendMode: "remote",
        remoteBackendUrl: "https://remote.example.test/",
      }),
    } as unknown as DesktopAppSettings.DesktopAppSettings["Service"]);
    return Effect.gen(function* () {
      assert.deepEqual(yield* getLocalEnvironmentBootstraps.handler(), [
        {
          id: "primary",
          label: "remote.example.test",
          runningDistro: null,
          httpBaseUrl: "https://remote.example.test/",
          wsBaseUrl: "wss://remote.example.test/",
        },
        {
          id: "windows:local",
          label: "Windows",
          runningDistro: null,
          httpBaseUrl: "http://127.0.0.1:3773/",
          wsBaseUrl: "ws://127.0.0.1:3773/",
          bootstrapToken: "bootstrap-token",
        },
      ]);
    }).pipe(
      Effect.provide(
        Layer.merge(DesktopBackendPool.layerTest([windowsSecondaryInstance]), remoteSettingsLayer),
      ),
    );
  });

  it.effect("publishes the concrete running distro without replacing the stable instance id", () =>
    Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();

      assert.deepEqual(result, [
        {
          id: "wsl:default",
          label: "WSL (Ubuntu)",
          runningDistro: "Ubuntu",
          httpBaseUrl: "http://127.0.0.1:3774/",
          wsBaseUrl: "ws://127.0.0.1:3774/",
          bootstrapToken: "bootstrap-token",
        },
      ]);
    }).pipe(
      Effect.provide(DesktopBackendPool.layerTest([defaultWslInstance])),
      withDesktopSettings,
    ),
  );

  it.effect("publishes a pending bootstrap only while a transient retry is scheduled", () => {
    const retryingConfig: DesktopBackendManager.DesktopBackendStartConfig = {
      ...readyWslConfig,
      preflightFailure: Option.some({
        reason: "WSL probe timed out",
        fatal: false,
        retryLimit: 12,
      }),
    };
    const retryingInstance: DesktopBackendManager.DesktopBackendInstance = {
      ...defaultWslInstance,
      currentConfig: Effect.succeed(Option.some(retryingConfig)),
      snapshot: Effect.succeed({
        desiredRunning: true,
        ready: false,
        activePid: Option.none(),
        restartAttempt: 2,
        restartScheduled: true,
      }),
    };

    return Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();
      assert.deepEqual(result, [
        {
          id: "wsl:default",
          label: "WSL (default distro)",
          runningDistro: null,
          httpBaseUrl: null,
          wsBaseUrl: null,
        },
      ]);
    }).pipe(Effect.provide(DesktopBackendPool.layerTest([retryingInstance])), withDesktopSettings);
  });

  it.effect("omits a bounded transient bootstrap after retries stop", () => {
    const stoppedInstance: DesktopBackendManager.DesktopBackendInstance = {
      ...defaultWslInstance,
      currentConfig: Effect.succeed(
        Option.some({
          ...readyWslConfig,
          preflightFailure: Option.some({
            reason: "WSL probe timed out",
            fatal: false,
            retryLimit: 12,
          }),
        }),
      ),
      snapshot: Effect.succeed({
        desiredRunning: false,
        ready: false,
        activePid: Option.none(),
        restartAttempt: 12,
        restartScheduled: false,
      }),
    };

    return Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();
      assert.deepEqual(result, []);
    }).pipe(Effect.provide(DesktopBackendPool.layerTest([stoppedInstance])), withDesktopSettings);
  });
});

describe("getWindowFullscreenState", () => {
  it.effect("reads the current native window state", () => {
    const window = { isFullScreen: () => true } as Electron.BrowserWindow;

    return Effect.gen(function* () {
      assert.isTrue(yield* getWindowFullscreenState.handler());
    }).pipe(
      Effect.provide(
        Layer.mock(ElectronWindow.ElectronWindow)({
          currentMainOrFirst: Effect.succeed(Option.some(window)),
        }),
      ),
    );
  });
});
