import { describe, expect, it } from "vite-plus/test";

import { getElectronPlatformClassNames } from "./windowControlsOverlay";

describe("getElectronPlatformClassNames", () => {
  it("marks desktop platforms that need a native-control fallback", () => {
    expect(getElectronPlatformClassNames("Win32")).toEqual(["electron", "electron-windows"]);
    expect(getElectronPlatformClassNames("Linux x86_64")).toEqual(["electron", "electron-linux"]);
  });

  it("does not put right-side caption controls on macOS", () => {
    expect(getElectronPlatformClassNames("MacIntel")).toEqual(["electron"]);
  });
});
