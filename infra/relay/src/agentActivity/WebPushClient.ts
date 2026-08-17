import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import * as RelayConfiguration from "../Config.ts";
import { encryptWebPushPayload, makeVapidJwt, WebPushCryptoError } from "./webPushCrypto.ts";

// Push services cap TTL generously; an hour comfortably outlives the queue's
// retry window while keeping missed notifications from arriving absurdly late.
const WEB_PUSH_TTL_SECONDS = 60 * 60;
// VAPID JWTs may live up to 24h. Quantize expiry the way ApnsProviderTokens
// quantizes iat: every isolate derives the identical (deterministically
// signed) JWT within a window, so the jwtCache never signs twice per origin.
export const VAPID_JWT_WINDOW_SECONDS = 6 * 60 * 60;
const VAPID_JWT_LIFETIME_SECONDS = 12 * 60 * 60;

export class WebPushHttpRequestError extends Schema.TaggedErrorClass<WebPushHttpRequestError>()(
  "WebPushHttpRequestError",
  {
    endpointOrigin: Schema.String,
    stage: Schema.Literals(["send", "read-response"]),
    status: Schema.NullOr(Schema.Number),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Web push request to ${this.endpointOrigin} failed during ${this.stage}.`;
  }
}

export const WebPushError = Schema.Union([WebPushCryptoError, WebPushHttpRequestError]);
export type WebPushError = typeof WebPushError.Type;

export interface WebPushDeliveryResult {
  readonly ok: boolean;
  readonly status: number;
  readonly reason?: string;
  // The stored subscription is dead (the browser unsubscribed or the
  // subscription rotated); delete the row instead of retrying.
  readonly permanentFailure: boolean;
}

// What the service worker's push handler receives; keep in sync with
// apps/web/public/service-worker.js.
export interface WebPushNotificationPayload {
  readonly title: string;
  readonly body: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly deepLink: string;
}

export class WebPushClient extends Context.Service<
  WebPushClient,
  {
    readonly send: (input: {
      readonly endpoint: string;
      readonly p256dh: string;
      readonly auth: string;
      readonly payload: WebPushNotificationPayload;
    }) => Effect.Effect<WebPushDeliveryResult, WebPushError>;
  }
>()("t3code-relay/agentActivity/WebPushClient") {}

const encodeWebPushPayloadJson = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      title: Schema.String,
      body: Schema.String,
      environmentId: Schema.String,
      threadId: Schema.String,
      deepLink: Schema.String,
    }),
  ),
);

// One JWT per push-service origin per expiry window (see apnsJwt.ts for why
// deterministic signing makes this cache fleet-coherent).
const jwtCache = new Map<string, { readonly jwt: string; readonly expiresAt: number }>();

export function __resetWebPushJwtCacheForTest(): void {
  jwtCache.clear();
}

export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const config = yield* RelayConfiguration.RelayConfiguration;

  const vapidJwtForOrigin = Effect.fnUntraced(function* (origin: string, nowMs: number) {
    const nowSeconds = Math.floor(nowMs / 1_000);
    const windowStart =
      Math.floor(nowSeconds / VAPID_JWT_WINDOW_SECONDS) * VAPID_JWT_WINDOW_SECONDS;
    const expiresAtUnixSeconds = windowStart + VAPID_JWT_LIFETIME_SECONDS;
    const cached = jwtCache.get(origin);
    if (cached && cached.expiresAt === expiresAtUnixSeconds) {
      return cached.jwt;
    }
    const jwt = yield* makeVapidJwt({
      audience: origin,
      subject: config.webPush.subject,
      privateKey: config.webPush.privateKey,
      expiresAtUnixSeconds,
    });
    jwtCache.set(origin, { jwt, expiresAt: expiresAtUnixSeconds });
    return jwt;
  });

  return WebPushClient.of({
    send: Effect.fn("relay.web_push.send")(function* (input) {
      const origin = new URL(input.endpoint).origin;
      yield* Effect.annotateCurrentSpan({ "relay.web_push.endpoint_origin": origin });

      const payloadJson = yield* encodeWebPushPayloadJson(input.payload).pipe(
        Effect.mapError((cause) => new WebPushCryptoError({ stage: "encrypt", cause })),
      );
      const body = yield* encryptWebPushPayload({
        plaintext: new TextEncoder().encode(payloadJson),
        p256dh: input.p256dh,
        auth: input.auth,
      });
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      const jwt = yield* vapidJwtForOrigin(origin, now);

      const response = yield* HttpClientRequest.post(input.endpoint).pipe(
        HttpClientRequest.setHeaders({
          authorization: `vapid t=${jwt}, k=${config.webPush.publicKey}`,
          "content-encoding": "aes128gcm",
          ttl: String(WEB_PUSH_TTL_SECONDS),
          urgency: "high",
        }),
        HttpClientRequest.bodyUint8Array(body, "application/octet-stream"),
        httpClient.execute,
        Effect.mapError(
          (cause) =>
            new WebPushHttpRequestError({
              endpointOrigin: origin,
              stage: "send",
              status: null,
              cause,
            }),
        ),
      );
      const responseText = yield* response.text.pipe(
        Effect.mapError(
          (cause) =>
            new WebPushHttpRequestError({
              endpointOrigin: origin,
              stage: "read-response",
              status: response.status,
              cause,
            }),
        ),
      );
      const ok = response.status >= 200 && response.status < 300;
      return {
        ok,
        status: response.status,
        ...(ok || responseText.length === 0 ? {} : { reason: responseText.slice(0, 256) }),
        // 404/410 mean the subscription no longer exists at the push service.
        permanentFailure: response.status === 404 || response.status === 410,
      };
    }),
  });
});

export const layer = Layer.effect(WebPushClient, make);
