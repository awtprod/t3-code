// Adapted from infra/relay/src/agentActivity/WebPushClient.ts: same aes128gcm
// body, per-origin VAPID JWT cache, one-hour TTL and `urgency: high` headers,
// and the same 404/410 = dead-subscription rule. The one difference is the
// configuration source — this reads the environment-local WebPushConfig
// (self-hosted VAPID key) instead of the relay's RelayConfiguration.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { isAllowedPushEndpoint } from "./pushEndpointAllowlist.ts";
import { WebPushConfig, type WebPushRuntimeConfig } from "./WebPushConfig.ts";
import { encryptWebPushPayload, makeVapidJwt, WebPushCryptoError } from "./webPushCrypto.ts";

// Push services cap TTL generously; an hour comfortably outlives a delivery
// retry window while keeping missed notifications from arriving absurdly late.
const WEB_PUSH_TTL_SECONDS = 60 * 60;
// A hung push service must not stall the notifier's per-thread worker; cap the
// whole request+read at 15s and surface a transport failure instead.
const WEB_PUSH_REQUEST_TIMEOUT = "15 seconds";
// VAPID JWTs may live up to 24h. Quantize expiry so a deterministically signed
// JWT is reused across a window and the cache never re-signs per origin.
export const VAPID_JWT_WINDOW_SECONDS = 6 * 60 * 60;
const VAPID_JWT_LIFETIME_SECONDS = 12 * 60 * 60;

export class WebPushHttpRequestError extends Schema.TaggedError<WebPushHttpRequestError>()(
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

export class WebPushNotConfiguredError extends Schema.TaggedError<WebPushNotConfiguredError>()(
  "WebPushNotConfiguredError",
  {},
) {
  override get message(): string {
    return "Direct Web Push is not configured on this environment.";
  }
}

export class WebPushEndpointNotAllowedError extends Schema.TaggedError<WebPushEndpointNotAllowedError>()(
  "WebPushEndpointNotAllowedError",
  {
    endpoint: Schema.String,
  },
) {
  override get message(): string {
    return "Web push endpoint host is not on the allowed push-service allowlist.";
  }
}

export const WebPushSendError = Schema.Union([
  WebPushCryptoError,
  WebPushHttpRequestError,
  WebPushNotConfiguredError,
  WebPushEndpointNotAllowedError,
]);
export type WebPushSendError = typeof WebPushSendError.Type;

export interface WebPushDeliveryResult {
  readonly ok: boolean;
  readonly status: number;
  readonly reason?: string;
  // The stored subscription is dead (the browser unsubscribed or it rotated);
  // delete the row instead of retrying.
  readonly permanentFailure: boolean;
}

// What the service worker's push handler receives; keep in sync with
// apps/web/public/service-worker.js decodePushPayload.
export interface WebPushThreadNotificationPayload {
  readonly title: string;
  readonly body: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly deepLink: string;
}

export interface WebPushSendInput {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly payload: WebPushThreadNotificationPayload;
}

export class WebPushSender extends Context.Service<
  WebPushSender,
  {
    readonly send: (
      input: WebPushSendInput,
    ) => Effect.Effect<WebPushDeliveryResult, WebPushSendError>;
  }
>()("@awtprod/command-center/webPush/WebPushSender") {}

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

// One JWT per push-service origin per expiry window. Deterministic signing keeps
// the cache coherent across isolates.
const jwtCache = new Map<string, { readonly jwt: string; readonly expiresAt: number }>();

export function __resetWebPushJwtCacheForTest(): void {
  jwtCache.clear();
}

export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const webPushConfig = yield* WebPushConfig;

  const vapidJwtForOrigin = Effect.fnUntraced(function* (
    config: WebPushRuntimeConfig,
    origin: string,
    nowMs: number,
  ) {
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
      subject: config.subject,
      privateKey: config.privateKey,
      expiresAtUnixSeconds,
    });
    jwtCache.set(origin, { jwt, expiresAt: expiresAtUnixSeconds });
    return jwt;
  });

  return WebPushSender.of({
    send: Effect.fn("web_push.send")(function* (input) {
      if (Option.isNone(webPushConfig.config)) {
        return yield* new WebPushNotConfiguredError({});
      }
      // Defense in depth: the HTTP layer allowlists on register, but a stored row
      // could predate a tightened allowlist, so re-check before ever contacting
      // the endpoint. Runs before `new URL` so a rejected value never throws.
      if (!isAllowedPushEndpoint(input.endpoint)) {
        return yield* new WebPushEndpointNotAllowedError({ endpoint: input.endpoint });
      }
      const config = webPushConfig.config.value;
      const origin = new URL(input.endpoint).origin;
      yield* Effect.annotateCurrentSpan({ "web_push.endpoint_origin": origin });

      const payloadJson = yield* encodeWebPushPayloadJson(input.payload).pipe(
        Effect.mapError((cause) => new WebPushCryptoError({ stage: "encrypt", cause })),
      );
      const body = yield* encryptWebPushPayload({
        plaintext: new TextEncoder().encode(payloadJson),
        p256dh: input.p256dh,
        auth: input.auth,
      });
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      const jwt = yield* vapidJwtForOrigin(config, origin, now);

      const deliver = Effect.gen(function* () {
        const response = yield* HttpClientRequest.post(input.endpoint).pipe(
          HttpClientRequest.setHeaders({
            authorization: `vapid t=${jwt}, k=${config.publicKey}`,
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
        } satisfies WebPushDeliveryResult;
      }).pipe(
        // A 3xx from a push service is a terminal non-ok result, never a hop to
        // follow (redirect:"manual" makes fetch surface the 3xx as-is).
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.timeoutOrElse({
          duration: WEB_PUSH_REQUEST_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new WebPushHttpRequestError({
                endpointOrigin: origin,
                stage: "send",
                status: null,
                cause: "web push request timed out",
              }),
            ),
        }),
      );
      return yield* deliver;
    }),
  });
});

export const layer = Layer.effect(WebPushSender, make).pipe(Layer.provide(FetchHttpClient.layer));
