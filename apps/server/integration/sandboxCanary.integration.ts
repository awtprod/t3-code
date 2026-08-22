/**
 * Sandbox canary: drives the real container lifecycle end to end.
 *
 * Unlike the decider/projection integration tests, this runs the harness with
 * `realSandboxReactors`, so `sandbox.provision`, `thread.settle`, and
 * `thread.delete` reach the real lifecycle reactors and the real container
 * runtime. The provider adapter stays faked -- every assertion here is about
 * containers, networks, volumes, and export artifacts, none of which need a
 * provider credential.
 *
 * The host must have a working rootless docker/podman and digest-pinned
 * `T3_SANDBOX_IMAGE` / `T3_SANDBOX_PREVIEW_PROXY_IMAGE`.
 *
 * Run: node apps/server/integration/sandboxCanary.integration.ts
 */
import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  defaultInstanceIdForDriver,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { NodeSandboxCommandExecutor } from "../src/sandbox/NodeSandboxCommandExecutor.ts";
import { resolveSandboxRuntime } from "../src/sandbox/SandboxRuntimeManager.ts";
import { makeOrchestrationIntegrationHarness } from "./OrchestrationEngineHarness.integration.ts";

const THREAD = ThreadId.make("canary-thread-0000000000000001");
const PROJECT = ProjectId.make("canary-project-000000000000001");

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

/**
 * Running workspace containers, read through the same argv-only executor the
 * backend uses, so the canary observes the runtime exactly as production does.
 */
const threadContainers: Effect.Effect<ReadonlyArray<string>> = Effect.promise(async () => {
  const executor = new NodeSandboxCommandExecutor(process.platform);
  try {
    const result = await executor.run({
      executable: resolveSandboxRuntime(),
      args: ["ps", "--format", "{{.Names}}"],
      timeoutMs: 30_000,
    });
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((name) => name.startsWith("t3-thread-"));
  } catch {
    return [] as ReadonlyArray<string>;
  }
});

export const runSandboxCanary = Effect.gen(function* () {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const failures: Array<string> = [];

  const check = (ok: boolean, label: string) =>
    Effect.gen(function* () {
      if (!ok) failures.push(label);
      yield* Console.log(`  ${ok ? "PASS" : "FAIL"} ${label}`);
    });

  const harness = yield* makeOrchestrationIntegrationHarness({ realSandboxReactors: true });
  const provider = harness.adapterHarness?.provider ?? ProviderDriverKind.make("codex");
  const modelSelection = {
    instanceId: defaultInstanceIdForDriver(provider),
    model: DEFAULT_MODEL_BY_PROVIDER[provider] ?? DEFAULT_MODEL,
  };
  const artifactsDir = path.join(harness.rootDir, "userdata", "sandbox-artifacts");
  // Only a thread's own export set counts. `seeds/` is a sibling directory the
  // manager keeps for in-flight provisioning bundles, and dot-prefixed names are
  // its temporaries -- neither is a retained artifact, so neither should make
  // the deletion assertion fail.
  const listArtifacts = fileSystem.readDirectory(artifactsDir).pipe(
    Effect.map((entries) => entries.filter((entry) => !entry.startsWith(".") && entry !== "seeds")),
    Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
  );

  /** Poll a host-side condition; the container runtime has no event stream. */
  const awaitHost = (label: string, attempts: number, condition: Effect.Effect<boolean>) =>
    condition.pipe(
      Effect.flatMap((met) => (met ? Effect.succeed(true) : Effect.fail("pending" as const))),
      Effect.retry(
        Schedule.recurs(attempts).pipe(Schedule.addDelay(() => Effect.succeed("1 second"))),
      ),
      Effect.catch(() =>
        Console.log(`    (timed out waiting for ${label})`).pipe(Effect.as(false)),
      ),
    );

  const lifecycle = harness
    .waitForThread(THREAD, () => true, 5_000)
    .pipe(Effect.map((thread) => thread.sandbox?.lifecycle ?? "none"));

  const settlesInto = (states: ReadonlyArray<string>, timeoutMs: number) =>
    harness
      .waitForThread(
        THREAD,
        (thread) => thread.sandbox != null && states.includes(thread.sandbox.lifecycle),
        timeoutMs,
      )
      .pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );

  yield* Console.log("== Phase 0: seed project and thread");
  yield* harness.engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("canary:project-create"),
    projectId: PROJECT,
    title: "Sandbox Canary",
    workspaceRoot: harness.workspaceDir,
    defaultModelSelection: modelSelection,
    createdAt: yield* nowIso,
  });
  yield* harness.engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make("canary:thread-create"),
    threadId: THREAD,
    projectId: PROJECT,
    title: "sandbox canary",
    modelSelection,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "approval-required",
    branch: "main",
    worktreePath: harness.workspaceDir,
    // No `sandboxBranch`: the decider resolves `current.branch ?? command.branch`,
    // so a seeded branch (like an explicit one on the command) makes
    // `sandbox.provision` emit `sandbox.provisioning-started` -- projector-only,
    // no reactor, no container. The branchless path emits
    // `sandbox.provision-requested`, which is what actually provisions.
    createdAt: yield* nowIso,
  });
  // No sandbox projection yet: `thread.create` only seeds one when given a
  // `sandboxBranch`, and that seeded branch is exactly what routes
  // `sandbox.provision` down the projector-only path. Starting without one is
  // what lets the branchless provision emit `sandbox.provision-requested`.
  yield* harness.waitForThread(THREAD, (thread) => thread.id === THREAD);
  yield* check(true, "thread created without a pre-seeded sandbox branch");

  yield* Console.log("== Phase 1: provision (real containers)");
  yield* harness.engine.dispatch({
    type: "sandbox.provision",
    commandId: CommandId.make("canary:provision"),
    threadId: THREAD,
    // Deliberately no `branch`: with one, the decider drives the sandbox to
    // `provisioning` itself and emits `sandbox.provisioning-started`, which no
    // reactor consumes -- only `sandbox.provision-requested` (the branchless
    // path) reaches SandboxLifecycleReactor and touches the container runtime.
    createdAt: yield* nowIso,
  });
  yield* settlesInto(["ready", "failed"], 600_000);
  const provisionedState = yield* lifecycle;
  yield* check(provisionedState === "ready", `sandbox reached 'ready' (saw '${provisionedState}')`);
  yield* check(
    yield* awaitHost(
      "workspace container",
      60,
      threadContainers.pipe(Effect.map((names) => names.length > 0)),
    ),
    "workspace container is running on the host",
  );

  yield* Console.log("== Phase 2: settle reclaims the sandbox (PR #47/#50 wedge fix)");
  yield* harness.engine.dispatch({
    type: "thread.settle",
    commandId: CommandId.make("canary:settle"),
    threadId: THREAD,
  });
  yield* settlesInto(["stopped", "expired", "failed"], 300_000);
  const settledState = yield* lifecycle;
  yield* check(
    settledState === "stopped" || settledState === "expired",
    `sandbox settled to '${settledState}' -- never wedged in 'stopping'`,
  );
  yield* check(
    yield* awaitHost(
      "containers reclaimed",
      120,
      threadContainers.pipe(Effect.map((names) => names.length === 0)),
    ),
    "containers reclaimed on settle",
  );
  const exported = yield* listArtifacts;
  yield* check(
    exported.some((entry) => entry.endsWith(".bundle")),
    "export artifacts written on teardown",
  );

  yield* Console.log("== Phase 3: re-provision from the export (PR #47)");
  yield* harness.engine.dispatch({
    type: "sandbox.provision",
    commandId: CommandId.make("canary:reprovision"),
    threadId: THREAD,
    createdAt: yield* nowIso,
  });
  yield* settlesInto(["ready", "failed"], 600_000);
  const reprovisionedState = yield* lifecycle;
  yield* check(
    reprovisionedState === "ready",
    `sandbox re-provisioned from stopped (saw '${reprovisionedState}')`,
  );

  yield* Console.log("== Phase 4: delete tears down sandbox + artifacts (PR #51/#52)");
  const beforeDelete = (yield* listArtifacts).length;
  yield* harness.engine.dispatch({
    type: "thread.delete",
    commandId: CommandId.make("canary:delete"),
    threadId: THREAD,
  });
  yield* check(
    yield* awaitHost(
      "containers torn down",
      180,
      threadContainers.pipe(Effect.map((names) => names.length === 0)),
    ),
    "containers torn down on thread deletion",
  );
  const artifactsCleared = yield* awaitHost(
    "artifacts removed",
    60,
    listArtifacts.pipe(Effect.map((entries) => entries.length === 0)),
  );
  const remaining = yield* listArtifacts;
  yield* check(
    artifactsCleared,
    `transcript artifacts removed on deletion (had ${beforeDelete} before` +
      (remaining.length === 0 ? ")" : `, left ${remaining.join(", ")})`),
  );

  yield* harness.dispose;
  yield* Console.log(`== Summary: ${failures.length === 0 ? "all checks passed" : "FAILURES"}`);
  for (const failure of failures) yield* Console.log(`  FAILED: ${failure}`);
  return failures.length;
});

const failureCount = await Effect.runPromise(
  runSandboxCanary.pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.catchCause((cause) =>
      Console.error(`canary aborted: ${String(cause)}`).pipe(Effect.as(1)),
    ),
  ),
);
process.exit(failureCount === 0 ? 0 : 1);
