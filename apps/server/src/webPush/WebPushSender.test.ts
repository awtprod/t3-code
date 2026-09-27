import * as NodeCrypto from "node:crypto";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import { vapidPublicKeyFromPem } from "./webPushCrypto.ts";
import { WebPushConfig } from "./WebPushConfig.ts";
import {
  __resetWebPushJwtCacheForTest,
  make as makeSender,
  WebPushSender,
} from "./WebPushSender.ts";

// RFC 8291 Appendix A subscription keys: valid 65-byte p256dh + 16-byte auth.
const P256DH =
  "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const AUTH = "BTBZMqHH6r4Tts7J_aSIgg"; // published RFC test vector, gitleaks:allow

const ALLOWED_ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc123";

const PAYLOAD = {
  title: "Thread done",
  body: "Done: Proj",
  environmentId: "env-1",
  threadId: "thread-1",
  deepLink: "/threads/env-1/thread-1",
};

const configLayer = Layer.effect(
  WebPushConfig,
  Effect.sync(() => {
    const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    return WebPushConfig.of({
      config: Option.some({
        subject: "mailto:ops@example.com",
        publicKey: vapidPublicKeyFromPem(publicKey),
        privateKey: Redacted.make(privateKey),
      }),
    });
  }),
);

const senderLayer = (fakeFetch: typeof globalThis.fetch) =>
  Layer.effect(WebPushSender, makeSender).pipe(
    Layer.provide(
      FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fakeFetch))),
    ),
    Layer.provide(configLayer),
  );

it.effect("rejects a disallowed endpoint without making an HTTP request", () => {
  let calls = 0;
  const fakeFetch = (() => {
    calls += 1;
    return Promise.resolve(new Response(null, { status: 201 }));
  }) as unknown as typeof globalThis.fetch;

  return Effect.gen(function* () {
    __resetWebPushJwtCacheForTest();
    const sender = yield* WebPushSender;
    const error = yield* sender
      .send({
        endpoint: "https://blocked.example/x",
        p256dh: P256DH,
        auth: AUTH,
        payload: PAYLOAD,
      })
      .pipe(Effect.flip);

    assert.equal(error._tag, "WebPushEndpointNotAllowedError");
    assert.equal(calls, 0);
  }).pipe(Effect.provide(senderLayer(fakeFetch)));
});

it.effect("does not follow redirects: a 3xx is returned as a non-ok result", () => {
  let calls = 0;
  let seenRedirect: string | undefined;
  const fakeFetch = ((_url: unknown, init?: RequestInit) => {
    calls += 1;
    seenRedirect = init?.redirect;
    return Promise.resolve(new Response(null, { status: 302 }));
  }) as unknown as typeof globalThis.fetch;

  return Effect.gen(function* () {
    __resetWebPushJwtCacheForTest();
    const sender = yield* WebPushSender;
    const result = yield* sender.send({
      endpoint: ALLOWED_ENDPOINT,
      p256dh: P256DH,
      auth: AUTH,
      payload: PAYLOAD,
    });

    assert.equal(calls, 1);
    assert.equal(seenRedirect, "manual");
    assert.equal(result.ok, false);
    assert.equal(result.status, 302);
    assert.equal(result.permanentFailure, false);
  }).pipe(Effect.provide(senderLayer(fakeFetch)));
});

it.effect("surfaces a hung push service as a timeout error", () => {
  let markInvoked: () => void = () => {};
  const invoked = new Promise<void>((resolve) => {
    markInvoked = resolve;
  });
  const hangingFetch = (() => {
    markInvoked();
    return new Promise<Response>(() => {});
  }) as unknown as typeof globalThis.fetch;

  return Effect.gen(function* () {
    __resetWebPushJwtCacheForTest();
    const sender = yield* WebPushSender;
    const fiber = yield* sender
      .send({ endpoint: ALLOWED_ENDPOINT, p256dh: P256DH, auth: AUTH, payload: PAYLOAD })
      .pipe(Effect.flip, Effect.forkScoped);
    // Wait until the request is in flight (timeout timer armed), then advance.
    yield* Effect.promise(() => invoked);
    yield* TestClock.adjust("15 seconds");
    const error = yield* Fiber.join(fiber);

    assert.equal(error._tag, "WebPushHttpRequestError");
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(senderLayer(hangingFetch), TestClock.layer())),
  );
});
