import type {
  BrowserNavigationTarget,
  EnvironmentId,
  PreviewUrlResolution,
  ServerPreviewGateway,
} from "@t3tools/contracts";
import { isLoopbackHost, normalizePreviewUrl } from "@t3tools/shared/preview";
import { buildPreviewGatewaySelectUrl } from "@t3tools/shared/previewGateway";

import { readServerConfig } from "~/state/server";
import { readPreparedConnection } from "~/state/session";

const normalizeHostname = (host: string): string => host.toLowerCase().replace(/^\[|\]$/g, "");

const parseIpv4Address = (host: string): readonly number[] | null => {
  const parts = normalizeHostname(host).split(".").map(Number);
  return parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
};

const isLocalLoopbackHost = (host: string): boolean => {
  const normalized = normalizeHostname(host);
  if (normalized === "localhost" || normalized === "::1") return true;
  return parseIpv4Address(normalized)?.[0] === 127;
};

const PRIVATE_NETWORK_DNS_SUFFIXES = [".home.arpa", ".internal", ".lan", ".local"] as const;

const isPrivateNetworkHost = (host: string): boolean => {
  const normalized = normalizeHostname(host);
  if (
    isLocalLoopbackHost(normalized) ||
    (!normalized.includes(".") && !normalized.includes(":")) ||
    PRIVATE_NETWORK_DNS_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  ) {
    return true;
  }
  if (normalized.endsWith(".ts.net")) return true;
  const parts = parseIpv4Address(normalized);
  if (parts) {
    return (
      parts[0] === 10 ||
      (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127) ||
      (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 169 && parts[1] === 254)
    );
  }
  const firstIpv6Token = normalized.split(":", 1)[0] ?? "";
  if (!normalized.includes(":") || !/^[\da-f]{1,4}$/u.test(firstIpv6Token)) return false;
  const firstIpv6Hextet = Number.parseInt(firstIpv6Token, 16);
  return (
    Number.isInteger(firstIpv6Hextet) &&
    ((firstIpv6Hextet & 0xfe00) === 0xfc00 || (firstIpv6Hextet & 0xffc0) === 0xfe80)
  );
};

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

  const resolvedHost = normalizedEnvironmentHost.includes(":")
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

export function resolveBrowserNavigationTarget(
  environmentId: EnvironmentId,
  target: BrowserNavigationTarget,
): PreviewUrlResolution {
  if (target.kind === "url") {
    let parsed: URL | null = null;
    try {
      parsed = new URL(normalizePreviewUrl(target.url));
    } catch {
      // Preserve the existing direct-navigation behavior so the preview host
      // reports malformed URL errors through its normal navigation path.
    }
    if (parsed && isLoopbackHost(parsed.hostname)) {
      const environmentUrl = readEnvironmentUrl(environmentId);
      if (parsed.hostname === "0.0.0.0" || !isLocalLoopbackHost(environmentUrl.hostname)) {
        return resolveEnvironmentPortTarget(
          environmentId,
          {
            kind: "environment-port",
            port: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)),
            protocol: parsed.protocol === "https:" ? "https" : "http",
            path: `${parsed.pathname}${parsed.search}${parsed.hash}`,
          },
          environmentUrl,
          target.url,
          parsed,
        );
      }
    }
    return {
      requestedUrl: target.url,
      resolvedUrl: target.url,
      resolutionKind: "direct",
      environmentId,
    };
  }
  return resolveEnvironmentPortTarget(environmentId, target, readEnvironmentUrl(environmentId));
}

export function resolveDiscoveredServerUrl(environmentId: EnvironmentId, rawUrl: string): string {
  try {
    const normalizedUrl = normalizePreviewUrl(rawUrl);
    return resolveBrowserNavigationTarget(environmentId, {
      kind: "url",
      url: normalizedUrl,
    }).resolvedUrl;
  } catch {
    return rawUrl;
  }
}
