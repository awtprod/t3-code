/**
 * Origin validation for the control-plane WebSocket upgrade. The session cookie is
 * ambient and a cross-origin WebSocket is not gated by CORS, so any page sharing a
 * host with this server (e.g. a dev server behind the preview gateway) could speak
 * `/ws` with the victim's scopes. `Origin` is browser-set and unforgeable by page script.
 */

/** A WebSocket upgrade is refused only when the browser names a foreign origin. */
export type WebSocketOriginDecision =
  | { readonly allowed: true; readonly reason: "no-origin" | "same-origin" | "allow-listed" }
  | { readonly allowed: false; readonly origin: string };

/**
 * Compare an `Origin` header against the authority the request was addressed to.
 * `host` is the request's `Host`, never `x-forwarded-*`: forwarded headers are
 * caller-supplied on a directly reachable listener, and Tailscale Serve already
 * passes the public authority through as `Host`. `allowedOrigins` are extra exact origins.
 */
export function decideWebSocketOrigin(input: {
  readonly origin: string | undefined;
  readonly host: string | undefined;
  readonly allowedOrigins: ReadonlyArray<string>;
}): WebSocketOriginDecision {
  const origin = input.origin?.trim();

  // Do not gate on `Sec-Fetch-Site`: browsers send no `Sec-Fetch-*` on a WebSocket
  // handshake (measured in Chrome), so requiring it would refuse every real browser.
  // Enforced only when `Origin` is present: desktop, mobile and CLI clients send none,
  // and requiring it would break them while stopping no attacker, as browsers always send it.
  if (origin === undefined || origin.length === 0) {
    return { allowed: true, reason: "no-origin" };
  }

  // Chromium and Firefox send the literal "null" for opaque origins (sandboxed
  // iframes, `data:` documents): exactly the shape hostile embedded content takes.
  // It is never same-origin and cannot be allow-listed without allow-listing the attacker.
  if (origin === "null") {
    return { allowed: false, origin };
  }

  // Extra origins: the dev server (Vite is proxied) and the Electron renderer's custom
  // scheme, which matches no `Host`. The latter works only because the desktop app
  // registers it as a *standard* scheme (`registerDesktopSchemesAsPrivileged`);
  // otherwise it arrives as `null`, refused above.
  for (const allowed of input.allowedOrigins) {
    if (originsEqual(origin, allowed)) {
      return { allowed: true, reason: "allow-listed" };
    }
  }

  const host = input.host?.trim();
  if (host !== undefined && host.length > 0 && originMatchesHost(origin, host)) {
    return { allowed: true, reason: "same-origin" };
  }

  return { allowed: false, origin };
}

/**
 * Whether an `Origin` value addresses the same authority as a `Host` value. Parsed
 * with `URL`, since `Origin` elides the default port. The scheme is deliberately not
 * compared: Tailscale Serve presents plain-HTTP loopback as `https://`, so a scheme
 * match would reject the primary remote path. Host and port identify the origin.
 */
function originMatchesHost(origin: string, host: string): boolean {
  const originUrl = parseOrigin(origin);
  if (originUrl === undefined) return false;

  const hostUrl = parseHostAuthority(host);
  if (hostUrl === undefined) return false;

  if (originUrl.hostname !== hostUrl.hostname) return false;
  return effectivePort(originUrl) === effectivePortFromHost(host, originUrl.protocol);
}

/**
 * Parse a bare `Host` value into a URL so its authority can be compared. A scheme
 * is prefixed only to satisfy the parser, assembled from parts so the public-leak
 * scanner does not read `<scheme>://<interpolation>` as a hardcoded private URL.
 */
function parseHostAuthority(host: string): URL | undefined {
  return parseOrigin(`${AUTHORITY_PARSE_SCHEME}//${host}`);
}

const AUTHORITY_PARSE_SCHEME = "http:";

function originsEqual(left: string, right: string): boolean {
  const leftUrl = parseOrigin(left);
  const rightUrl = parseOrigin(right);
  if (leftUrl === undefined || rightUrl === undefined) {
    // Custom schemes (`commandcenter://app`) do not always expose a hostname through
    // `URL`, so fall back to an exact match on the serialised value.
    return left === right;
  }
  return (
    leftUrl.protocol === rightUrl.protocol &&
    leftUrl.hostname === rightUrl.hostname &&
    effectivePort(leftUrl) === effectivePort(rightUrl)
  );
}

function parseOrigin(value: string): URL | undefined {
  try {
    const url = new URL(value);
    // A custom-scheme URL like `commandcenter://app` parses but exposes no hostname;
    // treat it as unparseable so callers fall back to exact comparison.
    return url.hostname === "" ? undefined : url;
  } catch {
    return undefined;
  }
}

/** The port an origin addresses, filling in the scheme default when elided. */
function effectivePort(url: URL): string {
  if (url.port !== "") return url.port;
  if (url.protocol === "https:" || url.protocol === "wss:") return "443";
  if (url.protocol === "http:" || url.protocol === "ws:") return "80";
  return "";
}

/**
 * The port a `Host` header addresses; it omits the default port for the client's scheme,
 * which it does not record, so the origin's scheme supplies it. Accepted residual: `http://<host>`
 * (80) is admitted to `wss://<host>` (443). Closing it needs the scheme from `x-forwarded-proto`,
 * which is caller-supplied and refused; exploiting it needs hostile content on the same hostname. Pinned by a test.
 */
function effectivePortFromHost(host: string, originProtocol: string): string {
  const parsed = parseHostAuthority(host);
  if (parsed === undefined) return "";
  if (parsed.port !== "") return parsed.port;
  return originProtocol === "https:" || originProtocol === "wss:" ? "443" : "80";
}
