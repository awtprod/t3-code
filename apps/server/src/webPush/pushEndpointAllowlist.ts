// A registered browser hands the server an opaque push-service endpoint URL and
// the server POSTs an encrypted body to it. Without a guard that is a
// server-side request forgery primitive: a malicious client could point the
// endpoint at an internal address. Every endpoint must therefore be https, use
// no embedded credentials, override no port, and resolve to a known public push
// service host. The allowlist is the set of hosts the major browsers actually
// subscribe against.

const EXACT_HOSTS = new Set<string>(["fcm.googleapis.com", "updates.push.services.mozilla.com"]);

// Suffix matches for the wildcard families. A leading dot is required so
// `fcm.googleapis.com.evil.com` and `notpush.apple.com` cannot slip through.
const SUFFIX_HOSTS = [".push.apple.com", ".notify.windows.com"] as const;

// The wildcard bases themselves (the zone apex) are legitimate targets too.
const SUFFIX_APEX_HOSTS = new Set<string>(["push.apple.com", "notify.windows.com"]);

const MAX_ENDPOINT_LENGTH = 2048;

export function isAllowedPushEndpoint(endpoint: string): boolean {
  if (
    typeof endpoint !== "string" ||
    endpoint.length === 0 ||
    endpoint.length > MAX_ENDPOINT_LENGTH
  ) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") {
    return false;
  }
  // Embedded userinfo credentials and explicit ports are both rejection-worthy:
  // they are never present on a real push subscription and are classic SSRF
  // bypass shapes.
  if (url.username !== "" || url.password !== "") {
    return false;
  }
  if (url.port !== "") {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (host.length === 0) {
    return false;
  }
  if (EXACT_HOSTS.has(host) || SUFFIX_APEX_HOSTS.has(host)) {
    return true;
  }
  return SUFFIX_HOSTS.some((suffix) => host.endsWith(suffix));
}
