import type { WebPushConfigResult, WebPushTestResult } from "@t3tools/contracts";
import type { RelayAgentAwarenessPreferences } from "@t3tools/contracts/relay";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { isElectron } from "../env";
import { randomUUID } from "../lib/utils";
import {
  getLocalStorageItem,
  removeLocalStorageItem,
  setLocalStorageItem,
} from "../hooks/useLocalStorage";
import { PrimaryEnvironmentHttpClient } from "../environments/primary/httpClient";
import { runPrimaryHttp, runtime } from "../lib/runtime";
import { readManagedRelayClerkToken } from "./managedAuth";
import { hasCloudPublicConfig } from "./publicConfig";

// The relay upserts by (userId, deviceId); a stable per-browser id keeps
// re-registrations from accumulating rows. The endpoint is stored so a
// rotated subscription (pushsubscriptionchange) is detectable on launch.
const WEB_PUSH_STORAGE_KEY = "t3code:web-push:v1";

const WebPushRegistrationRecord = Schema.fromJsonString(
  Schema.Struct({
    deviceId: Schema.String,
    endpoint: Schema.String,
    preferences: Schema.Struct({
      notifyOnApproval: Schema.Boolean,
      notifyOnInput: Schema.Boolean,
      notifyOnCompletion: Schema.Boolean,
      notifyOnFailure: Schema.Boolean,
    }),
  }),
);
export type WebPushRegistrationRecord = typeof WebPushRegistrationRecord.Type;

export type WebPushEventPreferences = WebPushRegistrationRecord["preferences"];

export const defaultWebPushEventPreferences: WebPushEventPreferences = {
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};

export function readWebPushRegistration(): WebPushRegistrationRecord | null {
  try {
    return getLocalStorageItem(WEB_PUSH_STORAGE_KEY, WebPushRegistrationRecord);
  } catch {
    return null;
  }
}

// Two delivery modes share the browser plumbing below. Relay mode (T3 Connect
// present) registers the subscription with the cloud relay; local mode registers
// straight with the paired Command Center server over its HTTP API. Which one
// runs is decided purely by whether the public T3 Connect config is baked in,
// so a production build with no relay config falls into local mode.
export function isLocalWebPushMode(): boolean {
  return !hasCloudPublicConfig();
}

export type WebPushSupport =
  | { readonly supported: true }
  | {
      readonly supported: false;
      readonly reason: "electron" | "insecure-context" | "no-push-api" | "ios-needs-install";
    };

// iOS Safari only exposes the Push API once the app is installed to the home
// screen; detect the "would work if installed" case to show a useful hint.
function isIosBrowserNeedingInstall(): boolean {
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches;
  return isIos && !isStandalone && !("PushManager" in window);
}

// Browser-capability only. Whether a delivery backend (relay vs local server)
// exists is a separate axis: relay mode is gated by the presence of T3 Connect
// config, local mode by the server's own `/api/web-push/config` response.
export function webPushSupport(): WebPushSupport {
  if (isElectron) {
    return { supported: false, reason: "electron" };
  }
  if (!window.isSecureContext) {
    return { supported: false, reason: "insecure-context" };
  }
  if (
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window)
  ) {
    return isIosBrowserNeedingInstall()
      ? { supported: false, reason: "ios-needs-install" }
      : { supported: false, reason: "no-push-api" };
  }
  return { supported: true };
}

function relayPreferences(events: WebPushEventPreferences): RelayAgentAwarenessPreferences {
  return {
    // No Live Activity analogue in a browser; the relay ignores the flag for
    // web subscriptions but the schema requires it.
    liveActivitiesEnabled: false,
    notificationsEnabled: true,
    ...events,
  };
}

function browserLabel(): string {
  const agent = navigator.userAgent;
  const browser = /Edg\//.test(agent)
    ? "Edge"
    : /OPR\//.test(agent)
      ? "Opera"
      : /Chrome\//.test(agent)
        ? "Chrome"
        : /Safari\//.test(agent)
          ? "Safari"
          : /Firefox\//.test(agent)
            ? "Firefox"
            : "Browser";
  const platform = /Mac/.test(agent)
    ? "macOS"
    : /Windows/.test(agent)
      ? "Windows"
      : /iPad|iPhone|iPod/.test(agent)
        ? "iOS"
        : /Android/.test(agent)
          ? "Android"
          : /Linux/.test(agent)
            ? "Linux"
            : null;
  return platform ? `${browser} on ${platform}` : browser;
}

// Safari rejects base64url strings for applicationServerKey; hand every
// browser the raw bytes. Backed by a plain ArrayBuffer to satisfy the
// BufferSource parameter type.
function applicationServerKeyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function subscriptionKey(subscription: PushSubscription, name: PushEncryptionKeyName): string {
  const key = subscription.getKey(name);
  if (!key) {
    throw new Error(`Push subscription is missing the ${name} key.`);
  }
  let binary = "";
  for (const byte of new Uint8Array(key)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export type WebPushEnableResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "permission-denied" | "not-signed-in" | "not-configured" | "failed";
      readonly detail?: string;
    };

async function acquireSubscription(vapidPublicKey: string): Promise<PushSubscription> {
  const registration = await navigator.serviceWorker.ready;
  return (
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKeyBytes(vapidPublicKey),
    }))
  );
}

// Whether a live subscription was created with this VAPID key. A subscription
// bound to a different applicationServerKey (server key regenerated, or a
// leftover relay-mode subscription) is silently undeliverable: the push service
// rejects every send whose signing key does not match the subscription's key.
function subscriptionMatchesVapidKey(
  subscription: PushSubscription,
  vapidPublicKey: string,
): boolean {
  const existingKey = subscription.options.applicationServerKey;
  if (!existingKey) {
    return false;
  }
  const expected = applicationServerKeyBytes(vapidPublicKey);
  const actual = new Uint8Array(existingKey);
  if (actual.length !== expected.length) {
    return false;
  }
  return actual.every((byte, index) => byte === expected[index]);
}

// Local mode: unlike the relay, the server owns the VAPID key, so a stale
// subscription bound to a different key must be dropped and recreated — reusing
// it would leave the browser subscribed but unreachable.
async function acquireLocalSubscription(vapidPublicKey: string): Promise<PushSubscription> {
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  if (existing) {
    if (subscriptionMatchesVapidKey(existing, vapidPublicKey)) {
      return existing;
    }
    await existing.unsubscribe();
  }
  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKeyBytes(vapidPublicKey),
  });
}

// ---------------------------------------------------------------------------
// Relay mode (T3 Connect): registers the subscription with the cloud relay.
// Behaviourally unchanged from before local mode existed.
// ---------------------------------------------------------------------------

async function registerWithRelay(
  subscription: PushSubscription,
  deviceId: string,
  events: WebPushEventPreferences,
): Promise<WebPushEnableResult> {
  const clerkToken = await readManagedRelayClerkToken();
  if (!clerkToken) {
    return { ok: false, reason: "not-signed-in" };
  }
  const result = await runtime.runPromiseExit(
    ManagedRelay.ManagedRelayClient.pipe(
      Effect.flatMap((client) =>
        client.registerDevice({
          clerkToken,
          payload: {
            deviceId,
            label: browserLabel(),
            platform: "web",
            webPushEndpoint: subscription.endpoint,
            webPushP256dh: subscriptionKey(subscription, "p256dh"),
            webPushAuth: subscriptionKey(subscription, "auth"),
            preferences: relayPreferences(events),
          },
        }),
      ),
    ),
  );
  if (result._tag === "Failure") {
    return { ok: false, reason: "failed", detail: String(result.cause) };
  }
  setLocalStorageItem(
    WEB_PUSH_STORAGE_KEY,
    { deviceId, endpoint: subscription.endpoint, preferences: events },
    WebPushRegistrationRecord,
  );
  return { ok: true };
}

async function enableRelayWebPush(events: WebPushEventPreferences): Promise<WebPushEnableResult> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return { ok: false, reason: "permission-denied" };
  }

  const config = await runtime.runPromiseExit(
    ManagedRelay.ManagedRelayClient.pipe(Effect.flatMap((client) => client.getWebPushConfig)),
  );
  if (config._tag === "Failure") {
    return { ok: false, reason: "failed", detail: String(config.cause) };
  }

  const subscription = await acquireSubscription(config.value.vapidPublicKey);
  const deviceId = readWebPushRegistration()?.deviceId ?? `web-${randomUUID()}`;
  return await registerWithRelay(subscription, deviceId, events);
}

async function disableRelayWebPush(record: WebPushRegistrationRecord): Promise<void> {
  const clerkToken = await readManagedRelayClerkToken();
  if (clerkToken) {
    await runtime.runPromiseExit(
      ManagedRelay.ManagedRelayClient.pipe(
        Effect.flatMap((client) =>
          client.unregisterDevice({ clerkToken, deviceId: record.deviceId }),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Local mode: registers straight with the paired Command Center server over
// its authenticated HTTP API (the same primary-environment client used for
// auth/session calls). The relay and Clerk are never touched.
// ---------------------------------------------------------------------------

// `configured: false` (null key) means the server has no VAPID subject set; the
// UI shows a not-configured hint instead of offering the toggle.
export function fetchLocalWebPushConfig(): Promise<WebPushConfigResult> {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.webPush.config({ headers: {} })),
    ),
  );
}

async function putLocalSubscription(
  subscription: PushSubscription,
  deviceId: string,
  events: WebPushEventPreferences,
): Promise<WebPushEnableResult> {
  try {
    await runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) =>
          client.webPush.putSubscription({
            headers: {},
            payload: {
              deviceId,
              endpoint: subscription.endpoint,
              p256dh: subscriptionKey(subscription, "p256dh"),
              auth: subscriptionKey(subscription, "auth"),
              preferences: events,
            },
          }),
        ),
      ),
    );
  } catch (cause) {
    return {
      ok: false,
      reason: "failed",
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }
  setLocalStorageItem(
    WEB_PUSH_STORAGE_KEY,
    { deviceId, endpoint: subscription.endpoint, preferences: events },
    WebPushRegistrationRecord,
  );
  return { ok: true };
}

async function enableLocalWebPush(events: WebPushEventPreferences): Promise<WebPushEnableResult> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return { ok: false, reason: "permission-denied" };
  }

  let config: WebPushConfigResult;
  try {
    config = await fetchLocalWebPushConfig();
  } catch (cause) {
    return {
      ok: false,
      reason: "failed",
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }
  if (!config.configured || !config.vapidPublicKey) {
    return { ok: false, reason: "not-configured" };
  }

  const subscription = await acquireLocalSubscription(config.vapidPublicKey);
  const deviceId = readWebPushRegistration()?.deviceId ?? `web-${randomUUID()}`;
  return await putLocalSubscription(subscription, deviceId, events);
}

// Local-mode reconcile fetches the server key so it can catch not just endpoint
// rotation but a key mismatch (which leaves the same endpoint but an
// undeliverable subscription); `acquireLocalSubscription` recreates the sub when
// the key changed, then we re-register whenever the live endpoint drifted.
async function reconcileLocalWebPush(record: WebPushRegistrationRecord): Promise<void> {
  let config: WebPushConfigResult;
  try {
    config = await fetchLocalWebPushConfig();
  } catch {
    return;
  }
  if (!config.configured || !config.vapidPublicKey) {
    return;
  }
  const subscription = await acquireLocalSubscription(config.vapidPublicKey);
  if (subscription.endpoint !== record.endpoint) {
    await putLocalSubscription(subscription, record.deviceId, record.preferences);
  }
}

async function disableLocalWebPush(record: WebPushRegistrationRecord): Promise<void> {
  try {
    await runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) =>
          client.webPush.deleteSubscription({
            headers: {},
            payload: { deviceId: record.deviceId },
          }),
        ),
      ),
    );
  } catch {
    // The server may already have dropped the row (dead endpoint cleanup); the
    // local unsubscribe above is what stops delivery to this browser.
  }
}

export type WebPushTestOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "not-configured" | "not-registered" | "failed";
      readonly status?: number;
      readonly detail?: string;
    };

// Local mode only: asks the server to push a "web-push-test" notification to
// this device. Relay mode has no equivalent endpoint.
export async function sendWebPushTestNotification(): Promise<WebPushTestOutcome> {
  const record = readWebPushRegistration();
  if (!record) {
    return { ok: false, reason: "not-registered" };
  }
  let result: WebPushTestResult;
  try {
    result = await runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) =>
          client.webPush.test({ headers: {}, payload: { deviceId: record.deviceId } }),
        ),
      ),
    );
  } catch (cause) {
    return {
      ok: false,
      reason: "failed",
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }
  if (result.notConfigured) {
    return { ok: false, reason: "not-configured" };
  }
  if (result.ok) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: "failed",
    status: result.status,
    ...(result.reason !== null ? { detail: result.reason } : {}),
  };
}

// ---------------------------------------------------------------------------
// Mode-dispatching public API used by the UI and startup.
// ---------------------------------------------------------------------------

export async function enableWebPushNotifications(
  events: WebPushEventPreferences = readWebPushRegistration()?.preferences ??
    defaultWebPushEventPreferences,
): Promise<WebPushEnableResult> {
  try {
    return isLocalWebPushMode()
      ? await enableLocalWebPush(events)
      : await enableRelayWebPush(events);
  } catch (cause) {
    return {
      ok: false,
      reason: "failed",
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

export async function disableWebPushNotifications(): Promise<void> {
  const record = readWebPushRegistration();
  removeLocalStorageItem(WEB_PUSH_STORAGE_KEY);
  try {
    const registration = await navigator.serviceWorker.ready;
    await (await registration.pushManager.getSubscription())?.unsubscribe();
  } catch {
    // The subscription may already be gone; server/relay-side cleanup still runs.
  }
  if (record) {
    if (isLocalWebPushMode()) {
      await disableLocalWebPush(record);
    } else {
      await disableRelayWebPush(record);
    }
  }
}

// Launch-time reconcile: push services rotate subscriptions (the SW forwards
// pushsubscriptionchange while a window is open, but rotation can also happen
// while none is), so a stored registration whose endpoint no longer matches
// the live subscription re-registers with the current delivery backend.
export async function reconcileWebPushRegistration(): Promise<void> {
  const record = readWebPushRegistration();
  if (!record || !webPushSupport().supported) {
    return;
  }
  try {
    if (Notification.permission !== "granted") {
      return;
    }
    if (isLocalWebPushMode()) {
      await reconcileLocalWebPush(record);
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      // Permission is still granted, so resubscribe with the stored identity.
      await enableWebPushNotifications(record.preferences);
      return;
    }
    if (subscription.endpoint !== record.endpoint) {
      await registerWithRelay(subscription, record.deviceId, record.preferences);
    }
  } catch {
    // Reconciliation is opportunistic; the next launch retries.
  }
}

// The SW posts {type: "push-subscription-change"} when the push service
// rotates the subscription while a window is open.
export function listenForWebPushSubscriptionChange(): void {
  if (!("serviceWorker" in navigator)) {
    return;
  }
  navigator.serviceWorker.addEventListener("message", (event) => {
    if ((event.data as { type?: string } | null)?.type === "push-subscription-change") {
      void reconcileWebPushRegistration();
    }
  });
}

// ---------------------------------------------------------------------------
// Local-mode view helpers (pure) — shared by the settings row and its tests.
// ---------------------------------------------------------------------------

export type LocalWebPushConfigState = "loading" | "configured" | "not-configured" | "unavailable";

export interface LocalWebPushViewModel {
  readonly toggleDisabled: boolean;
  readonly testButtonDisabled: boolean;
  readonly explanation: string | null;
}

export function localWebPushViewModel(input: {
  readonly configState: LocalWebPushConfigState;
  readonly enabled: boolean;
  readonly isUpdating: boolean;
  readonly isTesting: boolean;
}): LocalWebPushViewModel {
  const isConfigured = input.configState === "configured";
  return {
    toggleDisabled: input.isUpdating || !isConfigured,
    testButtonDisabled: !input.enabled || input.isTesting || !isConfigured,
    explanation:
      input.configState === "not-configured"
        ? "Notifications aren't set up on this server yet."
        : input.configState === "unavailable"
          ? "Couldn't reach this server to check notification settings."
          : null,
  };
}

export interface WebPushToastContent {
  readonly type: "success" | "error";
  readonly title: string;
  readonly description: string;
}

export function localEnableResultToast(result: WebPushEnableResult): WebPushToastContent {
  if (result.ok) {
    return {
      type: "success",
      title: "Browser notifications enabled",
      description:
        "This browser will notify you when agents need approval or input, or when work finishes.",
    };
  }
  if (result.reason === "permission-denied") {
    return {
      type: "error",
      title: "Could not enable notifications",
      description:
        "Notification permission was denied. Allow notifications for this site in your browser settings.",
    };
  }
  if (result.reason === "not-configured") {
    return {
      type: "error",
      title: "Notifications aren't set up on this server",
      description: "This server hasn't been configured to send notifications yet.",
    };
  }
  return {
    type: "error",
    title: "Could not enable notifications",
    description: "Something went wrong while registering this browser.",
  };
}

export const localDisableToast: WebPushToastContent = {
  type: "success",
  title: "Browser notifications disabled",
  description: "This browser will no longer receive agent activity notifications.",
};

export function localTestResultToast(outcome: WebPushTestOutcome): WebPushToastContent {
  if (outcome.ok) {
    return {
      type: "success",
      title: "Test notification sent",
      description: "Look for a notification from this server.",
    };
  }
  if (outcome.reason === "not-configured") {
    return {
      type: "error",
      title: "Not configured on this server",
      description: "This server hasn't been configured to send notifications yet.",
    };
  }
  if (outcome.reason === "not-registered") {
    return {
      type: "error",
      title: "Enable notifications first",
      description: "Turn on browser notifications before sending a test.",
    };
  }
  return {
    type: "error",
    title: "Test notification failed",
    description:
      outcome.status !== undefined
        ? `The push service responded with status ${outcome.status}.`
        : (outcome.detail ?? "Something went wrong while sending the test notification."),
  };
}
