import type {
  RelayAgentAwarenessPreferences,
  RelayClientDeviceRecord,
  RelayDeviceRegistrationRequest,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { and, eq, ne } from "drizzle-orm";

import * as RelayDb from "../db.ts";
import { relayWebPushSubscriptions } from "../persistence/schema.ts";

export class WebPushRegistrationInvalidError extends Schema.TaggedErrorClass<WebPushRegistrationInvalidError>()(
  "WebPushRegistrationInvalidError",
  {
    userId: Schema.String,
    deviceId: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Invalid web push registration for ${this.userId}/${this.deviceId}: ${this.reason}.`;
  }
}

export class WebPushSubscriptionPersistenceError extends Schema.TaggedErrorClass<WebPushSubscriptionPersistenceError>()(
  "WebPushSubscriptionPersistenceError",
  {
    userId: Schema.String,
    deviceId: Schema.optional(Schema.String),
    stage: Schema.Literals(["claim-endpoint", "upsert", "delete", "list", "invalidate"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to persist web push subscription for ${this.userId} during ${this.stage}.`;
  }
}

export interface WebPushTarget {
  readonly userId: string;
  readonly deviceId: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly preferences: RelayAgentAwarenessPreferences;
}

export class WebPushSubscriptions extends Context.Service<
  WebPushSubscriptions,
  {
    readonly register: (input: {
      readonly userId: string;
      readonly registration: RelayDeviceRegistrationRequest;
    }) => Effect.Effect<
      void,
      WebPushRegistrationInvalidError | WebPushSubscriptionPersistenceError
    >;
    readonly unregister: (input: {
      readonly userId: string;
      readonly deviceId: string;
    }) => Effect.Effect<void, WebPushSubscriptionPersistenceError>;
    readonly listTargets: (input: {
      readonly userId: string;
    }) => Effect.Effect<ReadonlyArray<WebPushTarget>, WebPushSubscriptionPersistenceError>;
    readonly listForUser: (input: {
      readonly userId: string;
    }) => Effect.Effect<
      ReadonlyArray<RelayClientDeviceRecord>,
      WebPushSubscriptionPersistenceError
    >;
    // Push services hand out one endpoint per subscription; a 404/410 from the
    // service means the browser dropped it, so the stored row is dead.
    readonly invalidateEndpoint: (input: {
      readonly endpoint: string;
    }) => Effect.Effect<void, WebPushSubscriptionPersistenceError>;
  }
>()("t3code-relay/agentActivity/WebPushSubscriptions") {}

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  return WebPushSubscriptions.of({
    register: Effect.fn("relay.web_push.register")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.web_push.device_id": input.registration.deviceId,
      });
      const registration = input.registration;
      const { deviceId } = registration;
      const endpoint = registration.webPushEndpoint;
      const p256dh = registration.webPushP256dh;
      const auth = registration.webPushAuth;
      if (!endpoint || !p256dh || !auth) {
        return yield* new WebPushRegistrationInvalidError({
          userId: input.userId,
          deviceId,
          reason: "webPushEndpoint, webPushP256dh, and webPushAuth are required",
        });
      }
      if (!endpoint.startsWith("https://")) {
        return yield* new WebPushRegistrationInvalidError({
          userId: input.userId,
          deviceId,
          reason: "webPushEndpoint must be an https URL",
        });
      }
      const updatedAt = DateTime.formatIso(yield* DateTime.now);

      // Same lazy-proxy constraint as Devices.register: every db chain must be
      // consumed via `yield*`, never handed to Effect.all.
      //
      // An endpoint uniquely identifies one browser subscription; if another
      // row (any user, any device) still holds it, that row is stale — claim
      // it by deletion so the unique index cannot reject the upsert.
      yield* db
        .delete(relayWebPushSubscriptions)
        .where(
          and(
            eq(relayWebPushSubscriptions.endpoint, endpoint),
            ne(relayWebPushSubscriptions.userId, input.userId),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new WebPushSubscriptionPersistenceError({
                userId: input.userId,
                deviceId,
                stage: "claim-endpoint",
                cause,
              }),
          ),
        );
      yield* db
        .delete(relayWebPushSubscriptions)
        .where(
          and(
            eq(relayWebPushSubscriptions.userId, input.userId),
            eq(relayWebPushSubscriptions.endpoint, endpoint),
            ne(relayWebPushSubscriptions.deviceId, deviceId),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new WebPushSubscriptionPersistenceError({
                userId: input.userId,
                deviceId,
                stage: "claim-endpoint",
                cause,
              }),
          ),
        );

      yield* db
        .insert(relayWebPushSubscriptions)
        .values({
          userId: input.userId,
          deviceId,
          label: registration.label,
          endpoint,
          p256dh,
          auth,
          appVersion: registration.appVersion ?? null,
          preferencesJson: registration.preferences,
          createdAt: updatedAt,
          updatedAt,
        })
        .onConflictDoUpdate({
          target: [relayWebPushSubscriptions.userId, relayWebPushSubscriptions.deviceId],
          set: {
            label: registration.label,
            endpoint,
            p256dh,
            auth,
            appVersion: registration.appVersion ?? null,
            preferencesJson: registration.preferences,
            updatedAt,
          },
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new WebPushSubscriptionPersistenceError({
                userId: input.userId,
                deviceId,
                stage: "upsert",
                cause,
              }),
          ),
        );
    }),

    unregister: Effect.fn("relay.web_push.unregister")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.web_push.device_id": input.deviceId,
      });
      yield* db
        .delete(relayWebPushSubscriptions)
        .where(
          and(
            eq(relayWebPushSubscriptions.userId, input.userId),
            eq(relayWebPushSubscriptions.deviceId, input.deviceId),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new WebPushSubscriptionPersistenceError({
                userId: input.userId,
                deviceId: input.deviceId,
                stage: "delete",
                cause,
              }),
          ),
        );
    }),

    listTargets: Effect.fn("relay.web_push.list_targets")(function* (input) {
      const rows = yield* db
        .select({
          deviceId: relayWebPushSubscriptions.deviceId,
          endpoint: relayWebPushSubscriptions.endpoint,
          p256dh: relayWebPushSubscriptions.p256dh,
          auth: relayWebPushSubscriptions.auth,
          preferences: relayWebPushSubscriptions.preferencesJson,
        })
        .from(relayWebPushSubscriptions)
        .where(eq(relayWebPushSubscriptions.userId, input.userId))
        .pipe(
          Effect.mapError(
            (cause) =>
              new WebPushSubscriptionPersistenceError({
                userId: input.userId,
                stage: "list",
                cause,
              }),
          ),
        );
      return rows.map((row) => ({
        userId: input.userId,
        deviceId: row.deviceId,
        endpoint: row.endpoint,
        p256dh: row.p256dh,
        auth: row.auth,
        preferences: row.preferences,
      }));
    }),

    listForUser: Effect.fn("relay.web_push.list_for_user")(function* (input) {
      const rows = yield* db
        .select({
          deviceId: relayWebPushSubscriptions.deviceId,
          label: relayWebPushSubscriptions.label,
          appVersion: relayWebPushSubscriptions.appVersion,
          preferences: relayWebPushSubscriptions.preferencesJson,
          updatedAt: relayWebPushSubscriptions.updatedAt,
        })
        .from(relayWebPushSubscriptions)
        .where(eq(relayWebPushSubscriptions.userId, input.userId))
        .pipe(
          Effect.mapError(
            (cause) =>
              new WebPushSubscriptionPersistenceError({
                userId: input.userId,
                stage: "list",
                cause,
              }),
          ),
        );
      return rows.map((row) => ({
        deviceId: row.deviceId,
        label: row.label,
        platform: "web" as const,
        iosMajorVersion: null,
        appVersion: row.appVersion,
        notifications: {
          enabled: row.preferences.notificationsEnabled,
          notifyOnApproval: row.preferences.notifyOnApproval,
          notifyOnInput: row.preferences.notifyOnInput,
          notifyOnCompletion: row.preferences.notifyOnCompletion,
          notifyOnFailure: row.preferences.notifyOnFailure,
        },
        liveActivities: {
          enabled: false,
        },
        updatedAt: row.updatedAt,
      }));
    }),

    invalidateEndpoint: Effect.fn("relay.web_push.invalidate_endpoint")(function* (input) {
      yield* db
        .delete(relayWebPushSubscriptions)
        .where(eq(relayWebPushSubscriptions.endpoint, input.endpoint))
        .pipe(
          Effect.mapError(
            (cause) =>
              new WebPushSubscriptionPersistenceError({
                userId: "unknown",
                stage: "invalidate",
                cause,
              }),
          ),
        );
    }),
  });
});

export const layer = Layer.effect(WebPushSubscriptions, make);
