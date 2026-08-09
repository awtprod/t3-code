import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";

const GOOGLE_KEYRING_PASSWORD_SECRET = "command-center-google-keyring-password";
const GOOGLE_KEYRING_PASSWORD_BYTES = 32;

export const googleKeyringEnvironment = Effect.fn("GoogleKeyring.environment")(function* () {
  const configuredBackend = process.env.GOG_KEYRING_BACKEND?.trim();
  const configuredPassword = process.env.GOG_KEYRING_PASSWORD;

  if (configuredBackend !== undefined && configuredBackend !== "" && configuredBackend !== "file") {
    return {
      GOG_KEYRING_BACKEND: configuredBackend,
      ...(configuredPassword === undefined ? {} : { GOG_KEYRING_PASSWORD: configuredPassword }),
    } satisfies NodeJS.ProcessEnv;
  }

  const password =
    configuredPassword ??
    Encoding.encodeBase64Url(
      yield* (yield* ServerSecretStore).getOrCreateRandom(
        GOOGLE_KEYRING_PASSWORD_SECRET,
        GOOGLE_KEYRING_PASSWORD_BYTES,
      ),
    );

  return {
    GOG_KEYRING_BACKEND: "file",
    GOG_KEYRING_PASSWORD: password,
  } satisfies NodeJS.ProcessEnv;
});
