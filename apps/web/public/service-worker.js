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

// Payloads are encrypted in transit (RFC 8291) and produced solely by the
// relay's WebPushClient; see WebPushNotificationPayload for the shape.
self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    return;
  }
  if (typeof payload?.title !== "string" || typeof payload?.body !== "string") {
    return;
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/pwa-icon-192.png",
      // One notification per thread: a newer phase replaces the stale one
      // instead of stacking.
      tag:
        typeof payload.environmentId === "string" && typeof payload.threadId === "string"
          ? `thread:${payload.environmentId}:${payload.threadId}`
          : undefined,
      data: {
        deepLink: typeof payload.deepLink === "string" ? payload.deepLink : undefined,
      },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(
    threadDeepLinkFromPayload(event.notification.data),
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
