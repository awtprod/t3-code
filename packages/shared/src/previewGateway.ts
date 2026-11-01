/**
 * Wire contract for the preview gateway (`apps/server/src/preview/`), shared so client
 * and server cannot drift on the path. It is mounted at the root of its own port, not
 * under `/preview/<port>/`, because dev servers emit absolute URLs (`/@vite/client`)
 * that would 404 there; the port is chosen once via {@link PREVIEW_GATEWAY_SELECT_PATH}.
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
 * Build the URL that selects an upstream port and then lands on `to`: the gateway
 * answers with a `303` that sets the port cookie. `to` is forced to an absolute path:
 * the gateway refuses anything else (a scheme-relative `//host` would be an open
 * redirect), and sending a value it discards would strand the browser at `/`.
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
