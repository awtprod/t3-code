import type { CapabilityName, RepositoryId, SpaceId } from "@command-center/core";
import { type ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpServer } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpProviderSession from "./McpProviderSession.ts";

export interface McpCredentialRequest {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly projectId?: ProjectId;
  readonly cwd?: string;
  readonly capabilities?: ReadonlySet<McpInvocationContext.McpCapability>;
  readonly databaseAccess?: "read" | "write";
  readonly spaceId?: SpaceId;
  readonly repositoryId?: RepositoryId;
}

export interface McpThreadScope {
  readonly capabilities: ReadonlySet<CapabilityName>;
  readonly spaceId: SpaceId;
  readonly repositoryId?: RepositoryId;
  readonly memoryWriteMode: McpInvocationContext.McpMemoryWriteMode;
  readonly role?: McpInvocationContext.McpThreadRole;
}

/**
 * Derives a durable thread scope from persisted state (a Space agent thread)
 * when no in-memory scope was registered. It is consulted on every credential
 * issue, so it survives restarts and provider-session stops, and a disabled or
 * archived Space simply resolves to no scope.
 */
export type McpThreadScopeResolver = (
  threadId: ThreadId,
) => Effect.Effect<McpThreadScope | undefined>;

export interface McpIssuedCredential {
  readonly config: McpProviderSession.McpProviderSessionConfig;
}

export interface McpSessionRegistryShape {
  readonly issue: (request: McpCredentialRequest) => Effect.Effect<McpIssuedCredential>;
  readonly resolve: (
    rawToken: string,
  ) => Effect.Effect<McpInvocationContext.McpInvocationScope | undefined>;
  /**
   * Records a sign of life for every credential bound to `threadId`. Provider
   * turns call this so that a session which is plainly alive keeps its
   * credential even when it goes a long time without touching an MCP tool.
   */
  readonly touch: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeProviderSession: (providerSessionId: string) => Effect.Effect<void>;
  readonly revokeThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly registerThreadScope: (threadId: ThreadId, scope: McpThreadScope) => Effect.Effect<void>;
  readonly unregisterThreadScope: (threadId: ThreadId) => Effect.Effect<void>;
  /** The registered scope, or the durable resolver's scope, for a thread. */
  readonly scopeForThread: (threadId: ThreadId) => Effect.Effect<McpThreadScope | undefined>;
  readonly revokeAll: Effect.Effect<void>;
}

export class McpSessionRegistry extends Context.Service<
  McpSessionRegistry,
  McpSessionRegistryShape
>()("@awtprod/command-center/mcp/McpSessionRegistry") {}

interface CredentialRecord {
  readonly tokenHash: string;
  readonly scope: McpInvocationContext.McpInvocationScope;
  readonly lastAliveAt: number;
}

interface RegistryState {
  readonly records: ReadonlyMap<string, CredentialRecord>;
  readonly threadScopes: ReadonlyMap<ThreadId, McpThreadScope>;
}

export interface McpSessionRegistryOptions {
  readonly livenessWindowMs?: number;
  readonly now?: () => number;
  /** Test seam; production reads the resolver installed by the Space agent. */
  readonly resolveThreadScope?: McpThreadScopeResolver;
}

let activeThreadScopeResolver: McpThreadScopeResolver | undefined;

/**
 * Install the durable thread-scope resolver for the lifetime of the calling
 * scope. The previous resolver is restored on release.
 */
export const installMcpThreadScopeResolver = (resolver: McpThreadScopeResolver) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous = activeThreadScopeResolver;
      activeThreadScopeResolver = resolver;
      return previous;
    }),
    (previous) =>
      Effect.sync(() => {
        if (activeThreadScopeResolver === resolver) activeThreadScopeResolver = previous;
      }),
  );

/**
 * How long a credential outlives the last sign of life from its provider
 * session.
 *
 * Liveness is refreshed both by MCP traffic and by `touch` on every provider
 * turn, so a session that is still doing work never expires no matter how long
 * it goes between browser tool calls. This window therefore only bounds
 * credentials whose session died without a clean stop — the normal paths
 * (`stopSession`, `stopAll`) revoke eagerly and do not wait for it.
 *
 * The bound matters because `/mcp` is mounted outside the environment auth
 * stack and is reachable on whatever host the server binds to, so this token is
 * the only thing guarding the `t3-code` toolkits on a remote-reachable server.
 */
const DEFAULT_LIVENESS_WINDOW_MS = 24 * 60 * 60 * 1_000;

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const tokenFromBytes = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

const getHttpMcpEndpointHost = (hostname: string): string => {
  const normalized = hostname.toLowerCase();
  const endpointHostname =
    normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]"
      ? "127.0.0.1"
      : hostname;
  return endpointHostname.includes(":") && !endpointHostname.startsWith("[")
    ? `[${endpointHostname}]`
    : endpointHostname;
};

const makeWithOptions = Effect.fn("McpSessionRegistry.make")(function* (
  options: McpSessionRegistryOptions = {},
) {
  const crypto = yield* Crypto.Crypto;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const httpServer = yield* HttpServer.HttpServer;
  const state = yield* SynchronizedRef.make<RegistryState>({
    records: new Map(),
    threadScopes: new Map(),
  });
  const currentTimeMillis = options.now ? Effect.sync(options.now) : Clock.currentTimeMillis;
  const livenessWindowMs = options.livenessWindowMs ?? DEFAULT_LIVENESS_WINDOW_MS;
  const endpoint =
    httpServer.address._tag === "TcpAddress"
      ? `http://${getHttpMcpEndpointHost(httpServer.address.hostname)}:${httpServer.address.port}/mcp`
      : "http://127.0.0.1/mcp";

  const resolveDurableScope = (threadId: ThreadId): Effect.Effect<McpThreadScope | undefined> => {
    const resolver = options.resolveThreadScope ?? activeThreadScopeResolver;
    if (resolver === undefined) return Effect.succeed(undefined);
    // Fail closed: a resolver defect grants no scope, it never widens one.
    return resolver(threadId).pipe(
      Effect.catchDefect((defect) =>
        Effect.logWarning("mcp.thread-scope-resolver-failed", { threadId, defect }).pipe(
          Effect.as(undefined),
        ),
      ),
    );
  };

  const scopeForThread: McpSessionRegistryShape["scopeForThread"] = (threadId) =>
    SynchronizedRef.get(state).pipe(
      Effect.flatMap(({ threadScopes }) => {
        const registered = threadScopes.get(threadId);
        return registered === undefined
          ? resolveDurableScope(threadId)
          : Effect.succeed(registered);
      }),
    );

  const hashToken = (token: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(token))
      .pipe(Effect.map(bytesToHex), Effect.orDie);

  const pruneDead = (records: ReadonlyMap<string, CredentialRecord>, timestamp: number) => {
    const next = new Map(
      Array.from(records).filter(
        ([, record]) => timestamp - record.lastAliveAt <= livenessWindowMs,
      ),
    );
    return next.size === records.size ? records : next;
  };

  const issue: McpSessionRegistryShape["issue"] = Effect.fn("McpSessionRegistry.issue")(
    function* (request) {
      const issuedAt = yield* currentTimeMillis;
      const providerSessionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const rawToken = yield* crypto.randomBytes(32).pipe(Effect.map(tokenFromBytes), Effect.orDie);
      const tokenHash = yield* hashToken(rawToken);
      const registeredScope = yield* scopeForThread(request.threadId);
      const spaceId = request.spaceId ?? registeredScope?.spaceId;
      const repositoryId = request.repositoryId ?? registeredScope?.repositoryId;
      const capabilities = new Set<McpInvocationContext.McpCapability>(
        registeredScope?.capabilities ?? request.capabilities ?? ["preview"],
      );
      if (request.databaseAccess !== undefined) capabilities.add("database.read");
      if (request.databaseAccess === "write") capabilities.add("database.write");
      const scope: McpInvocationContext.McpInvocationScope = {
        environmentId,
        threadId: ThreadId.make(request.threadId),
        providerSessionId,
        providerInstanceId: ProviderInstanceId.make(request.providerInstanceId),
        ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
        ...(request.cwd?.trim() ? { cwd: request.cwd.trim() } : {}),
        capabilities,
        ...(spaceId === undefined ? {} : { spaceId }),
        ...(repositoryId === undefined ? {} : { repositoryId }),
        memoryWriteMode: registeredScope?.memoryWriteMode ?? "propose",
        ...(registeredScope?.role === undefined ? {} : { role: registeredScope.role }),
        issuedAt,
      };
      yield* SynchronizedRef.update(state, ({ records, threadScopes }) => {
        const next = new Map(pruneDead(records, issuedAt));
        next.set(tokenHash, { tokenHash, scope, lastAliveAt: issuedAt });
        return { records: next, threadScopes };
      });
      return {
        config: {
          environmentId,
          threadId: scope.threadId,
          providerSessionId,
          providerInstanceId: scope.providerInstanceId,
          endpoint,
          authorizationHeader: `Bearer ${rawToken}`,
          capabilities: new Set(capabilities),
        },
      };
    },
  );

  const resolve: McpSessionRegistryShape["resolve"] = Effect.fn("McpSessionRegistry.resolve")(
    function* (rawToken) {
      if (rawToken.length === 0) return undefined;
      const tokenHash = yield* hashToken(rawToken);
      const timestamp = yield* currentTimeMillis;
      return yield* SynchronizedRef.modify(state, ({ records, threadScopes }) => {
        const current = pruneDead(records, timestamp);
        const record = current.get(tokenHash);
        if (!record) return [undefined, { records: current, threadScopes }] as const;
        const next = new Map(current);
        next.set(tokenHash, { ...record, lastAliveAt: timestamp });
        return [record.scope, { records: next, threadScopes }] as const;
      });
    },
  );

  const touch: McpSessionRegistryShape["touch"] = Effect.fn("McpSessionRegistry.touch")(
    function* (threadId) {
      const timestamp = yield* currentTimeMillis;
      yield* SynchronizedRef.update(state, ({ records, threadScopes }) => {
        const current = pruneDead(records, timestamp);
        const next = new Map(current);
        for (const [tokenHash, record] of current) {
          if (record.scope.threadId === threadId) {
            next.set(tokenHash, { ...record, lastAliveAt: timestamp });
          }
        }
        return { records: next, threadScopes };
      });
    },
  );

  const revokeWhere = (predicate: (record: CredentialRecord) => boolean) =>
    SynchronizedRef.update(state, ({ records, threadScopes }) => ({
      records: new Map(Array.from(records).filter(([, record]) => !predicate(record))),
      threadScopes,
    }));

  return McpSessionRegistry.of({
    issue,
    resolve,
    touch,
    revokeProviderSession: Effect.fn("McpSessionRegistry.revokeProviderSession")(
      function* (providerSessionId) {
        yield* revokeWhere((record) => record.scope.providerSessionId === providerSessionId);
      },
    ),
    revokeThread: Effect.fn("McpSessionRegistry.revokeThread")(function* (threadId) {
      yield* revokeWhere((record) => record.scope.threadId === threadId);
    }),
    registerThreadScope: Effect.fn("McpSessionRegistry.registerThreadScope")(
      function* (threadId, scope) {
        yield* SynchronizedRef.update(state, (current) => ({
          ...current,
          threadScopes: new Map(current.threadScopes).set(threadId, scope),
        }));
      },
    ),
    unregisterThreadScope: Effect.fn("McpSessionRegistry.unregisterThreadScope")(
      function* (threadId) {
        yield* SynchronizedRef.update(state, (current) => {
          const threadScopes = new Map(current.threadScopes);
          threadScopes.delete(threadId);
          return { ...current, threadScopes };
        });
      },
    ),
    scopeForThread,
    revokeAll: SynchronizedRef.set(state, { records: new Map(), threadScopes: new Map() }),
  });
});

let activeMcpSessionRegistry: McpSessionRegistryShape | undefined;

const make = Effect.acquireRelease(
  makeWithOptions().pipe(
    Effect.tap((registry) =>
      Effect.sync(() => {
        activeMcpSessionRegistry = registry;
      }),
    ),
  ),
  (registry) =>
    Effect.sync(() => {
      if (activeMcpSessionRegistry === registry) {
        activeMcpSessionRegistry = undefined;
      }
    }),
);

export const layer = Layer.effect(McpSessionRegistry, make);

export const issueActiveMcpCredential = (
  request: McpCredentialRequest,
): Effect.Effect<McpIssuedCredential | undefined> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry
        .revokeThread(request.threadId)
        .pipe(Effect.andThen(activeMcpSessionRegistry.issue(request)))
    : Effect.sync((): McpIssuedCredential | undefined => undefined);

/**
 * Refreshes the liveness of a thread's MCP credential. Called on every provider
 * turn so an active session is never mistaken for an abandoned one.
 */
export const touchActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.touch(threadId) : Effect.void;

export const revokeActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry
        .revokeThread(threadId)
        .pipe(Effect.andThen(activeMcpSessionRegistry.unregisterThreadScope(threadId)))
    : Effect.void;

export const registerActiveMcpThreadScope = (
  threadId: ThreadId,
  scope: McpThreadScope,
): Effect.Effect<boolean> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry.registerThreadScope(threadId, scope).pipe(Effect.as(true))
    : Effect.succeed(false);

/**
 * Whether a thread is bound to a Command Center scope (registered for a Run,
 * or durable for a Space agent). Such threads need a credential even when no
 * browser or database tools are enabled.
 */
export const hasActiveMcpThreadScope = (threadId: ThreadId): Effect.Effect<boolean> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry
        .scopeForThread(threadId)
        .pipe(Effect.map((scope) => scope !== undefined))
    : Effect.succeed(false);

export const revokeAllActiveMcpCredentials = (): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.revokeAll : Effect.void;

/** Exposed for tests. */
export const __testing = {
  make: makeWithOptions,
};
