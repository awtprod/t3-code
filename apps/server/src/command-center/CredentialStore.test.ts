import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import {
  decodeCommandCenterCredentialKey,
  decryptCommandCenterCredential,
  encryptCommandCenterCredential,
  makeCommandCenterCredentialStore,
} from "./CredentialStore.ts";

const key = Buffer.alloc(32, 3);
const otherKey = Buffer.alloc(32, 4);
const plaintext = new TextEncoder().encode("credential payload");

function memoryStore(initial?: Uint8Array) {
  let stored = initial === undefined ? undefined : Uint8Array.from(initial);
  const service = ServerSecretStore.of({
    get: () => Effect.succeed(stored === undefined ? Option.none() : Option.some(stored)),
    set: (_name, value) => Effect.sync(() => void (stored = Uint8Array.from(value))),
    create: (_name, value) => Effect.sync(() => void (stored = Uint8Array.from(value))),
    getOrCreateRandom: () => Effect.die("unused"),
    remove: () => Effect.sync(() => void (stored = undefined)),
  });
  return { service, stored: () => stored };
}

it("accepts only a canonical 32-byte base64url master key", () => {
  const encoded = key.toString("base64url");
  expect(Buffer.from(decodeCommandCenterCredentialKey(encoded)!)).toEqual(key);
  expect(decodeCommandCenterCredentialKey(`${encoded}=`)).toBeUndefined();
  expect(decodeCommandCenterCredentialKey(Buffer.alloc(31).toString("base64url"))).toBeUndefined();
});

it("binds an authenticated envelope to its credential name", () => {
  const envelope = encryptCommandCenterCredential({
    name: "sample-credential",
    plaintext,
    key,
    nonce: Buffer.alloc(12, 8),
  });
  expect(envelope).not.toContain(plaintext);
  expect(decryptCommandCenterCredential({ name: "sample-credential", envelope, key })).toEqual(
    plaintext,
  );
  expect(() =>
    decryptCommandCenterCredential({ name: "different-credential", envelope, key }),
  ).toThrow();
  expect(() =>
    decryptCommandCenterCredential({ name: "sample-credential", envelope, key: otherKey }),
  ).toThrow();
});

it.effect("persists only ciphertext and rejects tampering", () => {
  const storage = memoryStore();
  const credentials = makeCommandCenterCredentialStore({ storage: storage.service, key });
  return Effect.gen(function* () {
    yield* credentials.set("sample-credential", plaintext);
    const envelope = storage.stored()!;
    expect(Buffer.from(envelope).includes(Buffer.from(plaintext))).toBe(false);
    expect(yield* credentials.get("sample-credential")).toEqual(Option.some(plaintext));

    const lastByte = envelope.byteLength - 1;
    envelope[lastByte] = envelope[lastByte]! ^ 1;
    const failure = yield* credentials.get("sample-credential").pipe(Effect.flip);
    expect(failure.reason).toBe("authentication-failed");
  });
});

it.effect("fails closed when no external master key is configured", () => {
  const storage = memoryStore();
  const credentials = makeCommandCenterCredentialStore({ storage: storage.service });
  return Effect.gen(function* () {
    const readFailure = yield* credentials.get("sample-credential").pipe(Effect.flip);
    const writeFailure = yield* credentials.set("sample-credential", plaintext).pipe(Effect.flip);
    expect(readFailure.reason).toBe("key-unavailable");
    expect(writeFailure.reason).toBe("key-unavailable");
    expect(storage.stored()).toBeUndefined();
  });
});
