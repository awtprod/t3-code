import {
  bootstrapRemoteBearerSession,
  fetchRemoteSessionState,
} from "@t3tools/client-runtime/authorization";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import {
  ConnectionCatalogDocument,
  type ConnectionCatalogDocument as ConnectionCatalogDocumentType,
} from "@t3tools/client-runtime/platform";
import type { RemoteEnvironmentRequestError } from "@t3tools/client-runtime/rpc";
import { PRIMARY_LOCAL_ENVIRONMENT_ID, type AuthSessionState } from "@t3tools/contracts";
import { currentDesktopBootstrapToken } from "@t3tools/shared/desktopBootstrapToken";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";

import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import * as DesktopConnectionCatalogStore from "../app/DesktopConnectionCatalogStore.ts";
import { isLocalExecutionOverride } from "../ipc/methods/primaryBackend.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";

// A loopback /oauth/token exchange can fail transiently while the backend
// settles (a 502-504, a refused or reset connection, a timeout). Retry those
// for as long as the renderer's own bootstrap does; a rejected credential or a
// server error is final.
const BOOTSTRAP_TRANSIENT_RETRY_TIMEOUT = Duration.seconds(15);
const BOOTSTRAP_TRANSIENT_RETRY_INTERVAL = Duration.millis(500);
const TRANSIENT_BOOTSTRAP_STATUS_CODES = new Set([502, 503, 504]);

const isTransientBearerBootstrapError = (error: RemoteEnvironmentRequestError): boolean => {
  switch (error._tag) {
    case "RemoteEnvironmentAuthFetchError":
    case "RemoteEnvironmentAuthTimeoutError":
      return true;
    case "RemoteEnvironmentAuthUndeclaredStatusError":
      return TRANSIENT_BOOTSTRAP_STATUS_CODES.has(error.status);
    default:
      return false;
  }
};

export class DesktopLocalEnvironmentAuthBackendNotConfiguredError extends Schema.TaggedError<DesktopLocalEnvironmentAuthBackendNotConfiguredError>()(
  "DesktopLocalEnvironmentAuthBackendNotConfiguredError",
  {},
) {
  override get message(): string {
    return "Local backend is not configured.";
  }
}

export class DesktopLocalEnvironmentAuthSessionBootstrapError extends Schema.TaggedError<DesktopLocalEnvironmentAuthSessionBootstrapError>()(
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

export class DesktopSavedEnvironmentRecoveryError extends Schema.TaggedError<DesktopSavedEnvironmentRecoveryError>()(
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
    /**
     * The renderer rewrote the saved connection catalog (for example after
     * renewing the remote primary's bearer). Forget the cached remote-mode
     * token so the next `getBearerToken` re-ranks the saved credentials. A
     * local-mode token is kept: re-minting it would revoke the current one.
     */
    readonly invalidateSavedRemoteToken: Effect.Effect<void>;
  }
>()("@t3tools/desktop/backend/DesktopLocalEnvironmentAuth") {}

const decodeConnectionCatalog = Schema.decodeEffect(
  Schema.fromJsonString(ConnectionCatalogDocument),
);

/** Bounds recovery round-trips when one server has accumulated stale saved entries. */
const MAX_RECOVERY_CANDIDATES = 5;

const decodeSessionTokenExpiry = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ exp: Schema.Finite })),
);

/**
 * Reads the `exp` claim (epoch milliseconds) of a server session token shaped
 * `base64url(JSON claims).signature`. The signature is not checked: the value
 * only orders saved credentials, and the server validates whichever one is sent.
 */
function readSessionTokenExpiry(token: string): number | null {
  const separator = token.indexOf(".");
  if (separator <= 0) {
    return null;
  }
  const claims = Base64Url.decodeString(token.slice(0, separator));
  if (Result.isFailure(claims)) {
    return null;
  }
  return Option.match(decodeSessionTokenExpiry(claims.success), {
    onNone: () => null,
    onSome: (decoded) => decoded.exp,
  });
}

interface CachedBearerToken {
  readonly token: string;
  /** `remote`: read from the saved catalog. `local`: minted from the bootstrap seed. */
  readonly source: "remote" | "local";
}

interface SavedRemoteCredential {
  readonly token: string;
  readonly environmentId: string;
}

/**
 * Every bearer credential saved for exactly `remoteHttpBaseUrl`, best first.
 *
 * Orphaned profiles for the same server can outlive a re-pairing, so the first
 * URL match is not necessarily the current credential. Profiles referenced by a
 * saved bearer target come first, as that is the connection the renderer
 * resolves; the rest follow by token expiry, latest first, which also places
 * expired tokens after unexpired ones. Unreadable expiry claims go last.
 */
function savedRemoteCredentialsFor(
  catalog: ConnectionCatalogDocumentType,
  remoteHttpBaseUrl: string,
): ReadonlyArray<SavedRemoteCredential> {
  const candidates = catalog.profiles.flatMap((profile, catalogIndex) => {
    if (
      profile._tag !== "BearerConnectionProfile" ||
      DesktopAppSettings.normalizeRemoteBackendUrl(profile.httpBaseUrl) !== remoteHttpBaseUrl
    ) {
      return [];
    }
    const stored = catalog.credentials.find(
      (candidate) => candidate.connectionId === profile.connectionId,
    );
    if (stored === undefined || stored.credential._tag !== "BearerConnectionCredential") {
      return [];
    }
    const token = stored.credential.token;
    return [
      {
        token,
        environmentId: profile.environmentId,
        targetReferenced: catalog.targets.some(
          (target) =>
            target._tag === "BearerConnectionTarget" &&
            target.connectionId === profile.connectionId &&
            target.environmentId === profile.environmentId,
        ),
        expiresAt: readSessionTokenExpiry(token) ?? Number.NEGATIVE_INFINITY,
        catalogIndex,
      },
    ];
  });
  candidates.sort(
    (left, right) =>
      Number(right.targetReferenced) - Number(left.targetReferenced) ||
      (left.expiresAt === right.expiresAt ? 0 : left.expiresAt > right.expiresAt ? -1 : 1) ||
      left.catalogIndex - right.catalogIndex,
  );
  return candidates.map(({ token, environmentId }) => ({ token, environmentId }));
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const connectionCatalogStore = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
  const httpClient = yield* HttpClient.HttpClient;
  const tokenRef = yield* Ref.make(Option.none<CachedBearerToken>());
  // Bumped on every catalog write so a read that raced the write is not cached.
  const catalogGeneration = yield* Ref.make(0);
  const mutex = yield* Semaphore.make(1);

  const readSavedRemoteCredentials = Effect.fn(
    "desktop.localEnvironmentAuth.readSavedRemoteCredentials",
  )(
    function* (remoteHttpBaseUrl: string, existingOnly = false) {
      const encodedCatalog = yield* existingOnly
        ? connectionCatalogStore.getExisting
        : connectionCatalogStore.get;
      if (Option.isNone(encodedCatalog)) {
        return [];
      }
      const catalog: ConnectionCatalogDocumentType = yield* decodeConnectionCatalog(
        encodedCatalog.value,
      );
      return savedRemoteCredentialsFor(catalog, remoteHttpBaseUrl);
    },
    Effect.mapError((cause) => new DesktopLocalEnvironmentAuthSessionBootstrapError({ cause })),
  );

  const getBearerToken = mutex
    .withPermits(1)(
      Effect.gen(function* () {
        const cached = yield* Ref.get(tokenRef);
        if (Option.isSome(cached)) {
          return cached.value.token;
        }

        const settings = yield* appSettings.get;
        if (settings.primaryBackendMode === "remote" && !isLocalExecutionOverride()) {
          const remoteHttpBaseUrl = DesktopAppSettings.normalizeRemoteBackendUrl(
            settings.remoteBackendUrl,
          );
          if (remoteHttpBaseUrl === null) {
            return null;
          }
          const generation = yield* Ref.get(catalogGeneration);
          const [best] = yield* readSavedRemoteCredentials(remoteHttpBaseUrl);
          if (best === undefined) return null;
          if ((yield* Ref.get(catalogGeneration)) === generation) {
            yield* Ref.set(tokenRef, Option.some({ token: best.token, source: "remote" }));
          }
          return best.token;
        }

        const instances = yield* pool.list;
        const primary = instances.find((instance) => instance.id === PRIMARY_LOCAL_ENVIRONMENT_ID);
        const configOption = primary === undefined ? Option.none() : yield* primary.currentConfig;
        if (Option.isNone(configOption)) {
          return yield* new DesktopLocalEnvironmentAuthBackendNotConfiguredError();
        }
        const config = configOption.value;
        // A backend launched with the desktop secret accepts the current
        // window's token, not the one frozen into its launch config; this
        // exchange can run long after launch (e.g. after a suspend).
        const secret = config.bootstrap.desktopBootstrapSecret;
        const credential =
          secret === undefined
            ? config.bootstrap.desktopBootstrapToken
            : currentDesktopBootstrapToken(secret, yield* Clock.currentTimeMillis);
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
          Effect.retry({
            while: isTransientBearerBootstrapError,
            schedule: Schedule.spaced(BOOTSTRAP_TRANSIENT_RETRY_INTERVAL),
          }),
          // Bounds the attempts and any request still in flight at the deadline.
          Effect.timeout(BOOTSTRAP_TRANSIENT_RETRY_TIMEOUT),
          Effect.mapError(
            (cause) =>
              new DesktopLocalEnvironmentAuthSessionBootstrapError({
                cause,
              }),
          ),
        );
        yield* Ref.set(tokenRef, Option.some({ token: session.access_token, source: "local" }));
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
        const generation = yield* Ref.get(catalogGeneration);
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
        const saved = yield* readSavedRemoteCredentials(endpoint, true).pipe(
          Effect.mapError(
            () =>
              new DesktopSavedEnvironmentRecoveryError({
                message: "The saved credential could not be loaded on this device.",
              }),
          ),
        );
        if (saved.length === 0) {
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
        const candidates = saved
          .filter((candidate) => candidate.environmentId === descriptor.environmentId)
          .slice(0, MAX_RECOVERY_CANDIDATES);
        if (candidates.length === 0) {
          return yield* new DesktopSavedEnvironmentRecoveryError({
            message: "This server does not match the saved environment. Recovery stopped.",
          });
        }
        let validationFailed = false;
        for (const candidate of candidates) {
          const session = yield* fetchRemoteSessionState({
            httpBaseUrl: endpoint,
            bearerToken: candidate.token,
          }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient), Effect.option);
          if (Option.isNone(session)) {
            validationFailed = true;
            continue;
          }
          if (
            !session.value.authenticated ||
            session.value.sessionMethod !== "bearer-access-token"
          ) {
            continue;
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
          // A catalog write during verification may have saved a newer bearer;
          // leave it to the next read instead of pinning this one.
          if ((yield* Ref.get(catalogGeneration)) === generation) {
            yield* Ref.set(tokenRef, Option.some({ token: candidate.token, source: "remote" }));
          }
          return session.value;
        }
        return yield* new DesktopSavedEnvironmentRecoveryError({
          message: validationFailed
            ? "The saved credential could not be validated by the selected server."
            : "The selected server rejected the saved credential. It may have expired or been revoked.",
        });
      }),
    );
  });

  const invalidateSavedRemoteToken: DesktopLocalEnvironmentAuth["Service"]["invalidateSavedRemoteToken"] =
    Ref.update(catalogGeneration, (generation) => generation + 1).pipe(
      Effect.andThen(
        Ref.update(tokenRef, (cached) =>
          Option.isSome(cached) && cached.value.source === "remote" ? Option.none() : cached,
        ),
      ),
      Effect.withSpan("desktop.localEnvironmentAuth.invalidateSavedRemoteToken"),
    );

  return DesktopLocalEnvironmentAuth.of({
    getBearerToken,
    recoverRemotePrimarySession,
    invalidateSavedRemoteToken,
  });
});

export const layer = Layer.effect(DesktopLocalEnvironmentAuth, make);
