/**
 * Regression coverage for the preview gateway's router isolation: layers are
 * memoized by identity within one build, so the gateway's catch-all landed in the
 * main app's router ("Method 'GET' already declared for route '/*'"). The property
 * needs two routers in one build, as `makeServerLayer` has, so these tests build both.
 */

// @effect-diagnostics nodeBuiltinImport:off - this test binds real listeners to
// prove two routers can coexist, which needs the Node server the app itself uses.
import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
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
} from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import { makePreviewGatewayServedLayer } from "../server.ts";

/**
 * A stand-in for the main app's router: one catch-all, the only part of
 * `makeRoutesLayer` that participates in the collision. The real one needs a
 * dozen mocked services and would not make the assertion stronger.
 */
const APP_RESPONSE_BODY = "main-app-router";
const appRouterLayer = HttpRouter.add("*", "/*", HttpServerResponse.text(APP_RESPONSE_BODY));

/**
 * A distinct listener layer per call: reusing one layer value for both servers
 * would reintroduce the memoization sharing at the listener, and production has
 * two distinct values, so a factory is what mirrors it.
 */
const makeEphemeralHttpServerLayer = () =>
  NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 });

/** The same listener, plus a hook to read back the port it bound. */
const makePortCapturingHttpServerLayer = (capture: (port: number) => void) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      capture((server.address as { readonly port: number }).port);
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
    otlpLogsUrl: undefined,
    otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
    otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
    otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
    otelEnvironment: OtelEnvironment.none,
    mode: "web",
    port: 0,
    host: "127.0.0.1",
    cwd: process.cwd(),
    baseDir,
    ...derivedPaths,
    staticDir: undefined,
    devUrl: undefined,
    devAllowedOrigins: [],
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
    // Upstream scopes session credentials to the environment; this served-layer
    // test never boots a real ServerEnvironment, so pin a fixed id.
    Layer.provideMerge(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("preview-gateway-served-test")),
      }),
    ),
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
