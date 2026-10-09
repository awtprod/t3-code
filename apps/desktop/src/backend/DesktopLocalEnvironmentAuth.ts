import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import {
  bootstrapRemoteBearerSession,
  fetchRemoteSessionState,
} from "@t3tools/client-runtime/authorization";
import {
  ConnectionCatalogDocument,
  type ConnectionCatalogDocument as ConnectionCatalogDocumentType,
} from "@t3tools/client-runtime/platform";
import { PRIMARY_LOCAL_ENVIRONMENT_ID, type AuthSessionState } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/unstable/http/HttpClient";

import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import * as DesktopConnectionCatalogStore from "../app/DesktopConnectionCatalogStore.ts";
import { isLocalExecutionOverride } from "../ipc/methods/primaryBackend.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";

export class DesktopLocalEnvironmentAuthBackendNotConfiguredError extends Schema.TaggedErrorClass<DesktopLocalEnvironmentAuthBackendNotConfiguredError>()(
  "DesktopLocalEnvironmentAuthBackendNotConfiguredError",
  {},
) {
  override get message(): string {
    return "Local backend is not configured.";
  }
}

export class DesktopLocalEnvironmentAuthSessionBootstrapError extends Schema.TaggedErrorClass<DesktopLocalEnvironmentAuthSessionBootstrapError>()(
  "DesktopLocalEnvironmentAuthSessionBootstrapError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to create the local desktop bearer session.";
  }
}

export const DesktopLocalEnvironmentAuthError = Schema.Union([
  DesktopLocalEnvironmentAuthBackendNotConfiguredError,
  DesktopLocalEnvironmentAuthSessionBootstrapError,
]);
export type DesktopLocalEnvironmentAuthError = typeof DesktopLocalEnvironmentAuthError.Type;

export class DesktopSavedEnvironmentRecoveryError extends Schema.TaggedErrorClass<DesktopSavedEnvironmentRecoveryError>()(
  "DesktopSavedEnvironmentRecoveryError",
  { message: Schema.String },
) {}

export class DesktopLocalEnvironmentAuth extends Context.Service<
  DesktopLocalEnvironmentAuth,
  {
    readonly getBearerToken: Effect.Effect<string | null, DesktopLocalEnvironmentAuthError>;
    readonly recoverRemotePrimarySession: (
      expectedHttpBaseUrl: string,
    ) => Effect.Effect<AuthSessionState, DesktopSavedEnvironmentRecoveryError>;
  }
>()("@t3tools/desktop/backend/DesktopLocalEnvironmentAuth") {}

const decodeConnectionCatalog = Schema.decodeEffect(
  Schema.fromJsonString(ConnectionCatalogDocument),
);

export const make = Effect.gen(function* () {
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const connectionCatalogStore = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
  const httpClient = yield* HttpClient.HttpClient;
  const tokenRef = yield* Ref.make(Option.none<string>());
  const mutex = yield* Semaphore.make(1);

  const readSavedRemoteCredential = Effect.fn(
    "desktop.localEnvironmentAuth.readSavedRemoteCredential",
  )(
    function* (remoteHttpBaseUrl: string, existingOnly = false) {
      const encodedCatalog = yield* existingOnly
        ? connectionCatalogStore.getExisting
        : connectionCatalogStore.get;
      if (Option.isNone(encodedCatalog)) {
        return Option.none();
      }
      const catalog: ConnectionCatalogDocumentType = yield* decodeConnectionCatalog(
        encodedCatalog.value,
      );
      const profile = catalog.profiles.find(
        (candidate: ConnectionCatalogDocumentType["profiles"][number]) =>
          candidate._tag === "BearerConnectionProfile" &&
          DesktopAppSettings.normalizeRemoteBackendUrl(candidate.httpBaseUrl) === remoteHttpBaseUrl,
      );
      if (profile === undefined) {
        return Option.none();
      }
      const storedCredential = catalog.credentials.find(
        (candidate: ConnectionCatalogDocumentType["credentials"][number]) =>
          candidate.connectionId === profile.connectionId,
      );
      if (
        storedCredential === undefined ||
        storedCredential.credential._tag !== "BearerConnectionCredential"
      ) {
        return Option.none();
      }
      return Option.some({
        token: storedCredential.credential.token,
        environmentId: profile.environmentId,
      });
    },
    Effect.mapError((cause) => new DesktopLocalEnvironmentAuthSessionBootstrapError({ cause })),
  );

  const getBearerToken = mutex
    .withPermits(1)(
      Effect.gen(function* () {
        const cached = yield* Ref.get(tokenRef);
        if (Option.isSome(cached)) {
          return cached.value;
        }

        const settings = yield* appSettings.get;
        if (settings.primaryBackendMode === "remote" && !isLocalExecutionOverride()) {
          const remoteHttpBaseUrl = DesktopAppSettings.normalizeRemoteBackendUrl(
            settings.remoteBackendUrl,
          );
          if (remoteHttpBaseUrl === null) {
            return null;
          }
          const saved = yield* readSavedRemoteCredential(remoteHttpBaseUrl);
          if (Option.isNone(saved)) return null;
          yield* Ref.set(tokenRef, Option.some(saved.value.token));
          return saved.value.token;
        }

        const instances = yield* pool.list;
        const primary = instances.find((instance) => instance.id === PRIMARY_LOCAL_ENVIRONMENT_ID);
        const configOption = primary === undefined ? Option.none() : yield* primary.currentConfig;
        if (Option.isNone(configOption)) {
          return yield* new DesktopLocalEnvironmentAuthBackendNotConfiguredError();
        }
        const config = configOption.value;
        const credential = config.bootstrap.desktopBootstrapToken;
        if (!credential) {
          return yield* new DesktopLocalEnvironmentAuthBackendNotConfiguredError();
        }
        const session = yield* bootstrapRemoteBearerSession({
          httpBaseUrl: config.httpBaseUrl.href,
          credential,
          clientMetadata: {
            label: "Command Center Desktop",
            deviceType: "desktop",
          },
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.mapError(
            (cause) =>
              new DesktopLocalEnvironmentAuthSessionBootstrapError({
                cause,
              }),
          ),
        );
        yield* Ref.set(tokenRef, Option.some(session.access_token));
        return session.access_token;
      }),
    )
    .pipe(Effect.withSpan("desktop.localEnvironmentAuth.getBearerToken"));

  const recoverRemotePrimarySession = Effect.fn(
    "desktop.localEnvironmentAuth.recoverRemotePrimarySession",
  )(function* (expectedHttpBaseUrl: string) {
    return yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* Ref.set(tokenRef, Option.none());
        const settings = yield* appSettings.get;
        if (settings.primaryBackendMode !== "remote" || isLocalExecutionOverride()) {
          return yield* new DesktopSavedEnvironmentRecoveryError({
            message:
              "Saved-environment recovery requires the current remote primary. No settings were changed.",
          });
        }
        const endpoint = DesktopAppSettings.normalizeRemoteBackendUrl(settings.remoteBackendUrl);
        if (
          endpoint === null ||
          endpoint !== DesktopAppSettings.normalizeRemoteBackendUrl(expectedHttpBaseUrl)
        ) {
          return yield* new DesktopSavedEnvironmentRecoveryError({
            message:
              "The selected server changed. Recovery stopped without changing the primary environment.",
          });
        }
        const saved = yield* readSavedRemoteCredential(endpoint, true).pipe(
          Effect.mapError(
            () =>
              new DesktopSavedEnvironmentRecoveryError({
                message: "The saved credential could not be loaded on this device.",
              }),
          ),
        );
        if (Option.isNone(saved)) {
          return yield* new DesktopSavedEnvironmentRecoveryError({
            message: "No credential is saved on this device for the selected server.",
          });
        }
        const descriptor = yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl: endpoint }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.mapError(
            () =>
              new DesktopSavedEnvironmentRecoveryError({
                message:
                  "The selected server could not be verified. Try reconnecting when it is reachable.",
              }),
          ),
        );
        if (descriptor.environmentId !== saved.value.environmentId) {
          return yield* new DesktopSavedEnvironmentRecoveryError({
            message: "This server does not match the saved environment. Recovery stopped.",
          });
        }
        const session = yield* fetchRemoteSessionState({
          httpBaseUrl: endpoint,
          bearerToken: saved.value.token,
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.mapError(
            () =>
              new DesktopSavedEnvironmentRecoveryError({
                message: "The saved credential could not be validated by the selected server.",
              }),
          ),
        );
        if (!session.authenticated || session.sessionMethod !== "bearer-access-token") {
          return yield* new DesktopSavedEnvironmentRecoveryError({
            message:
              "The selected server rejected the saved credential. It may have expired or been revoked.",
          });
        }
        const current = yield* appSettings.get;
        if (
          current.primaryBackendMode !== "remote" ||
          isLocalExecutionOverride() ||
          DesktopAppSettings.normalizeRemoteBackendUrl(current.remoteBackendUrl) !== endpoint
        ) {
          return yield* new DesktopSavedEnvironmentRecoveryError({
            message: "The selected server changed during verification. Recovery stopped.",
          });
        }
        yield* Ref.set(tokenRef, Option.some(saved.value.token));
        return session;
      }),
    );
  });

  return DesktopLocalEnvironmentAuth.of({ getBearerToken, recoverRemotePrimarySession });
});

export const layer = Layer.effect(DesktopLocalEnvironmentAuth, make);
