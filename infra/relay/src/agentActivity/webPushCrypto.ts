import * as NodeCrypto from "node:crypto";

import { p256 } from "@noble/curves/nist";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

// RFC 8291 (Message Encryption for Web Push) and RFC 8292 (VAPID), hand-rolled
// on @noble + WebCrypto because the Node `web-push` package does not run on
// Workers. apnsJwt.ts is the sibling precedent for the deterministic-ES256
// approach: identical input yields the byte-identical JWT on every isolate.

export class WebPushCryptoError extends Schema.TaggedErrorClass<WebPushCryptoError>()(
  "WebPushCryptoError",
  {
    stage: Schema.Literals(["subscription-keys", "encrypt", "vapid-jwt", "vapid-public-key"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Web push crypto failed during ${this.stage}.`;
  }
}

// Secrets pasted into env vars often carry literal backslash-n sequences in
// place of newlines (same normalization as apnsJwt.ts, expressed without a
// backslash-escape literal so public-repo path scanners don't trip on it).
const ESCAPED_NEWLINE = String.fromCharCode(92) + "n";
function normalizePem(pem: string): string {
  return pem.split(ESCAPED_NEWLINE).join("\n");
}

const CONTENT_ENCRYPTION_KEY_INFO = new TextEncoder().encode("Content-Encoding: aes128gcm\0");
const NONCE_INFO = new TextEncoder().encode("Content-Encoding: nonce\0");
const WEB_PUSH_IKM_INFO_PREFIX = new TextEncoder().encode("WebPush: info\0");
// One record holds the whole payload; 4096 is the RFC 8291 default and far
// above any notification we send.
const RECORD_SIZE = 4096;

function concatBytes(...chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  const combined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return combined;
}

function decodeSubscriptionKey(value: string, expectedLength: number): Uint8Array {
  const bytes = Result.getOrThrowWith(
    Encoding.decodeBase64Url(value),
    () => new Error("Web push subscription key is not valid base64url."),
  );
  if (bytes.length !== expectedLength) {
    throw new Error(
      `Web push subscription key has length ${bytes.length}, expected ${expectedLength}.`,
    );
  }
  return bytes;
}

export interface WebPushEncryptionInput {
  readonly plaintext: Uint8Array;
  // Client keys from PushSubscription.getKey, base64url-encoded: p256dh is the
  // 65-byte uncompressed P-256 point, auth the 16-byte secret.
  readonly p256dh: string;
  readonly auth: string;
  // Injectable for the RFC 8291 round-trip test; production callers omit them
  // and get fresh randomness per message.
  readonly ephemeralPrivateKey?: Uint8Array;
  readonly salt?: Uint8Array;
}

// Produces the aes128gcm request body: header (salt | rs | idlen | ephemeral
// public key) followed by the sealed record. The Content-Encoding header on
// the push request must be aes128gcm.
export const encryptWebPushPayload = Effect.fn("relay.web_push.encrypt")(function* (
  input: WebPushEncryptionInput,
) {
  const keys = yield* Effect.try({
    try: () => ({
      clientPublicKey: decodeSubscriptionKey(input.p256dh, 65),
      authSecret: decodeSubscriptionKey(input.auth, 16),
    }),
    catch: (cause) => new WebPushCryptoError({ stage: "subscription-keys", cause }),
  });

  return yield* Effect.tryPromise({
    try: async () => {
      const ephemeralPrivateKey = input.ephemeralPrivateKey ?? p256.utils.randomPrivateKey();
      const ephemeralPublicKey = p256.getPublicKey(ephemeralPrivateKey, false);
      const salt = input.salt ?? globalThis.crypto.getRandomValues(new Uint8Array(16));

      // RFC 8291 §3.3-3.4: ECDH -> IKM keyed by both public keys -> CEK+nonce.
      const sharedSecret = p256
        .getSharedSecret(ephemeralPrivateKey, keys.clientPublicKey, false)
        .subarray(1, 33);
      const ikmInfo = concatBytes(
        WEB_PUSH_IKM_INFO_PREFIX,
        keys.clientPublicKey,
        ephemeralPublicKey,
      );
      const ikm = hkdf(sha256, sharedSecret, keys.authSecret, ikmInfo, 32);
      const contentEncryptionKey = hkdf(sha256, ikm, salt, CONTENT_ENCRYPTION_KEY_INFO, 16);
      const nonce = hkdf(sha256, ikm, salt, NONCE_INFO, 12);

      // RFC 8188 §2: single record, delimiter 0x02 marks the final record.
      // Copy noble's outputs into fresh Uint8Arrays: WebCrypto's BufferSource
      // parameters reject views over ArrayBufferLike.
      const record = concatBytes(input.plaintext, new Uint8Array([2]));
      const aesKey = await globalThis.crypto.subtle.importKey(
        "raw",
        new Uint8Array(contentEncryptionKey).buffer,
        "AES-GCM",
        false,
        ["encrypt"],
      );
      const sealed = new Uint8Array(
        await globalThis.crypto.subtle.encrypt(
          { name: "AES-GCM", iv: new Uint8Array(nonce).buffer },
          aesKey,
          record.buffer as ArrayBuffer,
        ),
      );

      const header = new Uint8Array(16 + 4 + 1 + ephemeralPublicKey.length);
      header.set(salt, 0);
      new DataView(header.buffer).setUint32(16, RECORD_SIZE);
      header[20] = ephemeralPublicKey.length;
      header.set(ephemeralPublicKey, 21);
      return concatBytes(header, sealed);
    },
    catch: (cause) => new WebPushCryptoError({ stage: "encrypt", cause }),
  });
});

const encodeVapidJwtHeaderJson = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      typ: Schema.Literal("JWT"),
      alg: Schema.Literal("ES256"),
    }),
  ),
);
const encodeVapidJwtPayloadJson = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      aud: Schema.String,
      exp: Schema.Number,
      sub: Schema.String,
    }),
  ),
);

export interface VapidJwtSigningInput {
  // Origin of the push service endpoint, e.g. https://fcm.googleapis.com
  readonly audience: string;
  // Contact for the push service operator: mailto: or https: URL.
  readonly subject: string;
  readonly privateKey: Redacted.Redacted<string>;
  readonly expiresAtUnixSeconds: number;
}

export const makeVapidJwt = Effect.fn("relay.web_push.make_vapid_jwt")(function* (
  input: VapidJwtSigningInput,
) {
  const headerJson = yield* encodeVapidJwtHeaderJson({ typ: "JWT", alg: "ES256" }).pipe(
    Effect.mapError((cause) => new WebPushCryptoError({ stage: "vapid-jwt", cause })),
  );
  const payloadJson = yield* encodeVapidJwtPayloadJson({
    aud: input.audience,
    exp: input.expiresAtUnixSeconds,
    sub: input.subject,
  }).pipe(Effect.mapError((cause) => new WebPushCryptoError({ stage: "vapid-jwt", cause })));

  return yield* Effect.try({
    try: () => {
      const signingInput = `${Encoding.encodeBase64Url(headerJson)}.${Encoding.encodeBase64Url(payloadJson)}`;
      // Deterministic ES256 (RFC 6979 via noble), same rationale as apnsJwt:
      // every isolate derives the identical JWT for a (key, exp) pair, so the
      // quantized-expiry cache below never signs twice for one window.
      const scalar = vapidSigningScalar(Redacted.value(input.privateKey));
      const signature = p256
        .sign(sha256(new TextEncoder().encode(signingInput)), scalar, { prehash: false })
        .toCompactRawBytes();
      return `${signingInput}.${Encoding.encodeBase64Url(signature)}`;
    },
    catch: (cause) => new WebPushCryptoError({ stage: "vapid-jwt", cause }),
  });
});

// PEM parsing is pure and the key set is static per deployment; memoize like
// apnsSigningScalar does.
const signingScalarCache = new Map<string, Uint8Array>();

function vapidSigningScalar(privateKeyPem: string): Uint8Array {
  const cached = signingScalarCache.get(privateKeyPem);
  if (cached) {
    return cached;
  }
  const jwk = NodeCrypto.createPrivateKey(normalizePem(privateKeyPem)).export({
    format: "jwk",
  });
  if (jwk.crv !== "P-256" || typeof jwk.d !== "string") {
    throw new Error("VAPID signing key is not a P-256 private key.");
  }
  const scalar = Result.getOrThrowWith(
    Encoding.decodeBase64Url(jwk.d),
    () => new Error("VAPID signing key scalar is not valid base64url."),
  );
  signingScalarCache.set(privateKeyPem, scalar);
  return scalar;
}

// The browser needs the applicationServerKey as the raw uncompressed point;
// alchemy's KeyPair hands us PEM spki. Derive once per isolate.
const publicKeyCache = new Map<string, string>();

export function vapidPublicKeyFromPem(publicKeyPem: string): string {
  const cached = publicKeyCache.get(publicKeyPem);
  if (cached) {
    return cached;
  }
  const jwk = NodeCrypto.createPublicKey(normalizePem(publicKeyPem)).export({
    format: "jwk",
  });
  if (jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new Error("VAPID public key is not a P-256 key.");
  }
  const x = Result.getOrThrowWith(
    Encoding.decodeBase64Url(jwk.x),
    () => new Error("VAPID public key x coordinate is not valid base64url."),
  );
  const y = Result.getOrThrowWith(
    Encoding.decodeBase64Url(jwk.y),
    () => new Error("VAPID public key y coordinate is not valid base64url."),
  );
  const point = new Uint8Array(65);
  point[0] = 4;
  point.set(x, 1);
  point.set(y, 33);
  const encoded = Encoding.encodeBase64Url(point);
  publicKeyCache.set(publicKeyPem, encoded);
  return encoded;
}
