/**
 * The wire contract between the preview gateway (`apps/server/src/preview/`) and
 * the clients that point a preview at it.
 *
 * The gateway is mounted at the **root** of its own port rather than under a
 * `/preview/<port>/` prefix, because dev servers emit absolute URLs
 * (`/@vite/client`, `/src/main.tsx`, the HMR socket) that resolve against the
 * gateway origin and would 404 under a prefix. Root mounting means the request
 * path can no longer name the upstream, so the port is chosen once via
 * {@link PREVIEW_GATEWAY_SELECT_PATH} and then travels in a signed cookie.
 *
 * These names live in `shared` rather than in the server because the client has
 * to build the select URL, and a second copy of the path would be a silent
 * mismatch waiting to happen.
 */

/**
 * Where a client selects which loopback port the gateway forwards to.
 *
 * Namespaced out of the way of anything a dev server would plausibly serve; it
 * is the one path on this origin the gateway answers itself.
 */
export const PREVIEW_GATEWAY_SELECT_PATH = "/__t3-preview/select";

/** Query parameter naming the loopback port to forward to. */
export const PREVIEW_GATEWAY_PORT_PARAM = "port";

/** Query parameter naming where to send the browser after a successful selection. */
export const PREVIEW_GATEWAY_REDIRECT_PARAM = "to";

/**
 * Build the URL that selects an upstream port and then lands on `to`.
 *
 * The gateway answers this with a `303` that sets the port cookie, so a single
 * navigation both selects the upstream and loads the page.
 *
 * `to` is forced to an absolute path: the gateway refuses anything else (a
 * scheme-relative `//host` would be an open redirect), and silently sending a
 * value that will be discarded server-side would strand the browser at `/`.
 */
export function buildPreviewGatewaySelectUrl(input: {
  readonly gatewayOrigin: string;
  readonly port: number;
  readonly to?: string;
}): string {
  const url = new URL(PREVIEW_GATEWAY_SELECT_PATH, input.gatewayOrigin);
  url.searchParams.set(PREVIEW_GATEWAY_PORT_PARAM, String(input.port));
  url.searchParams.set(PREVIEW_GATEWAY_REDIRECT_PARAM, normalizeRedirectTarget(input.to));
  return url.toString();
}

function normalizeRedirectTarget(to: string | undefined): string {
  if (to === undefined || to === "") return "/";
  // Browsers treat a backslash in the authority position as a slash, so `/\host`
  // is scheme-relative just like `//host`. Fold them together before collapsing
  // so both forms normalise to the same same-origin path; the gateway rejects
  // either one outright, and this keeps the intended path instead.
  const slashed = to.replaceAll("\\", "/");
  if (slashed.startsWith("//")) return `/${slashed.replace(/^\/+/, "")}`;
  return slashed.startsWith("/") ? slashed : `/${slashed}`;
}
