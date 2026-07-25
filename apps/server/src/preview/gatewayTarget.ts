/**
 * Pure target resolution for the authenticated preview gateway.
 *
 * The gateway forwards requests to a dev server bound on loopback inside this
 * environment. That makes it the one route in the server that can be pointed at
 * an arbitrary address, so everything it will accept is decided here, in pure
 * code that is cheap to test exhaustively.
 *
 * Two rules, both non-negotiable:
 *
 * 1. **Loopback only.** The forward target host is never taken from the request.
 *    It is always `127.0.0.1`; only the *port* is caller-supplied. Without this
 *    the route is an open forward proxy sitting behind the user's Tailscale
 *    identity — anything on the tailnet could reach anything the server can.
 * 2. **Port-bounded.** Only unprivileged ports (>= 1024) are reachable, and the
 *    server's own port is excluded so the gateway can never be aimed back at
 *    itself (a request loop that would consume a connection slot per hop).
 */

/** Lowest port the gateway will forward to. Privileged ports are never dev servers. */
export const MIN_GATEWAY_PORT = 1024;
/** Highest valid TCP port. */
export const MAX_GATEWAY_PORT = 65_535;

/** The only host the gateway ever connects to. Deliberately not caller-supplied. */
export const GATEWAY_TARGET_HOST = "127.0.0.1";

export type GatewayPortRejection =
  | "not-a-number"
  | "out-of-range"
  | "reserved-privileged"
  | "gateway-self";

export type GatewayPortResolution =
  | { readonly ok: true; readonly port: number }
  | { readonly ok: false; readonly reason: GatewayPortRejection };

/**
 * Validate a caller-supplied preview port.
 *
 * `selfPorts` are ports this server itself listens on (its HTTP port, and the
 * gateway port when they differ). Forwarding to one of those would make the
 * gateway proxy itself.
 */
export function resolveGatewayPort(
  rawPort: string | number | undefined,
  selfPorts: ReadonlyArray<number> = [],
): GatewayPortResolution {
  // `Number("")` is 0 and `Number(" 12 ")` is 12, so parse strictly: only a
  // run of digits is a port. This also rejects "8080/../", "+8080", and "0x1f".
  const port =
    typeof rawPort === "number"
      ? rawPort
      : typeof rawPort === "string" && /^\d+$/.test(rawPort)
        ? Number(rawPort)
        : Number.NaN;

  if (!Number.isInteger(port)) {
    return { ok: false, reason: "not-a-number" };
  }
  if (port < 0 || port > MAX_GATEWAY_PORT) {
    return { ok: false, reason: "out-of-range" };
  }
  if (port < MIN_GATEWAY_PORT) {
    return { ok: false, reason: "reserved-privileged" };
  }
  if (selfPorts.includes(port)) {
    return { ok: false, reason: "gateway-self" };
  }
  return { ok: true, port };
}

/** Human-readable explanation for a rejected port, safe to return in a response body. */
export function describeGatewayPortRejection(reason: GatewayPortRejection): string {
  switch (reason) {
    case "not-a-number":
      return "Preview port must be a number.";
    case "out-of-range":
      return `Preview port must be between ${MIN_GATEWAY_PORT} and ${MAX_GATEWAY_PORT}.`;
    case "reserved-privileged":
      return `Preview ports below ${MIN_GATEWAY_PORT} are not reachable through the gateway.`;
    case "gateway-self":
      return "The gateway cannot forward to its own port.";
  }
}

/**
 * Build the upstream URL for a forwarded request.
 *
 * The path and query come from the incoming request untouched — the dev server
 * behind the gateway sees itself at the origin root, which is the whole point of
 * mounting the gateway at a root rather than under a `/preview/<port>/` prefix.
 * A prefix would break every absolute URL the dev server emits (`/@vite/client`,
 * `/src/main.tsx`) and its HMR socket along with them.
 *
 * `pathAndQuery` is used verbatim rather than parsed and re-serialised so that
 * the upstream receives byte-identical encoding; re-encoding would corrupt
 * requests that rely on a specific escaping of `%2F` and friends.
 */
export function buildGatewayUpstreamUrl(port: number, pathAndQuery: string): string {
  return `http://${GATEWAY_TARGET_HOST}:${port}${normalizePathAndQuery(pathAndQuery)}`;
}

/**
 * Build the upstream URL for a forwarded WebSocket upgrade.
 *
 * Same rules as {@link buildGatewayUpstreamUrl}; only the scheme differs, since
 * `Socket.makeWebSocket` takes a `ws://` URL.
 */
export function buildGatewayUpstreamWebSocketUrl(port: number, pathAndQuery: string): string {
  return `ws://${GATEWAY_TARGET_HOST}:${port}${normalizePathAndQuery(pathAndQuery)}`;
}

function normalizePathAndQuery(pathAndQuery: string): string {
  return pathAndQuery.startsWith("/") ? pathAndQuery : `/${pathAndQuery}`;
}

/**
 * Headers that must not be copied verbatim between the client and the upstream.
 *
 * `host` is rewritten to the upstream authority; hop-by-hop headers are
 * connection-scoped per RFC 9110 and forwarding them corrupts keep-alive and
 * upgrade handling. `accept-encoding` is dropped on the way up so the upstream
 * responds uncompressed and we never have to re-encode a body we are streaming.
 */
export const GATEWAY_STRIPPED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "accept-encoding",
]);

/** Response headers that are connection-scoped and must not be relayed downstream. */
export const GATEWAY_STRIPPED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Copy request headers for the upstream, dropping the ones that must not travel
 * and rewriting `host` to the upstream authority.
 *
 * The session cookie is deliberately *not* forwarded: the dev server has no use
 * for it, and handing a credential to arbitrary user code on a loopback port is
 * a needless way to lose it.
 */
export function buildGatewayRequestHeaders(
  incoming: Readonly<Record<string, string | undefined>>,
  port: number,
  sessionCookieName: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const name = rawName.toLowerCase();
    if (GATEWAY_STRIPPED_REQUEST_HEADERS.has(name)) continue;
    if (name === "cookie") {
      const filtered = stripCookie(value, sessionCookieName);
      if (filtered) headers[name] = filtered;
      continue;
    }
    headers[name] = value;
  }
  headers.host = `${GATEWAY_TARGET_HOST}:${port}`;
  return headers;
}

/**
 * Copy response headers back downstream, dropping the connection-scoped ones.
 *
 * `content-length` goes too: the body is relayed as a stream and the framing is
 * decided by the downstream server, so a stale length would truncate or hang the
 * response.
 *
 * `content-encoding` goes for a subtler reason. The HTTP client negotiates its
 * own `accept-encoding` and hands back a *decoded* body stream, but leaves the
 * upstream's `content-encoding: gzip` on the response headers. Relaying that
 * header would tell the browser to gunzip bytes that are already plain, and
 * every response from a compressing dev server would fail to decode. (Measured:
 * a gzipping loopback server read back through `fetch` yields
 * `content-encoding: gzip` alongside a 16-byte plaintext stream.)
 *
 * `set-cookie` goes because it is relayed through the response's cookie channel
 * instead. This map is a `Record`, so it only ever holds the *last* of several
 * `Set-Cookie` values; leaving it in would emit that one cookie a second time
 * alongside the complete set. (Effect's own `fromClientResponse` removes it here
 * for the same reason.)
 */
export function buildGatewayResponseHeaders(
  incoming: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const name = rawName.toLowerCase();
    if (GATEWAY_STRIPPED_RESPONSE_HEADERS.has(name)) continue;
    if (name === "content-length" || name === "content-encoding") continue;
    if (name === "set-cookie") continue;
    headers[name] = value;
  }
  return headers;
}

/**
 * Whether a request is a WebSocket upgrade, which the gateway must relay as a
 * socket rather than as a request/response pair — dev-server HMR depends on it.
 */
export function isWebSocketUpgrade(headers: Readonly<Record<string, string | undefined>>): boolean {
  const upgrade = headerValue(headers, "upgrade");
  const connection = headerValue(headers, "connection");
  if (upgrade?.toLowerCase() !== "websocket") return false;
  // `Connection` is a comma-separated list ("keep-alive, Upgrade" in the wild).
  return (connection ?? "").split(",").some((token) => token.trim().toLowerCase() === "upgrade");
}

/**
 * Subprotocols the client asked for, in order.
 *
 * Vite's HMR client connects with the `vite-hmr` subprotocol and the dev server
 * echoes it back; if the gateway opens its upstream socket without it, the dev
 * server answers on the wrong protocol and HMR never connects.
 */
export function resolveRequestedSubprotocols(
  headers: Readonly<Record<string, string | undefined>>,
): ReadonlyArray<string> {
  return (headerValue(headers, "sec-websocket-protocol") ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function headerValue(
  headers: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  for (const [rawName, value] of Object.entries(headers)) {
    if (rawName.toLowerCase() === name) return value;
  }
  return undefined;
}

/** Remove one named cookie from a `Cookie` header value, preserving the rest. */
export function stripCookie(cookieHeader: string, cookieName: string): string {
  return cookieHeader
    .split(";")
    .filter((pair) => pair.trim().split("=", 1)[0]?.trim() !== cookieName)
    .map((pair) => pair.trim())
    .filter((pair) => pair.length > 0)
    .join("; ");
}
