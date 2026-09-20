const CACHE_PREFIX = "command-center-static-";
const CACHE_NAME = `${CACHE_PREFIX}v1`;

// Keep this allowlist deliberately small. The authenticated application shell,
// API responses, attachments, and navigation requests must always go to the
// network and are never written to Cache Storage.
const STATIC_ASSET_TYPES = new Map([
  ["/command-center-mark.svg", ["image/svg+xml"]],
  ["/command-center-icon-180.png", ["image/png"]],
  ["/manifest.webmanifest", ["application/manifest+json", "application/json"]],
  ["/pwa-icon-192.png", ["image/png"]],
  ["/pwa-icon-512.png", ["image/png"]],
]);

function isCacheableStaticResponse(pathname, response) {
  const allowedTypes = STATIC_ASSET_TYPES.get(pathname);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const cacheControl = response.headers.get("cache-control")?.toLowerCase() ?? "";

  return (
    response.ok &&
    response.type !== "opaque" &&
    !cacheControl.includes("private") &&
    !cacheControl.includes("no-store") &&
    allowedTypes?.some((allowedType) => contentType.startsWith(allowedType)) === true
  );
}

function publicStaticRequest(pathname) {
  return new Request(new URL(pathname, self.location.origin), {
    cache: "reload",
    credentials: "omit",
    mode: "same-origin",
  });
}

async function refreshStaticAsset(pathname) {
  const response = await fetch(publicStaticRequest(pathname));
  if (!isCacheableStaticResponse(pathname, response)) return;

  const cache = await caches.open(CACHE_NAME);
  await cache.put(pathname, response);
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    Promise.all(
      [...STATIC_ASSET_TYPES.keys()].map((pathname) =>
        refreshStaticAsset(pathname).catch(() => undefined),
      ),
    ).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !STATIC_ASSET_TYPES.has(url.pathname)) return;

  event.respondWith(
    caches.match(url.pathname).then((cached) => {
      if (cached) return cached;

      return fetch(publicStaticRequest(url.pathname)).then((response) => {
        if (!isCacheableStaticResponse(url.pathname, response)) return response;

        const cacheCopy = response.clone();
        void caches.open(CACHE_NAME).then((cache) => cache.put(url.pathname, cacheCopy));
        return response;
      });
    }),
  );
});

// Deep links from push payloads open in-app but originate from the relay;
// accept exactly /threads/{environmentId}/{threadId} (the contract shared with
// the mobile app's normalizeThreadDeepLink) and fall back to the app root.
// The web router serves threads at /{environmentId}/{threadId} (no /threads
// prefix), so the validated link is rewritten to the web route.
function threadDeepLinkFromPayload(data) {
  const deepLink = typeof data?.deepLink === "string" ? data.deepLink : "";
  if (
    deepLink.trim() !== deepLink ||
    deepLink.startsWith("//") ||
    deepLink.includes("?") ||
    deepLink.includes("#")
  ) {
    return "/";
  }
  const parts = deepLink.split("/");
  if (parts.length !== 4 || parts[0] !== "" || parts[1] !== "threads" || !parts[2] || !parts[3]) {
    return "/";
  }
  return `/${parts[2]}/${parts[3]}`;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isBoundedText(value, maxLength) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value
  );
}

function decodeProspectDeepLink(deepLink) {
  if (
    typeof deepLink !== "string" ||
    deepLink.includes("?") ||
    deepLink.includes("#") ||
    !deepLink.startsWith("/prospects/")
  ) {
    return null;
  }
  const segment = deepLink.slice("/prospects/".length);
  if (!segment || segment.includes("/")) return null;
  try {
    const itemId = decodeURIComponent(segment);
    return itemId.startsWith("prospect-review:") && encodeURIComponent(itemId) === segment
      ? itemId
      : null;
  } catch {
    return null;
  }
}

function decodePushPayload(value) {
  if (!isPlainObject(value)) return null;
  if (value.type === "prospect") {
    if (
      !hasExactlyKeys(value, [
        "type",
        "itemId",
        "spaceId",
        "evaluationId",
        "environmentId",
        "title",
        "body",
        "deepLink",
      ]) ||
      !isBoundedText(value.itemId, 512) ||
      !isBoundedText(value.spaceId, 256) ||
      !isBoundedText(value.evaluationId, 256) ||
      !isBoundedText(value.environmentId, 512) ||
      !isBoundedText(value.title, 120) ||
      !isBoundedText(value.body, 240)
    ) {
      return null;
    }
    const deepLinkItemId = decodeProspectDeepLink(value.deepLink);
    return deepLinkItemId === value.itemId ? value : null;
  }
  if (
    !hasExactlyKeys(value, ["title", "body", "environmentId", "threadId", "deepLink"]) ||
    !isBoundedText(value.title, 120) ||
    !isBoundedText(value.body, 120) ||
    !isBoundedText(value.environmentId, 512) ||
    !isBoundedText(value.threadId, 512) ||
    threadDeepLinkFromPayload(value) === "/"
  ) {
    return null;
  }
  return { type: "thread", ...value };
}

function notificationTargetFromData(data) {
  return data?.type === "prospect" ? "/prospects" : threadDeepLinkFromPayload(data);
}

// Payloads are encrypted in transit (RFC 8291) and produced solely by the
// relay's WebPushClient; see WebPushNotificationPayload for the shape.
self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = decodePushPayload(event.data.json());
  } catch {
    return;
  }
  if (payload === null) return;

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/pwa-icon-192.png",
      // One notification per thread: a newer phase replaces the stale one
      // instead of stacking.
      tag:
        payload.type === "prospect"
          ? `prospect:${payload.itemId}`
          : `thread:${payload.environmentId}:${payload.threadId}`,
      data: {
        type: payload.type,
        deepLink: payload.deepLink,
      },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(
    notificationTargetFromData(event.notification.data),
    self.location.origin,
  ).toString();

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const existing = windows.find(
        (client) => new URL(client.url).origin === self.location.origin,
      );
      if (existing) {
        return Promise.resolve(existing.focus()).then((focused) =>
          "navigate" in focused ? focused.navigate(target) : undefined,
        );
      }
      return self.clients.openWindow(target);
    }),
  );
});

// The push service can rotate a subscription at any time; hand the new one to
// the app on next launch by nudging every open client (registration with the
// relay needs the DPoP key, which only the app holds).
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windows) =>
        Promise.all(
          windows.map((client) => client.postMessage({ type: "push-subscription-change" })),
        ),
      ),
  );
});
