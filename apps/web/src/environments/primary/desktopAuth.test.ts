import type { DesktopBridge } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";

import {
  __resetDesktopPrimaryAuthForTests,
  clearDesktopPrimaryBearerToken,
  readDesktopPrimaryBearerToken,
} from "./desktopAuth";

describe("desktop primary auth", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {},
    });
  });

  afterEach(() => {
    __resetDesktopPrimaryAuthForTests();
    Reflect.deleteProperty(globalThis, "window");
  });

  it("reuses the main-process bearer token across renderer requests", async () => {
    const getLocalEnvironmentBearerToken = vi.fn().mockResolvedValue("desktop-bearer-token");
    window.desktopBridge = {
      getLocalEnvironmentBearerToken,
    } as unknown as DesktopBridge;

    await expect(readDesktopPrimaryBearerToken()).resolves.toBe("desktop-bearer-token");
    await expect(readDesktopPrimaryBearerToken()).resolves.toBe("desktop-bearer-token");
    expect(getLocalEnvironmentBearerToken).toHaveBeenCalledTimes(1);
  });

  it.each([null, "stale-saved-token"])(
    "reloads cached %s after recovery clears the renderer cache",
    async (stale) => {
      const getLocalEnvironmentBearerToken = vi
        .fn()
        .mockResolvedValueOnce(stale)
        .mockResolvedValue("fresh-saved-token");
      window.desktopBridge = { getLocalEnvironmentBearerToken } as unknown as DesktopBridge;
      await expect(readDesktopPrimaryBearerToken()).resolves.toBe(stale);
      clearDesktopPrimaryBearerToken();
      await expect(readDesktopPrimaryBearerToken()).resolves.toBe("fresh-saved-token");
      expect(getLocalEnvironmentBearerToken).toHaveBeenCalledTimes(2);
    },
  );

  it("does not require desktop auth in a browser", async () => {
    await expect(readDesktopPrimaryBearerToken()).resolves.toBeNull();
  });
});
