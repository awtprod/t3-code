import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const readPreparedConnection = vi.fn();
const readServerConfig = vi.fn();

vi.mock("~/state/session", () => ({ readPreparedConnection }));
vi.mock("~/state/server", () => ({ readServerConfig }));

/** A server advertising a gateway that is published for other machines. */
const withPublishedGateway = () =>
  readServerConfig.mockReturnValue({
    previewGateway: { loopbackPort: 3774, publicHttpsPort: 8445 },
  });

describe("browser target resolver", () => {
  beforeEach(() => {
    readPreparedConnection.mockReset();
    // Default to a server with no gateway, so the pre-existing cases below keep
    // exercising direct resolution and only the cases that opt in use the gateway.
    readServerConfig.mockReset();
    readServerConfig.mockReturnValue(null);
  });

  it("maps environment ports onto a private network host", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://192.168.1.25:3773" });
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "environment-port",
        port: 5173,
        path: "/dashboard",
      }),
    ).toEqual({
      requestedUrl: "http://localhost:5173/dashboard",
      resolvedUrl: "http://192.168.1.25:5173/dashboard",
      resolutionKind: "direct-private-network",
      environmentId: "environment-1",
    });
  });

  it("maps localhost URL navigation onto a remote Tailscale IPv4 host", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://100.65.180.100:3773" });
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "url",
        url: "http://localhost:5173/dashboard?mode=test#results",
      }),
    ).toEqual({
      requestedUrl: "http://localhost:5173/dashboard?mode=test#results",
      resolvedUrl: "http://100.65.180.100:5173/dashboard?mode=test#results",
      resolutionKind: "direct-private-network",
      environmentId: "environment-1",
    });
  });

  it("preserves URL credentials when mapping localhost onto a remote host", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://100.65.180.100:3773" });
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "url",
        url: "http://user:p%40ss@localhost:5173/dashboard",
      }).resolvedUrl,
    ).toBe("http://user:p%40ss@100.65.180.100:5173/dashboard");
  });

  it("maps credentialed localhost URLs onto private IPv6 hosts", async () => {
    readPreparedConnection.mockReturnValue({
      httpBaseUrl: "http://[fd7a:115c:a1e0::53]:3773",
    });
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "url",
        url: "http://user:p%40ss@localhost:5173/dashboard?mode=test#results",
      }).resolvedUrl,
    ).toBe("http://user:p%40ss@[fd7a:115c:a1e0::53]:5173/dashboard?mode=test#results");
  });

  it("maps schemeless localhost navigation onto a remote environment host", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://192.168.1.25:3773" });
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "url",
        url: "localhost:3000/app",
      }).resolvedUrl,
    ).toBe("http://192.168.1.25:3000/app");
  });

  it.each(["devbox", "server.lan", "server.home.arpa", "server.internal"])(
    "maps environment ports onto the same-network hostname %s",
    async (hostname) => {
      readPreparedConnection.mockReturnValue({ httpBaseUrl: `http://${hostname}:3773` });
      const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
      expect(
        resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
          kind: "environment-port",
          port: 4173,
          path: "/preview",
        }),
      ).toEqual({
        requestedUrl: "http://localhost:4173/preview",
        resolvedUrl: `http://${hostname}:4173/preview`,
        resolutionKind: "direct-private-network",
        environmentId: "environment-1",
      });
    },
  );

  it("keeps localhost navigation local for a local environment", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://127.0.0.1:3773" });
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "url",
        url: "localhost:3000/app",
      }),
    ).toEqual({
      requestedUrl: "localhost:3000/app",
      resolvedUrl: "localhost:3000/app",
      resolutionKind: "direct",
      environmentId: "environment-1",
    });
  });

  it("keeps localhost navigation local for the full IPv4 loopback range", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://127.0.0.2:3773" });
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "url",
        url: "http://localhost:3000/app",
      }),
    ).toEqual({
      requestedUrl: "http://localhost:3000/app",
      resolvedUrl: "http://localhost:3000/app",
      resolutionKind: "direct",
      environmentId: "environment-1",
    });
  });

  it("refuses public relay hosts when the server runs no gateway", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "https://relay.example.com" });
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(() =>
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "environment-port",
        port: 5173,
      }),
    ).toThrow(/authenticated preview gateway/);
    expect(() =>
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "url",
        url: "http://localhost:5173",
      }),
    ).toThrow(/authenticated preview gateway/);
  });

  it("routes a public relay host through the published gateway", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "https://relay.example.com" });
    withPublishedGateway();
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "environment-port",
        port: 5173,
        path: "/dashboard",
      }),
    ).toEqual({
      requestedUrl: "http://localhost:5173/dashboard",
      resolvedUrl: "https://relay.example.com:8445/__t3-preview/select?port=5173&to=%2Fdashboard",
      resolutionKind: "preview-gateway",
      environmentId: "environment-1",
    });
  });

  /**
   * The case the whole slice exists for. `.ts.net` is routable from here, which
   * is why the old resolver dialled `host:5173` directly — but the dev server
   * binds `127.0.0.1` on the far machine, so that URL hangs. The gateway
   * forwards from the server's own loopback, where the dev server actually is.
   */
  it("prefers the gateway over dialling a Tailscale host's port directly", async () => {
    readPreparedConnection.mockReturnValue({
      httpBaseUrl: "https://example-tailnet.ts.net/",
    });
    withPublishedGateway();
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    const resolution = resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
      kind: "environment-port",
      port: 5173,
      path: "/app?mode=test",
    });
    expect(resolution.resolutionKind).toBe("preview-gateway");
    expect(resolution.resolvedUrl).toBe(
      "https://example-tailnet.ts.net:8445/__t3-preview/select?port=5173&to=%2Fapp%3Fmode%3Dtest",
    );
  });

  it("keeps dialling a private-network host directly when the server runs no gateway", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://example-tailnet.ts.net:3773" });
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    const resolution = resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
      kind: "environment-port",
      port: 5173,
    });
    expect(resolution.resolutionKind).toBe("direct-private-network");
    expect(resolution.resolvedUrl).toBe("http://example-tailnet.ts.net:5173/");
  });

  /**
   * A gateway bound to the server's loopback with nothing publishing it is not
   * reachable from another machine. Falling back to the direct URL is the right
   * answer for a private-network host — it is at least routable — rather than
   * handing back a gateway URL that cannot connect.
   */
  it("falls back to direct when an unpublished gateway is unreachable from here", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://example-tailnet.ts.net:3773" });
    readServerConfig.mockReturnValue({ previewGateway: { loopbackPort: 3774 } });
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    const resolution = resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
      kind: "environment-port",
      port: 5173,
    });
    expect(resolution.resolutionKind).toBe("direct-private-network");
    expect(resolution.resolvedUrl).toBe("http://example-tailnet.ts.net:5173/");
  });

  /**
   * A gateway is advertised, but the environment is this machine, so the dev
   * server's port is right here. Direct is both correct and one hop shorter.
   */
  it("stays direct for a local environment even when a gateway is advertised", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://127.0.0.1:3773" });
    withPublishedGateway();
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "environment-port",
        port: 5173,
        path: "/app",
      }),
    ).toEqual({
      requestedUrl: "http://localhost:5173/app",
      resolvedUrl: "http://127.0.0.1:5173/app",
      resolutionKind: "direct",
      environmentId: "environment-1",
    });
  });

  it("maps a localhost URL onto the gateway, preserving query and hash", async () => {
    readPreparedConnection.mockReturnValue({
      httpBaseUrl: "https://example-tailnet.ts.net/",
    });
    withPublishedGateway();
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    const resolution = resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
      kind: "url",
      url: "http://localhost:5173/dashboard?mode=test#results",
    });
    expect(resolution).toEqual({
      requestedUrl: "http://localhost:5173/dashboard?mode=test#results",
      resolvedUrl:
        "https://example-tailnet.ts.net:8445/__t3-preview/select?port=5173&to=%2Fdashboard%3Fmode%3Dtest%23results",
      resolutionKind: "preview-gateway",
      environmentId: "environment-1",
    });
  });

  it("normalizes schemeless localhost server-picker values", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://localhost:3773" });
    const { resolveDiscoveredServerUrl } = await import("./browserTargetResolver");
    expect(resolveDiscoveredServerUrl(EnvironmentId.make("environment-1"), "localhost:5173")).toBe(
      "http://localhost:5173/",
    );
    expect(
      resolveDiscoveredServerUrl(EnvironmentId.make("environment-1"), "0.0.0.0:3000/app"),
    ).toBe("http://localhost:3000/app");
  });

  it("preserves localhost server-picker values when the prepared base is 127.0.0.1", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://127.0.0.1:3773" });
    const { resolveDiscoveredServerUrl } = await import("./browserTargetResolver");
    expect(
      resolveDiscoveredServerUrl(EnvironmentId.make("environment-1"), "localhost:5173/app?x=1#top"),
    ).toBe("http://localhost:5173/app?x=1#top");
  });

  it("normalizes public URLs without treating them as environment ports", async () => {
    const { resolveDiscoveredServerUrl } = await import("./browserTargetResolver");
    expect(resolveDiscoveredServerUrl(EnvironmentId.make("environment-1"), "example.com/app")).toBe(
      "https://example.com/app",
    );
  });

  it("supports private IPv6 environment hosts", async () => {
    readPreparedConnection.mockReturnValue({
      httpBaseUrl: "http://[fd7a:115c:a1e0::53]:3773",
    });
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "environment-port",
        port: 5173,
        path: "/app?mode=test",
      }).resolvedUrl,
    ).toBe("http://[fd7a:115c:a1e0::53]:5173/app?mode=test");
  });

  it("supports a local IPv6 environment host", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://[::1]:3773" });
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "environment-port",
        port: 5173,
      }).resolvedUrl,
    ).toBe("http://[::1]:5173/");
  });

  it("leaves malformed input for the normal navigation error path", async () => {
    const { resolveDiscoveredServerUrl } = await import("./browserTargetResolver");
    expect(resolveDiscoveredServerUrl(EnvironmentId.make("environment-1"), "   ")).toBe("   ");
  });

  it("classifies exact private IPv4 and IPv6 boundaries", async () => {
    const { isPrivateNetworkHost } = await import("./browserTargetResolver");
    const privateHosts = [
      "0.0.0.0",
      "10.0.0.0",
      "10.255.255.255",
      "100.64.0.0",
      "100.127.255.255",
      "127.0.0.0",
      "127.255.255.255",
      "169.254.0.0",
      "169.254.255.255",
      "172.16.0.0",
      "172.31.255.255",
      "192.168.0.0",
      "192.168.255.255",
      "198.18.0.0",
      "198.19.255.255",
      "fc00::",
      "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      "fe80::",
      "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      "::ffff:192.168.1.1",
      "localhost.",
      "localhost..",
      "devbox.",
      "devbox..",
      "printer.local.",
      "printer.local..",
      "printer.home.arpa.",
      "printer.home.arpa..",
      "devbox.example.ts.net.",
      "devbox.example.ts.net..",
    ];
    const publicHosts = [
      "1.0.0.0",
      "100.63.255.255",
      "100.128.0.0",
      "169.253.255.255",
      "169.255.0.0",
      "172.15.255.255",
      "172.32.0.0",
      "192.167.255.255",
      "192.169.0.0",
      "198.17.255.255",
      "198.20.0.0",
      "fbff:ffff::",
      "fec0::",
      "2001:4860:4860::8888",
      "::ffff:8.8.8.8",
      "example.com.",
    ];
    expect(privateHosts.filter((host) => !isPrivateNetworkHost(host))).toEqual([]);
    expect(publicHosts.filter(isPrivateNetworkHost)).toEqual([]);
  });

  it("allows only globally routable hosts to reach a public favicon provider", async () => {
    const { isPublicFaviconHost } = await import("./browserTargetResolver");
    const nonPublic = [
      "192.0.0.0",
      "192.0.0.255",
      "192.0.2.0",
      "192.0.2.255",
      "192.88.99.0",
      "192.88.99.255",
      "198.51.100.0",
      "198.51.100.255",
      "203.0.113.0",
      "203.0.113.255",
      "224.0.0.0",
      "255.255.255.255",
      "::2",
      "100::",
      "100::ffff:ffff:ffff:ffff",
      "100:0:0:1::",
      "100:0:0:1:ffff:ffff:ffff:ffff",
      "64:ff9b:1::1",
      "64:ff9b::a00:1",
      "64:ff9b::7f00:1",
      "64:ff9b::c0a8:101",
      "64:ff9b::c000:201",
      "2001:5::1",
      "2001:2::",
      "2001:2:0:ffff:ffff:ffff:ffff:ffff",
      "2001:db8::",
      "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff",
      "3fff::",
      "3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff",
      "5f00::1",
      "fec0::",
      "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      "::ffff:192.0.2.1",
      "app.test",
      "app.test..",
      "printer.local..",
      "printer.home.arpa..",
      "devbox.example.ts.net..",
      "127.0.0.1..",
      "127.1..",
      "10.1..",
      "172.16.1..",
      "192.168.1..",
      "service.internal",
      "hidden.onion",
    ];
    const publicHosts = [
      "191.255.255.255",
      "192.0.1.255",
      "192.0.3.0",
      "198.51.99.255",
      "198.51.101.0",
      "203.0.112.255",
      "203.0.114.0",
      "223.255.255.255",
      "1.1.1.1",
      "2001:4860:4860::8888",
      "2606:4700:4700::1111",
      "64:ff9b::808:808",
      "2001:1::1",
      "2001:3::1",
      "2001:4:112::1",
      "2001:20::1",
      "2001:30::1",
      "::ffff:8.8.8.8",
      "example.com",
      "example.com.",
    ];
    expect(nonPublic.filter(isPublicFaviconHost)).toEqual([]);
    expect(publicHosts.filter((host) => !isPublicFaviconHost(host))).toEqual([]);
  });
});
