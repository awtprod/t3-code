import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  getOrCreateVapidKeyPairFromSecretStore,
  make as makeWebPushConfig,
  parseWebPushSubject,
} from "./WebPushConfig.ts";

describe("parseWebPushSubject", () => {
  it("accepts mailto: and https: subjects", () => {
    expect(Option.getOrNull(parseWebPushSubject("mailto:ops@example.com"))).toBe(
      "mailto:ops@example.com",
    );
    expect(Option.getOrNull(parseWebPushSubject("  https://example.com/contact  "))).toBe(
      "https://example.com/contact",
    );
  });

  it("rejects unset, empty, bare-email, http:, and oversized subjects", () => {
    expect(Option.isNone(parseWebPushSubject(undefined))).toBe(true);
    expect(Option.isNone(parseWebPushSubject("   "))).toBe(true);
    expect(Option.isNone(parseWebPushSubject("ops@example.com"))).toBe(true);
    expect(Option.isNone(parseWebPushSubject("http://example.com"))).toBe(true);
    expect(Option.isNone(parseWebPushSubject("mailto:"))).toBe(true);
    expect(Option.isNone(parseWebPushSubject(`mailto:${"a".repeat(300)}`))).toBe(true);
  });
});

const secretStoreLayer = ServerSecretStore.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-web-push-config-test-" })),
);

it.layer(NodeServices.layer)("WebPushConfig VAPID key pair", (it) => {
  it.effect("returns a stable P-256 key pair on repeated get-or-create", () =>
    Effect.gen(function* () {
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const first = yield* getOrCreateVapidKeyPairFromSecretStore(secrets);
      const second = yield* getOrCreateVapidKeyPairFromSecretStore(secrets);
      assert.equal(first.privateKey, second.privateKey);
      assert.equal(first.publicKey, second.publicKey);
      assert.match(first.privateKey, /BEGIN PRIVATE KEY/);
    }).pipe(Effect.provide(secretStoreLayer)),
  );

  it.effect("resolves the create race to a single shared key pair", () =>
    Effect.gen(function* () {
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const [a, b, c] = yield* Effect.all(
        [
          getOrCreateVapidKeyPairFromSecretStore(secrets),
          getOrCreateVapidKeyPairFromSecretStore(secrets),
          getOrCreateVapidKeyPairFromSecretStore(secrets),
        ],
        { concurrency: 3 },
      );
      assert.equal(a.privateKey, b.privateKey);
      assert.equal(b.privateKey, c.privateKey);
    }).pipe(
      Effect.provide(
        ServerSecretStore.layer.pipe(
          Layer.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-web-push-config-race-" }),
          ),
        ),
      ),
    ),
  );

  it.effect("is configured with a valid subject and a base64url public key", () =>
    Effect.gen(function* () {
      const service = yield* makeWebPushConfig("mailto:ops@example.com");
      assert.isTrue(Option.isSome(service.config));
      if (Option.isSome(service.config)) {
        assert.equal(service.config.value.subject, "mailto:ops@example.com");
        assert.equal(Redacted.value(service.config.value.privateKey).includes("PRIVATE KEY"), true);
        const raw = Result.getOrThrow(Encoding.decodeBase64Url(service.config.value.publicKey));
        assert.equal(raw.length, 65);
        assert.equal(raw[0], 4);
      }
    }).pipe(Effect.provide(secretStoreLayer)),
  );

  it.effect("is not configured when the subject is unset or invalid", () =>
    Effect.gen(function* () {
      const unset = yield* makeWebPushConfig(undefined);
      assert.isTrue(Option.isNone(unset.config));
      const invalid = yield* makeWebPushConfig("http://not-allowed.example");
      assert.isTrue(Option.isNone(invalid.config));
    }).pipe(Effect.provide(secretStoreLayer)),
  );
});
