// @effect-diagnostics nodeBuiltinImport:off - artifact export is an explicit Node filesystem boundary.
import type {
  SandboxAdoptionHint,
  SandboxProvisionInput,
  SandboxReady,
  SandboxArtifactExport,
  SandboxReconcileResult,
  SandboxUsageSample,
  SandboxExecInput,
  SandboxCommandResult,
  SandboxCommandExecutor,
} from "./types.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { ContainerSandboxBackend } from "./ContainerSandboxBackend.ts";
import { NodeSandboxCommandExecutor } from "./NodeSandboxCommandExecutor.ts";
import { ThreadDesktopRuntime } from "./ThreadDesktopRuntime.ts";
import { ThreadServiceStackRuntime, type ThreadServiceDeclaration } from "./ThreadServiceStack.ts";
import { ThreadCredentialBroker } from "./CredentialBroker.ts";
import { desktopGateway } from "./DesktopGatewayService.ts";
import { ThreadPreviewProxy } from "./ThreadPreviewProxy.ts";
import {
  resolveSandboxCredentialProxyImage,
  ThreadCredentialProxySidecar,
} from "./SandboxCredentialProxy.ts";
import { ServerConfig } from "../config.ts";

const credentialBroker = new ThreadCredentialBroker();

const noop = () => {};

/**
 * Resolves the sandbox container image for a project: the `.t3` project file's
 * `sandbox.image` wins over the `T3_SANDBOX_IMAGE` environment default.
 * Returns undefined when sandboxing is not configured for this deployment.
 */
export function resolveSandboxImage(
  projectFile: { readonly sandbox?: { readonly image?: string } } | undefined,
): string | undefined {
  const image = projectFile?.sandbox?.image ?? process.env.T3_SANDBOX_IMAGE?.trim();
  return image ? image : undefined;
}

/** Resolves the preview-proxy sidecar image required by sandbox provisioning. */
export function resolveSandboxPreviewProxyImage(): string | undefined {
  const image = process.env.T3_SANDBOX_PREVIEW_PROXY_IMAGE?.trim();
  return image ? image : undefined;
}

/**
 * Deployment default for the container runtime binary.
 *
 * `sandboxConfig.runtime` is a valid contract field but no client populates it,
 * so without this the reactor's `?? "docker"` fallback is the only reachable
 * value and a podman-only host can never be selected. Returns the raw value
 * rather than narrowing it: the caller's existing docker/podman check then
 * rejects a typo loudly instead of silently routing threads at the wrong
 * runtime. Unset yields "docker", so nothing changes by default.
 */
/** The container runtime's stderr, when the failure carries one. */
const runtimeStderr = (error: Error): string =>
  "stderr" in error && typeof error.stderr === "string" ? error.stderr.trim() : "";

export function resolveSandboxRuntime(): string {
  const configured = process.env.T3_SANDBOX_RUNTIME?.trim().toLowerCase();
  return configured ? configured : "docker";
}

/**
 * Deployment-level desktop gate. `T3_SANDBOX_DESKTOP=disabled` runs sandboxes
 * headless: no X server, no WebRTC streaming, no automation target. Defaults to
 * "enabled" so nothing changes for deployments that never set the variable.
 *
 * This is intentionally an env var rather than `sandboxConfig.desktop`, which
 * is declared in contracts but read by nothing — the choice is a property of
 * the host image, not of a project.
 */
export function resolveSandboxDesktopMode(): "enabled" | "disabled" {
  return process.env.T3_SANDBOX_DESKTOP?.trim().toLowerCase() === "disabled"
    ? "disabled"
    : "enabled";
}

/** Preview routing is unnecessary only for a headless thread with no declared preview ports. */
export function sandboxPreviewProxyRequired(previewPorts?: ReadonlyArray<number>): boolean {
  return resolveSandboxDesktopMode() === "enabled" || (previewPorts?.length ?? 0) > 0;
}

/**
 * Ceiling on an archived provider conversation store, in bytes.
 *
 * The age-based artifact sweep only reclaims whole sets long after their last
 * export; this bounds each set's size at write time. Measured on a real host,
 * one long thread's transcript alone reached ~30MB, so the default is set well
 * above ordinary threads while still bounding the pathological ones.
 */
export function resolveSandboxStoreMaxBytes(): number {
  const raw = Number.parseInt(process.env.T3_SANDBOX_STORE_MAX_BYTES?.trim() ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 50 * 1024 * 1024;
}

/**
 * Age ceiling for exported sandbox artifact sets, in seconds.
 *
 * Filenames are `sha256(threadId)` and every export overwrites the same set,
 * so per-thread growth is already bounded -- what leaks is sets for threads
 * that were deleted out-of-band or settled long ago. Defaults to 30 days: old
 * enough that a returning thread almost always finds its export (deleting a
 * set degrades re-provision to a plain clone and loses the provider's archived
 * conversation), young enough that the directory stops growing without bound.
 * An explicit `T3_SANDBOX_ARTIFACT_MAX_AGE_SECONDS=0` disables the sweep;
 * anything unparseable or negative falls back to the default.
 */
export function resolveSandboxArtifactMaxAgeSeconds(): number {
  const raw = Number.parseInt(process.env.T3_SANDBOX_ARTIFACT_MAX_AGE_SECONDS?.trim() ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 30 * 24 * 60 * 60;
}

/**
 * Ceiling on artifact sets removed by one sweep pass. The directory is flat
 * and one set is three files, so a pass is cheap -- the cap only exists so a
 * pathological backlog cannot pin the sweep for minutes; the remainder goes
 * on the next pass.
 */
const ARTIFACT_SWEEP_MAX_SETS = 1000;

/** One-shot credential boundary used immediately before provider process spawn. */
export function redeemSandboxProviderEnvironment(
  threadId: string,
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const redeemed: Record<string, string> = {};
  for (const [scope, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    const grant = credentialBroker.issue({ threadId, scope, value, ttlMs: 60_000 });
    const result = credentialBroker.redeem({ ...grant, threadId, scope });
    if (result === null) throw new Error(`credential grant for ${scope} was denied`);
    redeemed[scope] = result;
  }
  return redeemed;
}

/**
 * One thread's provision attempt: the authorization `authorizeProvision`
 * issues, and the identity everything that attempt goes on to do is decided
 * against.
 *
 * What this replaced was a per-thread BOOLEAN stop tombstone -- set by `stop`,
 * cleared by `authorizeProvision` -- and a boolean cannot tell two attempts
 * apart. Three separate defects were the same defect:
 *
 * - A stop invalidated provision A; provision B was then authorized, which
 *   cleared the thread's one tombstone; and A -- still queued, holding no lock
 *   because it had not reached the manager yet -- was admitted under B's
 *   authorization and built a container for a thread nothing would ever stop
 *   again.
 * - Readiness was not attempt-scoped either, so A's refused
 *   `sandbox.provision.ready` tore down the container B had just published,
 *   leaving the projection saying `ready` over a sandbox that no longer
 *   existed.
 * - The tombstone set had to be capped and evicted, and the entry a queued
 *   provision depends on is exactly the one with no lifecycle lock to spare it
 *   from eviction -- so the cap put the first leak straight back.
 *
 * A per-thread authorization dissolves all three at once. Admission compares
 * tokens instead of consulting a flag, so a stale attempt is refused however
 * long it queued and whatever else has happened since; teardown names the
 * attempt that owns the container, so it can only ever destroy its own; and
 * refusing anyone who cannot present the current token means "stopped" needs
 * no tombstone at all -- the manager holds one entry per LIVE thread, which is
 * O(threads) and needs no cap and no eviction.
 *
 * `generation` is unique across the manager, not per thread: entries are
 * dropped when a thread stops, and a per-thread counter would restart at 1 and
 * hand a re-authorized thread a number a token still in flight already holds.
 *
 * Opaque to callers, who only ever pass it back.
 */
export type SandboxProvisionAttempt = {
  readonly threadId: string;
  readonly generation: number;
};

export type ManagedSandboxReady = SandboxReady & {
  /** Absent when the deployment runs headless (`T3_SANDBOX_DESKTOP=disabled`). */
  readonly desktopSessionId?: string;
  readonly desktopStreamPath?: string;
  readonly services: ReadonlyArray<{
    readonly name: string;
    readonly internalPorts: ReadonlyArray<number>;
  }>;
  /**
   * The attempt that built this sandbox, echoed back so the caller's readiness
   * teardown names it rather than "whatever this thread has now".
   *
   * Carried on the provision result rather than through a channel of its own:
   * the caller already passes this value from `provision` to the readiness
   * dispatch, and a second channel would be one more thing that can disagree
   * with it.
   */
  readonly attempt: SandboxProvisionAttempt;
};

export interface SandboxRuntimeManagerShape {
  readonly exec?: (
    runtime: "docker" | "podman",
    threadId: string,
    input: SandboxExecInput,
  ) => Effect.Effect<SandboxCommandResult, SandboxManagerError>;
  /**
   * Opens a provision attempt for the thread and returns the token that
   * identifies it.
   *
   * Called once the decider has ACCEPTED a `sandbox.provision` for the thread
   * and immediately before provisioning it. The manager cannot tell a
   * legitimate re-provision of a stopped thread from a stale provision that
   * was already in flight when a deletion stopped the thread -- both arrive as
   * a bare `provision` call -- so the caller, which has just had the one
   * authority on the lifecycle accept its command, says so, and the token it
   * gets back is what distinguishes ITS provision from every other one.
   *
   * The token issued here is the thread's authorization until the next
   * `authorizeProvision` or `stop` replaces it.
   */
  readonly authorizeProvision: (threadId: string) => Effect.Effect<SandboxProvisionAttempt>;
  /**
   * `attempt` is the token `authorizeProvision` returned for this provision,
   * and admission is decided on nothing else: a `stop` or a newer
   * `authorizeProvision` invalidates it, and this provision is then refused no
   * matter how long it sat queued before reaching the manager.
   */
  readonly provision: (
    input: SandboxProvisionInput & {
      services?: ReadonlyArray<ThreadServiceDeclaration>;
      attempt: SandboxProvisionAttempt;
    },
  ) => Effect.Effect<ManagedSandboxReady, SandboxManagerError>;
  /**
   * Tear down the sandbox an attempt published, and only that one.
   *
   * For the caller whose `sandbox.provision.ready` the decider refused: the
   * containers it built have to go, but a plain `stop` would destroy whatever
   * the thread has NOW, which after a stop and a re-provision is a newer
   * attempt's container -- leaving the projection saying `ready` over a
   * sandbox that no longer exists. So this runs the teardown only while the
   * attempt is still the thread's current authorization, and does nothing
   * otherwise: anything the attempt left behind in that case was already
   * destroyed by the stop that superseded it, or belongs to a thread whose own
   * teardown and reconcile pass will account for it.
   */
  readonly stopProvisionAttempt: (
    runtime: "docker" | "podman",
    attempt: SandboxProvisionAttempt,
  ) => Effect.Effect<void, SandboxManagerError>;
  /**
   * `hint` lets export and teardown reach a sandbox this manager generation
   * never provisioned -- a server restart empties the backend's per-thread
   * records, which otherwise strands the thread's commits in its volume.
   */
  readonly exportBranch: (
    runtime: "docker" | "podman",
    threadId: string,
    hint?: SandboxAdoptionHint,
  ) => Effect.Effect<SandboxArtifactExport, SandboxManagerError>;
  readonly stop: (
    runtime: "docker" | "podman",
    threadId: string,
    hint?: SandboxAdoptionHint,
  ) => Effect.Effect<void, SandboxManagerError>;
  readonly reconcile: (
    runtime: "docker" | "podman",
    expectedThreadIds: ReadonlySet<string>,
    adoptionHints?: ReadonlyMap<string, SandboxAdoptionHint>,
  ) => Effect.Effect<SandboxReconcileResult, SandboxManagerError>;
  readonly sampleUsage: (
    runtime: "docker" | "podman",
    threadId: string,
  ) => Effect.Effect<SandboxUsageSample, SandboxManagerError>;
  readonly recoverPreview: (
    runtime: "docker" | "podman",
    threadId: string,
    hostname: string,
    ports: ReadonlyArray<number>,
  ) => Effect.Effect<boolean, SandboxManagerError>;
  readonly revokeCredentials: (threadId: string) => Effect.Effect<number>;
  /**
   * Deletes the thread's exported sandbox artifacts -- the branch bundle,
   * manifest, and archived provider conversation store. Called when the thread
   * itself is deleted: the transcripts and commits in the artifact directory
   * must not outlive the thread they belong to.
   */
  readonly removeThreadArtifacts: (threadId: string) => Effect.Effect<void, SandboxManagerError>;
  /**
   * Deletes exported artifact sets whose newest file is older than
   * `T3_SANDBOX_ARTIFACT_MAX_AGE_SECONDS`, except sets belonging to
   * `protectedThreadIds` -- threads whose sandbox is still in a non-terminal
   * lifecycle, whose next stop will overwrite the set anyway. Returns the
   * number of sets removed.
   */
  readonly sweepExpiredArtifacts: (
    protectedThreadIds: ReadonlySet<string>,
  ) => Effect.Effect<number, SandboxManagerError>;
}

export class SandboxManagerError extends Schema.TaggedErrorClass<SandboxManagerError>()(
  "SandboxManagerError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

/**
 * Builds a manager over a command executor. Tests supply their own executor to
 * observe the exact runtime invocations without launching containers.
 */
export const makeSandboxRuntimeManager = (
  artifactRoot: string | undefined,
  platform: NodeJS.Platform,
  commandExecutor?: SandboxCommandExecutor,
): SandboxRuntimeManagerShape => {
  const executor = commandExecutor ?? new NodeSandboxCommandExecutor(platform);
  const runtimes = new Map<
    "docker" | "podman",
    {
      backend: ContainerSandboxBackend;
      desktop: ThreadDesktopRuntime;
      services: ThreadServiceStackRuntime;
      previews: ThreadPreviewProxy;
      credentials: ThreadCredentialProxySidecar;
    }
  >();
  const teardownHooks = new Map<string, NonNullable<SandboxProvisionInput["teardown"]>>();
  /**
   * Serializes everything that writes or deletes one thread's artifact set.
   *
   * Export and deletion used to race: deletion removed the set immediately
   * after enqueuing the stop, and an export already in flight then renamed
   * fresh canonical files into place behind it -- leaving a deleted thread's
   * transcripts and commits on disk forever. One entry per thread with an
   * in-flight operation, deleted as soon as the chain drains.
   */
  const artifactLocks = new Map<string, Promise<unknown>>();
  const withArtifactLock = async <A>(threadId: string, run: () => Promise<A>): Promise<A> => {
    const previous = artifactLocks.get(threadId);
    // Chained off the predecessor's settlement, not its value: one failed
    // export must not poison every later operation on the same thread.
    const settled = previous === undefined ? Promise.resolve() : previous.then(noop, noop);
    const started = settled.then(run);
    const tail = started.then(noop, noop);
    artifactLocks.set(threadId, tail);
    try {
      return await started;
    } finally {
      // Only the last link clears the entry; an operation queued behind this
      // one has already replaced it.
      if (artifactLocks.get(threadId) === tail) artifactLocks.delete(threadId);
    }
  };
  /**
   * Serializes a thread's WHOLE provision against its whole stop.
   *
   * The backend has a tombstone of its own, and it stays the inner guard --
   * but it only spans `ensureReady`. A provision keeps going long after that
   * returns: it starts the service stack, the preview proxy, the credential
   * proxy, and the desktop sidecar, and publishes the thread's gateway state.
   * A stop synchronized against the backend alone therefore destroyed whatever
   * existed at that instant, reported the thread stopped, and left every
   * sidecar created moments afterwards running forever -- unreferenced
   * containers, live preview routes, and readable credential grants belonging
   * to a thread nothing would ever stop again.
   *
   * Held here because this is the only level where the whole lifecycle is
   * visible. A stop arriving mid-provision now waits for the provision to
   * finish publishing and then tears down exactly what it published.
   *
   * Re-entrancy is not a concern: every unwind inside the provision drives the
   * per-runtime components directly (`managed.backend.stop`,
   * `managed.previews.stop`, ...) rather than this manager's `stop`, so
   * nothing running under this lock ever asks for it again.
   *
   * Refcounted rather than left in place: unlike the artifact lock below,
   * whose presence is read as "this thread still has work queued", this one
   * carries no meaning once idle, and a permanent entry per thread would leak
   * on a long-lived server.
   */
  const lifecycleLocks = new Map<
    string,
    { readonly semaphore: Semaphore.Semaphore; waiting: number }
  >();
  const withLifecycleLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      const existing = lifecycleLocks.get(threadId);
      const entry = existing ?? { semaphore: Semaphore.makeUnsafe(1), waiting: 0 };
      // Counted BEFORE the wait, not after acquisition: an operation queued
      // behind the current holder has to keep the entry alive, or the holder's
      // release would drop it and the waiter would be admitted against a fresh
      // semaphore that grants immediately.
      entry.waiting += 1;
      if (existing === undefined) lifecycleLocks.set(threadId, entry);
      return entry.semaphore
        .withPermits(1)(effect)
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              entry.waiting -= 1;
              if (entry.waiting === 0 && lifecycleLocks.get(threadId) === entry)
                lifecycleLocks.delete(threadId);
            }),
          ),
        );
    });
  /**
   * The provision attempt each thread is currently authorized for, and with it
   * the identity of whatever sandbox that thread has.
   *
   * The lock above only orders operations that have already ENTERED this
   * manager, and a provision spends real time getting here: the reactor
   * dispatches `sandbox.provision`, loads the project file, and derives the
   * branch first. A deletion issued in that window took the lock uncontended,
   * found no record, reported "nothing to do", and returned -- and the
   * provision then ran against a thread that was already terminal, creating a
   * container, sidecars, a network, and volumes with nothing left holding a
   * reference to them. Ordering was never the missing piece; the provision has
   * to be TOLD that a stop went past it.
   *
   * This was a per-thread boolean tombstone. It could say that a stop had gone
   * past SOMETHING, never past WHICH provision, and `SandboxProvisionAttempt`
   * records the three defects that followed from exactly that. Holding the
   * thread's current authorization instead answers the question the tombstone
   * could not, and answers it for admission and for teardown alike.
   *
   * No cap and no eviction, unlike `deletedThreadArtifacts` below. A tombstone
   * had to be kept for every thread ever stopped, and the entry a queued
   * provision depends on is precisely the one holding no lifecycle lock to
   * spare it from eviction -- so bounding the set reintroduced the leak it
   * existed to prevent. Here a thread's entry is DELETED when it stops,
   * because refusing everyone who cannot present the current token already
   * refuses the stale provision: the absence of an entry and a superseded
   * entry are the same answer. What is left is one entry per live thread.
   *
   * `attempts` is a single counter across every thread, not one per thread:
   * entries are deleted, and a per-thread counter restarting at 1 would hand a
   * re-authorized thread a generation a token still in flight already holds.
   */
  const threadProvisionAttempts = new Map<string, number>();
  let attempts = 0;
  const openProvisionAttempt = (threadId: string): SandboxProvisionAttempt => {
    attempts += 1;
    threadProvisionAttempts.set(threadId, attempts);
    return { threadId, generation: attempts };
  };
  const isCurrentAttempt = (attempt: SandboxProvisionAttempt) =>
    threadProvisionAttempts.get(attempt.threadId) === attempt.generation;
  /**
   * Threads whose artifacts have been deleted, so an export that was already
   * running when the deletion landed discards its temporaries instead of
   * renaming them into place after the removal.
   *
   * The lock above orders the two operations but cannot decide them: an export
   * that wins the lock still finishes by publishing files for a thread that no
   * longer exists.
   *
   * Bounded, but never at the cost of correctness: a tombstone is only
   * evictable once every operation queued on that thread's artifact lock has
   * drained. Plain FIFO eviction at a fixed cap was wrong -- a busy server that
   * deletes 4096 threads while one slow export is still running drops that
   * thread's tombstone, and the export then republishes a deleted thread's
   * transcripts and commits with nothing left to ever remove them. An entry in
   * `artifactLocks` is exactly "this thread still has artifact work queued",
   * so the cap is enforced against everything else and the set holds at most a
   * few extra entries while those settle.
   */
  const deletedThreadArtifacts = new Set<string>();
  const DELETED_ARTIFACT_TOMBSTONES = 4096;
  const tombstoneThreadArtifacts = (threadId: string) => {
    deletedThreadArtifacts.add(threadId);
    if (deletedThreadArtifacts.size <= DELETED_ARTIFACT_TOMBSTONES) return;
    for (const candidate of deletedThreadArtifacts) {
      if (deletedThreadArtifacts.size <= DELETED_ARTIFACT_TOMBSTONES) break;
      // Oldest first, but never one an export could still be racing. The
      // thread being tombstoned right now always has a lock (this runs inside
      // it), so it is never its own eviction victim.
      if (artifactLocks.has(candidate)) continue;
      deletedThreadArtifacts.delete(candidate);
    }
  };
  const get = (runtime: "docker" | "podman") => {
    const existing = runtimes.get(runtime);
    if (existing) return existing;
    const backend = new ContainerSandboxBackend(runtime, executor);
    const value = {
      backend,
      desktop: new ThreadDesktopRuntime(backend),
      services: new ThreadServiceStackRuntime(runtime, executor),
      previews: new ThreadPreviewProxy(runtime, executor, desktopGateway.previews),
      credentials: new ThreadCredentialProxySidecar(runtime, executor),
    };
    runtimes.set(runtime, value);
    return value;
  };
  /**
   * Bootstrap fields that seed a sandbox from the branch bundle a previous
   * teardown exported, or `undefined` when this is not a restore.
   *
   * A missing or tampered artifact is not fatal: the thread still gets a
   * sandbox, seeded the ordinary way at its recorded base commit. Losing the
   * previous session's commits is bad, but refusing to provision at all would
   * leave the user with a thread they cannot use either way.
   */
  const resolveRestoreBootstrap = Effect.fn("SandboxRuntimeManager.resolveRestoreBootstrap")(
    function* (input: SandboxProvisionInput) {
      const restore = input.restore;
      if (restore === undefined || artifactRoot === undefined) return undefined;
      if (!/^[a-f0-9]{64}$/i.test(restore.artifactId)) {
        yield* Effect.logWarning("sandbox restore artifact id is malformed", {
          threadId: input.bootstrap.threadId,
        });
        return undefined;
      }
      const bundle = NodePath.resolve(artifactRoot, `${restore.artifactId}.bundle`);
      const digest = yield* Effect.tryPromise(async () =>
        NodeCrypto.createHash("sha256")
          .update(await NodeFSP.readFile(bundle))
          .digest("hex"),
      ).pipe(Effect.orElseSucceed(() => undefined));
      if (digest === undefined) {
        yield* Effect.logWarning("sandbox restore bundle is missing; seeding from base commit", {
          threadId: input.bootstrap.threadId,
          bundle,
        });
        return undefined;
      }
      if (digest !== restore.bundleSha256.toLowerCase()) {
        yield* Effect.logWarning("sandbox restore bundle failed its digest check", {
          threadId: input.bootstrap.threadId,
          bundle,
        });
        return undefined;
      }
      // A store is optional in a way the bundle is not: exports written before
      // stores existed have no digest, and a mismatch or missing file just
      // means the provider starts fresh.
      const storePath = yield* Effect.gen(function* () {
        if (restore.storeSha256 === undefined) return undefined;
        const candidate = NodePath.resolve(artifactRoot, `${restore.artifactId}.store.tar`);
        const storeDigest = yield* Effect.tryPromise(async () =>
          NodeCrypto.createHash("sha256")
            .update(await NodeFSP.readFile(candidate))
            .digest("hex"),
        ).pipe(Effect.orElseSucceed(() => undefined));
        if (storeDigest === undefined) {
          yield* Effect.logWarning(
            "sandbox restore provider store is missing; provider will start without prior context",
            { threadId: input.bootstrap.threadId, store: candidate },
          );
          return undefined;
        }
        if (storeDigest !== restore.storeSha256.toLowerCase()) {
          yield* Effect.logWarning(
            "sandbox restore provider store failed its digest check; provider will start without prior context",
            { threadId: input.bootstrap.threadId, store: candidate },
          );
          return undefined;
        }
        return candidate;
      });
      return {
        ...input.bootstrap,
        repositoryBundlePath: bundle,
        ...(storePath === undefined ? {} : { providerStorePath: storePath }),
        // `exportBundle` names the thread branch explicitly, so it is in there
        // under its ordinary heads ref -- the seeding fetch has to name it too,
        // since a bundle fetch takes no default refspec.
        repositoryBundleRef: `refs/heads/${restore.branchName}`,
        restoreCommit: restore.headCommit,
        // From the event log, which is the only record of this that verifies
        // against anything -- a manifest sitting beside the bundle is written
        // by whoever wrote the bundle.
        ...(restore.snapshotCommit === undefined
          ? {}
          : { restoreSnapshotCommit: restore.snapshotCommit }),
      };
    },
  );

  const attempt = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => {
        // `SandboxRuntimeError` carries the container runtime's stderr, and it
        // is the only thing that says WHY a command failed. Dropping it here
        // left every failure reading as a bare "podman network failed" --
        // undiagnosable from the thread's recorded failure or from the logs.
        const detail = cause instanceof Error ? runtimeStderr(cause) : "";
        return new SandboxManagerError({
          message:
            cause instanceof Error
              ? detail.length > 0
                ? `${cause.message}: ${detail}`
                : cause.message
              : String(cause),
          cause,
        });
      },
    });
  const provisionUnsynchronized = Effect.fn("SandboxRuntimeManager.provision")(function* (
    input: Parameters<SandboxRuntimeManagerShape["provision"]>[0],
  ) {
    const previewRequired = sandboxPreviewProxyRequired(input.previewPorts);
    const previewImage = resolveSandboxPreviewProxyImage();
    if (previewRequired && !previewImage)
      return yield* new SandboxManagerError({
        message:
          "T3_SANDBOX_PREVIEW_PROXY_IMAGE is required when desktop streaming or preview ports are enabled",
      });
    // Per-thread config wins, then the deployment default. Callers validate the
    // runtime before dispatching but pass `config` through verbatim, so the
    // deployment default has to be applied here or a podman-only host runs
    // docker.
    const runtime = input.config?.runtime ?? resolveSandboxRuntime();
    if (runtime !== "docker" && runtime !== "podman")
      return yield* new SandboxManagerError({
        message: `unsupported sandbox runtime: ${runtime}`,
      });
    const trustedCaches = new Set(
      (process.env.T3_SANDBOX_TRUSTED_CACHE_DIGESTS ?? "")
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    );
    for (const cache of input.caches ?? []) {
      if (!trustedCaches.has(cache.digest.toLowerCase())) {
        return yield* new SandboxManagerError({
          message: `cache ${cache.digest} is absent from the server-trusted cache manifest`,
        });
      }
    }
    const managed = get(runtime);
    let provisionInput = input;
    let seedBundle: string | undefined;
    const restored = yield* resolveRestoreBootstrap(input);
    if (restored !== undefined) {
      provisionInput = { ...input, bootstrap: restored };
    } else if (!/^(?:https|ssh):\/\//i.test(input.bootstrap.repositoryUrl)) {
      if (artifactRoot === undefined)
        return yield* new SandboxManagerError({
          message: "local repository seeding requires configured server artifact storage",
        });
      const seedRoot = NodePath.resolve(artifactRoot, "seeds");
      yield* attempt(() => NodeFSP.mkdir(seedRoot, { recursive: true, mode: 0o700 }));
      const seedHash = NodeCrypto.createHash("sha256")
        .update(input.bootstrap.threadId)
        .digest("hex");
      seedBundle = NodePath.resolve(seedRoot, `.${seedHash}.${process.pid}.bundle`);
      // `git bundle create` refuses a bare commit SHA ("Refusing to create empty
      // bundle") because a bundle records named refs, not anonymous commits. Pin a
      // throwaway ref at the base commit so the bundle has something to name, then
      // remove it once the bundle is written.
      const seedRef = `refs/t3-sandbox-seed/${seedHash}.${process.pid}`;
      yield* attempt(async () => {
        const refUpdated = await executor.run({
          executable: "git",
          args: [
            "-C",
            input.bootstrap.repositoryUrl,
            "update-ref",
            seedRef,
            input.bootstrap.baseCommit,
          ],
          timeoutMs: 30_000,
        });
        if (refUpdated.exitCode !== 0)
          throw new Error(refUpdated.stderr || "failed to pin local repository seed ref");
        try {
          const created = await executor.run({
            executable: "git",
            args: ["-C", input.bootstrap.repositoryUrl, "bundle", "create", seedBundle!, seedRef],
            timeoutMs: 120_000,
          });
          if (created.exitCode !== 0)
            throw new Error(created.stderr || "failed to create local repository seed bundle");
          // `bundle verify` resolves the bundle's prerequisites against a
          // repository, so it needs `-C` even though the bundle names a full
          // history; without it git exits with "need a repository to verify a
          // bundle" wherever the server happens to be running.
          const verified = await executor.run({
            executable: "git",
            args: ["-C", input.bootstrap.repositoryUrl, "bundle", "verify", seedBundle!],
            timeoutMs: 60_000,
          });
          if (verified.exitCode !== 0)
            throw new Error(verified.stderr || "local repository seed bundle failed verification");
        } finally {
          await executor.run({
            executable: "git",
            args: ["-C", input.bootstrap.repositoryUrl, "update-ref", "-d", seedRef],
            timeoutMs: 30_000,
          });
        }
      });
      provisionInput = {
        ...input,
        bootstrap: {
          ...input.bootstrap,
          repositoryBundlePath: seedBundle,
          repositoryBundleRef: seedRef,
        },
      };
    }
    const ready = yield* attempt(() => managed.backend.ensureReady(provisionInput)).pipe(
      Effect.ensuring(
        seedBundle === undefined
          ? Effect.void
          : Effect.promise(() => NodeFSP.rm(seedBundle!, { force: true })),
      ),
    );
    teardownHooks.set(input.bootstrap.threadId, input.teardown ?? []);
    const services = yield* attempt(() =>
      managed.services.start(input.bootstrap.threadId, input.services ?? [], ready.networkName),
    ).pipe(
      Effect.tapError(() =>
        Effect.promise(async () => {
          teardownHooks.delete(input.bootstrap.threadId);
          await managed.backend.stop(input.bootstrap.threadId).catch(() => undefined);
        }),
      ),
    );
    desktopGateway.setServiceStatus(
      input.bootstrap.threadId,
      services.map((service) => ({ name: service.hostname, healthy: true })),
    );
    // A typed failure, not a bare `throw`: a defect thrown from inside this
    // generator escapes every `tapError` unwind below and leaks everything
    // provisioned so far -- containers, networks, and issued grants.
    const serviceGrants = yield* Effect.try({
      try: () =>
        services.flatMap((service) => {
          const declaration = input.services?.find(
            (candidate) => candidate.name === service.hostname,
          );
          return (declaration?.generatedEnvironment ?? []).map((entry) => {
            const value = service.environment[entry.key];
            if (value === undefined)
              throw new Error(
                `generated service credential ${service.hostname}:${entry.key} is missing`,
              );
            const scope = `service:${service.hostname}:${entry.key}`;
            return {
              ...desktopGateway.credentials.issue({
                threadId: input.bootstrap.threadId,
                scope,
                value,
                ttlMs: 15 * 60_000,
              }),
              scope,
            };
          });
        }),
      catch: (cause) =>
        new SandboxManagerError({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    }).pipe(
      Effect.tapError(() =>
        Effect.promise(async () => {
          // Grants issued before the failing service are revoked with the
          // rest of the thread's gateway state.
          desktopGateway.removeThread(input.bootstrap.threadId);
          teardownHooks.delete(input.bootstrap.threadId);
          await managed.services.stop(input.bootstrap.threadId);
          await managed.backend.stop(input.bootstrap.threadId).catch(() => undefined);
        }),
      ),
    );
    desktopGateway.setServiceCredentialGrants(input.bootstrap.threadId, serviceGrants);
    managed.services.redactCredentials(input.bootstrap.threadId);
    const credentialImage = resolveSandboxCredentialProxyImage();
    yield* attempt(async () => {
      const starts: Array<Promise<void>> = [];
      if (previewRequired && previewImage !== undefined)
        starts.push(
          managed.previews.start(input.bootstrap.threadId, ready.networkName, previewImage),
        );
      if (credentialImage !== undefined)
        starts.push(
          managed.credentials.start(
            input.bootstrap.threadId,
            ready.networkName,
            credentialImage,
            input.egressProxyImage !== undefined || input.egressProxyUrl !== undefined,
          ),
        );
      const results = await Promise.allSettled(starts);
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failure !== undefined) throw failure.reason;
    }).pipe(
      Effect.tapError(() =>
        Effect.promise(async () => {
          // Service status and credential grants are already registered on
          // the gateway at this point; a failed provision must not leave
          // them readable against a container that is being destroyed.
          desktopGateway.removeThread(input.bootstrap.threadId);
          await managed.previews.stop(input.bootstrap.threadId);
          await managed.services.stop(input.bootstrap.threadId);
          teardownHooks.delete(input.bootstrap.threadId);
          await managed.backend.stop(input.bootstrap.threadId).catch(() => undefined);
        }),
      ),
    );
    if (previewRequired) desktopGateway.setPreviewProxy(input.bootstrap.threadId, managed.previews);
    for (const port of input.previewPorts ?? []) {
      desktopGateway.registerPreviewRoute({
        routeId: `${NodeCrypto.createHash("sha256").update(`${input.bootstrap.threadId}\0${port}`).digest("hex").slice(0, 24)}`,
        threadId: input.bootstrap.threadId,
        hostname: ready.containerName,
        internalPort: port,
        token: NodeCrypto.randomBytes(32).toString("base64url"),
      });
    }
    // Headless deployments stop here: no desktop runtime, no automation
    // target. The preview sidecar above still runs, since preview routing is
    // independent of the streamed desktop.
    const desktop =
      resolveSandboxDesktopMode() === "disabled"
        ? undefined
        : yield* attempt(() =>
            managed.desktop.start(
              input.bootstrap.threadId,
              desktopGateway.bridge(input.bootstrap.threadId),
              managed.previews.internalSignalingOrigin(input.bootstrap.threadId),
            ),
          ).pipe(
            Effect.tapError(() =>
              Effect.promise(async () => {
                // Clears preview routes, the thread's preview-proxy entry,
                // service status, and credential grants -- the gateway state
                // registered above that would otherwise outlive the
                // containers this unwind destroys.
                desktopGateway.removeThread(input.bootstrap.threadId);
                await managed.credentials.stop(input.bootstrap.threadId);
                await managed.services.stop(input.bootstrap.threadId);
                await managed.previews.stop(input.bootstrap.threadId);
                teardownHooks.delete(input.bootstrap.threadId);
                await managed.backend.stop(input.bootstrap.threadId).catch(() => undefined);
              }),
            ),
          );
    if (desktop !== undefined) {
      const automation = managed.desktop.automationTarget(input.bootstrap.threadId);
      desktopGateway.setAutomationTarget(
        input.bootstrap.threadId,
        ready.containerName,
        automation.profilePath,
      );
    }
    return {
      ...ready,
      ...(desktop === undefined
        ? {}
        : { desktopSessionId: desktop.sessionId, desktopStreamPath: desktop.signalingPath }),
      services: services.map((service) => ({
        name: service.hostname,
        internalPorts: service.internalPorts,
      })),
    };
  });

  const stopUnsynchronized = Effect.fn("SandboxRuntimeManager.stop")(function* (
    runtime: "docker" | "podman",
    threadId: string,
    hint: SandboxAdoptionHint | undefined,
  ) {
    const managed = get(runtime);
    if (resolveSandboxDesktopMode() !== "disabled")
      yield* Effect.promise(() => managed.desktop.stop(threadId));
    yield* Effect.promise(() => managed.credentials.stop(threadId));
    yield* Effect.promise(() => managed.previews.stop(threadId));
    yield* Effect.promise(() => managed.services.stop(threadId));
    credentialBroker.revokeThread(threadId);
    desktopGateway.removeThread(threadId);
    yield* attempt(() => managed.backend.stop(threadId, teardownHooks.get(threadId) ?? [], hint));
    teardownHooks.delete(threadId);
  });

  return {
    exec: Effect.fn("SandboxRuntimeManager.exec")(function* (runtime, threadId, input) {
      return yield* attempt(() => get(runtime).backend.exec(threadId, input));
    }),
    authorizeProvision: (threadId) => Effect.sync(() => openProvisionAttempt(threadId)),
    provision: (input) =>
      withLifecycleLock(
        input.bootstrap.threadId,
        // Compared UNDER the lock, not before it: a stop that ran while this
        // provision was still queued -- or that ran to completion before it
        // ever reached this manager -- has already replaced the thread's
        // authorization, and that is only visible here.
        Effect.suspend(() =>
          isCurrentAttempt(input.attempt)
            ? provisionUnsynchronized(input).pipe(
                Effect.map((ready) => ({ ...ready, attempt: input.attempt })),
              )
            : new SandboxManagerError({
                message: `sandbox for thread ${input.bootstrap.threadId} was stopped before provisioning began`,
              }),
        ),
      ),
    exportBranch: (runtime, threadId, hint) =>
      // Under the per-thread artifact lock so an export and a thread deletion
      // cannot interleave their filesystem work.
      attempt(() =>
        withArtifactLock(threadId, async () => {
          if (artifactRoot === undefined)
            throw new Error(
              "sandbox artifact storage requires the configured server runtime layer",
            );
          await NodeFSP.mkdir(artifactRoot, { recursive: true, mode: 0o700 });
          const name = NodeCrypto.createHash("sha256").update(threadId).digest("hex");
          const bundleTemporary = NodePath.resolve(
            artifactRoot,
            `.${name}.${process.pid}.bundle.tmp`,
          );
          const bundleDestination = NodePath.resolve(artifactRoot, `${name}.bundle`);
          const manifestTemporary = NodePath.resolve(
            artifactRoot,
            `.${name}.${process.pid}.json.tmp`,
          );
          const manifestDestination = NodePath.resolve(artifactRoot, `${name}.json`);
          const storeTemporary = NodePath.resolve(
            artifactRoot,
            `.${name}.${process.pid}.store.tmp`,
          );
          const storeDestination = NodePath.resolve(artifactRoot, `${name}.store.tar`);
          try {
            const result = await get(runtime).backend.exportBranch(threadId, hint);
            // The snapshot this export just pinned, named into the bundle. The
            // bundle used to glob the snapshot namespace instead, which shipped
            // whatever cleanup had failed to remove -- an earlier export's tree,
            // and with it files the user has since deleted.
            await get(runtime).backend.exportBundle(threadId, bundleTemporary, {
              ...(result.snapshotCommit === undefined
                ? {}
                : { snapshotCommit: result.snapshotCommit }),
              ...(hint === undefined ? {} : { hint }),
            });
            const bundleSha256 = NodeCrypto.createHash("sha256")
              .update(await NodeFSP.readFile(bundleTemporary))
              .digest("hex");
            // The conversation store is a bonus, the branch is the point: a store
            // that fails to archive costs the next turn its context, while a
            // failure propagated from here would strand the user's commits inside
            // a container that is about to be deleted.
            const storeBytes = await get(runtime)
              .backend.exportProviderStore(
                threadId,
                storeTemporary,
                resolveSandboxStoreMaxBytes(),
                hint,
              )
              .catch(() => undefined);
            const storeSha256 =
              storeBytes === undefined
                ? undefined
                : await NodeFSP.readFile(storeTemporary)
                    .then((contents) =>
                      NodeCrypto.createHash("sha256").update(contents).digest("hex"),
                    )
                    .catch(() => undefined);
            await NodeFSP.writeFile(
              manifestTemporary,
              JSON.stringify({
                threadId,
                bundle: `${name}.bundle`,
                bundleSha256,
                // `storeServed: false` marks the store as a server-internal
                // artifact: re-provision reads it from disk to restore the
                // provider's conversation, but the artifact HTTP route serves
                // only `bundle` and `manifest` -- a client following the
                // manifest must not treat `store` as downloadable.
                ...(storeSha256 === undefined
                  ? {}
                  : { store: `${name}.store.tar`, storeServed: false, storeSha256, storeBytes }),
                ...result,
              }),
              { mode: 0o600, flag: "wx" },
            );
            // Checked immediately before the renames, under the per-thread
            // artifact lock: a deletion that landed while this export was
            // running has already removed the set, and publishing now would put
            // a deleted thread's transcripts and commits back on disk with
            // nothing left to ever remove them. The export still reports the
            // digests it computed -- the caller's event is about a container
            // that is going away either way, and the thread it belonged to no
            // longer exists to restore from them.
            if (!deletedThreadArtifacts.has(threadId)) {
              await NodeFSP.rename(bundleTemporary, bundleDestination);
              if (storeSha256 !== undefined) await NodeFSP.rename(storeTemporary, storeDestination);
              await NodeFSP.rename(manifestTemporary, manifestDestination);
            }
            return {
              ...result,
              artifactId: name,
              bundleSha256,
              ...(storeSha256 === undefined ? {} : { storeSha256 }),
            };
          } finally {
            await Promise.all([
              NodeFSP.rm(bundleTemporary, { force: true }),
              NodeFSP.rm(manifestTemporary, { force: true }),
              NodeFSP.rm(storeTemporary, { force: true }),
            ]);
          }
        }),
      ),
    stop: (runtime, threadId, hint) =>
      // The thread's authorization is dropped BEFORE queueing for the lock:
      // whichever of the two wins it, and whether or not this stop finds
      // anything to tear down, a provision still on its way has to arrive with
      // a token that no longer matches anything.
      Effect.suspend(() => {
        threadProvisionAttempts.delete(threadId);
        return withLifecycleLock(threadId, stopUnsynchronized(runtime, threadId, hint));
      }),
    stopProvisionAttempt: (runtime, attempt) =>
      // The attempt's own authorization is what says the sandbox on this
      // thread is still the one it built. A superseded attempt tears down
      // nothing: the stop that superseded it already destroyed what it
      // published, and anything newer belongs to a provision this one has no
      // claim on.
      Effect.suspend(() => {
        // Tested and dropped in one synchronous step, before anything can
        // yield: an `authorizeProvision` landing between the two would have
        // its brand-new authorization deleted by a teardown that had already
        // decided it was not the current one.
        if (!isCurrentAttempt(attempt))
          return Effect.logWarning(
            "not tearing down a refused sandbox readiness: a newer provision attempt owns this thread's sandbox",
            { threadId: attempt.threadId },
          );
        threadProvisionAttempts.delete(attempt.threadId);
        return withLifecycleLock(
          attempt.threadId,
          stopUnsynchronized(runtime, attempt.threadId, undefined),
        );
      }),
    reconcile: (runtime, expectedThreadIds, adoptionHints) =>
      attempt(async () => {
        const managed = get(runtime);
        const result = await managed.backend.reconcile({
          expectedThreadIds,
          removeOrphans: true,
          ...(adoptionHints === undefined ? {} : { adoptionHints }),
        });
        const headless = resolveSandboxDesktopMode() === "disabled";
        for (const threadId of result.activeThreadIds) {
          await managed.credentials.recover(threadId);
          // Headless threads have no desktop to recover, and marking them as
          // capability failures would report a desktop that was never started.
          if (headless) {
            await managed.previews.recover(threadId);
            continue;
          }
          const desktop = await managed.desktop.recover(threadId);
          if (desktop === null) {
            desktopGateway.setCapabilityFailure(threadId, ["desktop-session"]);
          } else {
            const automation = managed.desktop.automationTarget(threadId);
            const runtimeRef = managed.backend.runtimeRef(threadId);
            desktopGateway.setAutomationTarget(
              threadId,
              runtimeRef ?? automation.endpoint,
              automation.profilePath,
            );
          }
        }
        return result;
      }),
    sampleUsage: (runtime, threadId) => attempt(() => get(runtime).backend.sampleUsage(threadId)),
    recoverPreview: (runtime, threadId, hostname, ports) =>
      attempt(async () => {
        if (ports.length === 0) return false;
        const previews = get(runtime).previews;
        if (!(await previews.recover(threadId))) return false;
        desktopGateway.setPreviewProxy(threadId, previews);
        for (const port of ports)
          desktopGateway.registerPreviewRoute({
            routeId: NodeCrypto.createHash("sha256")
              .update(`${threadId}\0${port}`)
              .digest("hex")
              .slice(0, 24),
            threadId,
            hostname,
            internalPort: port,
            token: NodeCrypto.randomBytes(32).toString("base64url"),
          });
        return true;
      }),
    revokeCredentials: (threadId) => Effect.sync(() => credentialBroker.revokeThread(threadId)),
    removeThreadArtifacts: (threadId) =>
      attempt(() =>
        withArtifactLock(threadId, async () => {
          // Tombstoned before the lock's work and outside the artifactRoot
          // guard: an export that is already past its own lock check but has
          // not yet renamed still has to see this, and a manager without
          // artifact storage has no files to remove but can still be asked to
          // delete a thread.
          tombstoneThreadArtifacts(threadId);
          if (artifactRoot === undefined) return;
          // The artifact id is derived from the thread id exactly as
          // `exportBranch` derives it, so deletion needs no manifest lookup.
          const name = NodeCrypto.createHash("sha256").update(threadId).digest("hex");
          await Promise.all(
            [`${name}.bundle`, `${name}.json`, `${name}.store.tar`].map((file) =>
              NodeFSP.rm(NodePath.resolve(artifactRoot, file), { force: true }),
            ),
          );
        }),
      ),
    sweepExpiredArtifacts: Effect.fn("SandboxRuntimeManager.sweepExpiredArtifacts")(
      function* (protectedThreadIds) {
        const maxAgeSeconds = resolveSandboxArtifactMaxAgeSeconds();
        if (maxAgeSeconds === 0 || artifactRoot === undefined) return 0;
        const protectedNames = new Set(
          [...protectedThreadIds].map((threadId) =>
            NodeCrypto.createHash("sha256").update(threadId).digest("hex"),
          ),
        );
        const { removed, capped } = yield* attempt(async () => {
          const entries = await NodeFSP.readdir(artifactRoot).catch((cause: unknown) => {
            // No directory means no exports have happened yet: nothing to sweep.
            if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
            throw cause;
          });
          // One set per thread: `<sha256(threadId)>.{bundle,json,store.tar}`.
          // Dot-prefixed names are in-flight temporaries owned by `exportBranch`
          // and never eligible.
          const sets = new Map<string, string[]>();
          for (const entry of entries) {
            const match = /^([a-f0-9]{64})\.(?:bundle|json|store\.tar)$/.exec(entry);
            if (match?.[1] === undefined) continue;
            const files = sets.get(match[1]) ?? [];
            files.push(entry);
            sets.set(match[1], files);
          }
          // @effect-diagnostics-next-line globalDate:off - ages are real filesystem mtimes; the virtual test clock would misdate them.
          const cutoff = Date.now() - maxAgeSeconds * 1000;
          let removedCount = 0;
          let cappedAtLimit = false;
          for (const [name, files] of sets) {
            if (protectedNames.has(name)) continue;
            // The newest file's mtime dates the set as a whole: exports rename
            // all three files together, so a set with one young file is a set
            // that exported recently.
            const times = await Promise.all(
              files.map((file) =>
                NodeFSP.stat(NodePath.resolve(artifactRoot, file))
                  .then((stat) => stat.mtimeMs)
                  // A file deleted mid-sweep (thread deletion, another export)
                  // simply no longer dates the set.
                  .catch(() => undefined),
              ),
            );
            const newest = Math.max(...times.map((time) => time ?? Number.NEGATIVE_INFINITY));
            if (!Number.isFinite(newest) || newest > cutoff) continue;
            if (removedCount >= ARTIFACT_SWEEP_MAX_SETS) {
              cappedAtLimit = true;
              break;
            }
            await Promise.all(
              files.map((file) =>
                NodeFSP.rm(NodePath.resolve(artifactRoot, file), { force: true }),
              ),
            );
            removedCount += 1;
          }
          return { removed: removedCount, capped: cappedAtLimit };
        });
        if (capped)
          yield* Effect.logWarning("sandbox artifact sweep hit its per-run deletion cap", {
            removed,
            cap: ARTIFACT_SWEEP_MAX_SETS,
          });
        if (removed > 0)
          yield* Effect.logInfo("sandbox artifact sweep removed expired export sets", {
            removed,
            maxAgeSeconds,
          });
        return removed;
      },
    ),
  };
};

const configuredArtifactRoot = process.env.T3_SANDBOX_ARTIFACT_DIR;
const defaultManager = makeSandboxRuntimeManager(
  configuredArtifactRoot === undefined ? undefined : NodePath.resolve(configuredArtifactRoot),
  Effect.runSync(HostProcessPlatform),
);
export class SandboxRuntimeManager extends Context.Reference<SandboxRuntimeManagerShape>(
  "@awtprod/command-center/sandbox/SandboxRuntimeManager",
  { defaultValue: () => defaultManager },
) {}

export const SandboxRuntimeManagerLive = Layer.effect(
  SandboxRuntimeManager,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const platform = yield* HostProcessPlatform;
    return makeSandboxRuntimeManager(
      NodePath.resolve(config.stateDir, "sandbox-artifacts"),
      platform,
    );
  }),
);
