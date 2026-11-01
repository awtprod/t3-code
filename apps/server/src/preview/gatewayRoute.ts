/**
 * The authenticated preview gateway: an HTTP + WebSocket reverse proxy that puts
 * a loopback-bound dev server behind the environment's session auth. Mounted at
 * the root of its own port (dev servers emit absolute URLs), so the port travels in
 * the signed cookie from {@link ./gatewayPortCookie.ts}, set via {@link PREVIEW_GATEWAY_SELECT_PATH}.
 */

import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
// The select path and its query parameters are shared with the clients that
// build the URL; a second copy here would be a silent mismatch waiting to happen.
import {
  PREVIEW_GATEWAY_PORT_PARAM,
  PREVIEW_GATEWAY_REDIRECT_PARAM,
  PREVIEW_GATEWAY_SELECT_PATH,
} from "@t3tools/shared/previewGateway";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpMethod,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
  HttpServerRespondable,
} from "effect/http";
import * as Cookies from "effect/http/Cookies";
import * as Socket from "effect/socket/Socket";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";

import {
  describePreviewPortCookieRejection,
  PREVIEW_PORT_COOKIE_TTL_MILLIS,
  PREVIEW_PORT_SIGNING_SECRET_BYTES,
  PREVIEW_PORT_SIGNING_SECRET_NAME,
  resolvePreviewPortCookieName,
  signPreviewPortCookie,
  verifyPreviewPortCookie,
} from "./gatewayPortCookie.ts";
import {
  buildGatewayRequestHeaders,
  buildGatewayResponseHeaders,
  buildGatewayUpstreamUrl,
  buildGatewayUpstreamWebSocketUrl,
  describeGatewayPortRejection,
  isWebSocketUpgrade,
  resolveGatewayPort,
  resolveRequestedSubprotocols,
  stripCookie,
} from "./gatewayTarget.ts";

/**
 * A bodyless upstream response is routine (`304`s, `HEAD`, `204`): reading the
 * client's stream then fails with `EmptyBodyError`, so it is caught and turned
 * into an empty body, as Effect's `fromClientResponse` does. Catching beats
 * enumerating bodyless statuses: no list to keep in sync with dev servers.
 */
const emptyOnAbsentBody = (
  stream: Stream.Stream<Uint8Array, HttpClientError.HttpClientError>,
): Stream.Stream<Uint8Array, HttpClientError.HttpClientError> =>
  Stream.catchIf(
    stream,
    (error: HttpClientError.HttpClientError) =>
      HttpClientError.isHttpClientError(error) && error.reason._tag === "EmptyBodyError",
    () => Stream.empty,
  );

/**
 * Authenticate against the environment session exactly as the rest of the
 * server does. Mirrors `authenticateRawRouteWithScope` in `../http.ts`; the
 * gateway deliberately has no auth path of its own.
 */
const authenticateGatewayRequest = Effect.fn("authenticateGatewayRequest")(function* (
  scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
      failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      failEnvironmentInternal("internal_error", error),
    ),
  );
  if (!session.scopes.includes(scope)) {
    return yield* failEnvironmentScopeRequired(scope);
  }
});

const environmentErrorResponses = {
  EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
  EnvironmentInternalError: HttpServerRespondable.toResponse,
  EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
} as const;

const firstSearchParam = (
  params: Readonly<Record<string, string | ReadonlyArray<string>>>,
  name: string,
): string | undefined => {
  const value = params[name];
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : value[0];
};

/**
 * Methods the proxy treats as read-only.
 *
 * `GET` covers the HMR WebSocket upgrade too, so a read-only session still gets
 * a working live-reloading preview.
 */
const SAFE_PROXY_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Only same-origin, absolute-path redirects are honoured after a selection, so
 * the select route cannot be an open redirect. A leading `//` is scheme-relative
 * and `/\` normalises to `//` in `new URL()` and every browser (`/\evil.example/x`),
 * so any backslash is rejected outright, not just the leading pair.
 */
const resolveRedirectTarget = (raw: string | undefined): string => {
  if (raw === undefined || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  if (raw.includes("\\")) return "/";
  return raw;
};

/**
 * Build the gateway's route table. Upstreams are loopback-only and port-bounded
 * ({@link ./gatewayTarget.ts}); this is deliberately not a general forward proxy.
 * `selfPorts` are ports it must refuse to forward to, at minimum its own, which
 * would otherwise recurse.
 */
export const makePreviewGatewayRoutesLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const gatewayServer = yield* HttpServer.HttpServer;
    const gatewayAddress = gatewayServer.address;
    const gatewayPort =
      typeof gatewayAddress === "string" || !("port" in gatewayAddress)
        ? undefined
        : gatewayAddress.port;

    // The gateway's own port would recurse; the backend's own port would loop a
    // preview back into the app. `config.port` is the configured port, which is
    // the real one in every non-ephemeral configuration.
    const selfPorts = [gatewayPort, config.port].filter(
      (port): port is number => typeof port === "number" && port > 0,
    );

    const previewCookieName = resolvePreviewPortCookieName({
      mode: config.mode,
      port: gatewayPort ?? config.port,
    });

    /** Resolve the upstream port for the current request, or explain why not. */
    const resolveUpstreamPort = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      const secret = yield* secretStore
        .getOrCreateRandom(PREVIEW_PORT_SIGNING_SECRET_NAME, PREVIEW_PORT_SIGNING_SECRET_BYTES)
        .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
      const nowMillis = yield* Clock.currentTimeMillis;
      return verifyPreviewPortCookie({
        value: request.cookies[previewCookieName],
        secret,
        nowMillis,
        selfPorts,
      });
    });

    const selectRouteLayer = HttpRouter.add(
      "GET",
      PREVIEW_GATEWAY_SELECT_PATH,
      Effect.gen(function* () {
        yield* authenticateGatewayRequest(AuthOrchestrationOperateScope);
        const params = yield* HttpServerRequest.ParsedSearchParams;
        // Any unprivileged port passes, not only discovered dev servers; the
        // deny-list in `./gatewayTarget.ts` narrows that exposure but cannot close it.
        const resolved = resolveGatewayPort(
          firstSearchParam(params, PREVIEW_GATEWAY_PORT_PARAM),
          selfPorts,
        );
        if (!resolved.ok) {
          return HttpServerResponse.text(describeGatewayPortRejection(resolved.reason), {
            status: 400,
          });
        }

        const secretStore = yield* ServerSecretStore.ServerSecretStore;
        const secret = yield* secretStore
          .getOrCreateRandom(PREVIEW_PORT_SIGNING_SECRET_NAME, PREVIEW_PORT_SIGNING_SECRET_BYTES)
          .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
        const nowMillis = yield* Clock.currentTimeMillis;
        const expiresAtMillis = nowMillis + PREVIEW_PORT_COOKIE_TTL_MILLIS;
        const value = signPreviewPortCookie({ port: resolved.port, expiresAtMillis, secret });

        // Residual risk: cookies are host-scoped, not port-scoped, so a page served
        // through the gateway is same-site with the main app and `sameSite: "lax"`
        // does not block its state-changing requests to the main origin. Fully
        // closing this needs a separate hostname for previews.
        const cookies = yield* Effect.fromResult(
          // No `secure`: the gateway is reached over plain HTTP on loopback as
          // well as over HTTPS through Tailscale, and a `secure` cookie would
          // silently never be set on the former.
          Cookies.set(Cookies.empty, previewCookieName, value, {
            httpOnly: true,
            path: "/",
            sameSite: "lax",
            maxAge: PREVIEW_PORT_COOKIE_TTL_MILLIS,
          }),
        ).pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));

        yield* Effect.logDebug("Preview gateway upstream selected", { port: resolved.port });

        return HttpServerResponse.redirect(
          resolveRedirectTarget(firstSearchParam(params, PREVIEW_GATEWAY_REDIRECT_PARAM)),
          { status: 303, cookies },
        );
      }).pipe(Effect.catchTags(environmentErrorResponses)),
    );

    // Preview content could open the control-plane WebSocket with the victim's
    // ambient session; `../ws.ts` rejects `/ws` upgrades whose `Origin` is not Host,
    // dev server or desktop ({@link ../auth/websocketOrigin.ts}). Clients sending
    // no `Origin` (desktop, mobile) still pass, since only browsers set it.
    const proxyRouteLayer = HttpRouter.add(
      "*",
      "/*",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        // The port cookie carries only `{port, exp}`, so it proves nothing about
        // scopes. Selection needs operate; the proxy re-derives the scope per request
        // so a read-only session can browse a preview but not drive state changes.
        yield* authenticateGatewayRequest(
          SAFE_PROXY_METHODS.has(request.method)
            ? AuthOrchestrationReadScope
            : AuthOrchestrationOperateScope,
        );
        const sessions = yield* SessionStore.SessionStore;

        const verification = yield* resolveUpstreamPort;
        if (!verification.ok) {
          return HttpServerResponse.text(describePreviewPortCookieRejection(verification.reason), {
            status: 421,
          });
        }
        const port = verification.port;

        // Strip every credential before the dev server (arbitrary user code) sees
        // it: the session cookie, the port cookie (the gateway's own control channel)
        // and any `authorization`/`dpop` header (the latter in the header builder).
        const headers = buildGatewayRequestHeaders(request.headers, port, sessions.cookieName);
        if (headers.cookie !== undefined) {
          const remaining = stripCookie(headers.cookie, previewCookieName);
          if (remaining) {
            headers.cookie = remaining;
          } else {
            delete headers.cookie;
          }
        }

        if (isWebSocketUpgrade(request.headers)) {
          return yield* proxyWebSocket(port);
        }

        const httpClient = yield* HttpClient.HttpClient;
        const upstreamRequest = HttpClientRequest.make(request.method)(
          buildGatewayUpstreamUrl(port, request.url),
          { headers },
        ).pipe(
          HttpMethod.hasBody(request.method)
            ? HttpClientRequest.bodyStream(request.stream)
            : (self) => self,
        );

        const response = yield* httpClient.execute(upstreamRequest).pipe(
          // A dev server's redirect must reach the browser verbatim; following
          // it here would resolve it against the *upstream* origin and hand back
          // the wrong document. (Measured: `fetch` follows by default.)
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          Effect.catch((cause) =>
            Effect.logWarning("Preview gateway upstream request failed", { cause, port }).pipe(
              Effect.as(undefined),
            ),
          ),
        );
        if (response === undefined) {
          return HttpServerResponse.text(`No dev server is answering on 127.0.0.1:${port}.`, {
            status: 502,
          });
        }

        const responseOptions = {
          status: response.status,
          headers: buildGatewayResponseHeaders(response.headers),
          // Relayed via the cookie channel: the header map is a `Record`, so several
          // `Set-Cookie` values would collapse to the last. The gateway's own two cookies
          // are dropped first: they share a host with the dev server, so an upstream
          // could overwrite the live session or hijack the port selection.
          cookies: Cookies.remove(
            Cookies.remove(response.cookies, sessions.cookieName),
            previewCookieName,
          ),
        };

        return HttpServerResponse.stream(emptyOnAbsentBody(response.stream), responseOptions);
      }).pipe(Effect.catchTags(environmentErrorResponses)),
    );

    return Layer.mergeAll(selectRouteLayer, proxyRouteLayer);
  }),
);

/**
 * Relay a WebSocket upgrade to the upstream dev server.
 *
 * Both halves are Effect `Socket`s: the downstream one comes from the server's
 * upgrade handler, the upstream one from a client WebSocket. Each is pumped into
 * the other's writer, and the first to end tears the other down.
 */
const proxyWebSocket = Effect.fnUntraced(function* (port: number) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = buildGatewayUpstreamWebSocketUrl(port, request.url);
  // Vite's HMR client connects with the `vite-hmr` subprotocol and expects it
  // echoed. The downstream server echoes the client's first requested protocol
  // on its own, so forwarding the same list keeps both halves in agreement.
  const protocols = resolveRequestedSubprotocols(request.headers);

  const downstream = yield* Effect.orDie(request.upgrade);
  const upstream = yield* Socket.makeWebSocket(
    url,
    protocols.length > 0 ? { protocols: [...protocols] } : {},
  ).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal));

  const upstreamWriter = yield* upstream.writer;
  const downstreamWriter = yield* downstream.writer;

  // Every socket termination, a clean close included, fails `pull` with a
  // SocketError, so each pump only ends by failing.
  const pump = (from: Socket.Socket, to: Socket.Writer) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { pull } = yield* from.reader;
        while (true) {
          yield* to.writeAll(yield* pull);
        }
      }),
    );

  yield* Effect.raceFirst(pump(upstream, downstreamWriter), pump(downstream, upstreamWriter)).pipe(
    // A socket closing is how this ends, not a failure to report.
    Effect.catchTags({
      SocketError: (error) =>
        Effect.logDebug("Preview gateway websocket closed", { port, reason: error.reason._tag }),
    }),
  );

  return HttpServerResponse.empty();
});
