import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import {
  AuthClientMetadataDeviceType,
  AuthEnvironmentScopes,
  AuthSessionId,
  ClientSurface,
  ServerAuthSessionMethod,
} from "@t3tools/contracts";

import {
  type AuthSessionRepositoryError,
  PersistenceDecodeError,
  type PersistenceErrorCorrelation,
  PersistenceSqlError,
} from "./Errors.ts";

export const AuthSessionClientMetadataRecord = Schema.Struct({
  label: Schema.NullOr(Schema.String),
  ipAddress: Schema.NullOr(Schema.String),
  userAgent: Schema.NullOr(Schema.String),
  deviceType: AuthClientMetadataDeviceType,
  os: Schema.NullOr(Schema.String),
  browser: Schema.NullOr(Schema.String),
});
export type AuthSessionClientMetadataRecord = typeof AuthSessionClientMetadataRecord.Type;

export const AuthSessionRecord = Schema.Struct({
  sessionId: AuthSessionId,
  subject: Schema.String,
  scopes: AuthEnvironmentScopes,
  method: ServerAuthSessionMethod,
  client: AuthSessionClientMetadataRecord,
  issuedAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  lastConnectedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  revokedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  /** The session this one renewed, if it was minted by bearer renewal. */
  renewedFromSessionId: Schema.NullOr(AuthSessionId),
  /** When this session minted its (single) renewal successor. */
  renewedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
export type AuthSessionRecord = typeof AuthSessionRecord.Type;

export const CreateAuthSessionInput = Schema.Struct({
  sessionId: AuthSessionId,
  subject: Schema.String,
  scopes: AuthEnvironmentScopes,
  method: ServerAuthSessionMethod,
  client: AuthSessionClientMetadataRecord,
  issuedAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  renewedFromSessionId: Schema.optionalKey(AuthSessionId),
});
export type CreateAuthSessionInput = typeof CreateAuthSessionInput.Type;

export const CreateRenewalAuthSessionInput = Schema.Struct({
  previousSessionId: AuthSessionId,
  session: CreateAuthSessionInput,
});
export type CreateRenewalAuthSessionInput = typeof CreateRenewalAuthSessionInput.Type;

export const CreateReplacingActiveAuthSessionInput = Schema.Struct({
  session: CreateAuthSessionInput,
  revokedAt: Schema.DateTimeUtcFromString,
  replaceSessionId: Schema.optionalKey(AuthSessionId),
});
export type CreateReplacingActiveAuthSessionInput =
  typeof CreateReplacingActiveAuthSessionInput.Type;

export const GetAuthSessionByIdInput = Schema.Struct({
  sessionId: AuthSessionId,
});
export type GetAuthSessionByIdInput = typeof GetAuthSessionByIdInput.Type;

export const ListAuthSessionLineageInput = Schema.Struct({
  sessionId: AuthSessionId,
});
export type ListAuthSessionLineageInput = typeof ListAuthSessionLineageInput.Type;

export const ListActiveAuthSessionsInput = Schema.Struct({
  now: Schema.DateTimeUtcFromString,
  connectedSessionIds: Schema.optionalKey(Schema.Array(AuthSessionId)),
});
export type ListActiveAuthSessionsInput = typeof ListActiveAuthSessionsInput.Type;

export const RevokeAuthSessionInput = Schema.Struct({
  sessionId: AuthSessionId,
  revokedAt: Schema.DateTimeUtcFromString,
});
export type RevokeAuthSessionInput = typeof RevokeAuthSessionInput.Type;

export const RevokeOtherAuthSessionsInput = Schema.Struct({
  currentSessionId: AuthSessionId,
  revokedAt: Schema.DateTimeUtcFromString,
});
export type RevokeOtherAuthSessionsInput = typeof RevokeOtherAuthSessionsInput.Type;

export const SetAuthSessionConnectionInput = Schema.Struct({
  sessionId: AuthSessionId,
  lastConnectedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  surface: Schema.NullOr(ClientSurface),
  appVersion: Schema.NullOr(Schema.String),
});
export type SetAuthSessionConnectionInput = typeof SetAuthSessionConnectionInput.Type;

export class AuthSessionRepository extends Context.Service<
  AuthSessionRepository,
  {
    readonly create: (
      input: CreateAuthSessionInput,
    ) => Effect.Effect<void, AuthSessionRepositoryError>;
    readonly createReplacingActive: (
      input: CreateReplacingActiveAuthSessionInput,
    ) => Effect.Effect<ReadonlyArray<AuthSessionId>, AuthSessionRepositoryError>;
    readonly createIfAbsent: (
      input: CreateAuthSessionInput,
    ) => Effect.Effect<void, AuthSessionRepositoryError>;
    /**
     * Atomically marks `previousSessionId` as renewed and stores its successor.
     * Returns false, storing nothing, when the previous session was already
     * renewed, revoked, or expired: a session mints at most one successor.
     */
    readonly createRenewal: (
      input: CreateRenewalAuthSessionInput,
    ) => Effect.Effect<boolean, AuthSessionRepositoryError>;
    /** Every session in the renewal chain containing `sessionId`, itself included. */
    readonly listLineage: (
      input: ListAuthSessionLineageInput,
    ) => Effect.Effect<ReadonlyArray<AuthSessionRecord>, AuthSessionRepositoryError>;
    readonly getById: (
      input: GetAuthSessionByIdInput,
    ) => Effect.Effect<Option.Option<AuthSessionRecord>, AuthSessionRepositoryError>;
    readonly listActive: (
      input: ListActiveAuthSessionsInput,
    ) => Effect.Effect<ReadonlyArray<AuthSessionRecord>, AuthSessionRepositoryError>;
    /** Revokes the session and its whole renewal chain; returns the ids revoked now. */
    readonly revoke: (
      input: RevokeAuthSessionInput,
    ) => Effect.Effect<ReadonlyArray<AuthSessionId>, AuthSessionRepositoryError>;
    /** Spares the current session's renewal chain. */
    readonly revokeAllExcept: (
      input: RevokeOtherAuthSessionsInput,
    ) => Effect.Effect<ReadonlyArray<AuthSessionId>, AuthSessionRepositoryError>;
    readonly setConnection: (
      input: SetAuthSessionConnectionInput,
    ) => Effect.Effect<void, AuthSessionRepositoryError>;
  }
>()("@awtprod/command-center/persistence/AuthSessions/AuthSessionRepository") {}

const AuthSessionDbRow = Schema.Struct({
  sessionId: AuthSessionId,
  subject: Schema.String,
  scopes: Schema.fromJsonString(AuthEnvironmentScopes),
  method: ServerAuthSessionMethod,
  clientLabel: Schema.NullOr(Schema.String),
  clientIpAddress: Schema.NullOr(Schema.String),
  clientUserAgent: Schema.NullOr(Schema.String),
  clientDeviceType: Schema.Literals(["desktop", "mobile", "tablet", "bot", "unknown"]),
  clientOs: Schema.NullOr(Schema.String),
  clientBrowser: Schema.NullOr(Schema.String),
  issuedAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  lastConnectedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  revokedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  renewedFromSessionId: Schema.NullOr(AuthSessionId),
  renewedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});

const AuthSessionRawDbRow = Schema.Struct({
  sessionId: Schema.String,
  subject: Schema.Unknown,
  scopes: Schema.Unknown,
  method: Schema.Unknown,
  clientLabel: Schema.Unknown,
  clientIpAddress: Schema.Unknown,
  clientUserAgent: Schema.Unknown,
  clientDeviceType: Schema.Unknown,
  clientOs: Schema.Unknown,
  clientBrowser: Schema.Unknown,
  issuedAt: Schema.Unknown,
  expiresAt: Schema.Unknown,
  lastConnectedAt: Schema.Unknown,
  revokedAt: Schema.Unknown,
  renewedFromSessionId: Schema.Unknown,
  renewedAt: Schema.Unknown,
});

const decodeAuthSessionDbRow = Schema.decodeUnknownEffect(AuthSessionDbRow);

function toAuthSessionRecord(row: typeof AuthSessionDbRow.Type): AuthSessionRecord {
  return {
    sessionId: row.sessionId,
    subject: row.subject,
    scopes: row.scopes,
    method: row.method,
    client: {
      label: row.clientLabel,
      ipAddress: row.clientIpAddress,
      userAgent: row.clientUserAgent,
      deviceType: row.clientDeviceType,
      os: row.clientOs,
      browser: row.clientBrowser,
    },
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    lastConnectedAt: row.lastConnectedAt,
    revokedAt: row.revokedAt,
    renewedFromSessionId: row.renewedFromSessionId,
    renewedAt: row.renewedAt,
  };
}

function toPersistenceSqlOrDecodeError(
  sqlOperation: string,
  decodeOperation: string,
  correlation?: PersistenceErrorCorrelation,
) {
  return (cause: unknown): AuthSessionRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause, correlation)
      : new PersistenceSqlError({
          operation: sqlOperation,
          ...(correlation === undefined ? {} : { correlation }),
          cause,
        });
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertSessionRow = (ignoreExisting: boolean) =>
    SqlSchema.void({
      Request: CreateAuthSessionInput,
      execute: (input) =>
        sql`
        INSERT INTO auth_sessions (
          session_id,
          subject,
          scopes,
          method,
          client_label,
          client_ip_address,
          client_user_agent,
          client_device_type,
          client_os,
          client_browser,
          issued_at,
          expires_at,
          revoked_at,
          renewed_from_session_id
        )
        VALUES (
          ${input.sessionId},
          ${input.subject},
          ${JSON.stringify(input.scopes)},
          ${input.method},
          ${input.client.label},
          ${input.client.ipAddress},
          ${input.client.userAgent},
          ${input.client.deviceType},
          ${input.client.os},
          ${input.client.browser},
          ${input.issuedAt},
          ${input.expiresAt},
          NULL,
          ${input.renewedFromSessionId ?? null}
        )
        ${ignoreExisting ? sql`ON CONFLICT(session_id) DO NOTHING` : sql``}
      `,
    });
  const createSessionRow = insertSessionRow(false);
  const createSessionRowIfAbsent = insertSessionRow(true);

  const getSessionRowById = SqlSchema.findOneOption({
    Request: GetAuthSessionByIdInput,
    Result: AuthSessionRawDbRow,
    execute: ({ sessionId }) =>
      sql`
        SELECT
          session_id AS "sessionId",
          subject AS "subject",
          scopes AS "scopes",
          method AS "method",
          client_label AS "clientLabel",
          client_ip_address AS "clientIpAddress",
          client_user_agent AS "clientUserAgent",
          client_device_type AS "clientDeviceType",
          client_os AS "clientOs",
          client_browser AS "clientBrowser",
          issued_at AS "issuedAt",
          expires_at AS "expiresAt",
          last_connected_at AS "lastConnectedAt",
          revoked_at AS "revokedAt",
          renewed_from_session_id AS "renewedFromSessionId",
          renewed_at AS "renewedAt"
        FROM auth_sessions
        WHERE session_id = ${sessionId}
      `,
  });

  // Renewal chains are linear (one successor per session), so walking up to the
  // root and then down from every ancestor yields exactly the chain.
  const lineageIds = (sessionId: string) => sql`
    WITH RECURSIVE
      lineage_ancestors(id) AS (
        SELECT ${sessionId}
        UNION
        SELECT parent.renewed_from_session_id
        FROM auth_sessions parent
        JOIN lineage_ancestors ON parent.session_id = lineage_ancestors.id
        WHERE parent.renewed_from_session_id IS NOT NULL
      ),
      lineage(id) AS (
        SELECT id FROM lineage_ancestors
        UNION
        SELECT child.session_id
        FROM auth_sessions child
        JOIN lineage ON child.renewed_from_session_id = lineage.id
      )
    SELECT id FROM lineage
  `;

  const listLineageRows = SqlSchema.findAll({
    Request: ListAuthSessionLineageInput,
    Result: AuthSessionRawDbRow,
    execute: ({ sessionId }) =>
      sql`
        SELECT
          session_id AS "sessionId",
          subject AS "subject",
          scopes AS "scopes",
          method AS "method",
          client_label AS "clientLabel",
          client_ip_address AS "clientIpAddress",
          client_user_agent AS "clientUserAgent",
          client_device_type AS "clientDeviceType",
          client_os AS "clientOs",
          client_browser AS "clientBrowser",
          issued_at AS "issuedAt",
          expires_at AS "expiresAt",
          last_connected_at AS "lastConnectedAt",
          revoked_at AS "revokedAt",
          renewed_from_session_id AS "renewedFromSessionId",
          renewed_at AS "renewedAt"
        FROM auth_sessions
        WHERE session_id IN (${lineageIds(sessionId)})
        ORDER BY issued_at ASC, session_id ASC
      `,
  });

  // The conditional update is the single-use gate: only one caller can flip
  // `renewed_at` from NULL, and the successor is inserted in the same
  // transaction. The unique index on renewed_from_session_id backs it up.
  const markSessionRenewed = SqlSchema.findAll({
    Request: Schema.Struct({
      sessionId: AuthSessionId,
      renewedAt: Schema.DateTimeUtcFromString,
    }),
    Result: Schema.Struct({ sessionId: AuthSessionId }),
    execute: ({ sessionId, renewedAt }) =>
      sql`
        UPDATE auth_sessions
        SET renewed_at = ${renewedAt}
        WHERE session_id = ${sessionId}
          AND renewed_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > ${renewedAt}
        RETURNING session_id AS "sessionId"
      `,
  });

  const revokeActiveSessionsForReplacement = SqlSchema.findAll({
    Request: CreateReplacingActiveAuthSessionInput,
    Result: Schema.Struct({ sessionId: AuthSessionId }),
    execute: ({ session, revokedAt, replaceSessionId }) =>
      sql`
        UPDATE auth_sessions
        SET revoked_at = ${revokedAt}
        WHERE ${
          replaceSessionId === undefined
            ? sql`subject = ${session.subject}`
            : sql`session_id = ${replaceSessionId}`
        }
          AND method = ${session.method}
          AND revoked_at IS NULL
          AND expires_at > ${revokedAt}
        RETURNING session_id AS "sessionId"
      `,
  });

  const listActiveSessionRows = SqlSchema.findAll({
    Request: ListActiveAuthSessionsInput,
    Result: AuthSessionRawDbRow,
    execute: ({ now, connectedSessionIds = [] }) =>
      sql`
        SELECT
          session_id AS "sessionId",
          subject AS "subject",
          scopes AS "scopes",
          method AS "method",
          client_label AS "clientLabel",
          client_ip_address AS "clientIpAddress",
          client_user_agent AS "clientUserAgent",
          client_device_type AS "clientDeviceType",
          client_os AS "clientOs",
          client_browser AS "clientBrowser",
          issued_at AS "issuedAt",
          expires_at AS "expiresAt",
          last_connected_at AS "lastConnectedAt",
          revoked_at AS "revokedAt",
          renewed_from_session_id AS "renewedFromSessionId",
          renewed_at AS "renewedAt"
        FROM auth_sessions
        WHERE revoked_at IS NULL
          AND (expires_at > ${now} OR ${sql.in("session_id", connectedSessionIds)})
        ORDER BY issued_at DESC, session_id DESC
      `,
  });

  // COALESCE preserves the first-connect timestamp on concurrent connections
  // and metadata fields omitted by partial reports.
  const setConnectionRow = SqlSchema.void({
    Request: SetAuthSessionConnectionInput,
    execute: ({ sessionId, lastConnectedAt, surface, appVersion }) =>
      sql`
        UPDATE auth_sessions
        SET last_connected_at = COALESCE(${lastConnectedAt}, last_connected_at),
            client_surface = COALESCE(${surface}, client_surface),
            client_app_version = COALESCE(${appVersion}, client_app_version)
        WHERE session_id = ${sessionId}
          AND revoked_at IS NULL
      `,
  });

  const revokeSessionRows = SqlSchema.findAll({
    Request: RevokeAuthSessionInput,
    Result: Schema.Struct({ sessionId: AuthSessionId }),
    execute: ({ sessionId, revokedAt }) =>
      sql`
        UPDATE auth_sessions
        SET revoked_at = ${revokedAt}
        WHERE session_id IN (${lineageIds(sessionId)})
          AND revoked_at IS NULL
        RETURNING session_id AS "sessionId"
      `,
  });

  const revokeOtherSessionRows = SqlSchema.findAll({
    Request: RevokeOtherAuthSessionsInput,
    Result: Schema.Struct({ sessionId: AuthSessionId }),
    execute: ({ currentSessionId, revokedAt }) =>
      sql`
        UPDATE auth_sessions
        SET revoked_at = ${revokedAt}
        WHERE session_id NOT IN (${lineageIds(currentSessionId)})
          AND revoked_at IS NULL
        RETURNING session_id AS "sessionId"
      `,
  });

  const create: AuthSessionRepository["Service"]["create"] = (input) =>
    createSessionRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.create:query",
          "AuthSessionRepository.create:encodeRequest",
          { sessionId: input.sessionId },
        ),
      ),
    );

  const createReplacingActive: AuthSessionRepository["Service"]["createReplacingActive"] = (
    input,
  ) =>
    sql
      .withTransaction(
        revokeActiveSessionsForReplacement(input).pipe(
          Effect.flatMap((revokedRows) =>
            createSessionRow(input.session).pipe(
              Effect.as(revokedRows.map((row) => row.sessionId)),
            ),
          ),
        ),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "AuthSessionRepository.createReplacingActive:query",
            "AuthSessionRepository.createReplacingActive:encodeRequest",
            { sessionId: input.session.sessionId },
          ),
        ),
      );

  const createIfAbsent: AuthSessionRepository["Service"]["createIfAbsent"] = (input) =>
    createSessionRowIfAbsent(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.createIfAbsent:query",
          "AuthSessionRepository.createIfAbsent:encodeRequest",
          { sessionId: input.sessionId },
        ),
      ),
    );

  const createRenewal: AuthSessionRepository["Service"]["createRenewal"] = (input) =>
    sql
      .withTransaction(
        markSessionRenewed({
          sessionId: input.previousSessionId,
          renewedAt: input.session.issuedAt,
        }).pipe(
          Effect.flatMap((marked) =>
            marked.length === 0
              ? Effect.succeed(false)
              : createSessionRow({
                  ...input.session,
                  renewedFromSessionId: input.previousSessionId,
                }).pipe(Effect.as(true)),
          ),
        ),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "AuthSessionRepository.createRenewal:query",
            "AuthSessionRepository.createRenewal:encodeRequest",
            { sessionId: input.session.sessionId },
          ),
        ),
      );

  const listLineage: AuthSessionRepository["Service"]["listLineage"] = (input) =>
    listLineageRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.listLineage:query",
          "AuthSessionRepository.listLineage:decodeRows",
          { sessionId: input.sessionId },
        ),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodeAuthSessionDbRow(row).pipe(
            Effect.mapError((cause) =>
              PersistenceDecodeError.fromSchemaError(
                "AuthSessionRepository.listLineage:decodeRows",
                cause,
                { sessionId: row.sessionId },
              ),
            ),
            Effect.map(toAuthSessionRecord),
          ),
        ),
      ),
    );

  const getById: AuthSessionRepository["Service"]["getById"] = (input) =>
    getSessionRowById(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.getById:query",
          "AuthSessionRepository.getById:decodeRow",
          { sessionId: input.sessionId },
        ),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeedNone,
          onSome: (row) =>
            decodeAuthSessionDbRow(row).pipe(
              Effect.mapError((cause) =>
                PersistenceDecodeError.fromSchemaError(
                  "AuthSessionRepository.getById:decodeRow",
                  cause,
                  { sessionId: input.sessionId },
                ),
              ),
              Effect.map((decodedRow) => Option.some(toAuthSessionRecord(decodedRow))),
            ),
        }),
      ),
    );

  const listActive: AuthSessionRepository["Service"]["listActive"] = (input) =>
    listActiveSessionRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.listActive:query",
          "AuthSessionRepository.listActive:decodeRows",
        ),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodeAuthSessionDbRow(row).pipe(
            Effect.mapError((cause) =>
              PersistenceDecodeError.fromSchemaError(
                "AuthSessionRepository.listActive:decodeRows",
                cause,
                { sessionId: row.sessionId },
              ),
            ),
            Effect.map(toAuthSessionRecord),
          ),
        ),
      ),
    );

  const revoke: AuthSessionRepository["Service"]["revoke"] = (input) =>
    revokeSessionRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.revoke:query",
          "AuthSessionRepository.revoke:decodeRows",
          { sessionId: input.sessionId },
        ),
      ),
      Effect.map((rows) => rows.map((row) => row.sessionId)),
    );

  const revokeAllExcept: AuthSessionRepository["Service"]["revokeAllExcept"] = (input) =>
    revokeOtherSessionRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.revokeAllExcept:query",
          "AuthSessionRepository.revokeAllExcept:decodeRows",
          { currentSessionId: input.currentSessionId },
        ),
      ),
      Effect.map((rows) => rows.map((row) => row.sessionId)),
    );

  const setConnection: AuthSessionRepository["Service"]["setConnection"] = (input) =>
    setConnectionRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.setConnection:query",
          "AuthSessionRepository.setConnection:encodeRequest",
          { sessionId: input.sessionId },
        ),
      ),
    );

  return {
    create,
    createReplacingActive,
    createIfAbsent,
    createRenewal,
    listLineage,
    getById,
    listActive,
    revoke,
    revokeAllExcept,
    setConnection,
  } satisfies AuthSessionRepository["Service"];
});

export const layer = Layer.effect(AuthSessionRepository, make);
