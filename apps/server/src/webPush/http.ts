import {
  AuthRelayReadScope,
  EnvironmentHttpApi,
  EnvironmentHttpBadRequestError,
  ThreadId,
} from "@t3tools/contracts";
import { buildAgentAwarenessDeepLink } from "@t3tools/shared/agentAwareness";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { clipNotificationText } from "./notificationPayload.ts";
import { isAllowedPushEndpoint } from "./pushEndpointAllowlist.ts";
import { WebPushConfig } from "./WebPushConfig.ts";
import { WebPushSender } from "./WebPushSender.ts";
import { WebPushSubscriptions } from "./WebPushSubscriptions.ts";

interface WebPushHttpDependencies {
  readonly config: WebPushConfig["Service"];
  readonly subscriptions: WebPushSubscriptions["Service"];
  readonly sender: WebPushSender["Service"];
  readonly environment: ServerEnvironment.ServerEnvironment["Service"];
}

// Registering a browser's own push subscription and sending oneself a test is a
// per-client notification setting, the local analogue of the relay notification
// endpoints. `relay:read` is the notification-domain scope that standard paired
// clients (the PWA) already hold; `relay:write` gates environment-wide relay
// link administration and is intentionally withheld from standard clients, so
// gating on it would lock the PWA out. Least privilege that still works: relay:read.
const WEB_PUSH_SCOPE = AuthRelayReadScope;

const configHandler = (dependencies: WebPushHttpDependencies) =>
  Effect.fn("environment.webPush.config")(function* (args: {
    readonly endpoint: { readonly name: string };
  }) {
    yield* annotateEnvironmentRequest(args.endpoint.name);
    yield* requireEnvironmentScope(WEB_PUSH_SCOPE);
    return Option.match(dependencies.config.config, {
      onNone: () => ({ configured: false, vapidPublicKey: null }),
      onSome: (config) => ({ configured: true, vapidPublicKey: config.publicKey }),
    });
  });

const putSubscriptionHandler = (dependencies: WebPushHttpDependencies) =>
  Effect.fn("environment.webPush.putSubscription")(function* (args: {
    readonly endpoint: { readonly name: string };
    readonly payload: {
      readonly deviceId: string;
      readonly endpoint: string;
      readonly p256dh: string;
      readonly auth: string;
      readonly preferences: {
        readonly notifyOnApproval: boolean;
        readonly notifyOnInput: boolean;
        readonly notifyOnCompletion: boolean;
        readonly notifyOnFailure: boolean;
      };
    };
  }) {
    yield* annotateEnvironmentRequest(args.endpoint.name);
    yield* requireEnvironmentScope(WEB_PUSH_SCOPE);
    if (!isAllowedPushEndpoint(args.payload.endpoint)) {
      return yield* new EnvironmentHttpBadRequestError({
        message: "Push endpoint host is not on the allowed push-service allowlist.",
      });
    }
    yield* dependencies.subscriptions
      .upsert({
        deviceId: args.payload.deviceId,
        endpoint: args.payload.endpoint,
        p256dh: args.payload.p256dh,
        auth: args.payload.auth,
        preferences: args.payload.preferences,
      })
      .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
    return { ok: true };
  });

const deleteSubscriptionHandler = (dependencies: WebPushHttpDependencies) =>
  Effect.fn("environment.webPush.deleteSubscription")(function* (args: {
    readonly endpoint: { readonly name: string };
    readonly payload: { readonly deviceId: string };
  }) {
    yield* annotateEnvironmentRequest(args.endpoint.name);
    yield* requireEnvironmentScope(WEB_PUSH_SCOPE);
    yield* dependencies.subscriptions
      .deleteByDeviceId(args.payload.deviceId)
      .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
    return { ok: true };
  });

const testHandler = (dependencies: WebPushHttpDependencies) =>
  Effect.fn("environment.webPush.test")(function* (args: {
    readonly endpoint: { readonly name: string };
    readonly payload: { readonly deviceId: string };
  }) {
    yield* annotateEnvironmentRequest(args.endpoint.name);
    yield* requireEnvironmentScope(WEB_PUSH_SCOPE);

    const subscription = yield* dependencies.subscriptions
      .getByDeviceId(args.payload.deviceId)
      .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
    if (Option.isNone(subscription)) {
      return yield* new EnvironmentHttpBadRequestError({
        message: "No push subscription is registered for this device.",
      });
    }
    if (Option.isNone(dependencies.config.config)) {
      return { ok: false, notConfigured: true, status: 0, reason: null };
    }

    const environmentId = yield* dependencies.environment.getEnvironmentId;
    // A thread-less deep link the service worker still accepts:
    // /threads/{env}/{threadId} with a synthetic threadId keeps the SW's
    // exactly-these-keys + valid-deepLink contract satisfied.
    const threadId = ThreadId.make("web-push-test");
    const result = yield* dependencies.sender
      .send({
        endpoint: subscription.value.endpoint,
        p256dh: subscription.value.p256dh,
        auth: subscription.value.auth,
        payload: {
          title: clipNotificationText("Test notification"),
          body: clipNotificationText("Command Center web push is working."),
          environmentId,
          threadId,
          deepLink: buildAgentAwarenessDeepLink({ environmentId, threadId }),
        },
      })
      .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));

    if (result.permanentFailure) {
      yield* dependencies.subscriptions
        .deleteByEndpoint(subscription.value.endpoint)
        .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
    }
    return {
      ok: result.ok,
      notConfigured: false,
      status: result.status,
      reason: result.reason ?? null,
    };
  });

export const webPushHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "webPush",
  Effect.fnUntraced(function* (handlers) {
    const dependencies: WebPushHttpDependencies = {
      config: yield* WebPushConfig,
      subscriptions: yield* WebPushSubscriptions,
      sender: yield* WebPushSender,
      environment: yield* ServerEnvironment.ServerEnvironment,
    };
    return handlers
      .handle("config", configHandler(dependencies))
      .handle("putSubscription", putSubscriptionHandler(dependencies))
      .handle("deleteSubscription", deleteSubscriptionHandler(dependencies))
      .handle("test", testHandler(dependencies));
  }),
);
