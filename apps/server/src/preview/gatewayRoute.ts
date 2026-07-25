/**
 * The authenticated preview gateway: an HTTP + WebSocket reverse proxy that
 * puts a loopback-bound dev server behind the environment's existing session
 * auth, so previewing a dev server from another machine needs no new tunnel.
 *
 * The gateway is mounted at the **root** of its own port rather than under a
 * `/preview/<port>/` prefix. Dev servers emit absolute URLs (`/@vite/client`,
 * `/src/main.tsx`, the HMR socket) that resolve against the gateway origin and
 * would 404 under a prefix. Root mounting means the path can no longer name the
 * upstream, so the port travels in the signed cookie from
 * {@link ./gatewayPortCookie.ts} and is selected via {@link PREVIEW_GATEWAY_SELECT_PATH}.
 *
 * Security shape:
 * - Every request is authenticated with the *same* `EnvironmentAuth` session
 *   cookie as the rest of the server. There is no gateway-specific auth path.
 * - Upstreams are loopback-only and port-bounded ({@link ./gatewayTarget.ts});
 *   this is deliberately not a general forward proxy.
 * - The session cookie is stripped before the request reaches the dev server —
 *   arbitrary user code on a loopback port has no use for the credential.
 *
 * Known residual risk (documented, not solved here): cookies are scoped by host,
 * not by port, so a page served *through* the gateway is same-site with the main
 * app and its credentialed requests to the main origin will carry the session
 * cookie. CORS keeps responses unreadable, but state-changing same-site requests
 * are not blocked by `sameSite: "lax"`. Fully closing this needs a separate
 * hostname for previews, which is out of scope for this slice.
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
} from "effect/unstable/http";
import * as Cookies from "effect/unstable/http/Cookies";
import * as Socket from "effect/unstable/socket/Socket";

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
 * A bodyless upstream response is routine, not an edge case: a dev server emits
 * `304`s constantly once the browser has a warm cache, and `HEAD`/`204` responses
 * have no body either. Reading the client's stream in those cases fails with an
 * `EmptyBodyError`, so it is caught and turned into an empty body — the same
 * treatment Effect's own `HttpServerResponse.fromClientResponse` applies.
 *
 * Catching the error beats enumerating the bodyless statuses: it needs no list to
 * keep in sync with what dev servers actually send.
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
const authenticateGatewayRequest = (
  scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
) =>
  Effect.gen(function* () {
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
 * Only same-origin, absolute-path redirects are honoured after a selection, so
 * the select route cannot be used as an open redirect.
 */
const resolveRedirectTarget = (raw: string | undefined): string => {
  if (raw === undefined || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
};

/**
 * Build the gateway's route table.
 *
 * `selfPorts` are ports the gateway must refuse to forward to — at minimum its
 * own, which would otherwise recurse.
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

    const proxyRouteLayer = HttpRouter.add(
      "*",
      "/*",
      Effect.gen(function* () {
        yield* authenticateGatewayRequest(AuthOrchestrationReadScope);
        const request = yield* HttpServerRequest.HttpServerRequest;
        const sessions = yield* SessionStore.SessionStore;

        const verification = yield* resolveUpstreamPort;
        if (!verification.ok) {
          return HttpServerResponse.text(describePreviewPortCookieRejection(verification.reason), {
            status: 421,
          });
        }
        const port = verification.port;

        // Neither credential is the dev server's business: the session cookie is
        // a live credential for this environment, and the port cookie is the
        // gateway's own control channel.
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
          // Relayed through the cookie channel rather than the header map: the
          // header map is a `Record`, so multiple `Set-Cookie` values collapse
          // to the last one and every other cookie is lost.
          cookies: response.cookies,
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

  const writeUpstream = yield* upstream.writer;
  const writeDownstream = yield* downstream.writer;

  yield* Effect.raceFirst(
    upstream.runRaw((chunk) => writeDownstream(chunk)),
    downstream.runRaw((chunk) => writeUpstream(chunk)),
  ).pipe(
    // A socket closing is how this ends, not a failure to report.
    Effect.catchTag("SocketError", (error) =>
      Effect.logDebug("Preview gateway websocket closed", { port, reason: error.reason._tag }),
    ),
  );

  return HttpServerResponse.empty();
});
