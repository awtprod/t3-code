/**
 * Origins the Electron renderer loads from.
 *
 * The renderer is served from a custom scheme rather than over HTTP, so its
 * origin matches no `Host` header the server could ever see and has to be named
 * explicitly. Shared by the CORS layer (`./http.ts`) and the WebSocket origin
 * check (`./ws.ts`) so the two cannot drift into disagreeing about which
 * clients are legitimate.
 */
export const DESKTOP_RENDERER_ORIGINS = ["t3code://app", "t3code-dev://app"] as const;

export const browserApiCorsAllowedMethods = ["GET", "POST", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "dpop",
] as const;

export const browserApiCorsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": browserApiCorsAllowedMethods.join(", "),
  "access-control-allow-headers": browserApiCorsAllowedHeaders.join(", "),
} as const;
