import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { PrimaryEnvironmentHttpClient } from "../environments/primary/httpClient";
import { __setPrimaryHttpRunnerForTests, type PrimaryHttpEffectRunner } from "../lib/runtime";
import { removeLocalStorageItem } from "../hooks/useLocalStorage";

const publicConfigState = vi.hoisted(() => ({ localMode: true }));

vi.mock("./publicConfig", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./publicConfig")>();
  return {
    ...actual,
    // isLocalWebPushMode() === !hasCloudPublicConfig(); flip via the shared flag.
    hasCloudPublicConfig: () => !publicConfigState.localMode,
  };
});

import {
  disableWebPushNotifications,
  enableWebPushNotifications,
  isLocalWebPushMode,
  localDisableToast,
  localEnableResultToast,
  localTestResultToast,
  localWebPushViewModel,
  readWebPushRegistration,
  reconcileWebPushRegistration,
  sendWebPushTestNotification,
  webPushSupport,
  type LocalWebPushConfigState,
} from "./webPush";

const WEB_PUSH_STORAGE_KEY = "t3code:web-push:v1";
// Valid base64url; applicationServerKeyBytes must be able to atob-decode it.
const VAPID_KEY = "BExampleKey";

interface MockSubscription {
  endpoint: string;
  getKey: (name: string) => ArrayBuffer;
  unsubscribe: ReturnType<typeof vi.fn>;
}

function makeSubscription(endpoint: string): MockSubscription {
  return {
    endpoint,
    getKey: (name: string) =>
      new Uint8Array(name === "p256dh" ? [1, 2, 3, 4] : [5, 6, 7, 8]).buffer,
    unsubscribe: vi.fn(() => Promise.resolve(true)),
  };
}

function installBrowser(options?: {
  existingSubscription?: MockSubscription | null;
  newSubscription?: MockSubscription;
  permission?: NotificationPermission;
  userAgent?: string;
}) {
  const existing = options?.existingSubscription ?? null;
  const created = options?.newSubscription ?? makeSubscription("https://push.example/new");
  const subscribe = vi.fn(() => Promise.resolve(created));
  const getSubscription = vi.fn(() => Promise.resolve(existing));
  const registration = { pushManager: { getSubscription, subscribe } };

  vi.stubGlobal("window", {
    isSecureContext: true,
    matchMedia: () => ({ matches: false }),
    PushManager: class {},
    Notification: class {},
  });
  vi.stubGlobal("navigator", {
    userAgent: options?.userAgent ?? "Mozilla/5.0 (Macintosh) Chrome/120",
    serviceWorker: { ready: Promise.resolve(registration), addEventListener: vi.fn() },
  });
  vi.stubGlobal("Notification", {
    permission: options?.permission ?? "granted",
    requestPermission: vi.fn(() => Promise.resolve(options?.permission ?? "granted")),
  });

  return { subscribe, getSubscription, created };
}

interface MockCalls {
  config: number;
  put: unknown[];
  del: unknown[];
  test: unknown[];
}

function installPrimaryClient(overrides?: {
  config?: { configured: boolean; vapidPublicKey: string | null };
  test?: { ok: boolean; notConfigured: boolean; status: number; reason: string | null };
  putFails?: boolean;
}): MockCalls {
  const calls: MockCalls = { config: 0, put: [], del: [], test: [] };
  const client = {
    webPush: {
      config: () => {
        calls.config += 1;
        return Effect.succeed(overrides?.config ?? { configured: true, vapidPublicKey: VAPID_KEY });
      },
      putSubscription: ({ payload }: { payload: unknown }) => {
        calls.put.push(payload);
        return overrides?.putFails
          ? Effect.die(new Error("put failed"))
          : Effect.succeed({ ok: true });
      },
      deleteSubscription: ({ payload }: { payload: unknown }) => {
        calls.del.push(payload);
        return Effect.succeed({ ok: true });
      },
      test: ({ payload }: { payload: unknown }) => {
        calls.test.push(payload);
        return Effect.succeed(
          overrides?.test ?? { ok: true, notConfigured: false, status: 201, reason: null },
        );
      },
    },
  };
  const runner: PrimaryHttpEffectRunner = (effect) =>
    Effect.runPromise(
      effect.pipe(Effect.provideService(PrimaryEnvironmentHttpClient, client as never)),
    );
  __setPrimaryHttpRunnerForTests(runner);
  return calls;
}

afterEach(() => {
  removeLocalStorageItem(WEB_PUSH_STORAGE_KEY);
  __setPrimaryHttpRunnerForTests();
  vi.unstubAllGlobals();
  publicConfigState.localMode = true;
});

describe("webPushSupport", () => {
  it("reports supported in a secure browser with the Push API", () => {
    installBrowser();
    expect(webPushSupport()).toEqual({ supported: true });
  });

  it("reports insecure-context when the page is not secure", () => {
    installBrowser();
    vi.stubGlobal("window", { isSecureContext: false, matchMedia: () => ({ matches: false }) });
    expect(webPushSupport()).toEqual({ supported: false, reason: "insecure-context" });
  });

  it("reports ios-needs-install for iOS Safari without the Push API", () => {
    vi.stubGlobal("window", {
      isSecureContext: true,
      matchMedia: () => ({ matches: false }),
    });
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari",
      serviceWorker: {},
    });
    expect(webPushSupport()).toEqual({ supported: false, reason: "ios-needs-install" });
  });

  it("reports no-push-api on a non-iOS browser without the Push API", () => {
    vi.stubGlobal("window", { isSecureContext: true, matchMedia: () => ({ matches: false }) });
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Linux) Firefox", serviceWorker: {} });
    expect(webPushSupport()).toEqual({ supported: false, reason: "no-push-api" });
  });
});

describe("web push mode selection", () => {
  it("is local mode when T3 Connect config is absent", () => {
    publicConfigState.localMode = true;
    expect(isLocalWebPushMode()).toBe(true);
  });

  it("is relay mode when T3 Connect config is present", () => {
    publicConfigState.localMode = false;
    expect(isLocalWebPushMode()).toBe(false);
  });
});

describe("local mode enable", () => {
  it("subscribes and PUTs the subscription with the contract payload shape", async () => {
    installBrowser();
    const calls = installPrimaryClient();

    const result = await enableWebPushNotifications();

    expect(result).toEqual({ ok: true });
    expect(calls.config).toBe(1);
    expect(calls.put).toHaveLength(1);
    const payload = calls.put[0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      endpoint: "https://push.example/new",
      p256dh: expect.any(String),
      auth: expect.any(String),
      preferences: {
        notifyOnApproval: true,
        notifyOnInput: true,
        notifyOnCompletion: true,
        notifyOnFailure: true,
      },
    });
    expect(typeof payload.deviceId).toBe("string");
    expect((payload.deviceId as string).startsWith("web-")).toBe(true);

    const stored = readWebPushRegistration();
    expect(stored?.endpoint).toBe("https://push.example/new");
    expect(stored?.deviceId).toBe(payload.deviceId);
  });

  it("returns not-configured when the server has no VAPID subject", async () => {
    installBrowser();
    const calls = installPrimaryClient({ config: { configured: false, vapidPublicKey: null } });

    const result = await enableWebPushNotifications();

    expect(result).toEqual({ ok: false, reason: "not-configured" });
    expect(calls.put).toHaveLength(0);
    expect(readWebPushRegistration()).toBeNull();
  });

  it("returns permission-denied without contacting the server", async () => {
    installBrowser({ permission: "denied" });
    const calls = installPrimaryClient();

    const result = await enableWebPushNotifications();

    expect(result).toEqual({ ok: false, reason: "permission-denied" });
    expect(calls.config).toBe(0);
    expect(calls.put).toHaveLength(0);
  });

  it("returns failed and stores nothing when the PUT fails", async () => {
    installBrowser();
    installPrimaryClient({ putFails: true });

    const result = await enableWebPushNotifications();

    expect(result.ok).toBe(false);
    expect(readWebPushRegistration()).toBeNull();
  });
});

describe("local mode disable", () => {
  it("unsubscribes, DELETEs by deviceId, and clears the stored record", async () => {
    const existing = makeSubscription("https://push.example/existing");
    installBrowser({ existingSubscription: existing, newSubscription: existing });
    const calls = installPrimaryClient();

    await enableWebPushNotifications();
    const deviceId = readWebPushRegistration()?.deviceId;
    await disableWebPushNotifications();

    expect(existing.unsubscribe).toHaveBeenCalledTimes(1);
    expect(calls.del).toEqual([{ deviceId }]);
    expect(readWebPushRegistration()).toBeNull();
  });
});

describe("local mode reconcile", () => {
  it("re-PUTs when the live endpoint no longer matches the stored one", async () => {
    // Seed a registration via enable, then present a rotated subscription.
    installBrowser();
    installPrimaryClient();
    await enableWebPushNotifications();
    const seeded = readWebPushRegistration();
    expect(seeded?.endpoint).toBe("https://push.example/new");

    const rotated = makeSubscription("https://push.example/rotated");
    installBrowser({ existingSubscription: rotated });
    const calls = installPrimaryClient();

    await reconcileWebPushRegistration();

    expect(calls.put).toHaveLength(1);
    const payload = calls.put[0] as Record<string, unknown>;
    expect(payload.endpoint).toBe("https://push.example/rotated");
    expect(payload.deviceId).toBe(seeded?.deviceId);
  });

  it("does nothing when there is no stored registration", async () => {
    installBrowser();
    const calls = installPrimaryClient();

    await reconcileWebPushRegistration();

    expect(calls.put).toHaveLength(0);
  });
});

describe("local mode test notification", () => {
  it("returns not-registered when notifications are off", async () => {
    installBrowser();
    installPrimaryClient();
    const outcome = await sendWebPushTestNotification();
    expect(outcome).toEqual({ ok: false, reason: "not-registered" });
  });

  it("sends a test for the stored device", async () => {
    installBrowser();
    const calls = installPrimaryClient();
    await enableWebPushNotifications();
    const deviceId = readWebPushRegistration()?.deviceId;

    const outcome = await sendWebPushTestNotification();

    expect(outcome).toEqual({ ok: true });
    expect(calls.test).toEqual([{ deviceId }]);
  });

  it("surfaces not-configured from the server", async () => {
    installBrowser();
    installPrimaryClient();
    await enableWebPushNotifications();
    installPrimaryClient({ test: { ok: false, notConfigured: true, status: 200, reason: null } });

    const outcome = await sendWebPushTestNotification();
    expect(outcome).toEqual({ ok: false, reason: "not-configured" });
  });

  it("surfaces a failure status", async () => {
    installBrowser();
    installPrimaryClient();
    await enableWebPushNotifications();
    installPrimaryClient({
      test: { ok: false, notConfigured: false, status: 502, reason: "bad gateway" },
    });

    const outcome = await sendWebPushTestNotification();
    expect(outcome).toEqual({ ok: false, reason: "failed", status: 502, detail: "bad gateway" });
  });
});

describe("localWebPushViewModel", () => {
  const base = { enabled: false, isUpdating: false, isTesting: false } as const;

  it("disables everything while the config is loading", () => {
    expect(localWebPushViewModel({ ...base, configState: "loading" })).toEqual({
      toggleDisabled: true,
      testButtonDisabled: true,
      explanation: null,
    });
  });

  it("disables the toggle with an explanation when not configured", () => {
    const vm = localWebPushViewModel({ ...base, configState: "not-configured" });
    expect(vm.toggleDisabled).toBe(true);
    expect(vm.explanation).toBe("Notifications aren't set up on this server yet.");
  });

  it("explains an unreachable server", () => {
    const vm = localWebPushViewModel({ ...base, configState: "unavailable" });
    expect(vm.toggleDisabled).toBe(true);
    expect(vm.explanation).toContain("Couldn't reach this server");
  });

  it("enables the toggle when configured, and the test button only once registered", () => {
    expect(
      localWebPushViewModel({ ...base, configState: "configured", enabled: false }),
    ).toMatchObject({ toggleDisabled: false, testButtonDisabled: true, explanation: null });
    expect(
      localWebPushViewModel({ ...base, configState: "configured", enabled: true }),
    ).toMatchObject({ toggleDisabled: false, testButtonDisabled: false });
  });

  it("disables the test button while a test is in flight", () => {
    expect(
      localWebPushViewModel({
        configState: "configured",
        enabled: true,
        isUpdating: false,
        isTesting: true,
      }),
    ).toMatchObject({ testButtonDisabled: true });
  });
});

describe("local mode toast content", () => {
  it("maps enable results", () => {
    expect(localEnableResultToast({ ok: true }).type).toBe("success");
    expect(localEnableResultToast({ ok: false, reason: "permission-denied" }).type).toBe("error");
    expect(localEnableResultToast({ ok: false, reason: "not-configured" }).title).toContain(
      "aren't set up",
    );
  });

  it("maps the disable toast", () => {
    expect(localDisableToast.type).toBe("success");
  });

  it("maps test outcomes", () => {
    expect(localTestResultToast({ ok: true }).type).toBe("success");
    expect(localTestResultToast({ ok: false, reason: "not-configured" }).title).toBe(
      "Not configured on this server",
    );
    expect(
      localTestResultToast({ ok: false, reason: "failed", status: 500 }).description,
    ).toContain("500");
  });
});

// Keep the exported config-state type referenced so the suite fails if it drifts.
const _configStates: LocalWebPushConfigState[] = [
  "loading",
  "configured",
  "not-configured",
  "unavailable",
];
void _configStates;
