import { describe, expect, it } from "vite-plus/test";

import { shouldRegisterPwaServiceWorker } from "./pwa";

describe("PWA service worker registration", () => {
  const supportedProductionBrowser = {
    electron: false,
    production: true,
    secureContext: true,
    serviceWorkerSupported: true,
  } as const;

  it("registers only for a secure production browser", () => {
    expect(shouldRegisterPwaServiceWorker(supportedProductionBrowser)).toBe(true);
  });

  it.each([
    ["Electron", { electron: true }],
    ["development", { production: false }],
    ["an insecure origin", { secureContext: false }],
    ["an unsupported browser", { serviceWorkerSupported: false }],
  ])("does not register in %s", (_label, override) => {
    expect(
      shouldRegisterPwaServiceWorker({
        ...supportedProductionBrowser,
        ...override,
      }),
    ).toBe(false);
  });
});
