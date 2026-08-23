// @effect-diagnostics nodeBuiltinImport:off - derives the expected container names from the thread id.
import { describe, expect, it, vi } from "@effect/vitest";
import { afterEach } from "vite-plus/test";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { desktopGateway } from "./DesktopGatewayService.ts";
import { makeSandboxRuntimeManager } from "./SandboxRuntimeManager.ts";
import type { ThreadServiceDeclaration } from "./ThreadServiceStack.ts";
import type {
  SandboxCommand,
  SandboxCommandExecutor,
  SandboxCommandResult,
  SandboxProvisionInput,
} from "./types.ts";

const PREVIEW_IMAGE = `preview@sha256:${"a".repeat(64)}`;
const SANDBOX_IMAGE = `sandbox@sha256:${"b".repeat(64)}`;
const THREAD_ID = "thread-unwind";
const PROJECT_ID = "project-1";
const CONTAINER_NAME = `t3-thread-${NodeCrypto.createHash("sha256")
  .update(`${PROJECT_ID}\0${THREAD_ID}`)
  .digest("hex")
  .slice(0, 32)}`;

class FakeExecutor implements SandboxCommandExecutor {
  readonly commands: SandboxCommand[] = [];
  readonly #override: (command: SandboxCommand) => SandboxCommandResult | undefined;
  constructor(override?: (command: SandboxCommand) => SandboxCommandResult | undefined) {
    this.#override = override ?? (() => undefined);
  }
  async run(command: SandboxCommand): Promise<SandboxCommandResult> {
    this.commands.push(command);
    const overridden = this.#override(command);
    if (overridden !== undefined) return overridden;
    if (command.args[0] === "info") return { exitCode: 0, stdout: '["name=rootless"]', stderr: "" };
    if (command.args[0] === "inspect" && command.args.length === 2)
      return { exitCode: 1, stdout: "", stderr: "missing" };
    if (command.args[0] === "volume" && command.args[1] === "inspect") {
      const name = command.args.at(-1) ?? "";
      if (name.startsWith("t3-cache-")) return { exitCode: 1, stdout: "", stderr: "missing" };
      const bytes = name.startsWith("t3-desktop-")
        ? Math.max(256 * 1024 ** 2, Math.floor(20 * 1024 ** 3 * 0.1))
        : Math.floor(20 * 1024 ** 3 * 0.9);
      return { exitCode: 0, stdout: `size=${bytes}\n`, stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

type ProvisionRequest = SandboxProvisionInput & {
  services?: ReadonlyArray<ThreadServiceDeclaration>;
};

const provisionInput = (overrides: Partial<ProvisionRequest> = {}): ProvisionRequest => ({
  bootstrap: {
    threadId: THREAD_ID,
    projectId: PROJECT_ID,
    repositoryUrl: "https://example.test/repository.git",
    baseCommit: "a".repeat(40),
    branchName: `thread/${THREAD_ID}`,
  },
  image: SANDBOX_IMAGE,
  ...overrides,
});

const MUTATED_ENV = [
  "T3_SANDBOX_DESKTOP",
  "T3_SANDBOX_PREVIEW_PROXY_IMAGE",
  "T3_SANDBOX_CREDENTIAL_PROXY_IMAGE",
] as const;
const originalEnv = new Map(MUTATED_ENV.map((key) => [key, process.env[key]] as const));

afterEach(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
  desktopGateway.removeThread(THREAD_ID);
});

/** Every `rm --force <name>` the executor saw, in order. */
const forcedRemovals = (executor: FakeExecutor) =>
  executor.commands
    .filter((command) => command.args[0] === "rm" && command.args[1] === "--force")
    .map((command) => command.args.at(-1));

describe("provision failure unwinds", () => {
  it.effect("clears gateway routes, grants, and proxies when desktop start fails", () =>
    Effect.gen(function* () {
      // The failure point is AFTER setServiceStatus, setServiceCredentialGrants,
      // setPreviewProxy, and registerPreviewRoute have all run -- the exact
      // window where a failed provision used to leave live preview routes and
      // readable credential grants pointing at destroyed containers.
      delete process.env.T3_SANDBOX_DESKTOP;
      process.env.T3_SANDBOX_PREVIEW_PROXY_IMAGE = PREVIEW_IMAGE;
      delete process.env.T3_SANDBOX_CREDENTIAL_PROXY_IMAGE;
      const executor = new FakeExecutor((command) =>
        // Fail the desktop capability probe for `code`; every other probe and
        // container command succeeds, so provisioning reaches desktop.start
        // with services, grants, and preview state fully registered.
        command.args[0] === "exec" && command.args.at(-1) === "code"
          ? { exitCode: 1, stdout: "", stderr: "not found" }
          : undefined,
      );
      const manager = makeSandboxRuntimeManager(undefined, "linux", executor);

      const failure = yield* manager
        .provision(
          provisionInput({
            previewPorts: [3000],
            services: [
              {
                name: "database",
                image: `postgres@sha256:${"c".repeat(64)}`,
                generatedEnvironment: [{ key: "POSTGRES_PASSWORD", kind: "password" }],
              },
            ],
          }),
        )
        .pipe(Effect.flip);

      expect(failure._tag).toBe("SandboxManagerError");
      expect(failure.message).toContain("missing required capabilities");
      // The gateway holds nothing for the thread anymore: no routes, no
      // grants (token values were readable through the status endpoint), no
      // service status, no per-thread preview proxy.
      const status = desktopGateway.status(THREAD_ID);
      expect(status.previewRoutes).toEqual([]);
      expect(status.serviceCredentialGrants).toEqual([]);
      expect(status.services).toEqual([]);
      expect(status.ready).toBe(false);
      expect(desktopGateway.previewProxy(THREAD_ID)).toBeNull();
      // ...and the containers were torn down: workspace, service, and the
      // preview sidecar all removed.
      const removed = forcedRemovals(executor);
      expect(removed).toContain(CONTAINER_NAME);
      expect(removed.some((name) => name?.startsWith("t3-svc-"))).toBe(true);
      expect(removed.some((name) => name?.startsWith("t3-preview-"))).toBe(true);
    }),
  );

  it.effect("turns a sync throw while issuing service grants into a typed, unwound failure", () =>
    Effect.gen(function* () {
      // A bare `throw` inside the provision generator is a defect that skips
      // every tapError unwind, leaking the workspace container and services.
      // The grant-issuing block must fail typed and still tear everything down.
      process.env.T3_SANDBOX_DESKTOP = "disabled";
      process.env.T3_SANDBOX_PREVIEW_PROXY_IMAGE = PREVIEW_IMAGE;
      delete process.env.T3_SANDBOX_CREDENTIAL_PROXY_IMAGE;
      const issue = vi.spyOn(desktopGateway.credentials, "issue").mockImplementation(() => {
        throw new Error("generated service credential database:POSTGRES_PASSWORD is missing");
      });
      const executor = new FakeExecutor();
      const manager = makeSandboxRuntimeManager(undefined, "linux", executor);

      const failure = yield* manager
        .provision(
          provisionInput({
            services: [
              {
                name: "database",
                image: `postgres@sha256:${"c".repeat(64)}`,
                generatedEnvironment: [{ key: "POSTGRES_PASSWORD", kind: "password" }],
              },
            ],
          }),
        )
        .pipe(Effect.flip);

      expect(issue).toHaveBeenCalled();
      // Typed failure, not a defect: `Effect.flip` above only succeeds for the
      // error channel; a defect would have crashed the test instead.
      expect(failure._tag).toBe("SandboxManagerError");
      expect(failure.message).toContain("generated service credential");
      // The unwind ran: workspace container and service container removed,
      // and no gateway state survives.
      const removed = forcedRemovals(executor);
      expect(removed).toContain(CONTAINER_NAME);
      expect(removed.some((name) => name?.startsWith("t3-svc-"))).toBe(true);
      const status = desktopGateway.status(THREAD_ID);
      expect(status.services).toEqual([]);
      expect(status.serviceCredentialGrants).toEqual([]);
    }),
  );
});

describe("stop against an in-flight provision", () => {
  /** Every container name the run created with `run --detach`. */
  const created = (executor: FakeExecutor) =>
    executor.commands
      .filter((command) => command.args[0] === "run")
      .map((command) => command.args[command.args.indexOf("--name") + 1]);

  it.effect("tears down the sidecars a concurrent provision publishes after the backend", () =>
    Effect.gen(function* () {
      // Synchronizing the stop against the BACKEND was not enough. The backend
      // only owns `ensureReady`; the manager keeps going afterwards, starting
      // the service stack, the preview proxy, the credential proxy, and the
      // desktop sidecar and publishing the thread's gateway state. A stop that
      // waited only on the backend destroyed what existed at that instant,
      // reported the thread stopped, and left everything created after it
      // running forever -- unreferenced containers, live preview routes, and
      // readable credential grants belonging to a thread nothing would ever
      // stop again.
      //
      // The provision parks in the preview sidecar's `run`, which is AFTER the
      // backend has finished and the service stack and its credential grants
      // are already published: exactly the window the old synchronization
      // could not see.
      process.env.T3_SANDBOX_DESKTOP = "disabled";
      process.env.T3_SANDBOX_PREVIEW_PROXY_IMAGE = PREVIEW_IMAGE;
      delete process.env.T3_SANDBOX_CREDENTIAL_PROXY_IMAGE;
      let reachedPreview = () => {};
      const atPreview = new Promise<void>((resolve) => {
        reachedPreview = resolve;
      });
      let releasePreview = () => {};
      const previewReleased = new Promise<void>((resolve) => {
        releasePreview = resolve;
      });
      class ParkingExecutor extends FakeExecutor {
        override async run(command: SandboxCommand): Promise<SandboxCommandResult> {
          if (
            command.args[0] === "run" &&
            (command.args[command.args.indexOf("--name") + 1] ?? "").startsWith("t3-preview-")
          ) {
            reachedPreview();
            await previewReleased;
          }
          return super.run(command);
        }
      }
      const executor = new ParkingExecutor();
      const manager = makeSandboxRuntimeManager(undefined, "linux", executor);

      const provisioning = yield* manager
        .provision(
          provisionInput({
            previewPorts: [3000],
            services: [
              {
                name: "database",
                image: `postgres@sha256:${"c".repeat(64)}`,
                generatedEnvironment: [{ key: "POSTGRES_PASSWORD", kind: "password" }],
              },
            ],
          }),
        )
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Effect.promise(() => atPreview);
      // Issued while the provision is parked mid-way, past the backend.
      const stopping = yield* manager
        .stop("docker", THREAD_ID)
        .pipe(Effect.exit, Effect.forkScoped);
      // Give the stop every opportunity to run to completion while the
      // provision is still parked. Its executor calls all settle on the
      // microtask queue, so yielding repeatedly is enough for it to finish --
      // unless something is holding it back, which is the property under test.
      yield* Effect.forEach(Array.from({ length: 200 }), () => Effect.yieldNow, {
        discard: true,
      });
      releasePreview();
      yield* Fiber.join(provisioning);
      yield* Fiber.join(stopping);

      // Everything the provision created is gone, including the sidecars it
      // published after the backend step the old guard synchronized on.
      const removed = new Set(forcedRemovals(executor));
      for (const name of created(executor)) expect(removed).toContain(name);
      // ...and no gateway state outlives the containers: no preview routes, no
      // readable credential grants, no service status, no per-thread proxy.
      const status = desktopGateway.status(THREAD_ID);
      expect(status.previewRoutes).toEqual([]);
      expect(status.serviceCredentialGrants).toEqual([]);
      expect(status.services).toEqual([]);
      expect(desktopGateway.previewProxy(THREAD_ID)).toBeNull();
    }),
  );

  it.effect("refuses a provision dispatched before a stop that ran to completion first", () =>
    Effect.gen(function* () {
      // The window the lock cannot see. `sandbox.provision` is dispatched, and
      // before the reactor gets as far as calling this manager the deletion's
      // stop runs end to end: it takes the lock UNCONTENDED, finds no record,
      // reports "nothing to do", and returns. The provision then arrived at an
      // empty lock and built a container, sidecars, a network, and volumes for
      // a thread that was already terminal -- and the `sandbox.provision.ready`
      // that followed was rejected, so nothing ever tore them down.
      //
      // Serializing the two was never enough: the stop has to leave a mark the
      // provision reads once it finally gets here.
      process.env.T3_SANDBOX_DESKTOP = "disabled";
      process.env.T3_SANDBOX_PREVIEW_PROXY_IMAGE = PREVIEW_IMAGE;
      delete process.env.T3_SANDBOX_CREDENTIAL_PROXY_IMAGE;
      const executor = new FakeExecutor();
      const manager = makeSandboxRuntimeManager(undefined, "linux", executor);

      // The stop completes BEFORE the provision is even issued -- no
      // interleaving to arrange, which is the whole point.
      yield* manager.stop("docker", THREAD_ID);
      const failure = yield* manager
        .provision(
          provisionInput({
            previewPorts: [3000],
            services: [
              {
                name: "database",
                image: `postgres@sha256:${"c".repeat(64)}`,
                generatedEnvironment: [{ key: "POSTGRES_PASSWORD", kind: "password" }],
              },
            ],
          }),
        )
        .pipe(Effect.flip);

      expect(failure._tag).toBe("SandboxManagerError");
      expect(failure.message).toContain("was stopped before provisioning began");
      // Nothing was created at all: the refusal happens before the first
      // container command, so there is nothing left to leak.
      expect(created(executor)).toEqual([]);
      const status = desktopGateway.status(THREAD_ID);
      expect(status.previewRoutes).toEqual([]);
      expect(status.serviceCredentialGrants).toEqual([]);
      expect(status.services).toEqual([]);
    }),
  );

  it.effect("provisions a stopped thread again once the decider has authorized it", () =>
    Effect.gen(function* () {
      // The tombstone above must not turn "stopped" into a one-way door.
      // Settling a thread, hitting Stop, or being reaped by the idle sweep all
      // stop the sandbox, and coming back to the thread has to provision a
      // fresh one. The decider is the authority that tells those apart -- it
      // accepts `sandbox.provision` from a stopped lifecycle -- so a caller
      // whose command was accepted clears the mark before provisioning.
      process.env.T3_SANDBOX_DESKTOP = "disabled";
      process.env.T3_SANDBOX_PREVIEW_PROXY_IMAGE = PREVIEW_IMAGE;
      delete process.env.T3_SANDBOX_CREDENTIAL_PROXY_IMAGE;
      const executor = new FakeExecutor();
      const manager = makeSandboxRuntimeManager(undefined, "linux", executor);

      yield* manager.provision(provisionInput());
      yield* manager.stop("docker", THREAD_ID);
      yield* manager.authorizeProvision(THREAD_ID);
      const ready = yield* manager.provision(provisionInput());

      expect(ready.containerName).toBe(CONTAINER_NAME);
      expect(created(executor)).toContain(CONTAINER_NAME);
    }),
  );

  it.effect("stops a thread that has no provision in flight", () =>
    Effect.gen(function* () {
      // The lock must not require a provision to exist: a stop for a thread
      // this manager generation never provisioned (a server restart, an
      // already-stopped thread) still has to run its teardown rather than wait
      // on something that will never arrive.
      process.env.T3_SANDBOX_DESKTOP = "disabled";
      process.env.T3_SANDBOX_PREVIEW_PROXY_IMAGE = PREVIEW_IMAGE;
      delete process.env.T3_SANDBOX_CREDENTIAL_PROXY_IMAGE;
      const executor = new FakeExecutor();
      const manager = makeSandboxRuntimeManager(undefined, "linux", executor);

      yield* manager.stop("docker", THREAD_ID);

      // A second stop, after a real provision, still tears the container down:
      // the lock is released rather than stranded by the no-op above. The
      // provision is authorized first, exactly as every production caller does
      // once the decider has accepted its `sandbox.provision` -- the no-op stop
      // above still leaves the thread's stop tombstone behind.
      yield* manager.authorizeProvision(THREAD_ID);
      yield* manager.provision(provisionInput());
      yield* manager.stop("docker", THREAD_ID);
      expect(forcedRemovals(executor)).toContain(CONTAINER_NAME);
    }),
  );
});
