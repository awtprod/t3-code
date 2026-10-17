import {
  ProviderInstanceId,
  ProviderSetupError,
  type ThreadId,
  type OrchestrationV2ProviderCapabilities,
  type ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import {
  CommandCenterProviderAdmissionError,
  commandCenterProviderIsolationIssue,
  isCommandCenterThreadId,
} from "../provider/security/CommandCenterProviderIsolation.ts";
import {
  ProviderAdapterDriverCreateError,
  type AnyProviderAdapterDriver,
} from "@t3tools/provider-core/server/adapterDriver";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const isProviderSetupError = Schema.is(ProviderSetupError);

/**
 * The authoritative Command Center admission gate. Every orchestration session
 * opens through a registry `get`, so wrapping `openSession` here refuses a
 * `cc:` thread on a provider without an isolation profile (anything but Codex)
 * or in full-access mode before the adapter spawns anything. The `cc:`
 * identity comes from the server-assigned thread id in the open request.
 * Adapter errors pass through unchanged.
 */
function withCommandCenterAdmission(
  adapter: ProviderAdapter.ProviderAdapterV2["Service"],
): ProviderAdapter.ProviderAdapterV2["Service"] {
  return {
    ...adapter,
    openSession: (input) => {
      const issue = commandCenterProviderIsolationIssue({
        threadId: input.threadId,
        provider: adapter.driver,
        runtimeMode: input.runtimePolicy.runtimeMode,
      });
      return issue === undefined
        ? adapter
            .openSession(input)
            .pipe(
              Effect.map((runtime) => bindSessionToOpeningThread(adapter.driver, input, runtime)),
            )
        : Effect.fail(
            new ProviderAdapter.ProviderAdapterOpenSessionError({
              driver: adapter.driver,
              providerSessionId: input.providerSessionId,
              cause: new CommandCenterProviderAdmissionError({
                threadId: String(input.threadId),
                provider: String(adapter.driver),
                issue,
              }),
            }),
          );
    },
  };
}

const SESSION_THREAD_MISMATCH =
  "A Command Center thread runs only in the provider session launched for it, and no other thread may join that session.";

/** True when `threadId` may not use a session opened for `owner`. */
export function commandCenterSessionMismatch(owner: ThreadId, threadId: ThreadId): boolean {
  if (threadId === owner) return false;
  return isCommandCenterThreadId(owner) || isCommandCenterThreadId(threadId);
}

/**
 * Isolation is decided when a session opens, from the thread that opens it. A
 * `cc:` thread that joined a session another thread opened would run in that
 * session's unisolated launch, and a thread joining a `cc:` session would run
 * inside the Command Center sandbox. The Orchestrator gives every `cc:` thread
 * its own session; this refuses any path that does not, before the adapter
 * touches the thread.
 */
function bindSessionToOpeningThread(
  driver: ProviderDriverKind,
  opened: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
  runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
): ProviderAdapter.ProviderAdapterV2SessionRuntime {
  const owner = opened.threadId;
  const refusal = (threadId: ThreadId) =>
    new CommandCenterProviderAdmissionError({
      threadId: String(threadId),
      provider: String(driver),
      issue: SESSION_THREAD_MISMATCH,
    });
  const bound: ProviderAdapter.ProviderAdapterV2SessionRuntime = Object.assign(
    Object.create(Object.getPrototypeOf(runtime) as object | null) as object,
    runtime,
    {
      ensureThread: (input: ProviderAdapter.ProviderAdapterV2EnsureThreadInput) =>
        commandCenterSessionMismatch(owner, input.threadId)
          ? Effect.fail(
              new ProviderAdapter.ProviderAdapterEnsureThreadError({
                driver,
                threadId: input.threadId,
                cause: refusal(input.threadId),
              }),
            )
          : runtime.ensureThread(input),
      resumeThread: (input: Parameters<typeof runtime.resumeThread>[0]) => {
        const threadId = input.threadId ?? input.providerThread.appThreadId;
        return threadId !== null && commandCenterSessionMismatch(owner, threadId)
          ? Effect.fail(
              new ProviderAdapter.ProviderAdapterResumeThreadError({
                driver,
                providerSessionId: opened.providerSessionId,
                providerThreadId: input.providerThread.id,
                cause: refusal(threadId),
              }),
            )
          : runtime.resumeThread(input);
      },
      startTurn: (input: ProviderAdapter.ProviderAdapterV2TurnInput) =>
        commandCenterSessionMismatch(owner, input.threadId)
          ? Effect.fail(
              new ProviderAdapter.ProviderAdapterTurnStartError({
                driver,
                threadId: input.threadId,
                providerThreadId: input.providerThread.id,
                cause: refusal(input.threadId),
              }),
            )
          : runtime.startTurn(input),
      forkThread: (input: ProviderAdapter.ProviderAdapterV2ForkThreadInput) =>
        commandCenterSessionMismatch(owner, input.targetThreadId)
          ? Effect.fail(
              new ProviderAdapter.ProviderAdapterForkThreadError({
                driver,
                providerThreadId: input.sourceProviderThread.id,
                cause: refusal(input.targetThreadId),
              }),
            )
          : runtime.forkThread(input),
    },
  );
  return bound;
}

export class ProviderAdapterRegistryLookupError extends Schema.TaggedError<ProviderAdapterRegistryLookupError>()(
  "ProviderAdapterRegistryLookupError",
  {
    instanceId: ProviderInstanceId,
  },
) {
  override get message(): string {
    return `No orchestration provider adapter is registered for ${this.instanceId}.`;
  }
}

export class ProviderAdapterRegistryMetadataError extends Schema.TaggedError<ProviderAdapterRegistryMetadataError>()(
  "ProviderAdapterRegistryMetadataError",
  { instanceId: ProviderInstanceId, cause: Schema.Defect() },
) {}

export const ProviderAdapterRegistryV2Error = Schema.Union([
  ProviderAdapterRegistryLookupError,
  ProviderAdapterRegistryMetadataError,
  ProviderAdapterDriverCreateError,
]);
export type ProviderAdapterRegistryV2Error = typeof ProviderAdapterRegistryV2Error.Type;

export interface ProviderAdapterRegistryV2Shape {
  readonly get: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderAdapter.ProviderAdapterV2["Service"], ProviderAdapterRegistryV2Error>;
  readonly list: () => Effect.Effect<ReadonlyArray<ProviderInstanceId>>;
  readonly getMetadata?: (instanceId: ProviderInstanceId) => Effect.Effect<
    {
      readonly driver: ProviderAdapter.ProviderAdapterV2["Service"]["driver"];
      readonly continuationKey: string;
      readonly enabled: boolean;
      readonly capabilities: OrchestrationV2ProviderCapabilities;
    },
    ProviderAdapterRegistryV2Error
  >;
}

export class ProviderAdapterRegistryV2 extends Context.Service<
  ProviderAdapterRegistryV2,
  ProviderAdapterRegistryV2Shape
>()("@awtprod/command-center/orchestration-v2/ProviderAdapterRegistry/ProviderAdapterRegistryV2") {}

/**
 * Production facade over the canonical provider-instance registry. Adapter
 * lookup stays dynamic so instance hot reloads and removals are visible
 * without maintaining a second settings watcher or instance map.
 */
export const layerFromProviderInstanceRegistry: Layer.Layer<
  ProviderAdapterRegistryV2,
  never,
  ProviderInstanceRegistry.ProviderInstanceRegistry
> = Layer.effect(
  ProviderAdapterRegistryV2,
  Effect.gen(function* () {
    const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    return ProviderAdapterRegistryV2.of({
      get: (instanceId) =>
        instances.getInstance(instanceId).pipe(
          Effect.flatMap((instance) => {
            if (instance === undefined)
              return new ProviderAdapterRegistryLookupError({ instanceId });
            const adapter = instance.orchestrationAdapter;
            const auth = instance.auth;
            if (!auth) return Effect.succeed(withCommandCenterAdmission(adapter));
            return Effect.succeed(
              withCommandCenterAdmission({
                ...adapter,
                openSession: (input) => {
                  const open = Effect.gen(function* () {
                    const binding = auth.credentialBinding;
                    const related = binding
                      ? (yield* instances.listInstances).filter(
                          (instance) =>
                            instance.auth?.credentialBinding?.key === binding.key &&
                            instance.auth.credentialBinding.owner === binding.owner,
                        )
                      : [instance];
                    for (const instance of related) {
                      if (
                        instance.auth?.isChangingCredentials &&
                        (yield* instance.auth.isChangingCredentials)
                      )
                        return yield* new ProviderSetupError({
                          instanceId,
                          operation: "session",
                          detail:
                            "This provider's sign-in is changing. Try again after it finishes.",
                        });
                    }
                    let admitted: Effect.Effect<
                      ProviderAdapter.ProviderAdapterV2SessionRuntime,
                      ProviderAdapter.ProviderAdapterV2Error | ProviderSetupError,
                      Scope.Scope
                    > = adapter.openSession(input);
                    // Shared credential changes must interrupt a peer's startup too.
                    for (const peer of related) {
                      if (peer.auth?.withAccess) admitted = peer.auth.withAccess(admitted);
                    }
                    return yield* admitted;
                  });
                  return open.pipe(
                    Effect.mapError((cause) =>
                      isProviderSetupError(cause)
                        ? new ProviderAdapter.ProviderAdapterOpenSessionError({
                            driver: adapter.driver,
                            providerSessionId: input.providerSessionId,
                            cause,
                          })
                        : cause,
                    ),
                  );
                },
              } satisfies ProviderAdapter.ProviderAdapterV2["Service"]),
            );
          }),
        ),
      list: () =>
        instances.listInstances.pipe(
          Effect.map((available) => available.map((instance) => instance.instanceId)),
        ),
      getMetadata: (instanceId) =>
        Effect.gen(function* () {
          const instance = yield* instances.getInstance(instanceId);
          if (instance === undefined) {
            return yield* new ProviderAdapterRegistryLookupError({ instanceId });
          }
          const capabilities = yield* instance.orchestrationAdapter
            .getCapabilities()
            .pipe(
              Effect.mapError(
                (cause) => new ProviderAdapterRegistryMetadataError({ instanceId, cause }),
              ),
            );
          return {
            driver: instance.driverKind,
            continuationKey: instance.continuationIdentity.continuationKey,
            enabled: instance.enabled,
            capabilities,
          };
        }),
    });
  }),
);

export const ProviderAdapterRegistryBuildError = Schema.Union([ProviderAdapterDriverCreateError]);
export type ProviderAdapterRegistryBuildError = typeof ProviderAdapterRegistryBuildError.Type;

function makeRegistry(
  adapters: ReadonlyArray<ProviderAdapter.ProviderAdapterV2["Service"]>,
): ProviderAdapterRegistryV2Shape {
  return {
    get: (instanceId) =>
      Effect.gen(function* () {
        const adapter = adapters.find((candidate) => candidate.instanceId === instanceId);
        if (!adapter) {
          return yield* new ProviderAdapterRegistryLookupError({ instanceId });
        }
        return withCommandCenterAdmission(adapter);
      }),
    list: () => Effect.succeed(adapters.map((adapter) => adapter.instanceId)),
  };
}

export function layerFromAdapters(
  adapters: ReadonlyArray<ProviderAdapter.ProviderAdapterV2["Service"]>,
): Layer.Layer<ProviderAdapterRegistryV2> {
  return Layer.succeed(
    ProviderAdapterRegistryV2,
    ProviderAdapterRegistryV2.of(makeRegistry(adapters)),
  );
}

export function layerFromAdaptersEffect<R, E>(
  adapters: Effect.Effect<ReadonlyArray<ProviderAdapter.ProviderAdapterV2["Service"]>, E, R>,
): Layer.Layer<ProviderAdapterRegistryV2, E, R> {
  return Layer.effect(
    ProviderAdapterRegistryV2,
    adapters.pipe(Effect.map((entries) => ProviderAdapterRegistryV2.of(makeRegistry(entries)))),
  );
}

export function layerSingle(
  adapter: ProviderAdapter.ProviderAdapterV2["Service"],
): Layer.Layer<ProviderAdapterRegistryV2> {
  return layerFromAdapters([adapter]);
}

const decodedConfigEnabled = (config: unknown): boolean | undefined => {
  if (!config || typeof config !== "object" || globalThis.Array.isArray(config)) {
    return undefined;
  }
  const enabled = (config as { readonly enabled?: unknown }).enabled;
  return typeof enabled === "boolean" ? enabled : undefined;
};

interface LiveAdapterEntry {
  readonly adapter: ProviderAdapter.ProviderAdapterV2["Service"];
  readonly scope: Scope.Closeable;
  readonly entry: ProviderInstanceConfig;
}

function makeDriversById<R>(
  drivers: ReadonlyArray<AnyProviderAdapterDriver<R>>,
): ReadonlyMap<ProviderDriverKind, AnyProviderAdapterDriver<R>> {
  return new Map<ProviderDriverKind, AnyProviderAdapterDriver<R>>(
    drivers.map((driver) => [driver.driverKind, driver]),
  );
}

const createAdapterEntryFromConfigEntry = Effect.fn(
  "ProviderAdapterRegistry.createAdapterEntryFromConfigEntry",
)(function* <R>(input: {
  readonly driversById: ReadonlyMap<ProviderDriverKind, AnyProviderAdapterDriver<R>>;
  readonly parentScope: Scope.Scope;
  readonly instanceId: ProviderInstanceId;
  readonly entry: ProviderInstanceConfig;
}): Effect.fn.Return<LiveAdapterEntry, ProviderAdapterDriverCreateError, R> {
  const driver = input.driversById.get(input.entry.driver);
  if (driver === undefined) {
    return yield* new ProviderAdapterDriverCreateError({
      driver: input.entry.driver,
      instanceId: input.instanceId,
      detail: "Unknown provider driver.",
    });
  }

  const decodeConfig = Schema.decodeUnknownEffect(driver.configSchema);
  const typedConfig = yield* decodeConfig(input.entry.config ?? driver.defaultConfig()).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterDriverCreateError({
          driver: input.entry.driver,
          instanceId: input.instanceId,
          detail: "Invalid provider instance config.",
          cause,
        }),
    ),
  );

  const childScope = yield* Scope.make();
  yield* Scope.addFinalizer(
    input.parentScope,
    Scope.close(childScope, Exit.void).pipe(Effect.ignore),
  );

  const adapter = yield* driver
    .create({
      instanceId: input.instanceId,
      displayName: input.entry.displayName,
      accentColor: input.entry.accentColor,
      environment: input.entry.environment ?? [],
      enabled: input.entry.enabled ?? decodedConfigEnabled(typedConfig) ?? true,
      config: typedConfig,
    })
    .pipe(
      Effect.provideService(Scope.Scope, childScope),
      Effect.onError((cause) => Scope.close(childScope, Exit.failCause(cause))),
    );

  return {
    adapter,
    scope: childScope,
    entry: input.entry,
  };
});

const buildAdaptersFromConfigMap = Effect.fn("ProviderAdapterRegistry.buildAdaptersFromConfigMap")(
  function* <R>(input: {
    readonly drivers: ReadonlyArray<AnyProviderAdapterDriver<R>>;
    readonly configMap: ProviderInstanceConfigMap;
    readonly parentScope: Scope.Scope;
  }): Effect.fn.Return<
    ReadonlyMap<ProviderInstanceId, LiveAdapterEntry>,
    ProviderAdapterRegistryBuildError,
    R
  > {
    const driversById = makeDriversById(input.drivers);
    const adapters = new Map<ProviderInstanceId, LiveAdapterEntry>();

    for (const [rawInstanceId, entry] of Object.entries(input.configMap)) {
      const instanceId = ProviderInstanceId.make(rawInstanceId);
      if (!driversById.has(entry.driver)) {
        yield* Effect.logWarning("Skipping orchestration-v2 provider adapter with unknown driver", {
          instanceId,
          driver: entry.driver,
        });
        continue;
      }

      const adapter = yield* createAdapterEntryFromConfigEntry({
        driversById,
        parentScope: input.parentScope,
        instanceId,
        entry,
      });
      adapters.set(instanceId, adapter);
    }

    return adapters;
  },
);

export function makeRegistryFromConfigMap<R>(input: {
  readonly drivers: ReadonlyArray<AnyProviderAdapterDriver<R>>;
  readonly configMap: ProviderInstanceConfigMap;
}): Effect.Effect<
  ProviderAdapterRegistryV2Shape,
  ProviderAdapterRegistryBuildError,
  R | Scope.Scope
> {
  return Effect.gen(function* () {
    const parentScope = yield* Effect.scope;
    const entries = yield* buildAdaptersFromConfigMap({ ...input, parentScope });
    return makeRegistry(Array.from(entries.values()).map((entry) => entry.adapter));
  });
}

export function layerFromDrivers<R>(input: {
  readonly drivers: ReadonlyArray<AnyProviderAdapterDriver<R>>;
  readonly configMap: ProviderInstanceConfigMap;
}): Layer.Layer<ProviderAdapterRegistryV2, ProviderAdapterRegistryBuildError, R> {
  return Layer.effect(
    ProviderAdapterRegistryV2,
    makeRegistryFromConfigMap(input).pipe(
      Effect.map((registry) => ProviderAdapterRegistryV2.of(registry)),
    ),
  ) as Layer.Layer<ProviderAdapterRegistryV2, ProviderAdapterRegistryBuildError, R>;
}

const layerFromProviderAdapter: Layer.Layer<
  ProviderAdapterRegistryV2,
  never,
  ProviderAdapter.ProviderAdapterV2
> = Layer.effect(
  ProviderAdapterRegistryV2,
  Effect.gen(function* () {
    const adapter = yield* ProviderAdapter.ProviderAdapterV2;
    return ProviderAdapterRegistryV2.of({
      get: (instanceId) =>
        adapter.instanceId === instanceId
          ? Effect.succeed(withCommandCenterAdmission(adapter))
          : Effect.fail(new ProviderAdapterRegistryLookupError({ instanceId })),
      list: () => Effect.succeed([adapter.instanceId]),
    } satisfies ProviderAdapterRegistryV2Shape);
  }),
);
