import type { SandboxState } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { SandboxDesktopPanel } from "./SandboxDesktopPanel";

const state = {
  lifecycle: "paused",
  sandboxId: "sandbox-1",
  runtime: "docker",
  runtimeRef: "container-1",
  branch: { branchName: "thread/child", baseCommit: "0123456789abcdef0123456789abcdef01234567" },
  limits: {
    cpuCount: 2,
    memoryBytes: 4_294_967_296,
    diskBytes: 21_474_836_480,
    processCount: 512,
    idleTimeoutSeconds: 3600,
    maxLifetimeSeconds: 28800,
  },
  usage: { cpuPercent: 12.5, memoryBytes: 268_435_456, diskBytes: 536_870_912, processCount: 7 },
  desktop: { status: "ready", sessionId: "desktop-1", streamPath: "/sandbox/desktop/thread-1" },
  services: [{ name: "db", status: "healthy" }],
  controller: {
    kind: "human",
    leaseId: "lease-1",
    sessionId: "viewer-1",
    acquiredAt: "2026-08-15T00:00:00Z",
  },
  pauseReason: "human-takeover",
  createdAt: "2026-08-15T00:00:00Z",
  lastActiveAt: "2026-08-15T00:00:01Z",
} as unknown as SandboxState;

describe("SandboxDesktopPanel", () => {
  it("shows the explicit human-control lease and observable resource state", () => {
    const markup = renderToStaticMarkup(
      <SandboxDesktopPanel
        sandbox={state}
        onProvision={vi.fn()}
        onTakeover={vi.fn()}
        onResume={vi.fn()}
        onStop={vi.fn()}
        onExport={vi.fn()}
        onReconnect={vi.fn()}
        onRequestViewerUrl={vi.fn(
          async () => "https://environment.example/api/thread-desktop/thread-1/view?ticket=x",
        )}
      />,
    );

    expect(markup).toContain("Resume agent");
    expect(markup).toContain("Agent commands remain paused");
    expect(markup).toContain("thread/child");
    expect(markup).toContain("CPU 12.5%");
    expect(markup).toContain("Services 1/1");
    expect(markup).toContain("The desktop stream is not ready");
  });
});
