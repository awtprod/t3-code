/**
 * Instagram integration configuration. Ported from an earlier app's `lib/instagram/config.ts`.
 *
 * Connecting an account never publishes. The publishing kill-switch below is the guard the
 * publish path checks before it ever calls media_publish; it defaults OFF.
 */

/** Server-only env var that gates all publishing. Must be the string "true". */
export const INSTAGRAM_PUBLISHING_ENABLED_ENV = "INSTAGRAM_PUBLISHING_ENABLED";

/** Env var overriding the Graph API version (e.g. "v26.0"). */
export const INSTAGRAM_GRAPH_VERSION_ENV = "INSTAGRAM_GRAPH_VERSION";

/** Current Graph API version (v26.0, released 2026-07-29). Overridable via INSTAGRAM_GRAPH_VERSION. */
export const DEFAULT_INSTAGRAM_GRAPH_VERSION = "v26.0";

/** Host for "Instagram API with Instagram Login". NOT graph.facebook.com. */
export const INSTAGRAM_GRAPH_HOST = "graph.instagram.com";

/** Publishing kill-switch. Only the exact string "true" enables publishing. */
export function isInstagramPublishingEnabled(): boolean {
  return process.env[INSTAGRAM_PUBLISHING_ENABLED_ENV] === "true";
}

/** Resolve the Graph API version, honoring the env override when set. */
export function instagramGraphVersion(): string {
  const override = process.env[INSTAGRAM_GRAPH_VERSION_ENV]?.trim();
  return override && override.length > 0 ? override : DEFAULT_INSTAGRAM_GRAPH_VERSION;
}

/** Base URL for Graph API calls, e.g. https://graph.instagram.com/v26.0 */
export function instagramGraphBaseUrl(): string {
  return `https://${INSTAGRAM_GRAPH_HOST}/${instagramGraphVersion()}`;
}
