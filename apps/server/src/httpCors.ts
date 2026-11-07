import { ORCHESTRATION_PROTOCOL_HEADER } from "@t3tools/contracts";

export const browserApiCorsAllowedMethods = ["GET", "POST", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "dpop",
  ORCHESTRATION_PROTOCOL_HEADER,
] as const;

/**
 * Origins the Electron renderer loads from: a custom scheme, so its origin
 * matches no `Host` header and must be named explicitly. Shared by the CORS
 * layer and the WebSocket origin check so they cannot disagree on legitimate clients.
 */
export const DESKTOP_RENDERER_ORIGINS = [
  "commandcenter://app",
  "commandcenter-dev://app",
  // Retained for the existing T3 mobile clients and upstream-compatible builds.
  "t3code://app",
  "t3code-dev://app",
] as const;
