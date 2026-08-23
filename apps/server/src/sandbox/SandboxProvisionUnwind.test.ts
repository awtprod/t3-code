// @effect-diagnostics nodeBuiltinImport:off - derives the expected container names from the thread id.
import { describe, expect, it, vi } from "@effect/vitest";
import { afterEach } from "vite-plus/test";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { desktopGateway } from "./DesktopGatewayService.ts";
import { makeSandboxRuntimeManager } from "./SandboxRuntimeManager.ts";
import { provisionAuthorized } from "./testUtils/authorizedProvision.ts";
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

/** Just the thread's workspace containers, dropping the preview sidecar. */
const workspaceContainers = (names: ReadonlyArray<string | undefined>) =>
  names.filter((name) => name === CONTAINER_NAME);

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

      const failure = yield* provisionAuthorized(
        manager,
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
      ).pipe(Effect.flip);

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

      const failure = yield* provisionAuthorized(
        manager,
        provisionInput({
          services: [
            {
              name: "database",
              image: `postgres@sha256:${"c".repeat(64)}`,
              generatedEnvironment: [{ key: "POSTGRES_PASSWORD", kind: "password" }],
            },
          ],
        }),
      ).pipe(Effect.flip);

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

      const provisioning = yield* provisionAuthorized(
        manager,
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
      ).pipe(Effect.exit, Effect.forkScoped);
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

  it.effect("refuses a provision whose authorization a stop invalidated before it arrived", () =>
    Effect.gen(function* () {
      // The window the lock cannot see. The decider accepts
      // `sandbox.provision` and the caller authorizes, and before it gets as
      // far as calling `provision` the deletion's stop runs end to end: it
      // takes the lock UNCONTENDED, finds no record, reports "nothing to do",
      // and returns. The provision then arrived at an empty lock and built a
      // container, sidecars, a network, and volumes for a thread that was
      // already terminal -- and the `sandbox.provision.ready` that followed was
      // rejected, so nothing ever tore them down.
      //
      // Serializing the two was never enough: the stop has to invalidate what
      // the provision is carrying, so that the provision is refused whenever it
      // finally gets here.
      process.env.T3_SANDBOX_DESKTOP = "disabled";
      process.env.T3_SANDBOX_PREVIEW_PROXY_IMAGE = PREVIEW_IMAGE;
      delete process.env.T3_SANDBOX_CREDENTIAL_PROXY_IMAGE;
      const executor = new FakeExecutor();
      const manager = makeSandboxRuntimeManager(undefined, "linux", executor);

      const attempt = yield* manager.authorizeProvision(THREAD_ID);
      // The stop completes BEFORE the provision is even issued -- no
      // interleaving to arrange, which is the whole point.
      yield* manager.stop("docker", THREAD_ID);
      const failure = yield* manager
        .provision({
          ...provisionInput({
            previewPorts: [3000],
            services: [
              {
                name: "database",
                image: `postgres@sha256:${"c".repeat(64)}`,
                generatedEnvironment: [{ key: "POSTGRES_PASSWORD", kind: "password" }],
              },
            ],
          }),
          attempt,
        })
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

  it.effect("refuses a stale attempt even after a newer one has been authorized", () =>
    Effect.gen(function* () {
      // What a per-thread BOOLEAN tombstone could not express, and the reason
      // this is a token rather than a flag. Provision A is authorized; a stop
      // lands; provision B is authorized for the same thread. Clearing the
      // thread's one tombstone was how B readmitted itself -- and it readmitted
      // A along with it, because the mark said only that A's thread had been
      // stopped at some point, never that A in particular had been. A then
      // provisioned under B's authorization and built a container for a thread
      // whose stop had already come and gone.
      //
      // A's token stays superseded no matter what B does.
      process.env.T3_SANDBOX_DESKTOP = "disabled";
      process.env.T3_SANDBOX_PREVIEW_PROXY_IMAGE = PREVIEW_IMAGE;
      delete process.env.T3_SANDBOX_CREDENTIAL_PROXY_IMAGE;
      const executor = new FakeExecutor();
      const manager = makeSandboxRuntimeManager(undefined, "linux", executor);

      const stale = yield* manager.authorizeProvision(THREAD_ID);
      yield* manager.stop("docker", THREAD_ID);
      // B is authorized and provisions normally: the thread is emphatically not
      // a one-way door, and B's success is exactly what used to readmit A.
      const current = yield* manager.authorizeProvision(THREAD_ID);
      const ready = yield* manager.provision({ ...provisionInput(), attempt: current });
      expect(ready.containerName).toBe(CONTAINER_NAME);

      const failure = yield* manager
        .provision({ ...provisionInput(), attempt: stale })
        .pipe(Effect.flip);

      expect(failure._tag).toBe("SandboxManagerError");
      expect(failure.message).toContain("was stopped before provisioning began");
      // B's container is the only workspace container anything created, and it
      // is untouched: the refusal is a refusal, not a teardown of the live
      // sandbox.
      expect(workspaceContainers(created(executor))).toEqual([CONTAINER_NAME]);
      expect(forcedRemovals(executor)).not.toContain(CONTAINER_NAME);
    }),
  );

  it.effect("refuses a stale attempt that was queued behind the stop that invalidated it", () =>
    Effect.gen(function* () {
      // The interleaved form of the case above, and the one an unauthorized
      // provision could not be told apart from: A is already blocked on the
      // thread's lifecycle lock when the stop arrives, so it is admitted the
      // instant the stop releases -- with B authorized in between. Nothing
      // about A's arrival order distinguishes it; only its token does.
      process.env.T3_SANDBOX_DESKTOP = "disabled";
      process.env.T3_SANDBOX_PREVIEW_PROXY_IMAGE = PREVIEW_IMAGE;
      delete process.env.T3_SANDBOX_CREDENTIAL_PROXY_IMAGE;
      let reachedRemoval = () => {};
      const atRemoval = new Promise<void>((resolve) => {
        reachedRemoval = resolve;
      });
      let releaseRemoval = () => {};
      const removalReleased = new Promise<void>((resolve) => {
        releaseRemoval = resolve;
      });
      class ParkingExecutor extends FakeExecutor {
        override async run(command: SandboxCommand): Promise<SandboxCommandResult> {
          if (command.args[0] === "rm" && command.args.at(-1) === CONTAINER_NAME) {
            reachedRemoval();
            await removalReleased;
          }
          return super.run(command);
        }
      }
      const executor = new ParkingExecutor();
      const manager = makeSandboxRuntimeManager(undefined, "linux", executor);

      // A live sandbox, so the stop below has something to tear down and parks
      // inside its removal while holding the lifecycle lock.
      const first = yield* manager.authorizeProvision(THREAD_ID);
      yield* manager.provision({ ...provisionInput(), attempt: first });
      const stale = yield* manager.authorizeProvision(THREAD_ID);
      const stopping = yield* manager
        .stop("docker", THREAD_ID)
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Effect.promise(() => atRemoval);
      // Queued behind the parked stop, and released only once B has been
      // authorized -- the ordering that used to readmit it.
      const provisioning = yield* manager
        .provision({ ...provisionInput(), attempt: stale })
        .pipe(Effect.exit, Effect.forkScoped);
      // The fork above really did reach the lock and block there; without this
      // the assertions could pass on a fiber that never ran at all.
      yield* Effect.forEach(Array.from({ length: 200 }), () => Effect.yieldNow, {
        discard: true,
      });
      yield* manager.authorizeProvision(THREAD_ID);
      releaseRemoval();
      yield* Fiber.join(stopping);
      const outcome = yield* Fiber.join(provisioning);

      expect(outcome._tag).toBe("Failure");
      // The stale attempt built nothing: the only workspace container created
      // is the first one, which the stop removed.
      expect(workspaceContainers(created(executor))).toEqual([CONTAINER_NAME]);
      expect(forcedRemovals(executor)).toContain(CONTAINER_NAME);
    }),
  );

  it.effect("tears down only the attempt whose readiness was refused", () =>
    Effect.gen(function* () {
      // The readiness half of the same defect. A's `sandbox.provision.ready` is
      // refused, which means a stop landed mid-provision -- and a stop is
      // exactly what a re-provision follows, so by the time A's teardown runs,
      // B has published a container of its own and had ITS readiness accepted.
      // A teardown that named the thread destroyed B's container and left the
      // projection reporting `ready` over a sandbox that no longer existed.
      process.env.T3_SANDBOX_DESKTOP = "disabled";
      process.env.T3_SANDBOX_PREVIEW_PROXY_IMAGE = PREVIEW_IMAGE;
      delete process.env.T3_SANDBOX_CREDENTIAL_PROXY_IMAGE;
      const executor = new FakeExecutor();
      const manager = makeSandboxRuntimeManager(undefined, "linux", executor);

      // Preview ports so each provision publishes gateway state of its own,
      // and a teardown that hit the wrong container would be visible there too.
      const withPreview = provisionInput({ previewPorts: [3000] });
      const refused = yield* manager.authorizeProvision(THREAD_ID);
      yield* manager.provision({ ...withPreview, attempt: refused });
      // The stop that refuses A's readiness, and the re-provision that follows.
      yield* manager.stop("docker", THREAD_ID);
      const current = yield* manager.authorizeProvision(THREAD_ID);
      const live = yield* manager.provision({ ...withPreview, attempt: current });

      // A acts on its refusal only now, with B's container live.
      yield* manager.stopProvisionAttempt("docker", refused);

      // B's container was created after the stop and never removed again: the
      // count of removals is still the one the stop performed.
      expect(workspaceContainers(created(executor))).toEqual([CONTAINER_NAME, CONTAINER_NAME]);
      expect(forcedRemovals(executor).filter((name) => name === CONTAINER_NAME)).toHaveLength(1);
      // ...and the gateway still holds B's state rather than having been swept
      // along with the container A thought it owned.
      expect(desktopGateway.status(THREAD_ID).previewRoutes).not.toEqual([]);
      expect(desktopGateway.previewProxy(THREAD_ID)).not.toBeNull();

      // The live attempt's own teardown still works, so this is a scoping rule
      // rather than a teardown that quietly stopped happening.
      yield* manager.stopProvisionAttempt("docker", live.attempt);
      expect(forcedRemovals(executor).filter((name) => name === CONTAINER_NAME)).toHaveLength(2);
      expect(desktopGateway.status(THREAD_ID).previewRoutes).toEqual([]);
    }),
  );

  it.effect("provisions a stopped thread again once the decider has authorized it", () =>
    Effect.gen(function* () {
      // A stop must not turn "stopped" into a one-way door. Settling a thread,
      // hitting Stop, or being reaped by the idle sweep all stop the sandbox,
      // and coming back to the thread has to provision a fresh one. The decider
      // is the authority that tells those apart -- it accepts
      // `sandbox.provision` from a stopped lifecycle -- so a caller whose
      // command was accepted holds a token no stop has invalidated.
      process.env.T3_SANDBOX_DESKTOP = "disabled";
      process.env.T3_SANDBOX_PREVIEW_PROXY_IMAGE = PREVIEW_IMAGE;
      delete process.env.T3_SANDBOX_CREDENTIAL_PROXY_IMAGE;
      const executor = new FakeExecutor();
      const manager = makeSandboxRuntimeManager(undefined, "linux", executor);

      yield* provisionAuthorized(manager, provisionInput());
      yield* manager.stop("docker", THREAD_ID);
      const ready = yield* provisionAuthorized(manager, provisionInput());

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
      // the lock is released rather than stranded by the no-op above.
      yield* provisionAuthorized(manager, provisionInput());
      yield* manager.stop("docker", THREAD_ID);
      expect(forcedRemovals(executor)).toContain(CONTAINER_NAME);
    }),
  );
});
