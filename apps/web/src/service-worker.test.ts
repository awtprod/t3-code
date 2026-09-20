// @effect-diagnostics nodeBuiltinImport:off - The test reads the shipped service-worker source from disk and evaluates it in a sandboxed context.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";

import { describe, expect, it, vi } from "vite-plus/test";

function loadServiceWorker() {
  const listeners = new Map<string, (event: any) => void>();
  const showNotification = vi.fn((_title: string, options?: { data?: unknown }) =>
    Promise.resolve(),
  );
  const openWindow = vi.fn(() => Promise.resolve());
  const self = {
    location: { origin: "https://app.example.test" },
    registration: { showNotification },
    clients: {
      matchAll: vi.fn(() => Promise.resolve([])),
      openWindow,
      claim: vi.fn(() => Promise.resolve()),
    },
    skipWaiting: vi.fn(() => Promise.resolve()),
    addEventListener: (name: string, listener: (event: any) => void) =>
      listeners.set(name, listener),
  };
  const source = NodeFS.readFileSync(
    NodePath.resolve(import.meta.dirname, "../public/service-worker.js"),
    "utf8",
  );
  NodeVM.runInNewContext(source, {
    self,
    URL,
    Request,
    Promise,
    Map,
    fetch: vi.fn(),
    caches: { open: vi.fn(), keys: vi.fn(), match: vi.fn(), delete: vi.fn() },
  });
  return { listeners, showNotification, openWindow };
}

async function dispatchPush(
  listeners: Map<string, (event: any) => void>,
  payload: unknown,
): Promise<void> {
  let pending: Promise<unknown> | undefined;
  listeners.get("push")?.({
    data: { json: () => payload },
    waitUntil: (effect: Promise<unknown>) => {
      pending = effect;
    },
  });
  await pending;
}

describe("prospect service-worker notifications", () => {
  it("shows a valid prospect with the item tag and opens the actual prospects route", async () => {
    const { listeners, showNotification, openWindow } = loadServiceWorker();
    const itemId = "prospect-review:lead/123";
    await dispatchPush(listeners, {
      type: "prospect",
      itemId,
      spaceId: "space-1",
      evaluationId: "evaluation-1",
      environmentId: "environment-1",
      title: "New prospect",
      body: "Acme is ready for review.",
      deepLink: `/prospects/${encodeURIComponent(itemId)}`,
    });

    expect(showNotification).toHaveBeenCalledWith(
      "New prospect",
      expect.objectContaining({
        tag: `prospect:${itemId}`,
        data: expect.objectContaining({ type: "prospect" }),
      }),
    );
    let pending: Promise<unknown> | undefined;
    listeners.get("notificationclick")?.({
      notification: {
        close: vi.fn(),
        data: showNotification.mock.calls[0]?.[1]?.data,
      },
      waitUntil: (effect: Promise<unknown>) => {
        pending = effect;
      },
    });
    await pending;
    expect(openWindow).toHaveBeenCalledWith("https://app.example.test/prospects");
  });

  it.each([
    ["arbitrary URL", { deepLink: "https://evil.example/prospects/item" }],
    ["query", { deepLink: "/prospects/prospect-review%3Alead?item=1" }],
    ["wrong item", { deepLink: "/prospects/prospect-review%3Aother" }],
    ["extra field", { unexpected: true }],
  ])("rejects malformed prospect payloads: %s", async (_label, override) => {
    const { listeners, showNotification } = loadServiceWorker();
    const itemId = "prospect-review:lead";
    await dispatchPush(listeners, {
      type: "prospect",
      itemId,
      spaceId: "space-1",
      evaluationId: "evaluation-1",
      environmentId: "environment-1",
      title: "New prospect",
      body: "Review it.",
      deepLink: `/prospects/${encodeURIComponent(itemId)}`,
      ...override,
    });
    expect(showNotification).not.toHaveBeenCalled();
  });

  it("preserves current thread notification routing and tags", async () => {
    const { listeners, showNotification, openWindow } = loadServiceWorker();
    await dispatchPush(listeners, {
      title: "Agent needs input",
      body: "Open the thread.",
      environmentId: "env-1",
      threadId: "thread-1",
      deepLink: "/threads/env-1/thread-1",
    });
    expect(showNotification).toHaveBeenCalledWith(
      "Agent needs input",
      expect.objectContaining({ tag: "thread:env-1:thread-1" }),
    );
    let pending: Promise<unknown> | undefined;
    listeners.get("notificationclick")?.({
      notification: { close: vi.fn(), data: showNotification.mock.calls[0]?.[1]?.data },
      waitUntil: (effect: Promise<unknown>) => {
        pending = effect;
      },
    });
    await pending;
    expect(openWindow).toHaveBeenCalledWith("https://app.example.test/env-1/thread-1");
  });
});
