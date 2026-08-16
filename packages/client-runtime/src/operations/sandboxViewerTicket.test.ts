import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveSandboxViewerTicket } from "./sandboxViewerTicket.ts";

const threadId = ThreadId.make("thread-1");
const expiresAt = "2026-08-15T00:01:00.000Z";
const now = Date.parse("2026-08-15T00:00:00.000Z");

describe("resolveSandboxViewerTicket", () => {
  it.each(["http://127.0.0.1:3773", "https://remote.example.test/t3/"])(
    "resolves a viewer URL against its selected environment: %s",
    (httpBaseUrl) => {
      const result = resolveSandboxViewerTicket({
        httpBaseUrl,
        threadId,
        value: { viewerUrl: "/api/thread-desktop/thread-1/view?ticket=once", expiresAt },
        now,
      });
      expect(new URL(result.viewerUrl).origin).toBe(new URL(httpBaseUrl).origin);
      expect(result.viewerUrl).toContain("thread-1/view?ticket=once");
    },
  );

  it("rejects expired tickets", () => {
    expect(() =>
      resolveSandboxViewerTicket({
        httpBaseUrl: "https://remote.example.test",
        threadId,
        value: {
          viewerUrl: "/api/thread-desktop/thread-1/view?ticket=old",
          expiresAt: "2026-08-14T23:59:00Z",
        },
        now,
      }),
    ).toThrow(/expired/);
  });

  it.each([
    "https://wrong.example.test/api/thread-desktop/thread-1/view?ticket=x",
    "/api/thread-desktop/thread-2/view?ticket=x",
  ])("rejects a wrong environment or thread", (viewerUrl) => {
    expect(() =>
      resolveSandboxViewerTicket({
        httpBaseUrl: "https://remote.example.test",
        threadId,
        value: { viewerUrl, expiresAt },
        now,
      }),
    ).toThrow(/wrong environment or thread/);
  });
});
