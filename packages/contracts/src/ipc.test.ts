import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DesktopEnvironmentBootstrapSchema, DesktopPreviewTabStateSchema } from "./ipc.ts";

describe("DesktopEnvironmentBootstrapSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopEnvironmentBootstrapSchema);

  it("preserves the concrete running distro separately from the backend id", () => {
    expect(
      decode({
        id: "wsl:default",
        label: "WSL (Ubuntu)",
        runningDistro: "Ubuntu",
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
      }),
    ).toEqual({
      id: "wsl:default",
      label: "WSL (Ubuntu)",
      runningDistro: "Ubuntu",
      httpBaseUrl: "http://127.0.0.1:3774/",
      wsBaseUrl: "ws://127.0.0.1:3774/",
    });
  });

  it("allows non-running and non-WSL bootstraps to report no running distro", () => {
    expect(
      decode({
        id: "primary",
        label: "Windows",
        runningDistro: null,
        httpBaseUrl: null,
        wsBaseUrl: null,
      }).runningDistro,
    ).toBeNull();
  });
});

describe("DesktopPreviewTabStateSchema", () => {
  it("defaults audio state from older desktop producers", () => {
    expect(
      Schema.decodeUnknownSync(DesktopPreviewTabStateSchema)({
        tabId: "tab-1",
        webContentsId: 1,
        navStatus: { kind: "Idle", url: "https://example.com", title: "Example" },
        canGoBack: false,
        canGoForward: false,
        zoomFactor: 1,
        pictureInPicture: false,
        colorScheme: "system",
        controller: "human",
        updatedAt: "2026-09-09T00:00:00.000Z",
      }),
    ).toMatchObject({ audioMuted: false, audible: false });
  });
});
