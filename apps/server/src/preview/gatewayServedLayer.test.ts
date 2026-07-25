/**
 * Regression coverage for the preview gateway's router isolation.
 *
 * A live boot with `--preview-gateway` died at startup with
 * `Method 'GET' already declared for route '/*'`. `HttpRouter.serve` builds its
 * router from the module-level `HttpRouter.layer`, layers are memoized by
 * identity within a single build, and so the gateway's catch-all was registered
 * into the *main app's* router next to the app's own catch-all. A control boot
 * without the flag started clean, which is what pinned it on the gateway.
 *
 * `./gatewayRoute.test.ts` could not catch this and still cannot: it builds the
 * gateway on its own, and with only one router in the build there is nothing to
 * collide with. The property here needs two routers in one build, which is what
 * `makeServerLayer` does and what these tests reproduce.
 */

// @effect-diagnostics nodeBuiltinImport:off - this test binds real listeners to
// prove two routers can coexist, which needs the Node server the app itself uses.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { PREVIEW_GATEWAY_SELECT_PATH } from "@t3tools/shared/previewGateway";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import {
  FetchHttpClient,
  HttpClient,
  HttpRouter,
  HttpServer,
  HttpServerResponse,
} from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makePreviewGatewayServedLayer } from "../server.ts";

/**
 * A stand-in for the main app's router: one catch-all, which is the only thing
 * about `makeRoutesLayer` that participates in the collision. Building the real
 * one needs a dozen mocked services (`server.test.ts`'s `buildAppUnderTest`),
 * none of which would make the assertion stronger.
 */
const APP_RESPONSE_BODY = "main-app-router";
const appRouterLayer = HttpRouter.add("*", "/*", HttpServerResponse.text(APP_RESPONSE_BODY));

/**
 * A distinct listener layer per call.
 *
 * Reusing one layer *value* for both servers would reintroduce the same
 * memoization sharing at the listener instead of the router — and production
 * has two distinct values (`HttpServerLive`, `PreviewGatewayHttpServerLive`),
 * so a factory is what actually mirrors it.
 */
const makeEphemeralHttpServerLayer = () =>
  NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 });

/** The same listener, plus a hook to read back the port it bound. */
const makePortCapturingHttpServerLayer = (capture: (port: number) => void) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      capture((server.address as HttpServer.TcpAddress).port);
    }),
  ).pipe(Layer.provideMerge(makeEphemeralHttpServerLayer()));

const buildBothRoutersUnderTest = Effect.fnUntraced(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-gateway-served-" });
  const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
  yield* ServerConfig.ensureServerDirectories(derivedPaths);

  const config: ServerConfig.ServerConfig["Service"] = {
    logLevel: "Error",
    traceMinLevel: "Info",
    traceTimingEnabled: false,
    traceBatchWindowMs: 200,
    traceMaxBytes: 10 * 1024 * 1024,
    traceMaxFiles: 10,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpExportIntervalMs: 10_000,
    otlpServiceName: "t3-server",
    mode: "web",
    port: 0,
    host: "127.0.0.1",
    cwd: process.cwd(),
    baseDir,
    ...derivedPaths,
    staticDir: undefined,
    devUrl: undefined,
    noBrowser: true,
    startupPresentation: "browser",
    desktopBootstrapToken: undefined,
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
    previewGatewayEnabled: true,
    previewGatewayPort: 0,
    previewGatewayServePort: 8445,
  };

  const dependenciesLayer = Layer.mergeAll(
    EnvironmentAuth.layer.pipe(Layer.provide(SqlitePersistenceMemory)),
    FetchHttpClient.layer,
  ).pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(ServerConfig.layer(config)),
  );

  let appPort = 0;
  let gatewayPort = 0;

  // The shape under test. `Layer.mergeAll` of two served routers over shared
  // dependencies is exactly `serverApplicationLayer` in `server.ts`, minus the
  // services that have no bearing on routing.
  const combined = Layer.mergeAll(
    HttpRouter.serve(appRouterLayer, { disableListenLog: true, disableLogger: true }),
    makePreviewGatewayServedLayer(
      makePortCapturingHttpServerLayer((port) => {
        gatewayPort = port;
      }),
    ),
  ).pipe(
    Layer.provideMerge(
      makePortCapturingHttpServerLayer((port) => {
        appPort = port;
      }),
    ),
    Layer.provideMerge(dependenciesLayer),
  );

  // Building is itself part of the assertion: before `Layer.fresh` this failed
  // here with `Method 'GET' already declared for route '/*'`.
  yield* Layer.build(combined);

  assert.notEqual(appPort, 0);
  assert.notEqual(gatewayPort, 0);
  assert.notEqual(appPort, gatewayPort);

  return { appPort, gatewayPort } as const;
});

/**
 * Absolute-URL GET against one of the two listeners.
 *
 * Redirects stay unfollowed so a 3xx from the gateway's select route is visible
 * as itself rather than as whatever it points at.
 */
const get = Effect.fnUntraced(function* (port: number, path: string) {
  const response = yield* HttpClient.get(`http://127.0.0.1:${port}${path}`).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
  );
  return { status: response.status, body: yield* response.text } as const;
});

it.layer(NodeServices.layer)("preview gateway served layer", (it) => {
  it.effect("builds alongside the main app's router instead of colliding with it", () =>
    Effect.gen(function* () {
      const { appPort, gatewayPort } = yield* buildBothRoutersUnderTest();

      // Each listener answers `/` with its own router's handler. Same path, two
      // different answers, so neither router swallowed the other.
      const app = yield* get(appPort, "/");
      assert.equal(app.status, 200);
      assert.equal(app.body, APP_RESPONSE_BODY);

      // 401 rather than 200: the gateway's proxy route ran and rejected an
      // unauthenticated request, which the app's catch-all would never do.
      const gateway = yield* get(gatewayPort, "/");
      assert.equal(gateway.status, 401);
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  );

  it.effect("keeps the gateway's routes off the main app's listener", () =>
    Effect.gen(function* () {
      const { appPort, gatewayPort } = yield* buildBothRoutersUnderTest();

      // The inverse of the bug: if the gateway registered into the app's router,
      // its select route would answer here — with a 401, not the app's body.
      const leaked = yield* get(appPort, `${PREVIEW_GATEWAY_SELECT_PATH}?port=45678`);
      assert.equal(leaked.status, 200);
      assert.equal(leaked.body, APP_RESPONSE_BODY);

      // And the route does exist on the gateway, so the assertion above is about
      // where it is mounted rather than about it having been dropped entirely.
      const served = yield* get(gatewayPort, `${PREVIEW_GATEWAY_SELECT_PATH}?port=45678`);
      assert.equal(served.status, 401);
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  );
});
