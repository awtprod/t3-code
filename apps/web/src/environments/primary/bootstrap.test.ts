import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { readPrimaryEnvironmentTarget, resolvePrimaryEnvironmentHttpUrl } from ".";
import { resolvePrimaryEnvironmentWebSocketBaseUrl } from "./target";

function resolvePrimaryWebSocketBaseUrl() {
  const primaryTarget = readPrimaryEnvironmentTarget();
  if (!primaryTarget) {
    throw new Error("Expected a primary environment target.");
  }
  return resolvePrimaryEnvironmentWebSocketBaseUrl(primaryTarget);
}

function installTestBrowser(url: string) {
  vi.stubGlobal("window", {
    location: new URL(url),
    history: {
      replaceState: vi.fn(),
    },
  });
}

describe("environmentBootstrap", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    installTestBrowser("http://localhost/");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses https descriptor urls when the primary environment uses wss", () => {
    vi.stubEnv("VITE_HTTP_URL", "https://remote.example.com");
    vi.stubEnv("VITE_WS_URL", "wss://remote.example.com");

    expect(resolvePrimaryEnvironmentHttpUrl("/.well-known/t3/environment")).toBe(
      "https://remote.example.com/.well-known/t3/environment",
    );
  });

  it("keeps an uppercase wss scheme secure when deriving the http url", () => {
    vi.stubEnv("VITE_WS_URL", "WSS://remote.example.com");

    expect(readPrimaryEnvironmentTarget()?.target).toEqual({
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    });
  });

  it("keeps an uppercase https scheme secure when deriving the websocket url", () => {
    vi.stubEnv("VITE_HTTP_URL", "HTTPS://remote.example.com");

    expect(readPrimaryEnvironmentTarget()?.target).toEqual({
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    });
  });

  it("uses the vite proxy for desktop-managed loopback descriptor requests during local dev", () => {
    vi.stubEnv("VITE_DEV_SERVER_URL", "http://127.0.0.1:5733");
    vi.stubGlobal("window", {
      location: new URL("http://127.0.0.1:5733/"),
      history: {
        replaceState: vi.fn(),
      },
      desktopBridge: {
        getLocalEnvironmentEnabled: () => true,
        getLocalEnvironmentBootstraps: () => [
          {
            id: "primary",
            label: "Windows",
            httpBaseUrl: "http://127.0.0.1:3773",
            wsBaseUrl: "ws://127.0.0.1:3773",
            bootstrapToken: "desktop-bootstrap-token",
          },
        ],
      },
    });

    expect(resolvePrimaryEnvironmentHttpUrl("/.well-known/t3/environment")).toBe(
      "http://127.0.0.1:5733/.well-known/t3/environment",
    );
  });

  it("uses the vite proxy when the dev server is reached by a loopback alias", () => {
    // `VITE_DEV_SERVER_URL` is pinned to `localhost`, so the same dev server opened as
    // 127.0.0.1 must not look like a foreign origin: discovery would go cross-origin to the
    // backend, where CORS blocks it.
    vi.stubEnv("VITE_DEV_SERVER_URL", "http://localhost:5733");
    vi.stubEnv("VITE_WS_URL", "ws://localhost:13773");
    installTestBrowser("http://127.0.0.1:5733/");

    expect(resolvePrimaryEnvironmentHttpUrl("/.well-known/t3/environment")).toBe(
      "http://127.0.0.1:5733/.well-known/t3/environment",
    );
    expect(resolvePrimaryWebSocketBaseUrl()).toBe("ws://127.0.0.1:5733/");
  });

  it("uses the vite proxy when the dev server is reached over a non-loopback host", () => {
    // Remote access (Tailscale or LAN) serves the dev server under a hostname that can never
    // match the loopback `VITE_DEV_SERVER_URL`. The proxy is still the only path to the backend.
    vi.stubEnv("VITE_DEV_SERVER_URL", "http://localhost:5733");
    vi.stubEnv("VITE_WS_URL", "ws://localhost:13773");
    installTestBrowser("http://dev-host.example.test/");

    expect(resolvePrimaryEnvironmentHttpUrl("/.well-known/t3/environment")).toBe(
      "http://dev-host.example.test/.well-known/t3/environment",
    );
    expect(resolvePrimaryWebSocketBaseUrl()).toBe("ws://dev-host.example.test/");
  });
});
