import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  ProviderSetupError,
  type ProviderInstanceConfigMap,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import type { ProviderAuthController } from "../provider/ProviderAuthService.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
} from "@t3tools/provider-core/server/adapterDriver";
import { CommandCenterProviderAdmissionError } from "../provider/security/CommandCenterProviderIsolation.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const driver = ProviderDriverKind.make("codex");
const personalId = ProviderInstanceId.make("codex_personal");
const workId = ProviderInstanceId.make("codex_work");

const makeAdapter = (
  instanceId: ProviderInstanceId,
): ProviderAdapter.ProviderAdapterV2["Service"] =>
  ({
    instanceId,
    driver,
    getCapabilities: () => Effect.die("capabilities are not used by this registry test"),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("sessions are not used by this registry test"),
  }) as ProviderAdapter.ProviderAdapterV2["Service"];

const makeInstance = (
  instanceId: ProviderInstanceId,
  orchestrationAdapter: ProviderAdapter.ProviderAdapterV2["Service"],
): ProviderInstance => ({
  instanceId,
  driverKind: driver,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: `codex:test:${instanceId}`,
  },
  displayName: String(instanceId),
  enabled: true,
  snapshot: {} as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
});

const personalAdapter = makeAdapter(personalId);
const workAdapter = makeAdapter(workId);
const instances = [
  makeInstance(personalId, personalAdapter),
  makeInstance(workId, workAdapter),
] as const;
const layerInstanceRegistry = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
  getInstance: (instanceId) =>
    Effect.succeed(instances.find((instance) => instance.instanceId === instanceId)),
  listInstances: Effect.succeed(instances),
  listUnavailable: Effect.succeed([]),
  streamChanges: Stream.empty,
  subscribeChanges: Effect.never,
});
const layerTest = ProviderAdapterRegistry.layerFromProviderInstanceRegistry.pipe(
  Layer.provide(layerInstanceRegistry),
);

it.effect("routes two configured instances of the same driver independently", () =>
  Effect.gen(function* () {
    const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;

    // Adapters come back behind the Command Center admission gate, so compare identity.
    assert.strictEqual((yield* registry.get(personalId)).instanceId, personalAdapter.instanceId);
    assert.strictEqual((yield* registry.get(workId)).instanceId, workAdapter.instanceId);
    assert.deepEqual(yield* registry.list(), [personalId, workId]);
  }).pipe(Effect.provide(layerTest)),
);

const lifecycleDriver = ProviderDriverKind.make("lifecycle-test");
const lifecycleInstanceId = ProviderInstanceId.make("lifecycle-test");
const lifecycleConfigMap: ProviderInstanceConfigMap = {
  [lifecycleInstanceId]: {
    driver: lifecycleDriver,
    config: {},
  },
};
const lifecycleAdapter = makeAdapter(lifecycleInstanceId);

const makeLifecycleDriver = (
  create: Effect.Effect<
    ProviderAdapter.ProviderAdapterV2["Service"],
    ProviderAdapterDriverCreateError,
    Scope.Scope
  >,
): ProviderAdapterDriver<Record<string, never>> => ({
  driverKind: lifecycleDriver,
  configSchema: Schema.Struct({}),
  defaultConfig: () => ({}),
  create: () => create,
});

const trackedCreate = <A, E, R>(
  releases: Ref.Ref<number>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | Scope.Scope> =>
  Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Ref.update(releases, (count) => count + 1));
    return yield* effect;
  });

it.effect("closes a partially-created adapter scope immediately on typed failure", () =>
  Effect.gen(function* () {
    const releases = yield* Ref.make(0);
    const createError = new ProviderAdapterDriverCreateError({
      driver: lifecycleDriver,
      instanceId: lifecycleInstanceId,
      detail: "expected test failure",
    });

    yield* Effect.scoped(
      Effect.gen(function* () {
        const exit = yield* ProviderAdapterRegistry.makeRegistryFromConfigMap({
          drivers: [makeLifecycleDriver(trackedCreate(releases, Effect.fail(createError)))],
          configMap: lifecycleConfigMap,
        }).pipe(Effect.exit);

        assert.isTrue(Exit.isFailure(exit));
        assert.strictEqual(yield* Ref.get(releases), 1);
      }),
    );

    assert.strictEqual(yield* Ref.get(releases), 1);
  }),
);

it.effect("closes a partially-created adapter scope immediately on defect", () =>
  Effect.gen(function* () {
    const releases = yield* Ref.make(0);

    yield* Effect.scoped(
      Effect.gen(function* () {
        const exit = yield* ProviderAdapterRegistry.makeRegistryFromConfigMap({
          drivers: [
            makeLifecycleDriver(trackedCreate(releases, Effect.die("expected test defect"))),
          ],
          configMap: lifecycleConfigMap,
        }).pipe(Effect.exit);

        assert.isTrue(Exit.hasDies(exit));
        assert.strictEqual(yield* Ref.get(releases), 1);
      }),
    );

    assert.strictEqual(yield* Ref.get(releases), 1);
  }),
);

it.effect("closes a partially-created adapter scope immediately on interruption", () =>
  Effect.gen(function* () {
    const releases = yield* Ref.make(0);
    const createStarted = yield* Deferred.make<void>();

    yield* Effect.scoped(
      Effect.gen(function* () {
        const fiber = yield* ProviderAdapterRegistry.makeRegistryFromConfigMap({
          drivers: [
            makeLifecycleDriver(
              trackedCreate(
                releases,
                Deferred.succeed(createStarted, undefined).pipe(Effect.andThen(Effect.never)),
              ),
            ),
          ],
          configMap: lifecycleConfigMap,
        }).pipe(Effect.forkChild({ startImmediately: true }));

        yield* Deferred.await(createStarted);
        yield* Fiber.interrupt(fiber);
        const exit = yield* Fiber.await(fiber);

        assert.isTrue(Exit.hasInterrupts(exit));
        assert.strictEqual(yield* Ref.get(releases), 1);
      }),
    );

    assert.strictEqual(yield* Ref.get(releases), 1);
  }),
);

it.effect("keeps a successfully-created adapter scope open until normal release", () =>
  Effect.gen(function* () {
    const releases = yield* Ref.make(0);

    yield* Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* ProviderAdapterRegistry.makeRegistryFromConfigMap({
          drivers: [makeLifecycleDriver(trackedCreate(releases, Effect.succeed(lifecycleAdapter)))],
          configMap: lifecycleConfigMap,
        });

        assert.strictEqual(
          (yield* registry.get(lifecycleInstanceId)).instanceId,
          lifecycleAdapter.instanceId,
        );
        assert.strictEqual(yield* Ref.get(releases), 0);
      }),
    );

    assert.strictEqual(yield* Ref.get(releases), 1);
  }),
);

it.effect(
  "blocks a new session while another instance changes their shared provider credentials",
  () =>
    Effect.gen(function* () {
      const unused = () => Effect.die("unused auth operation");
      const auth: ProviderAuthController = {
        credentialBinding: { owner: "provider", key: "shared-cli" },
        isChangingCredentials: Effect.succeed(false),
        start: unused,
        complete: unused,
        cancel: unused,
        logout: unused,
        subscribe: () => Stream.empty,
      };
      const related = [
        { ...instances[0], auth },
        { ...instances[1], auth: { ...auth, isChangingCredentials: Effect.succeed(true) } },
      ];
      const registry = yield* Effect.service(
        ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      ).pipe(
        Effect.provide(
          ProviderAdapterRegistry.layerFromProviderInstanceRegistry.pipe(
            Layer.provide(
              Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
                getInstance: (id) =>
                  Effect.succeed(related.find((instance) => instance.instanceId === id)),
                listInstances: Effect.succeed(related),
              }),
            ),
          ),
        ),
      );
      const adapter = yield* registry.get(personalId);
      const error = yield* adapter
        .openSession({
          threadId: ThreadId.make("new-thread"),
          providerSessionId: ProviderSessionId.make("new-session"),
          modelSelection: { instanceId: personalId, model: "test-model" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace",
          },
        })
        .pipe(Effect.flip);
      assert.instanceOf(error, ProviderAdapter.ProviderAdapterOpenSessionError);
      assert.instanceOf(error.cause, ProviderSetupError);
    }),
);

it.effect("interrupts admitted session startup when a shared peer signs out", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const stopped = yield* Deferred.make<void>();
    const binding = { owner: "provider" as const, key: "shared-cli" };
    const auth = yield* ProviderAuthFlow.make({
      instanceId: personalId,
      credentialBinding: binding,
      methods: Effect.succeed([]),
      authenticate: () => Effect.void,
      logout: Effect.void,
    });
    const peerAuth = yield* ProviderAuthFlow.make({
      instanceId: workId,
      credentialBinding: binding,
      methods: Effect.succeed([]),
      authenticate: () => Effect.void,
      logout: Effect.void,
    });
    const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
      ...workAdapter,
      openSession: () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          return yield* Effect.never;
        }).pipe(Effect.ensuring(Deferred.succeed(stopped, undefined))),
    };
    const related = [
      { ...instances[0], auth },
      { ...instances[1], auth: peerAuth, orchestrationAdapter: adapter },
    ];
    const registry = yield* Effect.service(ProviderAdapterRegistry.ProviderAdapterRegistryV2).pipe(
      Effect.provide(
        ProviderAdapterRegistry.layerFromProviderInstanceRegistry.pipe(
          Layer.provide(
            Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
              getInstance: (id) =>
                Effect.succeed(related.find((instance) => instance.instanceId === id)),
              listInstances: Effect.succeed(related),
            }),
          ),
        ),
      ),
    );
    const guarded = yield* registry.get(workId);
    const startup = yield* guarded
      .openSession({
        threadId: ThreadId.make("shared-startup"),
        providerSessionId: ProviderSessionId.make("shared-session"),
        modelSelection: { instanceId: workId, model: "test-model" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: "/workspace",
        },
      })
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* auth.logout(Effect.void);
    yield* Deferred.await(stopped);
    assert.isTrue(Exit.isFailure(yield* Fiber.await(startup)));
  }).pipe(Effect.provide(NodeServices.layer)),
);

const isAdmissionError = Schema.is(CommandCenterProviderAdmissionError);

describe("Command Center admission gate", () => {
  const openInput = (threadId: string, runtimeMode: "full-access" | "approval-required") =>
    ({
      threadId: ThreadId.make(threadId),
      providerSessionId: ProviderSessionId.make(`session:${threadId}`),
      modelSelection: { instanceId: personalId, model: "gpt-test" },
      runtimePolicy: { runtimeMode, interactionMode: "default", cwd: "/workspace" },
    }) as unknown as ProviderAdapter.ProviderAdapterV2OpenSessionInput;
  const openingAdapter = (kind: string, opened: Array<string>) =>
    ({
      ...makeAdapter(personalId),
      driver: ProviderDriverKind.make(kind),
      openSession: (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
        Effect.sync(() => {
          opened.push(String(input.threadId));
        }).pipe(Effect.andThen(Effect.die("opened"))),
    }) as unknown as ProviderAdapter.ProviderAdapterV2["Service"];
  const refusal = (
    adapter: ProviderAdapter.ProviderAdapterV2["Service"],
    threadId: string,
    mode: "full-access" | "approval-required",
  ) =>
    Effect.scoped(adapter.openSession(openInput(threadId, mode))).pipe(
      Effect.flip,
      Effect.map((failure) => {
        assert.strictEqual(failure._tag, "ProviderAdapterOpenSessionError");
        const cause: unknown = "cause" in failure ? failure.cause : undefined;
        assert.isTrue(isAdmissionError(cause));
        return cause as CommandCenterProviderAdmissionError;
      }),
    );
  const fromAdapters = (adapters: ReadonlyArray<ProviderAdapter.ProviderAdapterV2["Service"]>) =>
    ProviderAdapterRegistry.layerFromAdapters(adapters);

  it.effect("refuses a Command Center thread on a provider without an isolation profile", () => {
    const opened: Array<string> = [];
    return Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
      const cause = yield* refusal(
        yield* registry.get(personalId),
        "cc:interactive:acme",
        "approval-required",
      );
      assert.strictEqual(cause._tag, "CommandCenterProviderAdmissionError");
      assert.match(cause.issue, /require Codex/);
      assert.deepEqual(opened, []);
    }).pipe(Effect.provide(fromAdapters([openingAdapter("claudeAgent", opened)])));
  });

  it.effect("refuses a full-access Command Center thread on Codex before spawning", () => {
    const opened: Array<string> = [];
    return Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
      const cause = yield* refusal(
        yield* registry.get(personalId),
        "cc:automation:acme",
        "full-access",
      );
      assert.strictEqual(cause._tag, "CommandCenterProviderAdmissionError");
      assert.match(cause.issue, /full-access/);
      assert.deepEqual(opened, []);
    }).pipe(Effect.provide(fromAdapters([openingAdapter("codex", opened)])));
  });

  it.effect("leaves ordinary threads, including full-access Codex, to the adapter", () => {
    const opened: Array<string> = [];
    return Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
      const adapter = yield* registry.get(personalId);
      const exit = yield* Effect.exit(
        Effect.scoped(adapter.openSession(openInput("thread-acme", "full-access"))),
      );
      // The adapter ran (and died on purpose), so the gate let it through untouched.
      assert.isTrue(Exit.isFailure(exit));
      assert.deepEqual(opened, ["thread-acme"]);
    }).pipe(Effect.provide(fromAdapters([openingAdapter("codex", opened)])));
  });

  // Isolation is decided at open from the opening thread, so the session must
  // stay that thread's: a cc: thread may not run in a session another thread
  // opened (its launch is unisolated), and nothing may join a cc: session. The
  // Space agent thread (cc-space-agent-*) is an ordinary thread here.
  const sessionAdapter = (calls: Array<string>) => {
    const record = (operation: string, threadId: unknown) =>
      Effect.sync(() => {
        calls.push(`${operation}:${String(threadId)}`);
        return {} as never;
      });
    return {
      ...makeAdapter(personalId),
      openSession: () =>
        Effect.succeed({
          ensureThread: (input: { readonly threadId: ThreadId }) =>
            record("ensure", input.threadId),
          resumeThread: (input: { readonly threadId?: ThreadId }) =>
            record("resume", input.threadId),
          startTurn: (input: { readonly threadId: ThreadId }) => record("start", input.threadId),
          forkThread: (input: { readonly targetThreadId: ThreadId }) =>
            record("fork", input.targetThreadId),
        } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime),
    } as unknown as ProviderAdapter.ProviderAdapterV2["Service"];
  };
  const providerThread = (appThreadId: string) => ({
    id: `provider-thread:${appThreadId}`,
    providerSessionId: null,
    appThreadId,
  });
  const operations = {
    ensure: (runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime, threadId: string) =>
      runtime.ensureThread({
        threadId: ThreadId.make(threadId),
      } as unknown as ProviderAdapter.ProviderAdapterV2EnsureThreadInput),
    resume: (runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime, threadId: string) =>
      runtime.resumeThread({
        threadId: ThreadId.make(threadId),
        providerThread: providerThread(threadId),
      } as unknown as Parameters<
        ProviderAdapter.ProviderAdapterV2SessionRuntime["resumeThread"]
      >[0]),
    start: (runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime, threadId: string) =>
      runtime.startTurn({
        threadId: ThreadId.make(threadId),
        runId: `run:${threadId}`,
        providerThread: providerThread(threadId),
      } as unknown as ProviderAdapter.ProviderAdapterV2TurnInput),
    fork: (runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime, threadId: string) =>
      runtime.forkThread({
        targetThreadId: ThreadId.make(threadId),
        sourceProviderThread: providerThread("source"),
      } as unknown as ProviderAdapter.ProviderAdapterV2ForkThreadInput),
  } as const;
  const expectedTag = {
    ensure: "ProviderAdapterEnsureThreadError",
    resume: "ProviderAdapterResumeThreadError",
    start: "ProviderAdapterTurnStartError",
    fork: "ProviderAdapterForkThreadError",
  } as const;
  const cases = [
    { owner: "cc:interactive:acme", other: "thread-acme" },
    { owner: "thread-acme", other: "cc:interactive:acme" },
    { owner: "cc:automation:acme", other: "cc-space-agent-acme-lab" },
    { owner: "cc-space-agent-acme-lab", other: "cc:automation:acme" },
    { owner: "cc:interactive:acme", other: "cc:interactive:acme-other" },
  ] as const;

  for (const { owner, other } of cases) {
    for (const operation of ["ensure", "resume", "start", "fork"] as const) {
      it.effect(`refuses ${operation} for ${other} in a session ${owner} opened`, () => {
        const calls: Array<string> = [];
        return Effect.scoped(
          Effect.gen(function* () {
            const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
            const adapter = yield* registry.get(personalId);
            const session = yield* adapter.openSession(openInput(owner, "approval-required"));
            const refused = yield* operations[operation](session, other).pipe(Effect.flip);
            assert.strictEqual(refused._tag, expectedTag[operation]);
            assert.isTrue(isAdmissionError("cause" in refused ? refused.cause : undefined));
            // The opening thread itself is served, and the refusal never reached the adapter.
            yield* operations[operation](session, owner);
            assert.deepEqual(calls, [`${operation}:${owner}`]);
          }),
        ).pipe(Effect.provide(fromAdapters([sessionAdapter(calls)])));
      });
    }
  }

  it.effect("lets ordinary threads, the Space agent included, share an ordinary session", () => {
    const calls: Array<string> = [];
    return Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
        const adapter = yield* registry.get(personalId);
        const session = yield* adapter.openSession(openInput("thread-acme", "approval-required"));
        for (const operation of ["ensure", "resume", "start", "fork"] as const) {
          yield* operations[operation](session, "cc-space-agent-acme-lab");
        }
        assert.lengthOf(calls, 4);
      }),
    ).pipe(Effect.provide(fromAdapters([sessionAdapter(calls)])));
  });

  it.effect("gates the production instance-registry facade too", () =>
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
      const cause = yield* refusal(
        yield* registry.get(personalId),
        "cc:interactive:acme",
        "full-access",
      );
      assert.strictEqual(cause._tag, "CommandCenterProviderAdmissionError");
    }).pipe(Effect.provide(layerTest)),
  );
});
