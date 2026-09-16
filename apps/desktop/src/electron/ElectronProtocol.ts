import Mime from "@effect/platform-node/Mime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeTimersPromises from "node:timers/promises";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as Electron from "electron";

export const DESKTOP_HOST = "app";
const DESKTOP_PRODUCTION_SCHEME = "commandcenter";
const DESKTOP_DEVELOPMENT_SCHEME = "commandcenter-dev";

export function getDesktopScheme(isDevelopment: boolean): string {
  return isDevelopment ? DESKTOP_DEVELOPMENT_SCHEME : DESKTOP_PRODUCTION_SCHEME;
}

/**
 * Declare the desktop schemes standard *before* Electron is ready.
 *
 * Custom schemes are non-standard by default, and Chromium gives a
 * non-standard scheme an **opaque** origin — every request the renderer makes
 * carries `Origin: null` rather than `commandcenter://app`. That matters beyond
 * tidiness: the server rejects `null` on the control-plane WebSocket upgrade
 * (`apps/server/src/auth/websocketOrigin.ts`), because `null` is also what a
 * sandboxed hostile iframe sends, so it cannot be allow-listed. Without this
 * call the renderer is indistinguishable from that attacker and is refused.
 *
 * Measured with a real Electron renderer on `commandcenter://app`: with
 * `protocol.handle` alone the upgrade arrives as `Origin: null`; adding this
 * registration makes it arrive as `Origin: commandcenter://app`.
 *
 * Must be called at module scope — Electron requires it before the `ready`
 * event, and it throws if called afterwards. Measured on Electron 41.5.0:
 * `ready` fires ~87 ms in, and a caller that awaits any real I/O first is
 * already too late, so this cannot be moved inside a layer.
 *
 * **This is deliberately not the only registration of these schemes.**
 * `@clerk/electron`'s `createClerkBridge` registers whichever scheme is active
 * (see `../app/DesktopClerk.ts`), and Electron documents the API as one-shot.
 * Measured on the pinned version, a second call before `ready` neither throws
 * nor replaces: the privileges *merge*, and `standard: true` wins regardless of
 * which call sets it. Clerk's registration is nonetheless not sufficient on its
 * own — it only covers the active scheme, and it runs during layer construction,
 * which is the window `ready` can beat. The privileges below are kept identical
 * to Clerk's so the merged result does not depend on call order.
 */
export function registerDesktopSchemesAsPrivileged(): void {
  Electron.protocol.registerSchemesAsPrivileged(
    [DESKTOP_PRODUCTION_SCHEME, DESKTOP_DEVELOPMENT_SCHEME].map((scheme) => ({
      scheme,
      privileges: {
        // `standard` is the one that grants a real origin; the rest keep the
        // renderer's capabilities equivalent to the https page it replaces, and
        // match `@clerk/electron`'s own registration exactly.
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        allowServiceWorkers: true,
        stream: true,
      },
    })),
  );
}

function getDesktopOrigin(isDevelopment: boolean): string {
  return `${getDesktopScheme(isDevelopment)}://${DESKTOP_HOST}`;
}

export function getDesktopUrl(isDevelopment: boolean): string {
  return `${getDesktopOrigin(isDevelopment)}/`;
}

export class ElectronProtocolRegistrationError extends Schema.TaggedError<ElectronProtocolRegistrationError>()(
  "ElectronProtocolRegistrationError",
  {
    scheme: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to register Electron protocol scheme "${this.scheme}".`;
  }
}

export class ElectronProtocolUnregistrationError extends Schema.TaggedError<ElectronProtocolUnregistrationError>()(
  "ElectronProtocolUnregistrationError",
  {
    scheme: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to unregister Electron protocol scheme "${this.scheme}".`;
  }
}

// The scheme either proxies to a dev server (`targetOrigin`) or serves the
// built client from disk (`assetDirectory`).
export type DesktopProtocolRegistrationInput = {
  readonly scheme: string;
  readonly clerkFrontendApiHostname: string | undefined;
  // Remote-only installers package the renderer but deliberately omit
  // apps/server. Serve that static client from the desktop protocol while its
  // Connections records make direct bearer-authenticated requests to servers.
  readonly staticClientRoot?: string;
} & ({ readonly targetOrigin: URL } | { readonly assetDirectory: string });

export class ElectronProtocol extends Context.Service<
  ElectronProtocol,
  {
    readonly registerDesktopProtocol: (
      input: DesktopProtocolRegistrationInput,
    ) => Effect.Effect<void, ElectronProtocolRegistrationError, Scope.Scope>;
  }
>()("@t3tools/desktop/electron/ElectronProtocol") {}

export function makeDesktopContentSecurityPolicy(input: DesktopProtocolRegistrationInput): string {
  const clerkOrigin = input.clerkFrontendApiHostname
    ? `https://${input.clerkFrontendApiHostname}`
    : undefined;
  const scriptSources = [
    "'self'",
    "'unsafe-inline'",
    "'wasm-unsafe-eval'",
    ...(clerkOrigin ? [clerkOrigin] : []),
    "https://challenges.cloudflare.com",
  ];

  // The renderer connects directly to user-configured environments in addition to
  // the build-configured Clerk, relay, and OTLP endpoints. Those environment
  // origins are not known when this response policy is created, so restrict
  // connections by the network schemes the client supports instead of by host.
  const connectSources = ["'self'", "http:", "https:", "ws:", "wss:"];

  return [
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    `connect-src ${connectSources.join(" ")}`,
    `img-src 'self' ${input.scheme}: blob: data: http: https:`,
    `media-src 'self' ${input.scheme}: blob: http: https:`,
    "style-src 'self' 'unsafe-inline'",
    `font-src 'self' ${input.scheme}: data:`,
    "worker-src 'self' blob:",
    // Document viewers use local Blob URLs and signed assets from runtime environments.
    // HTML viewers retain their own sandbox; the renderer's script policy stays unchanged.
    "frame-src 'self' blob: http: https:",
    "form-action 'self'",
  ].join("; ");
}

function withContentSecurityPolicy(response: Response, policy: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", policy);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Must run synchronously during process bootstrap, before Electron emits `ready`.
 */
function registerDesktopSchemePrivilegesSync(): void {
  Electron.protocol.registerSchemesAsPrivileged([
    {
      scheme: DESKTOP_PRODUCTION_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
    {
      scheme: DESKTOP_DEVELOPMENT_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

const registerDesktopSchemePrivileges = Effect.sync(registerDesktopSchemePrivilegesSync).pipe(
  Effect.withSpan("desktop.electron.protocol.registerSchemePrivileges"),
);

export const layerSchemePrivileges = Layer.effectDiscard(registerDesktopSchemePrivileges);

async function proxyRequest(
  request: Request,
  targetOrigin: URL,
  contentSecurityPolicy: string,
): Promise<Response> {
  const requestUrl = new URL(request.url);
  if (requestUrl.host !== DESKTOP_HOST) {
    return new Response(null, { status: 404 });
  }

  const targetUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, targetOrigin);
  const headers = new Headers(request.headers);
  const headersToRemove: string[] = [];
  for (const name of headers.keys()) {
    if (
      name === "host" ||
      name === "origin" ||
      name === "referer" ||
      name === "connection" ||
      name === "content-length" ||
      name === "accept-encoding" ||
      name === "upgrade-insecure-requests" ||
      name.startsWith("sec-fetch-")
    ) {
      headersToRemove.push(name);
    }
  }
  for (const name of headersToRemove) {
    headers.delete(name);
  }
  const init: RequestInit = {
    method: request.method,
    headers,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    (init as RequestInit & { duplex: "half" }).duplex = "half";
  }
  const response =
    request.method === "GET" || request.method === "HEAD"
      ? await fetchWithTransientRetry(targetUrl.toString(), init)
      : await Electron.net.fetch(targetUrl.toString(), init);
  return withContentSecurityPolicy(response, contentSecurityPolicy);
}

const staticClientContentTypes: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
};

export function resolveStaticClientPath(
  path: Path.Path,
  clientRoot: string,
  requestPathname: string,
): string | null {
  let pathname: string;
  try {
    pathname = decodeURIComponent(requestPathname);
  } catch {
    return null;
  }
  const root = path.resolve(clientRoot);
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = path.resolve(root, requested);
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return candidate;
}

async function staticClientResponse(
  request: Request,
  clientRoot: string,
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
): Promise<Response> {
  const requestUrl = new URL(request.url);
  const candidate = resolveStaticClientPath(path, clientRoot, requestUrl.pathname);
  if (candidate === null) return new Response(null, { status: 404 });

  const extension = path.extname(candidate).toLowerCase();
  const fallbackToIndex = extension.length === 0;
  const filePath = fallbackToIndex ? path.join(clientRoot, "index.html") : candidate;
  try {
    const body = Uint8Array.from(await Effect.runPromise(fileSystem.readFile(filePath)));
    return new Response(body.buffer, {
      headers: {
        "content-type":
          staticClientContentTypes[path.extname(filePath).toLowerCase()] ??
          "application/octet-stream",
      },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}

const TRANSIENT_FETCH_RETRY_DELAYS_MS = [0, 50, 150] as const;

// Serves the packaged web client without a backend: files resolve within the
// asset directory, and any other path falls back to index.html so the SPA
// router handles it, except for asset-shaped misses (`/missing.js`) which 404.
const serveDesktopAsset = Effect.fn("desktop.protocol.serveAsset")(function* (
  request: Request,
  assetDirectory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const url = new URL(request.url);
  if (url.host !== DESKTOP_HOST) return new Response(null, { status: 404 });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405 });
  }
  const pathname = yield* Effect.try(() => decodeURIComponent(url.pathname)).pipe(
    Effect.orElseSucceed(() => null),
  );
  if (pathname === null || pathname.includes("\0")) return new Response(null, { status: 400 });
  const root = path.resolve(assetDirectory);
  const assetPath = path.resolve(root, `.${pathname}`);
  if (assetPath !== root && !assetPath.startsWith(root + path.sep)) {
    return new Response(null, { status: 404 });
  }
  const stat = yield* fileSystem.stat(assetPath).pipe(Effect.orElseSucceed(() => null));
  let filePath = assetPath;
  if (stat?.type !== "File") {
    const wantsHtml = request.headers.get("accept")?.includes("text/html") ?? false;
    if (path.extname(assetPath) !== "" && !wantsHtml) {
      return new Response(null, { status: 404 });
    }
    filePath = path.join(root, "index.html");
  }
  const contents = yield* fileSystem.readFile(filePath).pipe(Effect.orElseSucceed(() => null));
  if (contents === null) return new Response(null, { status: 404 });
  return new Response(request.method === "HEAD" ? null : new Uint8Array(contents), {
    headers: { "content-type": Mime.getType(filePath) ?? "application/octet-stream" },
  });
});

async function fetchWithTransientRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: unknown;

  for (const delayMs of TRANSIENT_FETCH_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await NodeTimersPromises.setTimeout(delayMs);
    }

    try {
      return await Electron.net.fetch(url, init);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const registered = yield* Ref.make(false);
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const runPromise = Effect.runPromiseWith(context);

  const registerDesktopProtocol = Effect.fn("desktop.electron.protocol.registerDesktopProtocol")(
    function* (input: DesktopProtocolRegistrationInput) {
      if (yield* Ref.get(registered)) return;

      const contentSecurityPolicy = makeDesktopContentSecurityPolicy(input);

      yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            Electron.protocol.handle(input.scheme, async (request) => {
              if (input.staticClientRoot) {
                return withContentSecurityPolicy(
                  await staticClientResponse(request, input.staticClientRoot, fileSystem, path),
                  contentSecurityPolicy,
                );
              }
              if ("assetDirectory" in input) {
                return withContentSecurityPolicy(
                  await runPromise(serveDesktopAsset(request, input.assetDirectory)),
                  contentSecurityPolicy,
                );
              }
              return proxyRequest(request, input.targetOrigin, contentSecurityPolicy);
            });
          },
          catch: (cause) => new ElectronProtocolRegistrationError({ scheme: input.scheme, cause }),
        }).pipe(Effect.andThen(Ref.set(registered, true))),
        () =>
          Effect.try({
            try: () => Electron.protocol.unhandle(input.scheme),
            catch: (cause) =>
              new ElectronProtocolUnregistrationError({
                scheme: input.scheme,
                cause,
              }),
          }).pipe(Effect.andThen(Ref.set(registered, false)), Effect.orDie),
      );
    },
  );

  return ElectronProtocol.of({ registerDesktopProtocol });
});

export const layer = Layer.effect(ElectronProtocol, make);
