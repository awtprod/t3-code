import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export const COMMAND_CENTER_CREDENTIAL_KEY_ENV = "COMMAND_CENTER_CREDENTIAL_KEY";
export const COMMAND_CENTER_CREDENTIAL_KEY_FILE_ENV = "COMMAND_CENTER_CREDENTIAL_KEY_FILE";

const ENVELOPE_MAGIC = Buffer.from("CCRED001", "ascii");
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export class CommandCenterCredentialStoreError extends Schema.TaggedErrorClass<CommandCenterCredentialStoreError>()(
  "CommandCenterCredentialStoreError",
  {
    reason: Schema.Literals([
      "key-unavailable",
      "invalid-name",
      "storage-failed",
      "invalid-envelope",
      "authentication-failed",
    ]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const credentialError = (
  reason: CommandCenterCredentialStoreError["reason"],
  message: string,
  cause?: unknown,
) =>
  new CommandCenterCredentialStoreError({
    reason,
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const validCredentialName = (name: string): boolean => /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(name);

export function decodeCommandCenterCredentialKey(source: string): Uint8Array | undefined {
  try {
    const key = Buffer.from(source.trim(), "base64url");
    return key.byteLength === KEY_BYTES && key.toString("base64url") === source.trim()
      ? Uint8Array.from(key)
      : undefined;
  } catch {
    return undefined;
  }
}

function credentialAad(name: string): Buffer {
  return Buffer.from(`command-center-credential-v1\n${name}`, "utf8");
}

/**
 * Encrypt a credential into a versioned AES-256-GCM envelope. The record name
 * is authenticated as AAD so ciphertext cannot be copied between credential
 * slots. The master key is never included in the envelope.
 */
export function encryptCommandCenterCredential(input: {
  readonly name: string;
  readonly plaintext: Uint8Array;
  readonly key: Uint8Array;
  readonly nonce?: Uint8Array;
}): Uint8Array {
  if (!validCredentialName(input.name)) throw new Error("Invalid credential name.");
  if (input.key.byteLength !== KEY_BYTES) throw new Error("Invalid credential key.");
  const nonce = input.nonce ?? NodeCrypto.randomBytes(NONCE_BYTES);
  if (nonce.byteLength !== NONCE_BYTES) throw new Error("Invalid credential nonce.");

  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", input.key, nonce);
  cipher.setAAD(credentialAad(input.name));
  const ciphertext = Buffer.concat([cipher.update(input.plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Uint8Array.from(Buffer.concat([ENVELOPE_MAGIC, nonce, tag, ciphertext]));
}

/** Decrypt and authenticate a Command Center credential envelope. */
export function decryptCommandCenterCredential(input: {
  readonly name: string;
  readonly envelope: Uint8Array;
  readonly key: Uint8Array;
}): Uint8Array {
  if (!validCredentialName(input.name)) throw new Error("Invalid credential name.");
  if (input.key.byteLength !== KEY_BYTES) throw new Error("Invalid credential key.");
  const envelope = Buffer.from(input.envelope);
  const minimumBytes = ENVELOPE_MAGIC.byteLength + NONCE_BYTES + TAG_BYTES;
  if (
    envelope.byteLength < minimumBytes ||
    !NodeCrypto.timingSafeEqual(envelope.subarray(0, ENVELOPE_MAGIC.byteLength), ENVELOPE_MAGIC)
  ) {
    throw new Error("Invalid credential envelope.");
  }

  const nonceStart = ENVELOPE_MAGIC.byteLength;
  const tagStart = nonceStart + NONCE_BYTES;
  const ciphertextStart = tagStart + TAG_BYTES;
  const decipher = NodeCrypto.createDecipheriv(
    "aes-256-gcm",
    input.key,
    envelope.subarray(nonceStart, tagStart),
  );
  decipher.setAAD(credentialAad(input.name));
  decipher.setAuthTag(envelope.subarray(tagStart, ciphertextStart));
  return Uint8Array.from(
    Buffer.concat([decipher.update(envelope.subarray(ciphertextStart)), decipher.final()]),
  );
}

function readConfiguredKey(
  environment: NodeJS.ProcessEnv,
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
): Effect.Effect<Uint8Array | null> {
  const inline = environment[COMMAND_CENTER_CREDENTIAL_KEY_ENV];
  const keyFile = environment[COMMAND_CENTER_CREDENTIAL_KEY_FILE_ENV];
  if (inline !== undefined && keyFile !== undefined) {
    return Effect.succeed(null);
  }
  if (inline !== undefined) {
    return Effect.succeed(decodeCommandCenterCredentialKey(inline) ?? null);
  }
  if (keyFile === undefined || !path.isAbsolute(keyFile)) {
    return Effect.succeed(null);
  }

  return Effect.gen(function* () {
    const stat = yield* fileSystem.stat(keyFile);
    if (stat.type !== "File" || (stat.mode & 0o077) !== 0) return null;
    return decodeCommandCenterCredentialKey(yield* fileSystem.readFileString(keyFile)) ?? null;
  }).pipe(Effect.orElseSucceed(() => null));
}

export interface CommandCenterCredentialStoreShape {
  readonly get: (
    name: string,
  ) => Effect.Effect<Option.Option<Uint8Array>, CommandCenterCredentialStoreError>;
  readonly set: (
    name: string,
    value: Uint8Array,
  ) => Effect.Effect<void, CommandCenterCredentialStoreError>;
  readonly create: (
    name: string,
    value: Uint8Array,
  ) => Effect.Effect<void, CommandCenterCredentialStoreError>;
  readonly remove: (name: string) => Effect.Effect<void, CommandCenterCredentialStoreError>;
}

export class CommandCenterCredentialStore extends Context.Service<
  CommandCenterCredentialStore,
  CommandCenterCredentialStoreShape
>()("@awtprod/command-center/command-center/CredentialStore/CommandCenterCredentialStore") {}

const isCredentialStoreError = Schema.is(CommandCenterCredentialStoreError);

export function makeCommandCenterCredentialStore(input: {
  readonly storage: ServerSecretStore.ServerSecretStore["Service"];
  readonly key?: Uint8Array;
}): CommandCenterCredentialStoreShape {
  const requireKey = Effect.suspend(() =>
    input.key?.byteLength === KEY_BYTES
      ? Effect.succeed(input.key)
      : Effect.fail(
          credentialError(
            "key-unavailable",
            `Set exactly one of ${COMMAND_CENTER_CREDENTIAL_KEY_ENV} or ${COMMAND_CENTER_CREDENTIAL_KEY_FILE_ENV}.`,
          ),
        ),
  );
  const requireName = (name: string) =>
    validCredentialName(name)
      ? Effect.succeed(name)
      : Effect.fail(credentialError("invalid-name", "The credential name is invalid."));

  const encrypt = (name: string, value: Uint8Array) =>
    Effect.all({ name: requireName(name), key: requireKey }).pipe(
      Effect.flatMap(({ name: safeName, key }) =>
        Effect.try({
          try: () => encryptCommandCenterCredential({ name: safeName, plaintext: value, key }),
          catch: (cause) =>
            credentialError(
              "authentication-failed",
              "The credential could not be encrypted.",
              cause,
            ),
        }),
      ),
    );

  const get: CommandCenterCredentialStoreShape["get"] = (name) =>
    Effect.all({ name: requireName(name), key: requireKey }).pipe(
      Effect.flatMap(({ name: safeName, key }) =>
        input.storage.get(safeName).pipe(
          Effect.mapError((cause) =>
            credentialError("storage-failed", "The encrypted credential could not be read.", cause),
          ),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(Option.none<Uint8Array>()),
              onSome: (envelope) =>
                Effect.try({
                  try: () =>
                    Option.some(decryptCommandCenterCredential({ name: safeName, envelope, key })),
                  catch: (cause) =>
                    credentialError(
                      envelope.byteLength < ENVELOPE_MAGIC.byteLength
                        ? "invalid-envelope"
                        : "authentication-failed",
                      "The encrypted credential failed authentication.",
                      cause,
                    ),
                }),
            }),
          ),
        ),
      ),
    );

  const set: CommandCenterCredentialStoreShape["set"] = (name, value) =>
    encrypt(name, value).pipe(
      Effect.flatMap((envelope) => input.storage.set(name, envelope)),
      Effect.mapError((cause) =>
        isCredentialStoreError(cause)
          ? cause
          : credentialError(
              "storage-failed",
              "The encrypted credential could not be persisted.",
              cause,
            ),
      ),
    );

  const create: CommandCenterCredentialStoreShape["create"] = (name, value) =>
    encrypt(name, value).pipe(
      Effect.flatMap((envelope) => input.storage.create(name, envelope)),
      Effect.mapError((cause) =>
        isCredentialStoreError(cause)
          ? cause
          : credentialError(
              "storage-failed",
              "The encrypted credential could not be created.",
              cause,
            ),
      ),
    );

  const remove: CommandCenterCredentialStoreShape["remove"] = (name) =>
    Effect.gen(function* () {
      const safeName = yield* requireName(name);
      yield* input.storage.remove(safeName);
    }).pipe(
      Effect.mapError((cause) =>
        isCredentialStoreError(cause)
          ? cause
          : credentialError(
              "storage-failed",
              "The encrypted credential could not be removed.",
              cause,
            ),
      ),
    );

  return CommandCenterCredentialStore.of({ get, set, create, remove });
}

export const make = Effect.gen(function* () {
  const storage = yield* ServerSecretStore.ServerSecretStore;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const key = yield* readConfiguredKey(process.env, fileSystem, path);
  return makeCommandCenterCredentialStore({
    storage,
    ...(key === null ? {} : { key }),
  });
});

export const layer = Layer.effect(CommandCenterCredentialStore, make);
