import type {
  BrowserNavigationTarget,
  EnvironmentId,
  PreviewUrlResolution,
  ServerPreviewGateway,
} from "@t3tools/contracts";
import { isLoopbackHost, normalizePreviewUrl } from "@t3tools/shared/preview";
import { isLocalLoopbackHost, isPrivateNetworkHost } from "@t3tools/shared/hostClassification";
import { buildPreviewGatewaySelectUrl } from "@t3tools/shared/previewGateway";

import type { ConnectionTarget } from "@t3tools/client-runtime/connection";

import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { isElectron } from "~/env";
import { readServerConfig } from "~/state/server";
import { readPreparedConnection } from "~/state/session";

export { normalizeHostname, isLocalLoopbackHost } from "@t3tools/shared/hostClassification";

const readEnvironmentUrl = (environmentId: EnvironmentId): URL => {
  const connection = readPreparedConnection(environmentId);
  if (!connection) throw new Error(`Environment ${environmentId} is not connected.`);
  return new URL(connection.httpBaseUrl);
};

/**
 * Point a preview at the environment's authenticated preview gateway.
 *
 * The gateway is mounted at the root of its own port, so the URL selects the
 * upstream port once and then lands on the requested path; from there the dev
 * server sees itself at `/` and its absolute URLs and HMR socket work unchanged.
 *
 * The gateway is reached on the same host the client already reached the server
 * on — that address is the one known to work from here, and the server cannot
 * know which of its several addresses that was.
 */
const buildGatewayResolution = (input: {
  readonly environmentId: EnvironmentId;
  readonly gateway: ServerPreviewGateway;
  readonly environmentUrl: URL;
  readonly port: number;
  readonly path: string;
  readonly requestedUrl: string;
}): PreviewUrlResolution | null => {
  const gatewayUrl = new URL(input.environmentUrl);
  if (isLocalLoopbackHost(gatewayUrl.hostname)) {
    // Same machine: the gateway's own loopback listener is directly reachable.
    gatewayUrl.port = String(input.gateway.loopbackPort);
  } else if (input.gateway.publicHttpsPort !== undefined) {
    // Another machine: only the published HTTPS port is reachable, and it is
    // always HTTPS because Tailscale Serve terminates TLS.
    gatewayUrl.protocol = "https:";
    gatewayUrl.port = String(input.gateway.publicHttpsPort);
  } else {
    // A gateway bound to the server's loopback with nothing publishing it is
    // not reachable from here; say so rather than build a URL that will hang.
    return null;
  }
  return {
    requestedUrl: input.requestedUrl,
    resolvedUrl: buildPreviewGatewaySelectUrl({
      gatewayOrigin: gatewayUrl.toString(),
      port: input.port,
      to: input.path,
    }),
    resolutionKind: "preview-gateway",
    environmentId: input.environmentId,
  };
};

const resolveEnvironmentPortTarget = (
  environmentId: EnvironmentId,
  target: Extract<BrowserNavigationTarget, { readonly kind: "environment-port" }>,
  environmentUrl: URL,
  requestedUrl?: string,
  sourceUrl?: URL,
): PreviewUrlResolution => {
  const protocol = target.protocol ?? "http";
  const path = target.path?.startsWith("/") ? target.path : `/${target.path ?? ""}`;
  const normalizedEnvironmentHost = environmentUrl.hostname.replace(/^\[|\]$/g, "");
  const fallbackRequestedUrl = requestedUrl ?? `${protocol}://localhost:${target.port}${path}`;
  const isLocalEnvironment = isLocalLoopbackHost(normalizedEnvironmentHost);

  // When the environment is *this* machine the dev server's own port is right
  // here, so dialling it directly is both correct and certain — no gateway hop,
  // no cookie. Every other case goes through the gateway when one is advertised.
  //
  // The gateway wins over dialling the environment's host directly (rather than
  // being a fallback for it) because a private-network host is only *routable*,
  // not reachable on that port: dev servers bind `127.0.0.1`, so `host:5173`
  // hangs even though `host` answers. The gateway forwards from the server's own
  // loopback, which is where the dev server actually is. Direct remains the path
  // for servers that run no gateway, which is how this behaved before.
  if (!isLocalEnvironment) {
    const gateway = readServerConfig(environmentId)?.previewGateway;
    const viaGateway =
      gateway === undefined
        ? null
        : buildGatewayResolution({
            environmentId,
            gateway,
            environmentUrl,
            port: target.port,
            path,
            requestedUrl: fallbackRequestedUrl,
          });
    if (viaGateway) return viaGateway;
    if (!isPrivateNetworkHost(normalizedEnvironmentHost)) {
      throw new Error(
        "This environment port needs the authenticated preview gateway, which this server is not running or publishing.",
      );
    }
  }

  // localhost lets Chromium reach loopback servers bound to either IPv4 or IPv6.
  const resolvedHost = isLocalEnvironment
    ? "localhost"
    : normalizedEnvironmentHost.includes(":")
      ? `[${normalizedEnvironmentHost}]`
      : normalizedEnvironmentHost;
  const resolved = sourceUrl
    ? new URL(sourceUrl)
    : new URL(path, `${protocol}://${resolvedHost}:${target.port}`);
  if (sourceUrl) {
    resolved.hostname = resolvedHost;
    resolved.port = String(target.port);
  }
  return {
    requestedUrl: fallbackRequestedUrl,
    resolvedUrl: resolved.toString(),
    resolutionKind: isLocalEnvironment ? "direct" : "direct-private-network",
    environmentId,
  };
};

/**
 * Command Center: in a remote environment a loopback URL names the server's own
 * dev server, which only the authenticated preview gateway can reach. Route it
 * there when the server publishes a gateway; otherwise keep upstream's
 * explicit-URL behaviour (navigate exactly as typed).
 */
const resolveLoopbackUrlViaGateway = (
  environmentId: EnvironmentId,
  url: string,
): PreviewUrlResolution | null => {
  const gateway = readServerConfig(environmentId)?.previewGateway;
  if (gateway === undefined) return null;
  let parsed: URL;
  try {
    parsed = new URL(normalizePreviewUrl(url));
  } catch {
    return null;
  }
  if (!isLoopbackHost(parsed.hostname)) return null;
  const environmentUrl = readEnvironmentUrl(environmentId);
  if (isLocalLoopbackHost(environmentUrl.hostname.replace(/^\[|\]$/g, ""))) return null;
  return buildGatewayResolution({
    environmentId,
    gateway,
    environmentUrl,
    port: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)),
    path: `${parsed.pathname}${parsed.search}${parsed.hash}`,
    requestedUrl: url,
  });
};

export function resolveBrowserNavigationTarget(
  environmentId: EnvironmentId,
  target: BrowserNavigationTarget,
): PreviewUrlResolution {
  if (target.kind === "url") {
    const viaGateway = resolveLoopbackUrlViaGateway(environmentId, target.url);
    if (viaGateway) return viaGateway;
    return {
      requestedUrl: target.url,
      resolvedUrl: target.url,
      resolutionKind: "direct",
      environmentId,
    };
  }
  return resolveEnvironmentPortTarget(environmentId, target, readEnvironmentUrl(environmentId));
}

// Desktop renders primary and WSL tabs locally; loopback servers require localhost even for LAN backends.
const reachesEnvironmentLoopback = (target: ConnectionTarget): boolean =>
  isElectron &&
  (target._tag === "PrimaryConnectionTarget" || isDesktopLocalConnectionTarget(target));

export function resolveDiscoveredServerUrl(environmentId: EnvironmentId, rawUrl: string): string {
  try {
    const normalizedUrl = normalizePreviewUrl(rawUrl);
    const parsed = new URL(normalizedUrl);
    if (!isLoopbackHost(parsed.hostname)) return normalizedUrl;
    const target = readPreparedConnection(environmentId)?.target;
    if (target && reachesEnvironmentLoopback(target)) return normalizedUrl;
    return resolveEnvironmentPortTarget(
      environmentId,
      {
        kind: "environment-port",
        port: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)),
        protocol: parsed.protocol === "https:" ? "https" : "http",
        path: `${parsed.pathname}${parsed.search}${parsed.hash}`,
      },
      readEnvironmentUrl(environmentId),
      rawUrl,
      parsed,
    ).resolvedUrl;
  } catch {
    return rawUrl;
  }
}
