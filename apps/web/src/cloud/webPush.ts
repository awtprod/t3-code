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
import { runtime } from "../lib/runtime";
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

export type WebPushSupport =
  | { readonly supported: true }
  | {
      readonly supported: false;
      readonly reason:
        | "cloud-not-configured"
        | "electron"
        | "insecure-context"
        | "no-push-api"
        | "ios-needs-install";
    };

// iOS Safari only exposes the Push API once the app is installed to the home
// screen; detect the "would work if installed" case to show a useful hint.
function isIosBrowserNeedingInstall(): boolean {
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches;
  return isIos && !isStandalone && !("PushManager" in window);
}

export function webPushSupport(): WebPushSupport {
  if (!hasCloudPublicConfig()) {
    return { supported: false, reason: "cloud-not-configured" };
  }
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
      readonly reason: "permission-denied" | "not-signed-in" | "failed";
      readonly detail?: string;
    };

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

export async function enableWebPushNotifications(
  events: WebPushEventPreferences = readWebPushRegistration()?.preferences ??
    defaultWebPushEventPreferences,
): Promise<WebPushEnableResult> {
  try {
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

    const registration = await navigator.serviceWorker.ready;
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKeyBytes(config.value.vapidPublicKey),
      }));

    const deviceId = readWebPushRegistration()?.deviceId ?? `web-${randomUUID()}`;
    return await registerWithRelay(subscription, deviceId, events);
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
    // The subscription may already be gone; relay-side cleanup still runs.
  }
  if (record) {
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
}

// Launch-time reconcile: push services rotate subscriptions (the SW forwards
// pushsubscriptionchange while a window is open, but rotation can also happen
// while none is), so a stored registration whose endpoint no longer matches
// the live subscription re-registers with the relay.
export async function reconcileWebPushRegistration(): Promise<void> {
  const record = readWebPushRegistration();
  if (!record || !webPushSupport().supported) {
    return;
  }
  try {
    if (Notification.permission !== "granted") {
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
