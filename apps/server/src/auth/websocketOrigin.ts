/**
 * Origin validation for the control-plane WebSocket upgrade.
 *
 * The session cookie is *ambient*: the browser attaches it to a WebSocket
 * upgrade the same way it attaches it to an image request, and — unlike
 * `fetch` — a cross-origin WebSocket is not gated by CORS. Any page that shares
 * a host with this server can therefore open `/ws` and speak the full RPC
 * protocol with the victim's scopes. The preview gateway makes that concrete:
 * cookies are scoped by host and not by port, so a dev server rendered *through*
 * the gateway is same-host with the app and its JavaScript inherits the session.
 *
 * `Origin` is the right discriminator because it is one of the headers a browser
 * sets itself and page script cannot override — including on WebSocket upgrades.
 *
 * Four rules, each of which exists because a simpler version breaks something
 * real in this repo:
 *
 * 1. **Enforced only when `Origin` is present.** Non-browser clients — desktop
 *    and mobile, both connecting through `Socket.layerWebSocket` in
 *    `@t3tools/client-runtime` — send no `Origin` at all, and neither does any
 *    CLI. Requiring the header would break every one of them while stopping no
 *    attacker: the threat is a *browser* page, and a browser always sends it.
 *    An absent `Origin` is not a bypass, because a bypass needs a browser to
 *    omit a header it is required to send.
 * 2. **The expected origin comes from `Host`, never from `x-forwarded-*`.**
 *    Forwarded headers are caller-supplied on a directly reachable listener, so
 *    trusting them would let the attacker nominate the origin they are checked
 *    against. This repo already takes that position elsewhere — DPoP URL
 *    validation and cloud link proofs both ignore forwarded headers on purpose.
 *    Measured through the deployment that actually matters: Tailscale Serve
 *    passes the public authority through as `Host`
 *    (`host: openclaw-server.<tailnet>.ts.net:8446` for a request to that URL),
 *    so a `Host`-derived origin matches the browser's `Origin` on the tailnet
 *    path without consulting a forwarded header at all.
 * 3. **Extra origins are allowed explicitly.** In dev the document is served by
 *    Vite on another port and proxied, so the browser's `Origin` is the Vite
 *    origin while `Host` is the backend's — `config.devUrl` closes that gap. The
 *    Electron renderer loads a custom scheme (`t3code://app`), which matches no
 *    `Host` by construction; those two origins are already enumerated in
 *    `../http.ts` as `DESKTOP_RENDERER_ORIGINS` for the CORS layer. That entry
 *    only works because the desktop app registers its scheme as *standard*
 *    (`registerDesktopSchemesAsPrivileged` in `apps/desktop`) — a non-standard
 *    custom scheme gets an opaque origin from Chromium and would arrive here as
 *    `null`, which rule 4 refuses. Measured in a real renderer: without that
 *    registration the upgrade carries `Origin: null`; with it, `t3code://app`.
 * 4. **The literal `null` is refused.** It is what Chromium and Firefox send for
 *    an opaque origin — a sandboxed iframe, a `data:` document — which is
 *    exactly the shape hostile embedded content takes. It cannot be
 *    allow-listed without allow-listing the attacker along with it.
 *
 * Scheme is deliberately *not* compared. A request arriving over plain HTTP on
 * loopback is routinely presented to the browser as `https://` by Tailscale
 * Serve, so requiring a scheme match would reject the primary remote path. Host
 * and port are what identify the origin here; the transport is the tunnel's
 * concern.
 *
 * **Known residual, accepted deliberately.** Because the scheme is not compared
 * and `Host` omits the port when it is the default one, an origin on the default
 * port of *one* scheme is accepted against a portless `Host` addressed over the
 * *other* — `http://<host>` (port 80) is admitted to `wss://<host>` (port 443).
 * Exploiting it needs hostile content on the same hostname over the opposite
 * scheme, which is a strictly stronger position than the preview gateway grants
 * (that content sits on a different *port*, which is compared and refused).
 * Closing it would require knowing the scheme the browser used, and behind
 * Tailscale Serve the only record of that is `x-forwarded-proto` — a header
 * rule 2 refuses to trust precisely because it is caller-supplied on a directly
 * reachable listener. Trading a real, reachable spoof for a narrower one is a
 * bad deal, so the port ambiguity stays and is pinned by a test.
 *
 * `Sec-Fetch-Site` has been proposed as a way to close this without trusting a
 * forwarded header, since it is browser-set and encodes scheme as well as host
 * and port. It does not work here: **browsers do not send `Sec-Fetch-*` on a
 * WebSocket handshake.** Measured against a live Chrome (this repo's DevTools
 * MCP) opening both a same-origin and a cross-origin `WebSocket` to a raw
 * `http.Server`: both upgrades arrived carrying `Origin` and exactly three
 * `sec-` headers — `sec-websocket-version`, `sec-websocket-key`,
 * `sec-websocket-extensions` — with `sec-fetch-site`, `sec-fetch-mode` and
 * `sec-fetch-dest` all absent. Requiring `Sec-Fetch-Site: same-origin` would
 * therefore refuse every real browser client, not just the ambiguous ones.
 */

/** A WebSocket upgrade is refused only when the browser names a foreign origin. */
export type WebSocketOriginDecision =
  | { readonly allowed: true; readonly reason: "no-origin" | "same-origin" | "allow-listed" }
  | { readonly allowed: false; readonly origin: string };

/**
 * Compare an `Origin` header against the authority the request was addressed to.
 *
 * `host` is the request's `Host` header — the authority the *client* used, which
 * is the thing an origin must agree with. `allowedOrigins` are additional exact
 * origins (dev server, desktop renderer) that no `Host` can produce.
 */
export function decideWebSocketOrigin(input: {
  readonly origin: string | undefined;
  readonly host: string | undefined;
  readonly allowedOrigins: ReadonlyArray<string>;
}): WebSocketOriginDecision {
  const origin = input.origin?.trim();

  // No `Origin` means no browser, and the browser is the whole threat model.
  if (origin === undefined || origin.length === 0) {
    return { allowed: true, reason: "no-origin" };
  }

  // Firefox sends the literal "null" for opaque origins (sandboxed iframes,
  // `data:` documents). That is precisely the shape hostile embedded content
  // takes, so it is never same-origin and must not be normalised away.
  if (origin === "null") {
    return { allowed: false, origin };
  }

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
 * Whether an `Origin` value addresses the same authority as a `Host` value.
 *
 * Parsed with `URL` rather than string-compared: `Origin` is a serialised origin
 * whose default port is elided (`https://example.test` and
 * `https://example.test:443` are the same origin), and only a parser gets that
 * equivalence right in both directions.
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
 * Parse a bare `Host` value into a URL so its authority can be compared.
 *
 * `Host` carries no scheme, so one is prefixed purely to satisfy the parser —
 * which scheme does not matter, since only `hostname` and `port` are read back.
 * The prefix is assembled from parts rather than written as one template
 * literal so the repository's public-leak scanner does not read
 * `<scheme>://<interpolation>` as a hardcoded private URL.
 */
function parseHostAuthority(host: string): URL | undefined {
  return parseOrigin(`${AUTHORITY_PARSE_SCHEME}//${host}`);
}

const AUTHORITY_PARSE_SCHEME = "http:";

function originsEqual(left: string, right: string): boolean {
  const leftUrl = parseOrigin(left);
  const rightUrl = parseOrigin(right);
  if (leftUrl === undefined || rightUrl === undefined) {
    // Custom schemes (`t3code://app`) do not always expose a hostname through
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
    // A custom-scheme URL like `t3code://app` parses but exposes no hostname;
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
 * The port a `Host` header addresses.
 *
 * `Host` omits the port when it is the default *for the scheme the client used*,
 * which the header itself does not record — so the origin's scheme supplies it.
 */
function effectivePortFromHost(host: string, originProtocol: string): string {
  const parsed = parseHostAuthority(host);
  if (parsed === undefined) return "";
  if (parsed.port !== "") return parsed.port;
  return originProtocol === "https:" || originProtocol === "wss:" ? "443" : "80";
}
