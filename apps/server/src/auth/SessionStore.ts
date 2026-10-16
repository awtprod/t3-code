import {
  AuthSessionId,
  AuthAdministrativeScopes,
  AuthStandardClientScopes,
  AuthEnvironmentScopes,
  type AuthClientMetadata,
  type AuthClientSession,
  type AuthEnvironmentScope,
  type ClientSurface,
  RuntimeMode,
  type ServerAuthSessionMethod,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import {
  REUSABLE_DEV_SESSION_EXPIRES_AT,
  REUSABLE_DEV_SESSION_PREFIX,
  resolveReusableDevAuth,
} from "./ReusableDevAuth.ts";
import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  resolveLegacySessionCookieName,
  resolveSessionCookieName,
  signPayload,
  timingSafeEqualBase64Url,
} from "./utils.ts";

export interface IssuedSession {
  readonly sessionId: AuthSessionId;
  readonly token: string;
  readonly method: ServerAuthSessionMethod;
  readonly client: AuthClientMetadata;
  readonly expiresAt: DateTime.DateTime;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly proofKeyThumbprint?: string;
}

export interface VerifiedSession {
  readonly sessionId: AuthSessionId;
  readonly token: string;
  readonly method: ServerAuthSessionMethod;
  readonly client: AuthClientMetadata;
  readonly expiresAt?: DateTime.DateTime;
  /** When the stored session was issued. Renewal keeps the original lifetime. */
  readonly issuedAt?: DateTime.DateTime;
  readonly subject: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly proofKeyThumbprint?: string;
  /** The most an MCP client approved through OAuth may hand to the threads it drives. */
  readonly runtimeModeCeiling?: RuntimeMode;
}

export type SessionCredentialChange =
  | {
      readonly type: "clientUpserted";
      readonly clientSession: AuthClientSession;
    }
  | {
      readonly type: "clientRemoved";
      readonly sessionId: AuthSessionId;
    };

export class MalformedSessionTokenError extends Schema.TaggedError<MalformedSessionTokenError>()(
  "MalformedSessionTokenError",
  {},
) {
  override get message(): string {
    return "Malformed session token.";
  }
}

export class InvalidSessionTokenSignatureError extends Schema.TaggedError<InvalidSessionTokenSignatureError>()(
  "InvalidSessionTokenSignatureError",
  {},
) {
  override get message(): string {
    return "Invalid session token signature.";
  }
}

export class InvalidSessionTokenPayloadError extends Schema.TaggedError<InvalidSessionTokenPayloadError>()(
  "InvalidSessionTokenPayloadError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Invalid session token payload.";
  }
}

export class SessionTokenExpiredError extends Schema.TaggedError<SessionTokenExpiredError>()(
  "SessionTokenExpiredError",
  {
    sessionId: AuthSessionId,
    expiresAt: Schema.DateTimeUtc,
    observedAt: Schema.DateTimeUtc,
  },
) {
  override get message(): string {
    return "Session token expired.";
  }
}

export class UnknownSessionTokenError extends Schema.TaggedError<UnknownSessionTokenError>()(
  "UnknownSessionTokenError",
  {
    sessionId: AuthSessionId,
  },
) {
  override get message(): string {
    return "Unknown session token.";
  }
}

export class SessionTokenRevokedError extends Schema.TaggedError<SessionTokenRevokedError>()(
  "SessionTokenRevokedError",
  {
    sessionId: AuthSessionId,
    revokedAt: Schema.DateTimeUtc,
  },
) {
  override get message(): string {
    return "Session token revoked.";
  }
}

export class InvalidSessionExpirationClaimError extends Schema.TaggedError<InvalidSessionExpirationClaimError>()(
  "InvalidSessionExpirationClaimError",
  {
    sessionId: AuthSessionId,
    expirationClaim: Schema.Number,
  },
) {
  override get message(): string {
    return "Invalid `exp` claim";
  }
}

export class MalformedWebSocketTokenError extends Schema.TaggedError<MalformedWebSocketTokenError>()(
  "MalformedWebSocketTokenError",
  {},
) {
  override get message(): string {
    return "Malformed websocket token.";
  }
}

export class InvalidWebSocketTokenSignatureError extends Schema.TaggedError<InvalidWebSocketTokenSignatureError>()(
  "InvalidWebSocketTokenSignatureError",
  {},
) {
  override get message(): string {
    return "Invalid websocket token signature.";
  }
}

export class InvalidWebSocketTokenPayloadError extends Schema.TaggedError<InvalidWebSocketTokenPayloadError>()(
  "InvalidWebSocketTokenPayloadError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Invalid websocket token payload.";
  }
}

export class WebSocketTokenExpiredError extends Schema.TaggedError<WebSocketTokenExpiredError>()(
  "WebSocketTokenExpiredError",
  {
    sessionId: AuthSessionId,
    expiresAt: Schema.DateTimeUtc,
    observedAt: Schema.DateTimeUtc,
  },
) {
  override get message(): string {
    return "Websocket token expired.";
  }
}

export class UnknownWebSocketSessionError extends Schema.TaggedError<UnknownWebSocketSessionError>()(
  "UnknownWebSocketSessionError",
  {
    sessionId: AuthSessionId,
  },
) {
  override get message(): string {
    return "Unknown websocket session.";
  }
}

export class WebSocketSessionExpiredError extends Schema.TaggedError<WebSocketSessionExpiredError>()(
  "WebSocketSessionExpiredError",
  {
    sessionId: AuthSessionId,
    expiresAt: Schema.DateTimeUtc,
    observedAt: Schema.DateTimeUtc,
  },
) {
  override get message(): string {
    return "Websocket session expired.";
  }
}

export class WebSocketSessionRevokedError extends Schema.TaggedError<WebSocketSessionRevokedError>()(
  "WebSocketSessionRevokedError",
  {
    sessionId: AuthSessionId,
    revokedAt: Schema.DateTimeUtc,
  },
) {
  override get message(): string {
    return "Websocket session revoked.";
  }
}

export const SessionCredentialInvalidError = Schema.Union([
  MalformedSessionTokenError,
  InvalidSessionTokenSignatureError,
  InvalidSessionTokenPayloadError,
  SessionTokenExpiredError,
  UnknownSessionTokenError,
  SessionTokenRevokedError,
  InvalidSessionExpirationClaimError,
  MalformedWebSocketTokenError,
  InvalidWebSocketTokenSignatureError,
  InvalidWebSocketTokenPayloadError,
  WebSocketTokenExpiredError,
  UnknownWebSocketSessionError,
  WebSocketSessionExpiredError,
  WebSocketSessionRevokedError,
]);
export type SessionCredentialInvalidError = typeof SessionCredentialInvalidError.Type;
export const isSessionCredentialInvalidError = Schema.is(SessionCredentialInvalidError);

const sessionCredentialInternalErrorContext = {
  cause: Schema.Defect(),
};

export class SessionClaimsEncodingError extends Schema.TaggedError<SessionClaimsEncodingError>()(
  "SessionClaimsEncodingError",
  {
    sessionId: AuthSessionId,
    operation: Schema.Literals(["encode_session_claims", "encode_websocket_claims"]),
    ...sessionCredentialInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to encode claims";
  }
}

export class SessionCredentialIssueError extends Schema.TaggedError<SessionCredentialIssueError>()(
  "SessionCredentialIssueError",
  {
    sessionId: Schema.optional(AuthSessionId),
    ...sessionCredentialInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to issue session credential.";
  }
}

export class SessionCredentialVerificationError extends Schema.TaggedError<SessionCredentialVerificationError>()(
  "SessionCredentialVerificationError",
  {
    sessionId: AuthSessionId,
    ...sessionCredentialInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to verify session credential.";
  }
}

export class WebSocketTokenIssueError extends Schema.TaggedError<WebSocketTokenIssueError>()(
  "WebSocketTokenIssueError",
  {
    sessionId: AuthSessionId,
    ...sessionCredentialInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to issue websocket token.";
  }
}

export class WebSocketTokenVerificationError extends Schema.TaggedError<WebSocketTokenVerificationError>()(
  "WebSocketTokenVerificationError",
  {
    sessionId: AuthSessionId,
    ...sessionCredentialInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to verify websocket token.";
  }
}

export class ActiveSessionsListError extends Schema.TaggedError<ActiveSessionsListError>()(
  "ActiveSessionsListError",
  {
    ...sessionCredentialInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to list active sessions.";
  }
}

export class SessionRevocationError extends Schema.TaggedError<SessionRevocationError>()(
  "SessionRevocationError",
  {
    sessionId: AuthSessionId,
    ...sessionCredentialInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to revoke session.";
  }
}

export class OtherSessionsRevocationError extends Schema.TaggedError<OtherSessionsRevocationError>()(
  "OtherSessionsRevocationError",
  {
    currentSessionId: AuthSessionId,
    ...sessionCredentialInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to revoke other sessions.";
  }
}

export const SessionCredentialInternalError = Schema.Union([
  SessionClaimsEncodingError,
  SessionCredentialIssueError,
  SessionCredentialVerificationError,
  WebSocketTokenIssueError,
  WebSocketTokenVerificationError,
  ActiveSessionsListError,
  SessionRevocationError,
  OtherSessionsRevocationError,
]);
export type SessionCredentialInternalError = typeof SessionCredentialInternalError.Type;

export const SessionCredentialError = Schema.Union([
  SessionCredentialInvalidError,
  SessionCredentialInternalError,
]);
export type SessionCredentialError = typeof SessionCredentialError.Type;

export class SessionStore extends Context.Service<
  SessionStore,
  {
    readonly cookieName: string;
    readonly legacyCookieName: string | undefined;
    readonly issue: (input?: {
      readonly ttl?: Duration.Duration;
      readonly subject?: string;
      readonly method?: ServerAuthSessionMethod;
      readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
      readonly client?: AuthClientMetadata;
      readonly proofKeyThumbprint?: string;
      readonly runtimeModeCeiling?: RuntimeMode;
      /**
       * Atomically revoke active sessions with the same subject and method
       * before storing this session.
       */
      readonly replaceActiveForSubjectAndMethod?: boolean;
      /** Replace only this session, of the same method, in the issuance transaction. */
      readonly replaceSessionId?: AuthSessionId;
    }) => Effect.Effect<IssuedSession, SessionCredentialInternalError>;
    /**
     * Mints the single renewal successor of `previousSessionId`, recording the
     * lineage atomically. `None` when that session was already renewed (or was
     * revoked or expired meanwhile): a session never mints a second successor.
     */
    readonly issueRenewal: (
      previousSessionId: AuthSessionId,
      input: {
        readonly ttl: Duration.Duration;
        readonly subject: string;
        readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
        readonly client: AuthClientMetadata;
      },
    ) => Effect.Effect<Option.Option<IssuedSession>, SessionCredentialInternalError>;
    readonly verify: (token: string) => Effect.Effect<VerifiedSession, SessionCredentialError>;
    readonly issueWebSocketToken: (
      sessionId: AuthSessionId,
      input?: {
        readonly ttl?: Duration.Duration;
      },
    ) => Effect.Effect<
      {
        readonly token: string;
        readonly expiresAt: DateTime.DateTime;
      },
      SessionCredentialInternalError
    >;
    readonly verifyWebSocketToken: (
      token: string,
    ) => Effect.Effect<VerifiedSession, SessionCredentialError>;
    readonly listActive: () => Effect.Effect<
      ReadonlyArray<AuthClientSession>,
      SessionCredentialInternalError
    >;
    readonly streamChanges: Stream.Stream<SessionCredentialChange>;
    readonly awaitInvalidation: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<void, SessionCredentialVerificationError>;
    readonly revoke: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<boolean, SessionCredentialInternalError>;
    readonly revokeAllExcept: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<number, SessionCredentialInternalError>;
    /** Ids of every session in the renewal chain containing `sessionId`. */
    readonly listLineageIds: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<ReadonlyArray<AuthSessionId>, SessionCredentialInternalError>;
    readonly markConnected: (
      sessionId: AuthSessionId,
      client?: {
        readonly surface?: ClientSurface | undefined;
        readonly appVersion?: string | undefined;
      },
    ) => Effect.Effect<void, never>;
    readonly markDisconnected: (sessionId: AuthSessionId) => Effect.Effect<void, never>;
  }
>()("@awtprod/command-center/auth/SessionStore") {}

const SIGNING_SECRET_NAME = "server-signing-key";
export const DEFAULT_SESSION_TTL = Duration.days(30);
const DEFAULT_WEBSOCKET_TOKEN_TTL = Duration.minutes(5);

const SessionClaims = Schema.Struct({
  v: Schema.Literals([1, 2]),
  kind: Schema.Literal("session"),
  sid: AuthSessionId,
  sub: Schema.String,
  scopes: AuthEnvironmentScopes,
  method: Schema.Literals(["browser-session-cookie", "bearer-access-token", "dpop-access-token"]),
  jkt: Schema.optionalKey(Schema.String),
  rtc: Schema.optionalKey(RuntimeMode),
  iat: Schema.Number,
  exp: Schema.Number,
});
type SessionClaims = typeof SessionClaims.Type;

const WebSocketClaims = Schema.Struct({
  v: Schema.Literal(1),
  kind: Schema.Literal("websocket"),
  sid: AuthSessionId,
  iat: Schema.Number,
  exp: Schema.Number,
});
type WebSocketClaims = typeof WebSocketClaims.Type;

const decodeSessionClaims = Schema.decodeUnknownEffect(Schema.fromJsonString(SessionClaims));
const decodeWebSocketClaims = Schema.decodeUnknownEffect(Schema.fromJsonString(WebSocketClaims));

function createDefaultClientMetadata(): AuthClientMetadata {
  return {
    deviceType: "unknown",
  };
}

function toClientMetadata(record: {
  readonly label: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly deviceType: AuthClientMetadata["deviceType"];
  readonly os: string | null;
  readonly browser: string | null;
}): AuthClientMetadata {
  return {
    ...(record.label ? { label: record.label } : {}),
    ...(record.ipAddress ? { ipAddress: record.ipAddress } : {}),
    ...(record.userAgent ? { userAgent: record.userAgent } : {}),
    deviceType: record.deviceType,
    ...(record.os ? { os: record.os } : {}),
    ...(record.browser ? { browser: record.browser } : {}),
  };
}

function toAuthClientSession(input: Omit<AuthClientSession, "current">): AuthClientSession {
  return {
    ...input,
    current: false,
  };
}

/**
 * One Settings entry for a renewal chain: the newest live session, connected
 * when a client is still on any live session of the chain.
 */
function toCollapsedClientSession(
  newest: AuthSessions.AuthSessionRecord,
  chain: ReadonlyArray<AuthSessions.AuthSessionRecord>,
  connectedSessions: ReadonlyMap<AuthSessionId, number>,
): AuthClientSession {
  const lastConnectedAt = chain.reduce<DateTime.Utc | null>(
    (latest, row) =>
      row.lastConnectedAt !== null &&
      (latest === null || row.lastConnectedAt.epochMilliseconds > latest.epochMilliseconds)
        ? row.lastConnectedAt
        : latest,
    null,
  );
  return toAuthClientSession({
    sessionId: newest.sessionId,
    subject: newest.subject,
    scopes: newest.scopes,
    method: newest.method,
    client: toClientMetadata(newest.client),
    issuedAt: newest.issuedAt,
    expiresAt: newest.expiresAt,
    lastConnectedAt,
    connected: chain.some((row) => connectedSessions.has(row.sessionId)),
  });
}

/** Folds each renewal chain among the active rows into its newest session. */
function collapseRenewalChains(
  rows: ReadonlyArray<AuthSessions.AuthSessionRecord>,
  connectedSessions: ReadonlyMap<AuthSessionId, number>,
): ReadonlyArray<AuthClientSession> {
  const byId = new Map(rows.map((row) => [row.sessionId, row] as const));
  const renewedIds = new Set(
    rows.flatMap((row) =>
      row.renewedFromSessionId !== null && byId.has(row.renewedFromSessionId)
        ? [row.renewedFromSessionId]
        : [],
    ),
  );
  return rows
    .filter((row) => !renewedIds.has(row.sessionId))
    .map((newest) => {
      const chain = [newest];
      let previous = newest.renewedFromSessionId;
      while (previous !== null) {
        const row = byId.get(previous);
        if (row === undefined || chain.includes(row)) break;
        chain.push(row);
        previous = row.renewedFromSessionId;
      }
      return toCollapsedClientSession(newest, chain, connectedSessions);
    });
}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const authSessions = yield* AuthSessions.AuthSessionRepository;
  const signingSecret = yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32);
  const connectedSessionsRef = yield* Ref.make(new Map<AuthSessionId, number>());
  const changesPubSub = yield* PubSub.unbounded<SessionCredentialChange>();
  const cookieInput = {
    mode: serverConfig.mode,
    port: serverConfig.port,
    host: serverConfig.host,
    instanceKey: serverConfig.stateDir,
    environmentId: yield* serverEnvironment.getEnvironmentId,
    development: serverConfig.devUrl !== undefined,
  } as const;
  const cookieName = resolveSessionCookieName(cookieInput);
  const legacyCookieName = resolveLegacySessionCookieName(cookieInput);
  const devAuth = resolveReusableDevAuth(serverConfig);
  if (devAuth) {
    yield* authSessions
      .createIfAbsent({
        sessionId: devAuth.sessionId,
        subject: "reusable-dev-token",
        scopes: AuthAdministrativeScopes,
        method: "browser-session-cookie",
        client: {
          label: "Reusable dev token",
          ipAddress: null,
          userAgent: null,
          deviceType: "unknown",
          os: null,
          browser: null,
        },
        issuedAt: yield* DateTime.now,
        expiresAt: REUSABLE_DEV_SESSION_EXPIRES_AT,
      })
      .pipe(
        Effect.mapError(
          (cause) => new SessionCredentialIssueError({ sessionId: devAuth.sessionId, cause }),
        ),
      );
  }

  const emitUpsert = (clientSession: AuthClientSession) =>
    PubSub.publish(changesPubSub, {
      type: "clientUpserted",
      clientSession,
    }).pipe(Effect.asVoid);

  const emitRemoved = (sessionId: AuthSessionId) =>
    PubSub.publish(changesPubSub, {
      type: "clientRemoved",
      sessionId,
    }).pipe(Effect.asVoid);

  /**
   * The Settings entry for the renewal chain containing `sessionId`: its newest
   * live session, connected if a client is still on any live session of the
   * chain. `hiddenSessionIds` are the chain's older live sessions it stands for.
   */
  const resolveVisibleSession = (sessionId: AuthSessionId) =>
    Effect.gen(function* () {
      const lineage = yield* authSessions.listLineage({ sessionId });
      const connectedSessions = yield* Ref.get(connectedSessionsRef);
      const now = yield* DateTime.now;
      const live = lineage.filter(
        (row) =>
          row.revokedAt === null &&
          (connectedSessions.has(row.sessionId) ||
            row.expiresAt.epochMilliseconds > now.epochMilliseconds),
      );
      const newest = live.at(-1);
      if (newest === undefined) {
        return {
          visible: Option.none<AuthClientSession>(),
          hiddenSessionIds: [] as ReadonlyArray<AuthSessionId>,
        };
      }
      return {
        visible: Option.some(toCollapsedClientSession(newest, live, connectedSessions)),
        hiddenSessionIds: live
          .filter((row) => row.sessionId !== newest.sessionId)
          .map((row) => row.sessionId),
      };
    });

  const publishLineage = (
    sessionId: AuthSessionId,
    options?: { readonly removeIfGone?: boolean },
  ) =>
    resolveVisibleSession(sessionId).pipe(
      Effect.flatMap(({ visible, hiddenSessionIds }) =>
        Effect.gen(function* () {
          yield* Effect.forEach(hiddenSessionIds, emitRemoved, { discard: true });
          if (Option.isSome(visible)) {
            yield* emitUpsert(visible.value);
          } else if (options?.removeIfGone === true) {
            yield* emitRemoved(sessionId);
          }
        }),
      ),
    );

  const markConnected: SessionStore["Service"]["markConnected"] = (sessionId, client = {}) =>
    Ref.modify(connectedSessionsRef, (current) => {
      const next = new Map(current);
      const wasDisconnected = !next.has(sessionId);
      next.set(sessionId, (next.get(sessionId) ?? 0) + 1);
      return [wasDisconnected, next] as const;
    }).pipe(
      Effect.flatMap((wasDisconnected) =>
        wasDisconnected || client.surface !== undefined || client.appVersion !== undefined
          ? Effect.flatMap(
              wasDisconnected ? DateTime.now : Effect.succeed(null),
              (lastConnectedAt) =>
                authSessions
                  .setConnection({
                    sessionId,
                    lastConnectedAt,
                    surface: client.surface ?? null,
                    appVersion: client.appVersion ?? null,
                  })
                  .pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("Failed to persist connected-session auth update.").pipe(
                        Effect.annotateLogs({ sessionId, cause }),
                      ),
                    ),
                  ),
            )
          : Effect.void,
      ),
      Effect.flatMap(() => publishLineage(sessionId)),
      Effect.catchCause((cause) =>
        Effect.logError("Failed to publish connected-session auth update.").pipe(
          Effect.annotateLogs({
            sessionId,
            cause,
          }),
        ),
      ),
      Effect.withSpan("SessionStore.markConnected"),
    );

  const markDisconnected: SessionStore["Service"]["markDisconnected"] = (sessionId) =>
    Ref.update(connectedSessionsRef, (current) => {
      const next = new Map(current);
      const remaining = (next.get(sessionId) ?? 0) - 1;
      if (remaining > 0) {
        next.set(sessionId, remaining);
      } else {
        next.delete(sessionId);
      }
      return next;
    }).pipe(
      Effect.flatMap(() => publishLineage(sessionId, { removeIfGone: true })),
      Effect.catchCause((cause) =>
        Effect.logError("Failed to publish disconnected-session auth update.").pipe(
          Effect.annotateLogs({
            sessionId,
            cause,
          }),
        ),
      ),
      Effect.withSpan("SessionStore.markDisconnected"),
    );

  const encodeClaims = Schema.encodeEffect(Schema.fromJsonString(SessionClaims));
  const issue: SessionStore["Service"]["issue"] = Effect.fn("SessionStore.issue")(
    function* (input) {
      const sessionId = AuthSessionId.make(
        yield* crypto
          .randomUUIDv4()
          .pipe(Effect.mapError((cause) => new SessionCredentialIssueError({ cause }))),
      );
      const issuedAt = yield* DateTime.now;
      const expiresAt = DateTime.add(issuedAt, {
        milliseconds: Duration.toMillis(input?.ttl ?? DEFAULT_SESSION_TTL),
      });
      const claims: SessionClaims = {
        v: 1,
        kind: "session",
        sid: sessionId,
        sub: input?.subject ?? "browser",
        scopes: input?.scopes ?? AuthStandardClientScopes,
        method: input?.method ?? "browser-session-cookie",
        ...(input?.proofKeyThumbprint ? { jkt: input.proofKeyThumbprint } : {}),
        ...(input?.runtimeModeCeiling ? { rtc: input.runtimeModeCeiling } : {}),
        iat: issuedAt.epochMilliseconds,
        exp: expiresAt.epochMilliseconds,
      };

      const encodedPayload = yield* encodeClaims(claims).pipe(
        Effect.map(base64UrlEncode),
        Effect.mapError(
          (cause) =>
            new SessionCredentialIssueError({
              sessionId,
              cause: new SessionClaimsEncodingError({
                sessionId,
                operation: "encode_session_claims",
                cause,
              }),
            }),
        ),
      );
      const signature = signPayload(encodedPayload, signingSecret);
      const client = input?.client ?? createDefaultClientMetadata();
      const sessionRecord = {
        sessionId,
        subject: claims.sub,
        scopes: claims.scopes,
        method: claims.method,
        client: {
          label: client.label ?? null,
          ipAddress: client.ipAddress ?? null,
          userAgent: client.userAgent ?? null,
          deviceType: client.deviceType,
          os: client.os ?? null,
          browser: client.browser ?? null,
        },
        issuedAt,
        expiresAt,
      } satisfies AuthSessions.CreateAuthSessionInput;
      return {
        sessionRecord,
        claims,
        client,
        issued: {
          sessionId,
          token: `${encodedPayload}.${signature}`,
          method: claims.method,
          client,
          expiresAt,
          scopes: claims.scopes,
          ...(claims.jkt ? { proofKeyThumbprint: claims.jkt } : {}),
        } satisfies IssuedSession,
      };
    },
  );

  const issue: SessionStore["Service"]["issue"] = Effect.fn("SessionStore.issue")(
    function* (input) {
      const { sessionRecord, claims, client, issued } = yield* prepareSession(input);
      const { sessionId, issuedAt, expiresAt } = sessionRecord;
      const replacedSessionIds = yield* (
        input?.replaceSessionId !== undefined || input?.replaceActiveForSubjectAndMethod
          ? authSessions.createReplacingActive({
              session: sessionRecord,
              revokedAt: issuedAt,
              ...(input.replaceSessionId !== undefined
                ? { replaceSessionId: input.replaceSessionId }
                : {}),
            })
          : authSessions.create(sessionRecord).pipe(Effect.as([] as ReadonlyArray<AuthSessionId>))
      ).pipe(Effect.mapError((cause) => new SessionCredentialIssueError({ sessionId, cause })));
      if (replacedSessionIds.length > 0) {
        yield* Ref.update(connectedSessionsRef, (current) => {
          const next = new Map(current);
          for (const replacedSessionId of replacedSessionIds) {
            next.delete(replacedSessionId);
          }
          return next;
        });
        yield* Effect.forEach(replacedSessionIds, emitRemoved, {
          concurrency: "unbounded",
          discard: true,
        });
      }
      yield* emitUpsert(
        toAuthClientSession({
          sessionId,
          subject: claims.sub,
          scopes: claims.scopes,
          method: claims.method,
          client,
          issuedAt,
          expiresAt,
          lastConnectedAt: null,
          connected: false,
        }),
      );

      return issued;
    },
  );

  const issueRenewal: SessionStore["Service"]["issueRenewal"] = Effect.fn(
    "SessionStore.issueRenewal",
  )(function* (previousSessionId, input) {
    const { sessionRecord, issued } = yield* prepareSession({
      ...input,
      method: "bearer-access-token",
    });
    const stored = yield* authSessions
      .createRenewal({ previousSessionId, session: sessionRecord })
      .pipe(
        Effect.mapError(
          (cause) => new SessionCredentialIssueError({ sessionId: issued.sessionId, cause }),
        ),
      );
    if (!stored) {
      return Option.none<IssuedSession>();
    }
    // Settings shows a renewal chain as one entry: the successor, carrying the
    // connection state of a client still on the previous token. Publishing the
    // lineage removes the previous entry and upserts the successor.
    yield* publishLineage(issued.sessionId).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Failed to publish renewed-session auth update.").pipe(
          Effect.annotateLogs({ sessionId: issued.sessionId, cause }),
        ),
      ),
    );
    return Option.some(issued);
  });

  const verify: SessionStore["Service"]["verify"] = Effect.fn("SessionStore.verify")(
    function* (token) {
      if (devAuth?.matches(token)) {
        const row = yield* authSessions
          .getById({ sessionId: devAuth.sessionId })
          .pipe(
            Effect.mapError(
              (cause) =>
                new SessionCredentialVerificationError({ sessionId: devAuth.sessionId, cause }),
            ),
          );
        if (Option.isNone(row)) {
          return yield* new UnknownSessionTokenError({ sessionId: devAuth.sessionId });
        }
        if (row.value.revokedAt !== null) {
          return yield* new SessionTokenRevokedError({
            sessionId: devAuth.sessionId,
            revokedAt: row.value.revokedAt,
          });
        }
        const observedAt = yield* DateTime.now;
        if (row.value.expiresAt.epochMilliseconds <= observedAt.epochMilliseconds) {
          return yield* new SessionTokenExpiredError({
            sessionId: devAuth.sessionId,
            expiresAt: row.value.expiresAt,
            observedAt,
          });
        }
        return {
          sessionId: row.value.sessionId,
          token,
          method: row.value.method,
          client: toClientMetadata(row.value.client),
          expiresAt: row.value.expiresAt,
          issuedAt: row.value.issuedAt,
          subject: row.value.subject,
          scopes: row.value.scopes,
        } satisfies VerifiedSession;
      }
      const [encodedPayload, signature] = token.split(".");
      if (!encodedPayload || !signature) {
        return yield* new MalformedSessionTokenError({});
      }

      const expectedSignature = signPayload(encodedPayload, signingSecret);
      if (!timingSafeEqualBase64Url(signature, expectedSignature)) {
        return yield* new InvalidSessionTokenSignatureError({});
      }

      const claims = yield* decodeSessionClaims(base64UrlDecodeUtf8(encodedPayload)).pipe(
        Effect.mapError((cause) => new InvalidSessionTokenPayloadError({ cause })),
      );

      const observedAt = yield* DateTime.now;
      const expiresAt = DateTime.make(claims.exp);
      if (Option.isNone(expiresAt)) {
        return yield* new InvalidSessionExpirationClaimError({
          sessionId: claims.sid,
          expirationClaim: claims.exp,
        });
      }
      if (claims.exp <= observedAt.epochMilliseconds) {
        return yield* new SessionTokenExpiredError({
          sessionId: claims.sid,
          expiresAt: expiresAt.value,
          observedAt,
        });
      }

      const row = yield* authSessions
        .getById({ sessionId: claims.sid })
        .pipe(
          Effect.mapError(
            (cause) => new SessionCredentialVerificationError({ sessionId: claims.sid, cause }),
          ),
        );
      if (Option.isNone(row)) {
        return yield* new UnknownSessionTokenError({ sessionId: claims.sid });
      }
      if (row.value.revokedAt !== null) {
        return yield* new SessionTokenRevokedError({
          sessionId: claims.sid,
          revokedAt: row.value.revokedAt,
        });
      }

      return {
        sessionId: claims.sid,
        token,
        method: claims.method,
        client: toClientMetadata(row.value.client),
        expiresAt: expiresAt.value,
        issuedAt: row.value.issuedAt,
        subject: claims.sub,
        scopes: claims.scopes,
        ...(claims.jkt ? { proofKeyThumbprint: claims.jkt } : {}),
        ...(claims.rtc ? { runtimeModeCeiling: claims.rtc } : {}),
      } satisfies VerifiedSession;
    },
  );

  const encodeWsClaims = Schema.encodeEffect(Schema.fromJsonString(WebSocketClaims));
  const issueWebSocketToken: SessionStore["Service"]["issueWebSocketToken"] = Effect.fn(
    "SessionStore.issueWebSocketToken",
  )(function* (sessionId, input) {
    const issuedAt = yield* DateTime.now;
    const expiresAt = DateTime.add(issuedAt, {
      milliseconds: Duration.toMillis(input?.ttl ?? DEFAULT_WEBSOCKET_TOKEN_TTL),
    });
    const claims: WebSocketClaims = {
      v: 1,
      kind: "websocket",
      sid: sessionId,
      iat: issuedAt.epochMilliseconds,
      exp: expiresAt.epochMilliseconds,
    };
    const encodedPayload = yield* encodeWsClaims(claims).pipe(
      Effect.map(base64UrlEncode),
      Effect.mapError(
        (cause) =>
          new WebSocketTokenIssueError({
            sessionId,
            cause: new SessionClaimsEncodingError({
              sessionId,
              operation: "encode_websocket_claims",
              cause,
            }),
          }),
      ),
    );
    const signature = signPayload(encodedPayload, signingSecret);
    return {
      token: `${encodedPayload}.${signature}`,
      expiresAt,
    };
  });

  const verifyWebSocketToken: SessionStore["Service"]["verifyWebSocketToken"] = Effect.fn(
    "SessionStore.verifyWebSocketToken",
  )(function* (token) {
    const [encodedPayload, signature] = token.split(".");
    if (!encodedPayload || !signature) {
      return yield* new MalformedWebSocketTokenError({});
    }

    const expectedSignature = signPayload(encodedPayload, signingSecret);
    if (!timingSafeEqualBase64Url(signature, expectedSignature)) {
      return yield* new InvalidWebSocketTokenSignatureError({});
    }

    const claims = yield* decodeWebSocketClaims(base64UrlDecodeUtf8(encodedPayload)).pipe(
      Effect.mapError((cause) => new InvalidWebSocketTokenPayloadError({ cause })),
    );
    if (claims.sid.startsWith(REUSABLE_DEV_SESSION_PREFIX) && claims.sid !== devAuth?.sessionId) {
      return yield* new UnknownWebSocketSessionError({ sessionId: claims.sid });
    }

    const observedAt = yield* DateTime.now;
    const expiresAt = DateTime.make(claims.exp);
    if (Option.isNone(expiresAt)) {
      return yield* new InvalidSessionExpirationClaimError({
        sessionId: claims.sid,
        expirationClaim: claims.exp,
      });
    }
    if (claims.exp <= observedAt.epochMilliseconds) {
      return yield* new WebSocketTokenExpiredError({
        sessionId: claims.sid,
        expiresAt: expiresAt.value,
        observedAt,
      });
    }

    const row = yield* authSessions
      .getById({ sessionId: claims.sid })
      .pipe(
        Effect.mapError(
          (cause) => new WebSocketTokenVerificationError({ sessionId: claims.sid, cause }),
        ),
      );
    if (Option.isNone(row)) {
      return yield* new UnknownWebSocketSessionError({ sessionId: claims.sid });
    }
    if (row.value.expiresAt.epochMilliseconds <= observedAt.epochMilliseconds) {
      return yield* new WebSocketSessionExpiredError({
        sessionId: claims.sid,
        expiresAt: row.value.expiresAt,
        observedAt,
      });
    }
    if (row.value.revokedAt !== null) {
      return yield* new WebSocketSessionRevokedError({
        sessionId: claims.sid,
        revokedAt: row.value.revokedAt,
      });
    }

    return {
      sessionId: row.value.sessionId,
      token,
      method: row.value.method,
      client: toClientMetadata(row.value.client),
      expiresAt: row.value.expiresAt,
      subject: row.value.subject,
      scopes: row.value.scopes,
    } satisfies VerifiedSession;
  });

  const listActive: SessionStore["Service"]["listActive"] = Effect.fn("SessionStore.listActive")(
    function* () {
      const now = yield* DateTime.now;
      const connectedSessions = yield* Ref.get(connectedSessionsRef);
      const rows = yield* authSessions.listActive({
        now,
        connectedSessionIds: Array.from(connectedSessions.keys()),
      });

      return collapseRenewalChains(rows, connectedSessions);
    },
    Effect.mapError((cause) => new ActiveSessionsListError({ cause })),
  );

  const revoke: SessionStore["Service"]["revoke"] = Effect.fn("SessionStore.revoke")(
    function* (sessionId) {
      const revokedAt = yield* DateTime.now;
      // Revoking any session of a renewal chain revokes the whole chain, so a
      // renewed credential cannot outlive the revocation of its predecessor.
      const revokedSessionIds = yield* authSessions
        .revoke({
          sessionId,
          revokedAt,
        })
        .pipe(Effect.mapError((cause) => new SessionRevocationError({ sessionId, cause })));
      if (revokedSessionIds.length > 0) {
        yield* Ref.update(connectedSessionsRef, (current) => {
          const next = new Map(current);
          for (const revokedSessionId of revokedSessionIds) {
            next.delete(revokedSessionId);
          }
          return next;
        });
        yield* Effect.forEach(revokedSessionIds, emitRemoved, { discard: true });
      }
      return revokedSessionIds.length > 0;
    },
  );

  const listLineageIds: SessionStore["Service"]["listLineageIds"] = (sessionId) =>
    authSessions.listLineage({ sessionId }).pipe(
      Effect.map((rows) => rows.map((row) => row.sessionId)),
      Effect.mapError((cause) => new ActiveSessionsListError({ cause })),
      Effect.withSpan("SessionStore.listLineageIds"),
    );

  const revokeAllExcept: SessionStore["Service"]["revokeAllExcept"] = Effect.fn(
    "SessionStore.revokeAllExcept",
  )(function* (sessionId) {
    const revokedAt = yield* DateTime.now;
    const revokedSessionIds = yield* authSessions
      .revokeAllExcept({
        currentSessionId: sessionId,
        revokedAt,
      })
      .pipe(
        Effect.mapError(
          (cause) => new OtherSessionsRevocationError({ currentSessionId: sessionId, cause }),
        ),
      );
    if (revokedSessionIds.length > 0) {
      yield* Ref.update(connectedSessionsRef, (current) => {
        const next = new Map(current);
        for (const revokedSessionId of revokedSessionIds) {
          next.delete(revokedSessionId);
        }
        return next;
      });
      yield* Effect.forEach(
        revokedSessionIds,
        (revokedSessionId) => emitRemoved(revokedSessionId),
        {
          concurrency: "unbounded",
          discard: true,
        },
      );
    }
    return revokedSessionIds.length;
  });

  const awaitInvalidation = Effect.fn(function* (sessionId: AuthSessionId) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        // Subscribe before reading: revocation can race with the WebSocket upgrade.
        const subscription = yield* PubSub.subscribe(changesPubSub);
        const row = yield* authSessions
          .getById({ sessionId })
          .pipe(
            Effect.mapError(
              (cause) => new SessionCredentialVerificationError({ sessionId, cause }),
            ),
          );
        if (Option.isNone(row) || row.value.revokedAt !== null) return;
        const now = yield* DateTime.now;
        const remaining = row.value.expiresAt.epochMilliseconds - now.epochMilliseconds;
        if (remaining <= 0) return;
        yield* Effect.raceFirst(
          Stream.fromSubscription(subscription).pipe(
            Stream.filter(
              (change) => change.type === "clientRemoved" && change.sessionId === sessionId,
            ),
            Stream.runHead,
          ),
          Effect.sleep(Duration.millis(remaining)),
        );
      }),
    );
  });

  return SessionStore.of({
    cookieName,
    legacyCookieName,
    issue,
    issueRenewal,
    verify,
    issueWebSocketToken,
    verifyWebSocketToken,
    listActive,
    awaitInvalidation,
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
    revoke,
    revokeAllExcept,
    listLineageIds,
    markConnected,
    markDisconnected,
  });
});

export const layer = Layer.effect(SessionStore, make).pipe(Layer.provideMerge(AuthSessions.layer));
