import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// The row must render in local mode WITHOUT a Clerk provider mounted — the whole
// point of splitting the row is that useAuth is never called in local mode. If
// the local path touched Clerk, this render would throw ("useAuth can only be
// used within <ClerkProvider>"), because no provider wraps it here.
const webPushMock = vi.hoisted(() => ({
  supported: true as boolean,
  local: true as boolean,
}));

vi.mock("~/cloud/webPush", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/cloud/webPush")>();
  return {
    ...actual,
    webPushSupport: () =>
      webPushMock.supported ? { supported: true } : { supported: false, reason: "no-push-api" },
    isLocalWebPushMode: () => webPushMock.local,
    readWebPushRegistration: () => null,
    // Never resolves: keeps the row in its initial "loading" config state for
    // a deterministic static render.
    fetchLocalWebPushConfig: () => new Promise(() => {}),
  };
});

// Clerk is intentionally NOT mocked with a working provider: if the local path
// called useAuth, importing/rendering would fail. Provide a throwing stub so a
// regression is loud rather than silently returning a default.
vi.mock("@clerk/react", () => ({
  useAuth: () => {
    throw new Error("useAuth called without a ClerkProvider");
  },
}));

import { WebPushNotificationsRow } from "./WebPushNotificationsRow";

afterEach(() => {
  webPushMock.supported = true;
  webPushMock.local = true;
});

describe("WebPushNotificationsRow (local mode)", () => {
  it("renders the toggle and test button without a Clerk provider", () => {
    const markup = renderToStaticMarkup(<WebPushNotificationsRow />);
    expect(markup).toContain("Enable browser notifications");
    expect(markup).toContain("Send test notification");
  });

  it("renders nothing when push is unsupported", () => {
    webPushMock.supported = false;
    expect(renderToStaticMarkup(<WebPushNotificationsRow />)).toBe("");
  });
});
