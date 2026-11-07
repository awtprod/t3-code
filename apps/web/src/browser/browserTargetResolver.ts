import type {
  BrowserNavigationTarget,
  EnvironmentId,
  PreviewUrlResolution,
  ServerPreviewGateway,
} from "@t3tools/contracts";
import { isLoopbackHost, normalizePreviewUrl } from "@t3tools/shared/preview";
import {
  isLocalLoopbackHost,
  isPrivateNetworkHost,
  normalizeHostname,
} from "@t3tools/shared/hostClassification";
import { buildPreviewGatewaySelectUrl } from "@t3tools/shared/previewGateway";

import type { ConnectionTarget } from "@t3tools/client-runtime/connection";

import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { isElectron } from "~/env";
import { readServerConfig } from "~/state/server";
import { readPreparedConnection } from "~/state/session";

export { normalizeHostname, isLocalLoopbackHost } from "@t3tools/shared/hostClassification";

// Command Center: previews also treat `.lan` and `.internal` hosts as same-network.
const isPreviewPrivateNetworkHost = (host: string): boolean => {
  const normalized = normalizeHostname(host);
  return (
    isPrivateNetworkHost(normalized) ||
    normalized.endsWith(".lan") ||
    normalized.endsWith(".internal")
  );
};

const readEnvironmentUrl = (environmentId: EnvironmentId): URL => {
  const connection = readPreparedConnection(environmentId);
  if (!connection) throw new Error(`Environment ${environmentId} is not connected.`);
  return new URL(connection.httpBaseUrl);
};

// The gateway serves at its port root, so the dev server's absolute URLs and HMR work unchanged.
// It is reached on the host the client already used; the server cannot know which address works.
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

  // A local environment dials the port directly. Elsewhere an advertised gateway wins: dev servers
  // bind 127.0.0.1, so `host:5173` hangs even when `host` answers. Direct is for gateway-less servers.
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
    if (!isPreviewPrivateNetworkHost(normalizedEnvironmentHost)) {
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
