import {
  CommandCenterError,
  type CommandCenterPublishConnection,
  type CommandCenterPublishConnectionRemoveInput,
  type CommandCenterPublishConnectionSetupBeginInput,
  type CommandCenterPublishConnectionSetupBeginResult,
  type CommandCenterPublishConnectionSetupCompleteInput,
  type CommandCenterPublishConnectionSetupMode,
  type CommandCenterPublishProvider,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import {
  InstagramTokenStore,
  layer as instagramTokenStoreLayer,
} from "./instagram/InstagramTokenStore.ts";

/**
 * Publishing connections: the external accounts finished clips publish to (YouTube, Instagram).
 *
 * Every provider plugs into the same begin/complete/remove lifecycle, mirroring
 * `GoogleConnectionSetup`: `begin` opens a short-lived server-side session (and, for OAuth
 * providers, an authorization URL); `complete` receives the one credential the user pastes
 * back (a long-lived token or the 127.0.0.1 callback address) and persists it through the
 * provider's `ServerSecretStore`-backed token store; `remove` forgets it. Credentials are
 * environment-scoped and never cross the wire; clients only see `CommandCenterPublishConnection`.
 */
export interface PublishConnectionProvider {
  readonly provider: CommandCenterPublishProvider;
  readonly setupMode: CommandCenterPublishConnectionSetupMode;
  readonly status: Effect.Effect<CommandCenterPublishConnection, CommandCenterError>;
  /**
   * Start setup. `complete` is kept server-side in the session and receives the pasted
   * credential, so provider-private state (OAuth `state`, PKCE verifier) never leaves the server.
   */
  readonly begin: Effect.Effect<
    {
      readonly authUrl?: string;
      readonly complete: (
        credential: string,
      ) => Effect.Effect<CommandCenterPublishConnection, CommandCenterError>;
    },
    CommandCenterError
  >;
  readonly remove: Effect.Effect<CommandCenterPublishConnection, CommandCenterError>;
}

export const PUBLISH_CONNECTION_SESSION_TTL_MINUTES = 10;

/** Every provider in the contract, in display order, with how its setup collects credentials. */
const PUBLISH_PROVIDERS: ReadonlyArray<{
  readonly provider: CommandCenterPublishProvider;
  readonly setupMode: CommandCenterPublishConnectionSetupMode;
  readonly unavailableDetail: string;
}> = [
  {
    provider: "youtube",
    setupMode: "oauth-redirect",
    unavailableDetail: "YouTube publishing is not available in this environment yet.",
  },
  {
    provider: "instagram",
    setupMode: "paste-token",
    unavailableDetail: "Instagram publishing is not available in this environment.",
  },
];

interface SetupSession {
  readonly provider: CommandCenterPublishProvider;
  readonly expiresAtMs: number;
  readonly complete: (
    credential: string,
  ) => Effect.Effect<CommandCenterPublishConnection, CommandCenterError>;
}

interface PublishConnectionsShape {
  readonly query: Effect.Effect<ReadonlyArray<CommandCenterPublishConnection>, CommandCenterError>;
  readonly begin: (
    input: CommandCenterPublishConnectionSetupBeginInput,
  ) => Effect.Effect<CommandCenterPublishConnectionSetupBeginResult, CommandCenterError>;
  readonly complete: (
    input: CommandCenterPublishConnectionSetupCompleteInput,
  ) => Effect.Effect<CommandCenterPublishConnection, CommandCenterError>;
  readonly remove: (
    input: CommandCenterPublishConnectionRemoveInput,
  ) => Effect.Effect<CommandCenterPublishConnection, CommandCenterError>;
}

export class PublishConnections extends Context.Service<
  PublishConnections,
  PublishConnectionsShape
>()("@awtprod/command-center/command-center/publish/PublishConnections") {}

const unavailable = (provider: CommandCenterPublishProvider) =>
  new CommandCenterError({
    reason: "connector",
    message:
      PUBLISH_PROVIDERS.find((entry) => entry.provider === provider)?.unavailableDetail ??
      "This publishing provider is not available in this environment.",
  });

/** Build the registry from whichever providers this environment implements. */
export const make = Effect.fn("PublishConnections.make")(function* (
  providers: ReadonlyArray<PublishConnectionProvider>,
) {
  const crypto = yield* Crypto.Crypto;
  const sessions = yield* Ref.make(new Map<string, SetupSession>());
  const byProvider = new Map(providers.map((entry) => [entry.provider, entry] as const));

  const query = Effect.forEach(PUBLISH_PROVIDERS, (entry) => {
    const implementation = byProvider.get(entry.provider);
    return implementation === undefined
      ? Effect.succeed<CommandCenterPublishConnection>({
          provider: entry.provider,
          state: "unavailable",
          setupMode: entry.setupMode,
          detail: entry.unavailableDetail,
        })
      : implementation.status;
  }).pipe(Effect.withSpan("PublishConnections.query"));

  const begin = Effect.fn("PublishConnections.begin")(function* (
    input: CommandCenterPublishConnectionSetupBeginInput,
  ) {
    const implementation = byProvider.get(input.provider);
    if (implementation === undefined) return yield* unavailable(input.provider);
    const started = yield* implementation.begin;
    const sessionId = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new CommandCenterError({
            reason: "connector",
            message: "Could not create a publishing connection setup session.",
            cause,
          }),
      ),
    );
    const now = yield* DateTime.now;
    const expiresAt = DateTime.add(now, { minutes: PUBLISH_CONNECTION_SESSION_TTL_MINUTES });
    const nowMs = DateTime.toEpochMillis(now);
    yield* Ref.update(sessions, (current) => {
      const next = new Map<string, SetupSession>();
      for (const [id, session] of current) {
        if (session.expiresAtMs > nowMs) next.set(id, session);
      }
      next.set(sessionId, {
        provider: input.provider,
        expiresAtMs: DateTime.toEpochMillis(expiresAt),
        complete: started.complete,
      });
      return next;
    });
    return {
      sessionId,
      provider: input.provider,
      setupMode: implementation.setupMode,
      ...(started.authUrl === undefined ? {} : { authUrl: started.authUrl }),
      expiresAt: DateTime.formatIso(expiresAt),
    };
  });

  const complete = Effect.fn("PublishConnections.complete")(function* (
    input: CommandCenterPublishConnectionSetupCompleteInput,
  ) {
    const session = (yield* Ref.get(sessions)).get(input.sessionId);
    const now = yield* DateTime.now;
    if (session === undefined || session.expiresAtMs <= DateTime.toEpochMillis(now)) {
      return yield* new CommandCenterError({
        reason: "validation",
        message: "This connection setup expired. Start the connection again.",
      });
    }
    const connection = yield* session.complete(input.credential);
    yield* Ref.update(sessions, (current) => {
      const next = new Map(current);
      next.delete(input.sessionId);
      return next;
    });
    return connection;
  });

  const remove = Effect.fn("PublishConnections.remove")(function* (
    input: CommandCenterPublishConnectionRemoveInput,
  ) {
    const implementation = byProvider.get(input.provider);
    if (implementation === undefined) return yield* unavailable(input.provider);
    return yield* implementation.remove;
  });

  return PublishConnections.of({ query, begin, complete, remove });
});

/** Instagram: paste a long-lived token; validated with GET /me and stored in the secret store. */
export const instagramConnectionProvider = Effect.gen(function* () {
  const store = yield* InstagramTokenStore;
  return {
    provider: "instagram",
    setupMode: "paste-token",
    status: store.summary,
    begin: Effect.succeed({ complete: store.connectFromToken }),
    remove: store.disconnect,
  } satisfies PublishConnectionProvider;
});

export const layerWithoutDependencies = Layer.effect(
  PublishConnections,
  Effect.gen(function* () {
    const instagram = yield* instagramConnectionProvider;
    return yield* make([instagram]);
  }),
);

export const layer = layerWithoutDependencies.pipe(Layer.provide(instagramTokenStoreLayer));
