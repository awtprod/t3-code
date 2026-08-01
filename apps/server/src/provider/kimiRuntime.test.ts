import { describe, expect, it } from "vite-plus/test";

import { isSupportedKimiVersion, parseKimiVersion } from "./kimiRuntime.ts";

describe("Kimi runtime compatibility", () => {
  it("requires Kimi Code 0.31.1 or newer", () => {
    expect(parseKimiVersion("kimi-code 0.31.1")).toBe("0.31.1");
    expect(isSupportedKimiVersion("0.31.0")).toBe(false);
    expect(isSupportedKimiVersion("0.31.1")).toBe(true);
    expect(isSupportedKimiVersion("1.0.0")).toBe(true);
  });
});
