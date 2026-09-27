// @effect-diagnostics nodeBuiltinImport:off - this test reads the shipped
// service-worker source from disk and evaluates it in a sandboxed context to
// prove our notifier payloads survive the real client-side decoder.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";

import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import { buildAgentAwarenessDeepLink } from "@t3tools/shared/agentAwareness";
import { describe, expect, it, vi } from "vite-plus/test";

import { buildThreadNotificationPayload, clipNotificationText } from "./notificationPayload.ts";

function loadServiceWorker() {
  const listeners = new Map<string, (event: any) => void>();
  const showNotification = vi.fn((_title: string, _options?: { data?: unknown }) =>
    Promise.resolve(),
  );
  const self = {
    location: { origin: "https://app.example.test" },
    registration: { showNotification },
    clients: {
      matchAll: vi.fn(() => Promise.resolve([])),
      openWindow: vi.fn(() => Promise.resolve()),
      claim: vi.fn(() => Promise.resolve()),
    },
    skipWaiting: vi.fn(() => Promise.resolve()),
    addEventListener: (name: string, listener: (event: any) => void) =>
      listeners.set(name, listener),
  };
  const source = NodeFS.readFileSync(
    NodePath.resolve(import.meta.dirname, "../../../web/public/service-worker.js"),
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
  return { listeners, showNotification };
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

function makeState(
  overrides: Partial<RelayAgentActivityState> & {
    readonly phase: RelayAgentActivityState["phase"];
  },
): RelayAgentActivityState {
  return {
    environmentId: "env-1",
    threadId: "thread-1",
    projectTitle: "Command Center",
    threadTitle: "Fix the widget",
    headline: "Approval needed",
    modelTitle: "opus",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deepLink: "/threads/env-1/thread-1",
    ...overrides,
  } as RelayAgentActivityState;
}

describe("web push payload contract with the real service worker", () => {
  it("accepts a thread notification payload", async () => {
    const { listeners, showNotification } = loadServiceWorker();
    const payload = buildThreadNotificationPayload(makeState({ phase: "completed" }));
    await dispatchPush(listeners, payload);
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(showNotification).toHaveBeenCalledWith(
      "Fix the widget",
      expect.objectContaining({ body: "Done: Command Center" }),
    );
  });

  it("accepts the thread-less test-notification payload", async () => {
    const { listeners, showNotification } = loadServiceWorker();
    const environmentId = "env-1" as EnvironmentId;
    const threadId = "web-push-test" as ThreadId;
    const payload = {
      title: clipNotificationText("Test notification"),
      body: clipNotificationText("Command Center web push is working."),
      environmentId,
      threadId,
      deepLink: buildAgentAwarenessDeepLink({ environmentId, threadId }),
    };
    await dispatchPush(listeners, payload);
    expect(showNotification).toHaveBeenCalledTimes(1);
  });
});
