import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";

import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import {
  PREVIEW_GATEWAY_PORT_PARAM,
  PREVIEW_GATEWAY_REDIRECT_PARAM,
  PREVIEW_GATEWAY_SELECT_PATH,
} from "@t3tools/shared/previewGateway";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http";
import * as Cookies from "effect/unstable/http/Cookies";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";

import { makePreviewGatewayRoutesLayer } from "./gatewayRoute.ts";

/**
 * A stand-in for the dev server behind the gateway.
 *
 * It records what it actually received, which is how the "the credential never
 * reaches the dev server" claims below are checked — asserting on the gateway's
 * own view would only prove that the test and the code agree.
 */
interface UpstreamRequestRecord {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
}

interface UpstreamHandlerInput {
  readonly method: string;
  readonly url: string;
  readonly body: string;
}

interface UpstreamResponse {
  readonly status?: number;
  /**
   * Array values become genuinely repeated headers on the wire. A comma-joined
   * string does NOT: `Set-Cookie` is the one header where the difference is
   * load-bearing, and a joined string would let a broken relay pass.
   */
  readonly headers?: Readonly<Record<string, string | ReadonlyArray<string>>>;
  readonly body?: string;
}

const startUpstream = (respond: (request: UpstreamHandlerInput) => UpstreamResponse) =>
  Effect.gen(function* () {
    const received: UpstreamRequestRecord[] = [];
    const server = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const NodeHttp = await import("node:http");
        const instance = NodeHttp.createServer((request, response) => {
          const chunks: Buffer[] = [];
          request.on("data", (chunk: Buffer | string) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          request.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            received.push({
              method: request.method ?? "",
              url: request.url ?? "",
              headers: request.headers as Readonly<Record<string, string | undefined>>,
              body,
            });
            const result = respond({ method: request.method ?? "", url: request.url ?? "", body });
            response.writeHead(
              result.status ?? 200,
              (result.headers ?? {}) as Record<string, string | Array<string>>,
            );
            response.end(result.body);
          });
        });
        await new Promise<void>((resolve, reject) => {
          instance.on("error", reject);
          instance.listen(0, "127.0.0.1", resolve);
        });
        return instance;
      }),
      (instance) =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              instance.closeAllConnections();
              instance.close(() => resolve());
            }),
        ),
    );

    const address = server.address();
    if (address === null || typeof address === "string") {
      return yield* Effect.die(new Error("Expected a TCP address for the upstream test server."));
    }
    return { port: address.port, received } as const;
  });

/** A port nothing is listening on: bound to learn the number, then released. */
const reserveClosedPort = Effect.promise(async () => {
  const NodeNet = await import("node:net");
  const server = NodeNet.createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Expected a TCP address for the reserved port."));
        return;
      }
      resolve(address.port);
    });
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
});

/**
 * Count `Set-Cookie` headers as they actually appear on the wire.
 *
 * Every parsed view of a response loses this: `Cookies` is keyed by cookie name
 * and the Effect header map is a `Record`, so a cookie sent twice looks identical
 * to a cookie sent once in both.
 */
const countRawSetCookieHeaders = (input: { readonly port: number; readonly cookie: string }) =>
  Effect.promise(async () => {
    const NodeHttp = await import("node:http");
    return await new Promise<number>((resolve, reject) => {
      const request = NodeHttp.request(
        { host: "127.0.0.1", port: input.port, path: "/", headers: { cookie: input.cookie } },
        (response) => {
          const raw = response.headersDistinct["set-cookie"] ?? [];
          response.resume();
          response.on("end", () => resolve(raw.length));
        },
      );
      request.on("error", reject);
      request.end();
    });
  });

const buildGatewayUnderTest = Effect.fnUntraced(function* (options?: {
  readonly config?: Partial<ServerConfig.ServerConfig["Service"]>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-preview-gateway-" });
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
    // Zero keeps the backend out of `selfPorts`, so the only port the gateway
    // refuses as "its own" is the ephemeral one the test server actually bound.
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
    ...options?.config,
  };

  const dependenciesLayer = Layer.mergeAll(
    EnvironmentAuth.layer.pipe(Layer.provide(SqlitePersistenceMemory)),
    // The gateway's own outbound client. It must not be the test client, which
    // is pinned to the gateway's base URL and would rewrite upstream URLs.
    FetchHttpClient.layer,
  ).pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(ServerConfig.layer(config)),
  );

  const servedLayer = HttpRouter.serve(makePreviewGatewayRoutesLayer, {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(Layer.provideMerge(dependenciesLayer));

  const context = yield* Layer.build(servedLayer);
  const sessions = Context.get(context, SessionStore.SessionStore);

  const server = yield* HttpServer.HttpServer;
  const address = server.address as HttpServer.TcpAddress;

  const issueSessionCookie = (
    scopes?: ReadonlyArray<
      typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope
    >,
  ) =>
    sessions
      .issue({
        scopes: scopes ?? [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      })
      .pipe(Effect.map((session) => `${sessions.cookieName}=${session.token}`));

  return {
    config,
    gatewayPort: address.port,
    sessionCookieName: sessions.cookieName,
    issueSessionCookie,
  } as const;
});

const gatewayRequest = (
  path: string,
  options?: {
    readonly method?: "GET" | "POST" | "HEAD";
    readonly cookie?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly followRedirects?: boolean;
  },
) => {
  const request = HttpClientRequest.make(options?.method ?? "GET")(path, {
    headers: {
      ...(options?.cookie === undefined ? {} : { cookie: options.cookie }),
      ...options?.headers,
    },
  }).pipe(
    options?.body === undefined
      ? (self) => self
      : HttpClientRequest.bodyText(options.body, "text/plain"),
  );
  const executed = HttpClient.execute(request);
  return options?.followRedirects === true
    ? executed
    : executed.pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
};

/** Run the select route and return a cookie header carrying both credentials. */
const selectPreviewPort = Effect.fnUntraced(function* (input: {
  readonly sessionCookie: string;
  readonly port: number;
}) {
  const response = yield* gatewayRequest(
    `${PREVIEW_GATEWAY_SELECT_PATH}?${PREVIEW_GATEWAY_PORT_PARAM}=${input.port}`,
    { cookie: input.sessionCookie },
  );
  assert.equal(response.status, 303);
  const previewCookies = Cookies.toCookieHeader(response.cookies);
  assert.notEqual(previewCookies, "");
  return `${input.sessionCookie}; ${previewCookies}`;
});

const responseText = (response: HttpClientResponse.HttpClientResponse) => response.text;

it.layer(NodeServices.layer)("preview gateway", (it) => {
  it.effect("rejects a proxy request with no session credential", () =>
    Effect.gen(function* () {
      yield* buildGatewayUnderTest();

      const response = yield* gatewayRequest("/");

      assert.equal(response.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects a select request with no session credential", () =>
    Effect.gen(function* () {
      yield* buildGatewayUnderTest();

      const response = yield* gatewayRequest(
        `${PREVIEW_GATEWAY_SELECT_PATH}?${PREVIEW_GATEWAY_PORT_PARAM}=45678`,
      );

      assert.equal(response.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects a select request from a session without the operate scope", () =>
    Effect.gen(function* () {
      const gateway = yield* buildGatewayUnderTest();
      const sessionCookie = yield* gateway.issueSessionCookie([AuthOrchestrationReadScope]);

      const response = yield* gatewayRequest(
        `${PREVIEW_GATEWAY_SELECT_PATH}?${PREVIEW_GATEWAY_PORT_PARAM}=45678`,
        { cookie: sessionCookie },
      );

      assert.equal(response.status, 403);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("answers 421 when an authenticated request has selected no port", () =>
    Effect.gen(function* () {
      const gateway = yield* buildGatewayUnderTest();
      const sessionCookie = yield* gateway.issueSessionCookie();

      const response = yield* gatewayRequest("/", { cookie: sessionCookie });

      assert.equal(response.status, 421);
      assert.include(yield* responseText(response), "Select a preview port");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects a forged port cookie rather than forwarding to it", () =>
    Effect.gen(function* () {
      const gateway = yield* buildGatewayUnderTest();
      const sessionCookie = yield* gateway.issueSessionCookie();
      const upstream = yield* startUpstream(() => ({ body: "should-not-be-reached" }));

      const nowMillis = yield* Clock.currentTimeMillis;
      const forged = `${sessionCookie}; t3_preview_port=${Buffer.from(
        `{"port":${upstream.port},"exp":${nowMillis + 60_000}}`,
      ).toString("base64url")}.not-a-real-signature`;
      const response = yield* gatewayRequest("/", { cookie: forged });

      assert.equal(response.status, 421);
      assert.include(yield* responseText(response), "not issued by this server");
      assert.equal(upstream.received.length, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("refuses to select the gateway's own port", () =>
    Effect.gen(function* () {
      const gateway = yield* buildGatewayUnderTest();
      const sessionCookie = yield* gateway.issueSessionCookie();

      const response = yield* gatewayRequest(
        `${PREVIEW_GATEWAY_SELECT_PATH}?${PREVIEW_GATEWAY_PORT_PARAM}=${gateway.gatewayPort}`,
        { cookie: sessionCookie },
      );

      assert.equal(response.status, 400);
      assert.include(yield* responseText(response), "its own port");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("refuses to select a privileged port", () =>
    Effect.gen(function* () {
      const gateway = yield* buildGatewayUnderTest();
      const sessionCookie = yield* gateway.issueSessionCookie();

      const response = yield* gatewayRequest(
        `${PREVIEW_GATEWAY_SELECT_PATH}?${PREVIEW_GATEWAY_PORT_PARAM}=80`,
        { cookie: sessionCookie },
      );

      assert.equal(response.status, 400);
      assert.include(yield* responseText(response), "not reachable through the gateway");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("redirects to the requested same-origin path after selecting a port", () =>
    Effect.gen(function* () {
      const gateway = yield* buildGatewayUnderTest();
      const sessionCookie = yield* gateway.issueSessionCookie();

      const response = yield* gatewayRequest(
        `${PREVIEW_GATEWAY_SELECT_PATH}?${PREVIEW_GATEWAY_PORT_PARAM}=45678&${PREVIEW_GATEWAY_REDIRECT_PARAM}=%2Fdashboard`,
        { cookie: sessionCookie },
      );

      assert.equal(response.status, 303);
      assert.equal(response.headers.location, "/dashboard");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("ignores an off-origin redirect target instead of honouring it", () =>
    Effect.gen(function* () {
      const gateway = yield* buildGatewayUnderTest();
      const sessionCookie = yield* gateway.issueSessionCookie();

      const response = yield* gatewayRequest(
        `${PREVIEW_GATEWAY_SELECT_PATH}?${PREVIEW_GATEWAY_PORT_PARAM}=45678&${PREVIEW_GATEWAY_REDIRECT_PARAM}=%2F%2Fevil.example.com%2F`,
        { cookie: sessionCookie },
      );

      assert.equal(response.status, 303);
      assert.equal(response.headers.location, "/");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("forwards path, query, and body to the selected upstream", () =>
    Effect.gen(function* () {
      const gateway = yield* buildGatewayUnderTest();
      const sessionCookie = yield* gateway.issueSessionCookie();
      const upstream = yield* startUpstream((request) => ({
        status: 201,
        headers: { "content-type": "text/plain", "x-upstream": "yes" },
        body: `saw ${request.method} ${request.url} body=${request.body}`,
      }));
      const cookie = yield* selectPreviewPort({ sessionCookie, port: upstream.port });

      const response = yield* gatewayRequest("/api/thing?a=1&b=2", {
        method: "POST",
        cookie,
        body: "payload",
      });

      assert.equal(response.status, 201);
      assert.equal(response.headers["x-upstream"], "yes");
      assert.equal(yield* responseText(response), "saw POST /api/thing?a=1&b=2 body=payload");

      const record = upstream.received[0];
      assert.isDefined(record);
      assert.equal(record.url, "/api/thing?a=1&b=2");
      assert.equal(record.headers.host, `127.0.0.1:${upstream.port}`);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("strips both gateway credentials from what the upstream receives", () =>
    Effect.gen(function* () {
      const gateway = yield* buildGatewayUnderTest();
      const sessionCookie = yield* gateway.issueSessionCookie();
      const upstream = yield* startUpstream(() => ({ body: "ok" }));
      const cookie = yield* selectPreviewPort({ sessionCookie, port: upstream.port });

      yield* gatewayRequest("/", { cookie: `${cookie}; app_pref=dark` });

      const record = upstream.received[0];
      assert.isDefined(record);
      const forwardedCookie = record.headers.cookie ?? "";
      assert.notInclude(forwardedCookie, gateway.sessionCookieName);
      assert.notInclude(forwardedCookie, "t3_preview_port");
      // The dev server's own cookies still have to survive the trip.
      assert.include(forwardedCookie, "app_pref=dark");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("drops the cookie header entirely when only gateway cookies were sent", () =>
    Effect.gen(function* () {
      const gateway = yield* buildGatewayUnderTest();
      const sessionCookie = yield* gateway.issueSessionCookie();
      const upstream = yield* startUpstream(() => ({ body: "ok" }));
      const cookie = yield* selectPreviewPort({ sessionCookie, port: upstream.port });

      yield* gatewayRequest("/", { cookie });

      const record = upstream.received[0];
      assert.isDefined(record);
      assert.isUndefined(record.headers.cookie);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("relays an upstream redirect verbatim instead of following it", () =>
    Effect.gen(function* () {
      const gateway = yield* buildGatewayUnderTest();
      const sessionCookie = yield* gateway.issueSessionCookie();
      const upstream = yield* startUpstream((request) =>
        request.url === "/moved"
          ? { status: 302, headers: { location: "/destination" } }
          : { body: "followed-the-redirect" },
      );
      const cookie = yield* selectPreviewPort({ sessionCookie, port: upstream.port });

      const response = yield* gatewayRequest("/moved", { cookie });

      assert.equal(response.status, 302);
      assert.equal(response.headers.location, "/destination");
      assert.equal(upstream.received.length, 1);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("relays every upstream Set-Cookie, not just the last one", () =>
    Effect.gen(function* () {
      const gateway = yield* buildGatewayUnderTest();
      const sessionCookie = yield* gateway.issueSessionCookie();
      const upstream = yield* startUpstream(() => ({
        headers: { "set-cookie": ["first=1; Path=/", "second=2; Path=/"] },
        body: "ok",
      }));
      const cookie = yield* selectPreviewPort({ sessionCookie, port: upstream.port });

      const response = yield* gatewayRequest("/", { cookie });

      // Read from the raw wire, not Effect's parsed view: the failure this
      // guards against is two Set-Cookie headers collapsing into one.
      // `response.cookies` is built from the raw multi-value `Set-Cookie`
      // headers, so it is the channel that proves nothing collapsed. The header
      // map cannot: it is a Record, and only ever holds the last value.
      const relayed = Cookies.toSetCookieHeaders(response.cookies);
      assert.deepEqual([...relayed], ["first=1; Path=/", "second=2; Path=/"]);
      // Counted on the raw wire, because a duplicate would be invisible in any
      // parsed view: `Cookies` is keyed by name and the header map is a Record.
      const rawSetCookieCount = yield* countRawSetCookieHeaders({
        port: gateway.gatewayPort,
        cookie,
      });
      assert.equal(rawSetCookieCount, 2);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  /**
   * These two characterise the wire behaviour of a bodyless upstream reply —
   * status and headers relayed, body empty. They do NOT cover `emptyOnAbsentBody`
   * itself: removing that guard leaves these passing, because the Node server has
   * already written the head by the time the empty stream fails. The guard stays
   * as defence (it is what Effect's own `fromClientResponse` does), not because a
   * test pins it.
   */
  it.effect("relays a bodyless upstream response without failing on the empty body", () =>
    Effect.gen(function* () {
      const gateway = yield* buildGatewayUnderTest();
      const sessionCookie = yield* gateway.issueSessionCookie();
      const upstream = yield* startUpstream(() => ({
        status: 304,
        headers: { etag: '"abc123"' },
      }));
      const cookie = yield* selectPreviewPort({ sessionCookie, port: upstream.port });

      const response = yield* gatewayRequest("/", { cookie });

      assert.equal(response.status, 304);
      // The headers a conditional-GET reply exists to carry must survive the
      // bodyless path, not just the status line.
      assert.equal(response.headers.etag, '"abc123"');
      assert.equal(yield* responseText(response), "");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("relays a HEAD response without a body", () =>
    Effect.gen(function* () {
      const gateway = yield* buildGatewayUnderTest();
      const sessionCookie = yield* gateway.issueSessionCookie();
      const upstream = yield* startUpstream(() => ({
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<html>body</html>",
      }));
      const cookie = yield* selectPreviewPort({ sessionCookie, port: upstream.port });

      const response = yield* gatewayRequest("/", { cookie, method: "HEAD" });

      assert.equal(response.status, 200);
      assert.equal(response.headers["content-type"], "text/html");
      assert.equal(yield* responseText(response), "");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("relays a HEAD response with headers but no body", () =>
    Effect.gen(function* () {
      const gateway = yield* buildGatewayUnderTest();
      const sessionCookie = yield* gateway.issueSessionCookie();
      const upstream = yield* startUpstream(() => ({
        status: 200,
        headers: { "content-type": "text/html", "x-marker": "head" },
        body: "<html>body</html>",
      }));
      const cookie = yield* selectPreviewPort({ sessionCookie, port: upstream.port });

      const response = yield* gatewayRequest("/", { cookie, method: "HEAD" });

      assert.equal(response.status, 200);
      assert.equal(response.headers["x-marker"], "head");
      assert.equal(yield* responseText(response), "");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("answers 502 when nothing is listening on the selected port", () =>
    Effect.gen(function* () {
      const gateway = yield* buildGatewayUnderTest();
      const sessionCookie = yield* gateway.issueSessionCookie();
      const closedPort = yield* reserveClosedPort;
      const cookie = yield* selectPreviewPort({ sessionCookie, port: closedPort });

      const response = yield* gatewayRequest("/", { cookie });

      assert.equal(response.status, 502);
      assert.include(yield* responseText(response), `127.0.0.1:${closedPort}`);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("relays a websocket upgrade to the upstream, preserving the subprotocol", () =>
    Effect.gen(function* () {
      const gateway = yield* buildGatewayUnderTest();
      const sessionCookie = yield* gateway.issueSessionCookie();

      const upstreamSockets = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const server = new NodeSocket.NodeWS.WebSocketServer({
            port: 0,
            host: "127.0.0.1",
            handleProtocols: (protocols: Set<string>) => [...protocols][0] ?? false,
          });
          await new Promise<void>((resolve) => server.once("listening", resolve));
          server.on("connection", (socket, request) => {
            socket.send(`hello ${request.url ?? ""}`);
            socket.on("message", (data: unknown) => {
              socket.send(`echo:${String(data)}`);
            });
          });
          return server;
        }),
        (server) =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                for (const client of server.clients) client.terminate();
                server.close(() => resolve());
              }),
          ),
      );
      const upstreamAddress = upstreamSockets.address();
      if (upstreamAddress === null || typeof upstreamAddress === "string") {
        return yield* Effect.die(new Error("Expected a TCP address for the upstream socket."));
      }
      const cookie = yield* selectPreviewPort({ sessionCookie, port: upstreamAddress.port });

      const exchange = yield* Effect.promise(
        () =>
          new Promise<{ readonly protocol: string; readonly messages: ReadonlyArray<string> }>(
            (resolve, reject) => {
              const messages: string[] = [];
              const client = new NodeSocket.NodeWS.WebSocket(
                `ws://127.0.0.1:${gateway.gatewayPort}/hmr?token=x`,
                ["vite-hmr"],
                { headers: { cookie } },
              );
              client.on("error", reject);
              client.on("message", (data: unknown) => {
                messages.push(String(data));
                if (messages.length === 1) {
                  client.send("ping");
                  return;
                }
                const protocol = client.protocol;
                client.close();
                resolve({ protocol, messages });
              });
            },
          ),
      ).pipe(Effect.timeout(Duration.seconds(10)));

      assert.equal(exchange.protocol, "vite-hmr");
      assert.deepEqual([...exchange.messages], ["hello /hmr?token=x", "echo:ping"]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("refuses a websocket upgrade from an unauthenticated client", () =>
    Effect.gen(function* () {
      const gateway = yield* buildGatewayUnderTest();

      const outcome = yield* Effect.promise(
        () =>
          new Promise<string>((resolve) => {
            const client = new NodeSocket.NodeWS.WebSocket(
              `ws://127.0.0.1:${gateway.gatewayPort}/hmr`,
            );
            client.on("error", () => resolve("rejected"));
            client.on("open", () => {
              client.close();
              resolve("opened");
            });
          }),
      ).pipe(Effect.timeout(Duration.seconds(10)));

      assert.equal(outcome, "rejected");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
