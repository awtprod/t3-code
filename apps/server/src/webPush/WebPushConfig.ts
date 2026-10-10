import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { vapidPublicKeyFromPem } from "./webPushCrypto.ts";

// The contact the push service operator can reach if this deployment misbehaves
// (RFC 8292 `sub`). Apple rejects `mailto:localhost`-style values, so it is
// never baked into the repo — the operator supplies it out of band.
const WEB_PUSH_SUBJECT_ENV = "T3CODE_WEB_PUSH_SUBJECT";

const VAPID_KEY_PAIR_SECRET = "web-push-vapid-key-pair";
const KEY_PAIR_RESOURCE = "web push VAPID key pair";

export interface WebPushRuntimeConfig {
  // Contact URL for the push service operator (mailto: or https:).
  readonly subject: string;
  // base64url uncompressed P-256 point browsers pass to PushManager.subscribe
  // and push services expect in the VAPID `k=` param.
  readonly publicKey: string;
  // PEM pkcs8 P-256 private key used to sign VAPID JWTs.
  readonly privateKey: Redacted.Redacted<string>;
}

/**
 * Direct Web Push configuration for this environment: the VAPID key pair plus
 * the operator contact subject. Resolved once at layer construction. When the
 * subject env var is unset or invalid the whole feature is "not configured":
 * `config` is `None`, the config endpoint reports it, and the notifier stays
 * silent.
 */
export class WebPushConfig extends Context.Service<
  WebPushConfig,
  {
    readonly config: Option.Option<WebPushRuntimeConfig>;
  }
>()("@awtprod/command-center/webPush/WebPushConfig") {}

/**
 * A valid VAPID subject is a `mailto:` or `https:` URL (RFC 8292 §2.1). Anything
 * else — including a bare email or an `http:` URL — is rejected so the feature
 * reports "not configured" rather than signing JWTs push services will refuse.
 */
export function parseWebPushSubject(raw: string | undefined): Option.Option<string> {
  if (raw === undefined) {
    return Option.none();
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 256) {
    return Option.none();
  }
  if (trimmed.startsWith("mailto:")) {
    return trimmed.length > "mailto:".length ? Option.some(trimmed) : Option.none();
  }
  if (trimmed.startsWith("https:")) {
    try {
      const url = new URL(trimmed);
      return url.protocol === "https:" && url.hostname.length > 0
        ? Option.some(trimmed)
        : Option.none();
    } catch {
      return Option.none();
    }
  }
  return Option.none();
}

const VapidKeyPair = Schema.Struct({
  privateKey: Schema.String,
  publicKey: Schema.String,
});
type VapidKeyPair = typeof VapidKeyPair.Type;

const VapidKeyPairJson = Schema.fromJsonString(VapidKeyPair);
const decodeVapidKeyPair = Schema.decodeUnknownEffect(VapidKeyPairJson);
const encodeVapidKeyPair = Schema.encodeEffect(VapidKeyPairJson);

const bytesToString = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const stringToBytes = (value: string): Uint8Array => new TextEncoder().encode(value);

const keyPairDecodeError = (cause: unknown): ServerSecretStore.SecretStoreDecodeError =>
  new ServerSecretStore.SecretStoreDecodeError({ resource: KEY_PAIR_RESOURCE, cause });

const keyPairEncodeError = (cause: unknown): ServerSecretStore.SecretStoreEncodeError =>
  new ServerSecretStore.SecretStoreEncodeError({ resource: KEY_PAIR_RESOURCE, cause });

const keyPairConcurrentReadError = (): ServerSecretStore.SecretStoreConcurrentReadError =>
  new ServerSecretStore.SecretStoreConcurrentReadError({ resource: KEY_PAIR_RESOURCE });

const readVapidKeyPair = Effect.fn("readVapidKeyPair")(function* (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
) {
  const encoded = yield* secrets.get(VAPID_KEY_PAIR_SECRET);
  if (Option.isNone(encoded)) {
    return Option.none<VapidKeyPair>();
  }
  const decoded = yield* decodeVapidKeyPair(bytesToString(encoded.value)).pipe(
    Effect.mapError(keyPairDecodeError),
  );
  return Option.some(decoded);
});

const persistVapidKeyPair = Effect.fn("persistVapidKeyPair")(function* (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
  keyPair: VapidKeyPair,
) {
  const encoded = yield* encodeVapidKeyPair(keyPair).pipe(Effect.mapError(keyPairEncodeError));
  // `create` uses an exclusive open, so a concurrent boot that lost the race
  // gets AlreadyExists; read back the winner's pair instead of failing.
  return yield* secrets.create(VAPID_KEY_PAIR_SECRET, stringToBytes(encoded)).pipe(
    Effect.as(keyPair),
    Effect.catchIf(ServerSecretStore.isSecretStoreError, (error) =>
      ServerSecretStore.isSecretAlreadyExistsError(error)
        ? readVapidKeyPair(secrets).pipe(
            Effect.flatMap(
              Option.match({
                onSome: Effect.succeed,
                onNone: () => Effect.fail(keyPairConcurrentReadError()),
              }),
            ),
          )
        : Effect.fail(error),
    ),
  );
});

export const getOrCreateVapidKeyPairFromSecretStore = Effect.fn(
  "getOrCreateVapidKeyPairFromSecretStore",
)(function* (secrets: ServerSecretStore.ServerSecretStore["Service"]) {
  const existing = yield* readVapidKeyPair(secrets);
  if (Option.isSome(existing)) {
    return existing.value;
  }
  const keyPair = NodeCrypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  return yield* persistVapidKeyPair(secrets, {
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
  });
});

export const make = (rawSubject: string | undefined) =>
  Effect.gen(function* () {
    const subject = parseWebPushSubject(rawSubject);
    if (Option.isNone(subject)) {
      yield* Effect.logWarning(
        `direct Web Push is not configured; set ${WEB_PUSH_SUBJECT_ENV} to a mailto: or https: contact URL to enable it`,
      );
      return WebPushConfig.of({ config: Option.none() });
    }
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const keyPair = yield* getOrCreateVapidKeyPairFromSecretStore(secrets);
    const publicKey = vapidPublicKeyFromPem(keyPair.publicKey);
    yield* Effect.logInfo("direct Web Push configured", { subject: subject.value });
    return WebPushConfig.of({
      config: Option.some({
        subject: subject.value,
        publicKey,
        privateKey: Redacted.make(keyPair.privateKey),
      }),
    });
  });

export const layer = Layer.effect(WebPushConfig, make(process.env[WEB_PUSH_SUBJECT_ENV]));
