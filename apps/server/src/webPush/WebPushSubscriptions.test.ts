import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  layer as webPushSubscriptionsLayer,
  WebPushSubscriptions,
} from "./WebPushSubscriptions.ts";

const PREFERENCES = {
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
} as const;

const storeLayer = () => webPushSubscriptionsLayer.pipe(Layer.provide(SqlitePersistenceMemory));

const base = {
  deviceId: "device-a",
  endpoint: "https://fcm.googleapis.com/fcm/send/a",
  p256dh: "p256dh-a",
  auth: "auth-a",
  preferences: PREFERENCES,
};

it.effect("upserts and reads a subscription back by device id", () =>
  Effect.gen(function* () {
    const store = yield* WebPushSubscriptions;
    yield* store.upsert(base);
    const found = yield* store.getByDeviceId("device-a");
    assert.isTrue(Option.isSome(found));
    if (Option.isSome(found)) {
      assert.equal(found.value.endpoint, base.endpoint);
      assert.deepEqual(found.value.preferences, PREFERENCES);
    }
  }).pipe(Effect.provide(storeLayer())),
);

it.effect("rotates a device's endpoint on re-upsert without leaving the old row", () =>
  Effect.gen(function* () {
    const store = yield* WebPushSubscriptions;
    yield* store.upsert(base);
    yield* store.upsert({ ...base, endpoint: "https://fcm.googleapis.com/fcm/send/rotated" });
    const all = yield* store.listAll();
    assert.equal(all.length, 1);
    assert.equal(all[0]?.endpoint, "https://fcm.googleapis.com/fcm/send/rotated");
  }).pipe(Effect.provide(storeLayer())),
);

it.effect("claims an endpoint held by another device", () =>
  Effect.gen(function* () {
    const store = yield* WebPushSubscriptions;
    yield* store.upsert(base);
    // A different device subscribes to the same rotated endpoint.
    yield* store.upsert({ ...base, deviceId: "device-b" });
    const all = yield* store.listAll();
    assert.equal(all.length, 1);
    assert.equal(all[0]?.deviceId, "device-b");
  }).pipe(Effect.provide(storeLayer())),
);

it.effect("deletes by device id", () =>
  Effect.gen(function* () {
    const store = yield* WebPushSubscriptions;
    yield* store.upsert(base);
    yield* store.deleteByDeviceId("device-a");
    assert.isTrue(Option.isNone(yield* store.getByDeviceId("device-a")));
  }).pipe(Effect.provide(storeLayer())),
);

it.effect("deletes a dead subscription by endpoint (404/410 path)", () =>
  Effect.gen(function* () {
    const store = yield* WebPushSubscriptions;
    yield* store.upsert(base);
    yield* store.deleteByEndpoint(base.endpoint);
    assert.equal((yield* store.listAll()).length, 0);
  }).pipe(Effect.provide(storeLayer())),
);
