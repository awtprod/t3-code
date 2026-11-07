/**
 * Pure target resolution for the authenticated preview gateway. It is the one
 * route that can be pointed at an address, so everything it will accept is
 * decided here: a fixed loopback host and a bounded, filtered port.
 */

/** Lowest port the gateway will forward to. Privileged ports are never dev servers. */
export const MIN_GATEWAY_PORT = 1024;
/** Highest valid TCP port. */
export const MAX_GATEWAY_PORT = 65_535;

/**
 * The only host the gateway ever connects to; never taken from the request. A
 * caller-supplied host would make the route an open forward proxy behind the
 * user's Tailscale identity, reaching anything the server can.
 */
export const GATEWAY_TARGET_HOST = "127.0.0.1";

/**
 * Loopback ports refused even for an authenticated caller: loopback holds
 * interfaces assumed unreachable (debuggers, container daemons, unauthenticated
 * databases and secret stores) and the gateway exposes it to the tailnet. This
 * deny-list is incomplete by construction; the real boundary is session auth.
 */
const BLOCKED_GATEWAY_PORTS: ReadonlySet<number> = new Set([
  2049, // NFS
  2375,
  2376, // Docker daemon (plaintext: container create is root on the host)
  2379,
  2380, // etcd client, peer
  3306, // MySQL / MariaDB
  4646,
  4647,
  4648, // Nomad HTTP, RPC, Serf
  5432,
  5433, // PostgreSQL
  5984, // CouchDB
  6379, // Redis, conventionally unauthenticated on loopback
  6443, // Kubernetes API server
  8200,
  8500, // HashiCorp Vault, Consul HTTP
  9200,
  9300, // Elasticsearch / OpenSearch HTTP, transport
  10_250, // kubelet
  11_211, // memcached
  27_017,
  27_018,
  27_019, // MongoDB, shard, config server
]);

/**
 * Inclusive port range of Chrome DevTools and the Node inspector (9229 is remote
 * code execution by design). Ranged because `--inspect` and `--remote-debugging-port`
 * take offsets (`9223`, `9230`) and every port in the range evaluates arbitrary code.
 */
const BLOCKED_DEBUGGER_PORT_RANGE = { first: 9222, last: 9239 } as const;

/**
 * Whether a port hosts a service the gateway must never expose. Not an allow-list
 * on `PortDiscovery`: `lsof` lists every listener, so "discovered" excludes nothing.
 */
function isBlockedGatewayPort(port: number): boolean {
  if (BLOCKED_GATEWAY_PORTS.has(port)) return true;
  return port >= BLOCKED_DEBUGGER_PORT_RANGE.first && port <= BLOCKED_DEBUGGER_PORT_RANGE.last;
}

export type GatewayPortRejection =
  | "not-a-number"
  | "out-of-range"
  | "reserved-privileged"
  | "gateway-self"
  | "blocked-service";

export type GatewayPortResolution =
  | { readonly ok: true; readonly port: number }
  | { readonly ok: false; readonly reason: GatewayPortRejection };

/**
 * Validate a caller-supplied preview port. `selfPorts` are ports this server
 * listens on (its HTTP port, and the gateway port when they differ); forwarding
 * to one would make the gateway proxy itself, a request loop that consumes a
 * connection slot per hop.
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
  if (isBlockedGatewayPort(port)) {
    return { ok: false, reason: "blocked-service" };
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
    case "blocked-service":
      return "That port is reserved for a system service and is not reachable through the gateway.";
  }
}

/**
 * Build the upstream URL for a forwarded request. Path and query pass through
 * untouched: the gateway is root-mounted so the dev server sees itself at the
 * origin root. `pathAndQuery` is used verbatim, not re-serialised, because
 * re-encoding would corrupt requests that rely on `%2F`-style escaping.
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
 * Headers not copied verbatim upstream: `host` is rewritten, hop-by-hop headers
 * are connection-scoped (RFC 9110), `accept-encoding` is dropped so bodies stream
 * uncompressed. `authorization` and `dpop` are live credentials; a token handed to
 * the dev server (arbitrary user code) would be reusable against the control plane.
 */
const GATEWAY_STRIPPED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
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
  "authorization",
  "dpop",
]);

/** Response headers that are connection-scoped and must not be relayed downstream. */
const GATEWAY_STRIPPED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Copy request headers for the upstream, dropping the ones that must not travel
 * and rewriting `host`. The session cookie is deliberately not forwarded: handing
 * a credential to arbitrary user code on a loopback port is a needless way to lose it.
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
 * Copy response headers downstream, dropping connection-scoped ones, plus
 * `content-length` (body is streamed; a stale length hangs), `content-encoding`
 * (the client already decoded the body, so relaying it breaks gunzip) and
 * `set-cookie` (relayed via the cookie channel; this Record keeps only the last).
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
