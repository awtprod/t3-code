import { CommandCenterError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";

/**
 * One publishing account credential persisted as UTF-8 JSON bytes in the
 * environment `ServerSecretStore` (0600 file under the secrets directory).
 * Each provider owns one slot; the value never leaves the server.
 */
export interface PublishCredentialSlot<A> {
  readonly read: Effect.Effect<Option.Option<A>, CommandCenterError>;
  readonly write: (value: A) => Effect.Effect<void, CommandCenterError>;
  readonly clear: Effect.Effect<void, CommandCenterError>;
}

const storageError = (message: string, cause: unknown) =>
  new CommandCenterError({ reason: "persistence", message, cause });

export const makePublishCredentialSlot = Effect.fn("PublishCredentialSlot.make")(function* <
  A,
  I,
>(input: {
  readonly secretName: string;
  readonly label: string;
  readonly schema: Schema.Codec<A, I>;
}) {
  const secrets = yield* ServerSecretStore;
  const codec = Schema.fromJsonString(input.schema);
  const decode = Schema.decodeUnknownEffect(codec);
  const encode = Schema.encodeEffect(codec);
  const textDecoder = new TextDecoder();
  const textEncoder = new TextEncoder();

  const read = secrets.get(input.secretName).pipe(
    Effect.mapError((cause) =>
      storageError(`The stored ${input.label} credential could not be read.`, cause),
    ),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<A>()),
        onSome: (bytes) =>
          decode(textDecoder.decode(bytes)).pipe(
            Effect.map(Option.some),
            Effect.mapError((cause) =>
              storageError(
                `The stored ${input.label} credential is unreadable. Disconnect and connect again.`,
                cause,
              ),
            ),
          ),
      }),
    ),
  );

  const write = (value: A) =>
    encode(value).pipe(
      Effect.mapError((cause) =>
        storageError(`The ${input.label} credential could not be encoded.`, cause),
      ),
      Effect.flatMap((json) =>
        secrets
          .set(input.secretName, textEncoder.encode(json))
          .pipe(
            Effect.mapError((cause) =>
              storageError(`The ${input.label} credential could not be stored.`, cause),
            ),
          ),
      ),
    );

  const clear = secrets
    .remove(input.secretName)
    .pipe(
      Effect.mapError((cause) =>
        storageError(`The ${input.label} credential could not be removed.`, cause),
      ),
    );

  return { read, write, clear } satisfies PublishCredentialSlot<A>;
});
