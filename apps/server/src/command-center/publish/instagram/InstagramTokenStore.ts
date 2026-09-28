import { CommandCenterError, type CommandCenterPublishConnection } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { makePublishCredentialSlot } from "../PublishCredentialSlot.ts";
import { InstagramApiError, InstagramClient, type FetchLike } from "./client.ts";

/**
 * Persistence + lifecycle for the single Instagram publishing account of this environment.
 * Replaces the earlier app's `lib/instagram/token-store.ts` (Supabase) with one JSON secret in
 * `ServerSecretStore`. T3 has no cron, so refresh is lazy: every read that needs the token
 * refreshes it first when it is within the refresh threshold of expiry.
 */

export const INSTAGRAM_CONNECTION_SECRET = "command-center-instagram-connection";

/** Long-lived Instagram tokens last ~60 days from issue/refresh. */
export const LONG_LIVED_TOKEN_TTL_DAYS = 60;

/** Refresh when the token is this many days from expiry. */
export const DEFAULT_REFRESH_THRESHOLD_DAYS = 15;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const StoredInstagramConnection = Schema.Struct({
  version: Schema.Literal(1),
  accessToken: Schema.String,
  igUserId: Schema.String,
  username: Schema.String,
  accountType: Schema.optional(Schema.String),
  tokenExpiresAtMs: Schema.Number,
  lastRefreshedAtMs: Schema.Number,
  connectedAtMs: Schema.Number,
  lastError: Schema.optional(Schema.String),
});
export type StoredInstagramConnection = typeof StoredInstagramConnection.Type;

/** Server-only credential handed to the publish path. Never serialize to a client. */
export interface InstagramActiveCredential {
  readonly accessToken: string;
  readonly igUserId: string;
  readonly username: string;
}

export type InstagramRefreshResult =
  | { readonly refreshed: false; readonly reason: "no_connection" }
  | { readonly refreshed: false; readonly reason: "not_expiring"; readonly expiresAtMs: number }
  | { readonly refreshed: true; readonly expiresAtMs: number }
  | { readonly refreshed: false; readonly reason: "error"; readonly message: string };

interface InstagramTokenStoreShape {
  /** Browser-safe summary. Lazily refreshes an expiring token first. */
  readonly summary: Effect.Effect<CommandCenterPublishConnection, CommandCenterError>;
  /** Validate a pasted long-lived token via GET /me, refresh it for an authoritative expiry, persist it. */
  readonly connectFromToken: (
    token: string,
  ) => Effect.Effect<CommandCenterPublishConnection, CommandCenterError>;
  readonly disconnect: Effect.Effect<CommandCenterPublishConnection, CommandCenterError>;
  /** Refresh the stored token when it is within `thresholdDays` of expiry. */
  readonly refreshIfExpiring: (
    thresholdDays?: number,
  ) => Effect.Effect<InstagramRefreshResult, CommandCenterError>;
  /** Token for the publish path, refreshed first when expiring. None when nothing is connected. */
  readonly activeCredential: Effect.Effect<
    Option.Option<InstagramActiveCredential>,
    CommandCenterError
  >;
}

export class InstagramTokenStore extends Context.Service<
  InstagramTokenStore,
  InstagramTokenStoreShape
>()("@awtprod/command-center/command-center/publish/instagram/InstagramTokenStore") {}

const connectorError = (message: string, cause?: unknown) =>
  new CommandCenterError({
    reason: "connector",
    message,
    ...(cause === undefined ? {} : { cause }),
  });

/** Graph error messages are already token-redacted by InstagramClient. */
const graphFailureMessage = (cause: unknown): string =>
  cause instanceof InstagramApiError
    ? cause.message
    : "Instagram could not be reached. Try again in a moment.";

const callGraph = <A>(run: () => Promise<A>, action: string) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => connectorError(`${action}: ${graphFailureMessage(cause)}`, cause),
  });

/** True when `expiresAtMs` is within `thresholdDays` of `nowMs`. */
export function isTokenExpiring(expiresAtMs: number, thresholdDays: number, nowMs: number) {
  return !Number.isFinite(expiresAtMs) || expiresAtMs - nowMs <= thresholdDays * MS_PER_DAY;
}

/** Shape-check a /refresh_access_token payload and derive the absolute expiry. */
export function parseRefreshedToken(
  refreshed: unknown,
  nowMs: number,
): { readonly accessToken: string; readonly expiresAtMs: number } | undefined {
  if (typeof refreshed !== "object" || refreshed === null) return undefined;
  const accessToken = "access_token" in refreshed ? refreshed.access_token : undefined;
  const expiresIn = "expires_in" in refreshed ? refreshed.expires_in : undefined;
  if (
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    return undefined;
  }
  return { accessToken, expiresAtMs: nowMs + expiresIn * 1000 };
}

const isoFromMillis = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

export const disconnectedInstagramConnection = {
  provider: "instagram",
  state: "disconnected",
  setupMode: "paste-token",
} as const satisfies CommandCenterPublishConnection;

export function instagramConnectionSummary(
  stored: StoredInstagramConnection,
  nowMs: number,
): CommandCenterPublishConnection {
  const expired = stored.tokenExpiresAtMs <= nowMs;
  const detail = expired
    ? "The Instagram token expired. Paste a new long-lived token to reconnect."
    : stored.lastError;
  return {
    provider: "instagram",
    state: "connected",
    setupMode: "paste-token",
    accountId: stored.igUserId,
    accountLabel: `@${stored.username}`,
    expiresAt: isoFromMillis(stored.tokenExpiresAtMs),
    lastRefreshedAt: isoFromMillis(stored.lastRefreshedAtMs),
    ...(detail === undefined || detail.trim().length === 0 ? {} : { detail }),
  };
}

export interface InstagramTokenStoreOptions {
  /** Injectable fetch for tests. Defaults to global fetch. */
  readonly fetchImpl?: FetchLike;
  /** Override the Graph base URL (tests). */
  readonly baseUrl?: string;
}

export const make = Effect.fn("InstagramTokenStore.make")(function* (
  options: InstagramTokenStoreOptions = {},
) {
  const slot = yield* makePublishCredentialSlot({
    secretName: INSTAGRAM_CONNECTION_SECRET,
    label: "Instagram",
    schema: StoredInstagramConnection,
  });
  const clientFor = (accessToken: string) =>
    new InstagramClient({
      accessToken,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    });
  const nowMs = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));

  const refreshIfExpiring = Effect.fn("InstagramTokenStore.refreshIfExpiring")(function* (
    thresholdDays: number = DEFAULT_REFRESH_THRESHOLD_DAYS,
  ) {
    const current = yield* slot.read;
    if (Option.isNone(current)) {
      return { refreshed: false, reason: "no_connection" } as const;
    }
    const stored = current.value;
    const now = yield* nowMs;
    if (!isTokenExpiring(stored.tokenExpiresAtMs, thresholdDays, now)) {
      return {
        refreshed: false,
        reason: "not_expiring",
        expiresAtMs: stored.tokenExpiresAtMs,
      } as const;
    }
    const refreshed = yield* callGraph(
      () => clientFor(stored.accessToken).refreshLongLivedToken(),
      "Instagram token refresh failed",
    ).pipe(
      Effect.flatMap((payload) => {
        const parsed = parseRefreshedToken(payload, now);
        return parsed === undefined
          ? Effect.fail(connectorError("Instagram token refresh returned an unexpected payload."))
          : Effect.succeed(parsed);
      }),
      Effect.result,
    );
    if (refreshed._tag === "Failure") {
      // Keep the token: it may still be valid. Record the failure so the settings row shows it
      // and the next read retries.
      const message = refreshed.failure.message;
      yield* slot.write({ ...stored, lastError: message });
      return { refreshed: false, reason: "error", message } as const;
    }
    const { lastError: _previousError, ...rest } = stored;
    yield* slot.write({
      ...rest,
      accessToken: refreshed.success.accessToken,
      tokenExpiresAtMs: refreshed.success.expiresAtMs,
      lastRefreshedAtMs: now,
    });
    return { refreshed: true, expiresAtMs: refreshed.success.expiresAtMs } as const;
  });

  const summary = Effect.gen(function* () {
    yield* refreshIfExpiring();
    const current = yield* slot.read;
    const now = yield* nowMs;
    return Option.match(current, {
      onNone: (): CommandCenterPublishConnection => disconnectedInstagramConnection,
      onSome: (stored) => instagramConnectionSummary(stored, now),
    });
  }).pipe(Effect.withSpan("InstagramTokenStore.summary"));

  const connectFromToken = Effect.fn("InstagramTokenStore.connectFromToken")(function* (
    rawToken: string,
  ) {
    const token = rawToken.trim();
    if (token.length === 0 || /\s/u.test(token)) {
      return yield* new CommandCenterError({
        reason: "validation",
        message: "Paste the Instagram long-lived access token exactly as issued, without spaces.",
      });
    }
    const api = clientFor(token);
    const me = yield* callGraph(() => api.getMe(), "Instagram rejected this token");
    if (
      typeof me.user_id !== "string" ||
      me.user_id.length === 0 ||
      typeof me.username !== "string" ||
      me.username.length === 0
    ) {
      return yield* connectorError(
        "Instagram accepted the token but did not return an account id and username.",
      );
    }
    const now = yield* nowMs;
    // A pasted long-lived token may already be weeks old. Refresh it for an authoritative expiry.
    // Graph rejects refreshing a token under 24h old; then the full 60-day TTL is accurate.
    const refreshed = yield* callGraph(
      () => api.refreshLongLivedToken(),
      "Instagram token refresh failed",
    ).pipe(
      Effect.map((payload) => parseRefreshedToken(payload, now)),
      Effect.orElseSucceed(() => undefined),
    );
    const stored: StoredInstagramConnection = {
      version: 1,
      accessToken: refreshed?.accessToken ?? token,
      igUserId: me.user_id,
      username: me.username,
      ...(typeof me.account_type === "string" ? { accountType: me.account_type } : {}),
      tokenExpiresAtMs: refreshed?.expiresAtMs ?? now + LONG_LIVED_TOKEN_TTL_DAYS * MS_PER_DAY,
      lastRefreshedAtMs: now,
      connectedAtMs: now,
    };
    yield* slot.write(stored);
    return instagramConnectionSummary(stored, now);
  });

  const disconnect = slot.clear.pipe(
    Effect.as<CommandCenterPublishConnection>(disconnectedInstagramConnection),
    Effect.withSpan("InstagramTokenStore.disconnect"),
  );

  const activeCredential = Effect.gen(function* () {
    yield* refreshIfExpiring();
    const current = yield* slot.read;
    const now = yield* nowMs;
    if (Option.isNone(current)) return Option.none<InstagramActiveCredential>();
    if (current.value.tokenExpiresAtMs <= now) {
      return yield* connectorError(
        "The Instagram token expired. Paste a new long-lived token in Settings > Connections.",
      );
    }
    return Option.some({
      accessToken: current.value.accessToken,
      igUserId: current.value.igUserId,
      username: current.value.username,
    });
  }).pipe(Effect.withSpan("InstagramTokenStore.activeCredential"));

  return InstagramTokenStore.of({
    summary,
    connectFromToken,
    disconnect,
    refreshIfExpiring,
    activeCredential,
  });
});

export const makeLayer = (options: InstagramTokenStoreOptions = {}) =>
  Layer.effect(InstagramTokenStore, make(options));

export const layer = makeLayer();
