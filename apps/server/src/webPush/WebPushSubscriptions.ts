import { WebPushPreferences } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  type AuthSessionRepositoryError,
  PersistenceDecodeError,
  PersistenceSqlError,
} from "../persistence/Errors.ts";

// The persistence errors are shared with the auth repositories; the union type is
// named for its first consumer but the two variants are generic.
export type WebPushSubscriptionRepositoryError = AuthSessionRepositoryError;

export const WebPushSubscriptionRecord = Schema.Struct({
  deviceId: Schema.String,
  endpoint: Schema.String,
  p256dh: Schema.String,
  auth: Schema.String,
  preferences: WebPushPreferences,
});
export type WebPushSubscriptionRecord = typeof WebPushSubscriptionRecord.Type;

export interface UpsertWebPushSubscriptionInput {
  readonly deviceId: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly preferences: WebPushPreferences;
}

export class WebPushSubscriptions extends Context.Service<
  WebPushSubscriptions,
  {
    // Upsert by device: a device's endpoint can rotate, so this claims both the
    // device's previous row and any row already holding the new endpoint.
    readonly upsert: (
      input: UpsertWebPushSubscriptionInput,
    ) => Effect.Effect<void, WebPushSubscriptionRepositoryError>;
    readonly getByDeviceId: (
      deviceId: string,
    ) => Effect.Effect<
      Option.Option<WebPushSubscriptionRecord>,
      WebPushSubscriptionRepositoryError
    >;
    readonly listAll: () => Effect.Effect<
      ReadonlyArray<WebPushSubscriptionRecord>,
      WebPushSubscriptionRepositoryError
    >;
    readonly deleteByDeviceId: (
      deviceId: string,
    ) => Effect.Effect<void, WebPushSubscriptionRepositoryError>;
    // A push service that returns 404/410 has dropped the subscription; delete
    // the dead row so it is never retried.
    readonly deleteByEndpoint: (
      endpoint: string,
    ) => Effect.Effect<void, WebPushSubscriptionRepositoryError>;
  }
>()("@awtprod/command-center/webPush/WebPushSubscriptions") {}

const WebPushPreferencesJson = Schema.fromJsonString(WebPushPreferences);
const encodePreferencesJson = Schema.encodeEffect(WebPushPreferencesJson);

const WebPushSubscriptionDbRow = Schema.Struct({
  deviceId: Schema.String,
  endpoint: Schema.String,
  p256dh: Schema.String,
  auth: Schema.String,
  preferences: WebPushPreferencesJson,
});

const WebPushSubscriptionRawDbRow = Schema.Struct({
  deviceId: Schema.String,
  endpoint: Schema.Unknown,
  p256dh: Schema.Unknown,
  auth: Schema.Unknown,
  preferences: Schema.Unknown,
});

function toRecord(row: typeof WebPushSubscriptionDbRow.Type): WebPushSubscriptionRecord {
  return {
    deviceId: row.deviceId,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    preferences: row.preferences,
  };
}

function sqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): WebPushSubscriptionRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause)
      : new PersistenceSqlError({ operation: sqlOperation, cause });
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getRowByDeviceId = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: WebPushSubscriptionRawDbRow,
    execute: (deviceId) =>
      sql`
        SELECT
          device_id AS "deviceId",
          endpoint AS "endpoint",
          p256dh AS "p256dh",
          auth AS "auth",
          preferences_json AS "preferences"
        FROM web_push_subscriptions
        WHERE device_id = ${deviceId}
      `,
  });

  const listAllRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: WebPushSubscriptionRawDbRow,
    execute: () =>
      sql`
        SELECT
          device_id AS "deviceId",
          endpoint AS "endpoint",
          p256dh AS "p256dh",
          auth AS "auth",
          preferences_json AS "preferences"
        FROM web_push_subscriptions
        ORDER BY created_at ASC, device_id ASC
      `,
  });

  const decodeRow = Schema.decodeUnknownEffect(WebPushSubscriptionDbRow);

  const upsert: WebPushSubscriptions["Service"]["upsert"] = (input) =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      const preferencesJson = yield* encodePreferencesJson(input.preferences);
      // One transaction: drop the device's previous row and any row already
      // holding this endpoint (a rotated endpoint can collide with another
      // device's stale row), then insert the fresh row. Keeps both the
      // device_id and endpoint unique constraints satisfiable.
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            DELETE FROM web_push_subscriptions
            WHERE device_id = ${input.deviceId} OR endpoint = ${input.endpoint}
          `;
          yield* sql`
            INSERT INTO web_push_subscriptions (
              endpoint, device_id, p256dh, auth, preferences_json, created_at, updated_at
            ) VALUES (
              ${input.endpoint}, ${input.deviceId}, ${input.p256dh}, ${input.auth},
              ${preferencesJson}, ${now}, ${now}
            )
          `;
        }),
      );
    }).pipe(
      Effect.mapError(
        sqlOrDecodeError("WebPushSubscriptions.upsert", "WebPushSubscriptions.upsert"),
      ),
    );

  const getByDeviceId: WebPushSubscriptions["Service"]["getByDeviceId"] = (deviceId) =>
    getRowByDeviceId(deviceId).pipe(
      Effect.mapError(
        sqlOrDecodeError(
          "WebPushSubscriptions.getByDeviceId",
          "WebPushSubscriptions.getByDeviceId",
        ),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none<WebPushSubscriptionRecord>()),
          onSome: (row) =>
            decodeRow(row).pipe(
              Effect.map((decoded) => Option.some(toRecord(decoded))),
              Effect.mapError(
                sqlOrDecodeError(
                  "WebPushSubscriptions.getByDeviceId",
                  "WebPushSubscriptions.getByDeviceId:decode",
                ),
              ),
            ),
        }),
      ),
    );

  const listAll: WebPushSubscriptions["Service"]["listAll"] = () =>
    listAllRows(undefined).pipe(
      Effect.mapError(
        sqlOrDecodeError("WebPushSubscriptions.listAll", "WebPushSubscriptions.listAll"),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodeRow(row).pipe(
            Effect.map(toRecord),
            Effect.mapError(
              sqlOrDecodeError(
                "WebPushSubscriptions.listAll",
                "WebPushSubscriptions.listAll:decode",
              ),
            ),
          ),
        ),
      ),
    );

  const deleteByDeviceId: WebPushSubscriptions["Service"]["deleteByDeviceId"] = (deviceId) =>
    sql`DELETE FROM web_push_subscriptions WHERE device_id = ${deviceId}`.pipe(
      Effect.asVoid,
      Effect.mapError(
        sqlOrDecodeError(
          "WebPushSubscriptions.deleteByDeviceId",
          "WebPushSubscriptions.deleteByDeviceId",
        ),
      ),
    );

  const deleteByEndpoint: WebPushSubscriptions["Service"]["deleteByEndpoint"] = (endpoint) =>
    sql`DELETE FROM web_push_subscriptions WHERE endpoint = ${endpoint}`.pipe(
      Effect.asVoid,
      Effect.mapError(
        sqlOrDecodeError(
          "WebPushSubscriptions.deleteByEndpoint",
          "WebPushSubscriptions.deleteByEndpoint",
        ),
      ),
    );

  return WebPushSubscriptions.of({
    upsert,
    getByDeviceId,
    listAll,
    deleteByDeviceId,
    deleteByEndpoint,
  });
});

export const layer = Layer.effect(WebPushSubscriptions, make);
