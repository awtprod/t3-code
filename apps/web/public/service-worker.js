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
