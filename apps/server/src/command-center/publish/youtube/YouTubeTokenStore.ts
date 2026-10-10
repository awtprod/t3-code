import { CommandCenterError, type CommandCenterPublishConnection } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { ServerSecretStore } from "../../../auth/ServerSecretStore.ts";
import { validateGoogleCallbackAddress } from "../../GoogleConnectionSetup.ts";
import { makePublishCredentialSlot } from "../PublishCredentialSlot.ts";
import {
  authorizationCodeFromCallback,
  createYouTubeAuthorizationRequest,
  emailFromIdToken,
  exchangeYouTubeAuthorizationCode,
  grantsYouTubeUpload,
  grantsYouTubeAnalytics,
  refreshYouTubeAccessToken,
  resolveYouTubeOAuthClient,
  revokeYouTubeToken,
  YOUTUBE_OAUTH_CLIENT_ID_ENV,
  YOUTUBE_OAUTH_CLIENT_SECRET_ENV,
  YOUTUBE_OAUTH_CLIENT_SECRET_NAME,
  YouTubeOAuthError,
  type FetchLike,
  type YouTubeOAuthClient,
} from "./YouTubeOAuth.ts";

/**
 * Persistence + lifecycle for the single YouTube publishing account of this environment.
 * Only the refresh token (plus display metadata) is persisted, as one JSON secret in
 * `ServerSecretStore`; access tokens live in memory and are refreshed lazily shortly before
 * they expire. Nothing here is ever sent to a client beyond `CommandCenterPublishConnection`.
 */

export const YOUTUBE_CONNECTION_SECRET = "command-center-youtube-connection";

/** Refresh the in-memory access token when it is this close to expiry. */
const ACCESS_TOKEN_REFRESH_SKEW_MS = 2 * 60 * 1000;

const StoredYouTubeConnection = Schema.Struct({
  version: Schema.Literal(1),
  refreshToken: Schema.String,
  /** The OAuth client the refresh token was issued to; refresh must use the same client. */
  clientId: Schema.String,
  scope: Schema.String,
  email: Schema.optional(Schema.String),
  channelId: Schema.optional(Schema.String),
  channelTitle: Schema.optional(Schema.String),
  connectedAtMs: Schema.Number,
  lastRefreshedAtMs: Schema.Number,
  lastError: Schema.optional(Schema.String),
  analyticsVerifiedAtMs: Schema.optional(Schema.Number),
  analyticsLastError: Schema.optional(Schema.String),
});
export type StoredYouTubeConnection = typeof StoredYouTubeConnection.Type;

interface CachedAccessToken {
  readonly accessToken: string;
  readonly expiresAtMs: number;
  readonly refreshToken: string;
  readonly scope: string;
}

interface YouTubeTokenStoreShape {
  /** Browser-safe summary. */
  readonly summary: Effect.Effect<CommandCenterPublishConnection, CommandCenterError>;
  /** Start OAuth: returns the consent URL and a server-side `complete(callbackAddress)`. */
  readonly begin: Effect.Effect<
    {
      readonly authUrl: string;
      readonly complete: (
        callbackAddress: string,
      ) => Effect.Effect<CommandCenterPublishConnection, CommandCenterError>;
    },
    CommandCenterError
  >;
  /** Best-effort revoke at Google, then delete the stored refresh token. */
  readonly disconnect: Effect.Effect<CommandCenterPublishConnection, CommandCenterError>;
  /** A valid access token for the upload path, refreshed first when near expiry. */
  readonly accessToken: Effect.Effect<string, CommandCenterError>;
  readonly analyticsAccessToken: Effect.Effect<string, CommandCenterError>;
  readonly recordAnalyticsCheck: (error?: string) => Effect.Effect<void, CommandCenterError>;
  /** Drop the cached access token (after a 401) so the next read refreshes. */
  readonly invalidateAccessToken: Effect.Effect<void>;
  /** Remember the channel an upload landed on, for the settings row label. */
  readonly recordChannel: (channel: {
    readonly channelId: string;
    readonly channelTitle?: string | undefined;
  }) => Effect.Effect<void, CommandCenterError>;
}

export class YouTubeTokenStore extends Context.Service<YouTubeTokenStore, YouTubeTokenStoreShape>()(
  "@awtprod/command-center/command-center/publish/youtube/YouTubeTokenStore",
) {}

const connectorError = (message: string, cause?: unknown) =>
  new CommandCenterError({
    reason: "connector",
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const callGoogle = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof YouTubeOAuthError
        ? connectorError(cause.message, cause)
        : connectorError("Google could not be reached. Try again in a moment.", cause),
  });

const YOUTUBE_CLIENT_NOT_CONFIGURED_DETAIL = `YouTube needs a Google Desktop OAuth client on this environment: set ${YOUTUBE_OAUTH_CLIENT_ID_ENV} and ${YOUTUBE_OAUTH_CLIENT_SECRET_ENV}, or store the downloaded client JSON as the ${YOUTUBE_OAUTH_CLIENT_SECRET_NAME} secret.`;

const isoFromMillis = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const disconnectedYouTubeConnection = {
  provider: "youtube",
  state: "disconnected",
  setupMode: "oauth-redirect",
} as const satisfies CommandCenterPublishConnection;

function youTubeConnectionSummary(stored: StoredYouTubeConnection): CommandCenterPublishConnection {
  const label = stored.channelTitle ?? stored.email;
  return {
    provider: "youtube",
    state: "connected",
    setupMode: "oauth-redirect",
    ...(stored.channelId === undefined ? {} : { accountId: stored.channelId }),
    ...(label === undefined || label.trim().length === 0 ? {} : { accountLabel: label }),
    lastRefreshedAt: isoFromMillis(stored.lastRefreshedAtMs),
    ...(stored.lastError === undefined || stored.lastError.trim().length === 0
      ? {}
      : { detail: stored.lastError }),
    analytics: !grantsYouTubeAnalytics(stored.scope)
      ? {
          state: "needs-consent",
          detail: "Reconnect YouTube to grant Analytics and YouTube read access.",
        }
      : stored.analyticsLastError !== undefined
        ? { state: "error", detail: stored.analyticsLastError }
        : stored.analyticsVerifiedAtMs !== undefined
          ? {
              state: "verified",
              detail: "Analytics read access verified.",
              verifiedAt: isoFromMillis(stored.analyticsVerifiedAtMs),
            }
          : {
              state: "permission-granted",
              detail: "Analytics permission granted; live report access has not been verified.",
            },
  };
}

export interface YouTubeTokenStoreOptions {
  /** Injectable fetch for tests. Defaults to global fetch. */
  readonly fetchImpl?: FetchLike;
  /** Env to read the OAuth client from. Defaults to process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly tokenEndpoint?: string;
  readonly revokeEndpoint?: string;
}

const make = Effect.fn("YouTubeTokenStore.make")(function* (
  options: YouTubeTokenStoreOptions = {},
) {
  const secrets = yield* ServerSecretStore;
  const slot = yield* makePublishCredentialSlot({
    secretName: YOUTUBE_CONNECTION_SECRET,
    label: "YouTube",
    schema: StoredYouTubeConnection,
  });
  const cache = yield* Ref.make(Option.none<CachedAccessToken>());
  const env = options.env ?? process.env;
  const fetchOptions = {
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.tokenEndpoint === undefined ? {} : { tokenEndpoint: options.tokenEndpoint }),
  };
  const nowMs = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
  const textDecoder = new TextDecoder();

  /** Re-resolved on every use so a newly supplied client takes effect without a restart. */
  const oauthClient = secrets.get(YOUTUBE_OAUTH_CLIENT_SECRET_NAME).pipe(
    Effect.mapError((cause) =>
      connectorError("The YouTube OAuth client secret could not be read.", cause),
    ),
    Effect.map((bytes) =>
      Option.fromNullishOr(
        resolveYouTubeOAuthClient({
          env,
          clientJson: Option.match(bytes, {
            onNone: () => undefined,
            onSome: (value) => textDecoder.decode(value),
          }),
        }),
      ),
    ),
  );

  const requireClient = oauthClient.pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(connectorError(YOUTUBE_CLIENT_NOT_CONFIGURED_DETAIL)),
        onSome: (client) => Effect.succeed(client),
      }),
    ),
  );

  const summary = Effect.gen(function* () {
    const current = yield* slot.read;
    if (Option.isSome(current)) return youTubeConnectionSummary(current.value);
    if (Option.isNone(yield* oauthClient)) {
      return {
        provider: "youtube",
        state: "unavailable",
        setupMode: "oauth-redirect",
        detail: YOUTUBE_CLIENT_NOT_CONFIGURED_DETAIL,
      } satisfies CommandCenterPublishConnection;
    }
    return disconnectedYouTubeConnection;
  }).pipe(Effect.withSpan("YouTubeTokenStore.summary"));

  const complete = Effect.fn("YouTubeTokenStore.complete")(function* (
    client: YouTubeOAuthClient,
    request: ReturnType<typeof createYouTubeAuthorizationRequest>,
    callbackAddress: string,
  ) {
    const address = callbackAddress.trim();
    const callbackError = validateGoogleCallbackAddress(address, {
      redirectUri: request.redirectUri,
      state: request.state,
    });
    const code = authorizationCodeFromCallback(address);
    if (callbackError !== undefined || code === undefined) {
      return yield* new CommandCenterError({
        reason: "validation",
        message:
          callbackError ??
          "The pasted address does not contain Google's authorization code. Copy the complete address from the browser address bar.",
      });
    }
    const grant = yield* callGoogle(() =>
      exchangeYouTubeAuthorizationCode({
        client,
        code,
        codeVerifier: request.codeVerifier,
        redirectUri: request.redirectUri,
        ...fetchOptions,
      }),
    );
    if (!grantsYouTubeUpload(grant.scope)) {
      return yield* connectorError(
        "Google did not grant permission to upload videos. Connect again and leave the YouTube upload permission checked.",
      );
    }
    if (grant.refreshToken === undefined) {
      return yield* connectorError(
        "Google did not issue a reusable sign-in token. Connect again and approve access when Google asks for consent.",
      );
    }
    const now = yield* nowMs;
    const email = emailFromIdToken(grant.idToken);
    const stored: StoredYouTubeConnection = {
      version: 1,
      refreshToken: grant.refreshToken,
      clientId: client.clientId,
      scope: grant.scope ?? "",
      ...(email === undefined ? {} : { email }),
      connectedAtMs: now,
      lastRefreshedAtMs: now,
    };
    yield* slot.write(stored);
    yield* Ref.set(
      cache,
      Option.some({
        accessToken: grant.accessToken,
        expiresAtMs: now + grant.expiresInSeconds * 1000,
        refreshToken: stored.refreshToken,
        scope: stored.scope,
      }),
    );
    return youTubeConnectionSummary(stored);
  });

  const begin = Effect.gen(function* () {
    const client = yield* requireClient;
    const request = createYouTubeAuthorizationRequest(client);
    return {
      authUrl: request.authUrl,
      complete: (callbackAddress: string) => complete(client, request, callbackAddress),
    };
  }).pipe(Effect.withSpan("YouTubeTokenStore.begin"));

  const disconnect = Effect.gen(function* () {
    const current = yield* slot.read;
    if (Option.isSome(current)) {
      yield* Effect.promise(() =>
        revokeYouTubeToken({
          token: current.value.refreshToken,
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
          ...(options.revokeEndpoint === undefined
            ? {}
            : { revokeEndpoint: options.revokeEndpoint }),
        }),
      );
    }
    yield* slot.clear;
    yield* Ref.set(cache, Option.none());
    return yield* summary;
  }).pipe(Effect.withSpan("YouTubeTokenStore.disconnect"));

  const accessToken = Effect.gen(function* () {
    const now = yield* nowMs;
    const current = yield* slot.read;
    if (Option.isNone(current)) {
      return yield* connectorError(
        "YouTube is not connected. Connect it in Settings > Connections > Publishing accounts.",
      );
    }
    const stored = current.value;
    const cached = yield* Ref.get(cache);
    if (
      Option.isSome(cached) &&
      cached.value.refreshToken === stored.refreshToken &&
      cached.value.scope === stored.scope &&
      cached.value.expiresAtMs - now > ACCESS_TOKEN_REFRESH_SKEW_MS
    ) {
      return cached.value.accessToken;
    }
    const client = yield* requireClient;
    if (client.clientId !== stored.clientId) {
      return yield* connectorError(
        "The YouTube OAuth client changed since this account was connected. Connect YouTube again.",
      );
    }
    const refreshed = yield* callGoogle(() =>
      refreshYouTubeAccessToken({ client, refreshToken: stored.refreshToken, ...fetchOptions }),
    ).pipe(Effect.result);
    if (refreshed._tag === "Failure") {
      // Keep the refresh token (the failure may be transient); record it for the settings row.
      yield* slot.write({ ...stored, lastError: refreshed.failure.message });
      return yield* refreshed.failure;
    }
    const { lastError: _previousError, ...rest } = stored;
    const nextStored = {
      ...rest,
      // Google may rotate the refresh token; keep whichever is newest.
      refreshToken: refreshed.success.refreshToken ?? stored.refreshToken,
      scope: refreshed.success.scope ?? stored.scope,
      lastRefreshedAtMs: now,
    };
    yield* slot.write(nextStored);
    yield* Ref.set(
      cache,
      Option.some({
        accessToken: refreshed.success.accessToken,
        expiresAtMs: now + refreshed.success.expiresInSeconds * 1000,
        refreshToken: nextStored.refreshToken,
        scope: nextStored.scope,
      }),
    );
    return refreshed.success.accessToken;
  }).pipe(Effect.withSpan("YouTubeTokenStore.accessToken"));

  const analyticsAccessToken = Effect.gen(function* () {
    const current = yield* slot.read;
    if (Option.isNone(current) || !grantsYouTubeAnalytics(current.value.scope)) {
      return yield* connectorError(
        "YouTube Analytics read permission is missing. Reconnect YouTube in Settings > Connections.",
      );
    }
    const token = yield* accessToken;
    const refreshed = yield* slot.read;
    if (Option.isNone(refreshed) || !grantsYouTubeAnalytics(refreshed.value.scope)) {
      return yield* connectorError(
        "YouTube Analytics read permission was removed. Reconnect YouTube in Settings > Connections.",
      );
    }
    return token;
  });

  const recordAnalyticsCheck = Effect.fn("YouTubeTokenStore.recordAnalyticsCheck")(function* (
    error?: string,
  ) {
    const current = yield* slot.read;
    if (Option.isNone(current)) return;
    const at = yield* nowMs;
    const { analyticsLastError: _oldError, ...rest } = current.value;
    yield* slot.write({
      ...rest,
      ...(error === undefined ? { analyticsVerifiedAtMs: at } : { analyticsLastError: error }),
    });
  });

  const recordChannel = Effect.fn("YouTubeTokenStore.recordChannel")(function* (channel: {
    readonly channelId: string;
    readonly channelTitle?: string | undefined;
  }) {
    const current = yield* slot.read;
    if (Option.isNone(current)) return;
    const stored = current.value;
    if (stored.channelId === channel.channelId && stored.channelTitle === channel.channelTitle) {
      return;
    }
    yield* slot.write({
      ...stored,
      channelId: channel.channelId,
      ...(channel.channelTitle === undefined ? {} : { channelTitle: channel.channelTitle }),
    });
  });

  return YouTubeTokenStore.of({
    summary,
    begin,
    disconnect,
    accessToken,
    analyticsAccessToken,
    recordAnalyticsCheck,
    invalidateAccessToken: Ref.set(cache, Option.none()),
    recordChannel,
  });
});

export const makeLayer = (options: YouTubeTokenStoreOptions = {}) =>
  Layer.effect(YouTubeTokenStore, make(options));

export const layer = makeLayer();
