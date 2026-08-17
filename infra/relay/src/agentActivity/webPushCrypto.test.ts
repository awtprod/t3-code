// @effect-diagnostics preferSchemaOverJson:off - this test plays the browser
// receiver: it decrypts raw bytes and inspects plain JSON exactly as a push
// client library would, without Effect schemas in the loop.
import * as NodeCrypto from "node:crypto";

import { p256 } from "@noble/curves/nist";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";

import { encryptWebPushPayload, makeVapidJwt, vapidPublicKeyFromPem } from "./webPushCrypto.ts";

const decodeB64Url = (value: string) => Result.getOrThrow(Encoding.decodeBase64Url(value));

// RFC 8291 Appendix A test vectors.
const rfc8291 = {
  plaintext: "When I grow up, I want to be a watermelon",
  receiverPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  receiverPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg", // published RFC test vector, gitleaks:allow
  senderPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  ciphertext:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

describe("webPushCrypto", () => {
  it.effect("reproduces the RFC 8291 Appendix A ciphertext", () =>
    Effect.gen(function* () {
      const body = yield* encryptWebPushPayload({
        plaintext: new TextEncoder().encode(rfc8291.plaintext),
        p256dh: rfc8291.receiverPublic,
        auth: rfc8291.authSecret,
        ephemeralPrivateKey: decodeB64Url(rfc8291.senderPrivate),
        salt: decodeB64Url(rfc8291.salt),
      });
      expect(Encoding.encodeBase64Url(body)).toBe(rfc8291.ciphertext);
    }),
  );

  it.effect("round-trips a payload a browser-side receiver can decrypt", () =>
    Effect.gen(function* () {
      // Simulate the browser: it generates the subscription keypair + auth
      // secret and hands the public half to the server.
      const receiverPrivate = p256.utils.randomPrivateKey();
      const receiverPublic = p256.getPublicKey(receiverPrivate, false);
      const authSecret = NodeCrypto.randomBytes(16);
      const plaintext = JSON.stringify({ title: "Thread done", body: "review it" });

      const body = yield* encryptWebPushPayload({
        plaintext: new TextEncoder().encode(plaintext),
        p256dh: Encoding.encodeBase64Url(receiverPublic),
        auth: Encoding.encodeBase64Url(authSecret),
      });

      // Decrypt per RFC 8291 §3.1/RFC 8188 §2 exactly as a push service
      // client library would.
      const salt = body.subarray(0, 16);
      const keyIdLength = body[20]!;
      expect(keyIdLength).toBe(65);
      const senderPublic = body.subarray(21, 21 + keyIdLength);
      const ciphertext = body.subarray(21 + keyIdLength);

      const sharedSecret = p256
        .getSharedSecret(receiverPrivate, senderPublic, false)
        .subarray(1, 33);
      const hkdf = (ikm: Uint8Array, saltBytes: Uint8Array, info: Uint8Array, length: number) =>
        new Uint8Array(NodeCrypto.hkdfSync("sha256", ikm, saltBytes, info, length));
      const ikmInfo = Buffer.concat([
        Buffer.from("WebPush: info\0"),
        Buffer.from(receiverPublic),
        Buffer.from(senderPublic),
      ]);
      const ikm = hkdf(sharedSecret, authSecret, ikmInfo, 32);
      const cek = hkdf(ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
      const nonce = hkdf(ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12);

      const decipher = NodeCrypto.createDecipheriv("aes-128-gcm", cek, nonce);
      decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
      const record = Buffer.concat([
        decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
        decipher.final(),
      ]);
      // Strip the final-record delimiter.
      expect(record[record.length - 1]).toBe(2);
      expect(record.subarray(0, record.length - 1).toString("utf8")).toBe(plaintext);
    }),
  );

  it.effect("signs a VAPID JWT that verifies against the public key", () =>
    Effect.gen(function* () {
      const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
        namedCurve: "prime256v1",
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      });
      const jwt = yield* makeVapidJwt({
        audience: "https://fcm.googleapis.com",
        subject: "mailto:ops@example.com",
        privateKey: Redacted.make(privateKey),
        expiresAtUnixSeconds: 1_700_000_000,
      });
      const [header, payload, signature] = jwt.split(".");
      expect(header).toBeDefined();
      expect(payload).toBeDefined();
      expect(signature).toBeDefined();

      const decodedHeader = JSON.parse(Buffer.from(header!, "base64url").toString("utf8"));
      expect(decodedHeader).toEqual({ typ: "JWT", alg: "ES256" });
      const decodedPayload = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
      expect(decodedPayload).toEqual({
        aud: "https://fcm.googleapis.com",
        exp: 1_700_000_000,
        sub: "mailto:ops@example.com",
      });

      const verified = NodeCrypto.verify(
        "sha256",
        Buffer.from(`${header}.${payload}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature!, "base64url"),
      );
      expect(verified).toBe(true);

      // Determinism: the isolate cache depends on identical output for
      // identical (key, exp) input.
      const again = yield* makeVapidJwt({
        audience: "https://fcm.googleapis.com",
        subject: "mailto:ops@example.com",
        privateKey: Redacted.make(privateKey),
        expiresAtUnixSeconds: 1_700_000_000,
      });
      expect(again).toBe(jwt);
    }),
  );

  it("derives the browser applicationServerKey from PEM spki", () => {
    const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const raw = decodeB64Url(vapidPublicKeyFromPem(publicKey));
    expect(raw.length).toBe(65);
    expect(raw[0]).toBe(4);
    // The raw point must match the public key noble derives from the scalar.
    const jwk = NodeCrypto.createPrivateKey(privateKey).export({ format: "jwk" });
    const expected = p256.getPublicKey(decodeB64Url(jwk.d!), false);
    expect(Buffer.from(raw).equals(Buffer.from(expected))).toBe(true);
  });
});
