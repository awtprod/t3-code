import {
  DEFAULT_SANDBOX_RESOURCE_LIMITS,
  type SandboxConfig,
  type SandboxRuntime,
} from "@t3tools/contracts";
import type {
  SandboxAdoptionHint,
  SandboxCommandExecutor,
  SandboxExecInput,
  SandboxExport,
  SandboxHook,
  SandboxProvisionInput,
  SandboxReady,
  SandboxUsageSample,
  SandboxReconcileInput,
  SandboxReconcileResult,
  ThreadSandboxBackend,
} from "./types.ts";
import {
  sanitizeId,
  validateBranchName,
  validateBootstrap,
  validateCache,
  validateExec,
  validateHook,
} from "./validation.ts";
import { CREDENTIAL_PROXY_ALIAS } from "./SandboxCredentialProxy.ts";
import { resolveSandboxGitIdentity } from "./SandboxGitIdentity.ts";
import * as Effect from "effect/Effect";
import * as NodeCrypto from "node:crypto";

const MANAGED_LABEL = "com.t3tools.sandbox.managed=true";
const THREAD_LABEL = "com.t3tools.sandbox.thread";
const PROJECT_LABEL = "com.t3tools.sandbox.project";
const IMAGE_LABEL = "com.t3tools.sandbox.image";
const BASE_LABEL = "com.t3tools.sandbox.base";
const BRANCH_LABEL = "com.t3tools.sandbox.branch";
const ROLE_LABEL = "com.t3tools.sandbox.role";
const CACHE_DIGEST_LABEL = "com.t3tools.sandbox.cache-digest";
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
/**
 * Resource ceilings for the egress proxy sidecar. The workspace container's
 * limits come from per-thread config, but a runaway or compromised sidecar
 * would otherwise share the host unbounded -- conservative constants, matching
 * the sibling sidecars in `SandboxCredentialProxy` / `ThreadPreviewProxy`.
 */
const EGRESS_PROXY_MEMORY = "256m";
const EGRESS_PROXY_CPUS = "0.5";
const INTERNAL_EGRESS_PROXY_URL = ["http:/", "/egress-proxy:3128"].join("");
/**
 * Hosts the workload must dial directly rather than through the egress proxy.
 *
 * The credential proxy answers on a private address and the egress proxy runs
 * with `--deny-private`, so without this a provider CLI's call to the
 * credential proxy is refused by our own egress policy ("403 egress denied:
 * private address") -- which Claude Code reports as an authentication failure.
 * The bypass loosens nothing: the alias resolves only on the `--internal`
 * network the container is already confined to.
 */
const INTERNAL_NO_PROXY_HOSTS = ["localhost", "127.0.0.1", "::1", CREDENTIAL_PROXY_ALIAS];
const MAX_HOOK_TIMEOUT_MS = 10 * 60_000;
/**
 * Where the provider CLI keeps its config and conversation store inside the
 * container. Must stay in step with `SANDBOX_PROVIDER_ENV.HOME` in
 * `SandboxProviderProcess.ts` -- that is the `HOME` every provider spawn runs
 * with, and this is the directory archived and restored across a teardown.
 */
const PROVIDER_HOME = "/thread-data/provider-home";
/**
 * Namespace the export pins its dirty-and-untracked snapshot commit under.
 *
 * The export bundles this namespace alongside the thread branch, so naming the
 * snapshot as a ref is what carries the
 * working tree across a teardown: the branch tip alone records only what the
 * user committed, and everything they had merely edited or newly created would
 * be destroyed by an automatic settle. Under `refs/t3/` rather than
 * `refs/heads/` so it is invisible to `git branch`, never checked out, and
 * removed from the restored repository the moment its contents are unpacked.
 */
const EXPORT_SNAPSHOT_NAMESPACE = "refs/t3/export-snapshot";
/**
 * The ref one specific snapshot commit is pinned under.
 *
 * Named by the commit it points at rather than by a fixed name, so a ref an
 * earlier export left behind can never be mistaken for this export's. A single
 * shared name made a FAILED deletion silently catastrophic: the stale ref rode
 * out in the next bundle, and restore unpacked an old working tree over the
 * user's newer state. A per-export name cannot collide, and restore is told
 * exactly which commit to expect.
 */
const exportSnapshotRef = (commit: string) => `${EXPORT_SNAPSHOT_NAMESPACE}/${commit}`;
/**
 * Identity for the snapshot commit. It is a container for a tree, never a
 * commit the user authored, so `commit-tree` gets an explicit export identity
 * rather than attributing the snapshot to the sandbox's ordinary commit identity.
 */
const EXPORT_SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: "T3 Sandbox Export",
  GIT_AUTHOR_EMAIL: "sandbox-export@example.test",
  GIT_COMMITTER_NAME: "T3 Sandbox Export",
  GIT_COMMITTER_EMAIL: "sandbox-export@example.test",
} as const;
/**
 * Paths excluded from the archived provider store, relative to `PROVIDER_HOME`.
 *
 * The provider home holds live auth material next to the transcripts, and an
 * exported archive lands in a host directory that outlives the container.
 * Excluding at archive time means a credential is never written into the tar in
 * the first place -- so every pattern here is load-bearing, and each is listed
 * with what it is for:
 *
 * - `.credentials.json` / `*.credentials.json` -- Claude Code's OAuth store,
 *   at `~/.claude/.credentials.json` and its per-profile variants.
 * - `*auth*` -- Codex's `~/.codex/auth.json` and anything else that names
 *   itself auth material.
 * - `*token*` -- bare token files providers drop beside their config.
 * - `*.key` -- private key material anywhere under the home, INCLUDING inside
 *   a `sessions/` directory (a tar exclude glob matches across `/`).
 * - `.claude.json.tmp.*` -- crash-time temporaries, not a credential.
 * - `.cache` -- churn a restored store is better off without.
 *
 * A bare `sessions` used to be in this list. It was aimed at `sessions/*.key`,
 * which `*.key` already covers -- and it stripped Codex's `~/.codex/sessions`
 * transcripts, which ARE the conversation the archive exists to carry. The
 * extraction still reported success, so the thread came back with a retained
 * cursor naming a conversation that was never in the tar, and every following
 * turn failed to resume. Exclusions must target credentials, not a directory
 * name that two providers use for different things.
 */
const PROVIDER_STORE_EXCLUDES = [
  ".credentials.json",
  "*.credentials.json",
  ".claude.json.tmp.*",
  "*.key",
  "*token*",
  "*auth*",
  ".cache",
] as const;

/**
 * Directory names, anywhere in the top two levels of `PROVIDER_HOME`, whose
 * presence means a provider's conversation store really is there.
 *
 * One name per provider layout, and both providers that can run sandboxed are
 * covered:
 *
 * - `sessions` -- Codex, at `~/.codex/sessions`.
 * - `projects` -- Claude, at `~/.claude/projects` on a default install and at
 *   `<config dir>/projects` when the config directory is overridden (the same
 *   pair `UsageService.resolveClaudeTranscriptDir` probes for on the host).
 *
 * Depth 1 is admitted alongside depth 2 for that second Claude shape. Anything
 * added here must be a directory the CLI itself creates for its transcripts:
 * a name that also occurs in a checked-out repository would report a
 * conversation that is not there.
 */
const PROVIDER_STORE_DIRECTORIES = ["sessions", "projects"] as const;

export class SandboxRuntimeError extends Error {
  override readonly name = "SandboxRuntimeError";
  readonly stderr: string;
  constructor(message: string, stderr = "") {
    super(message);
    this.stderr = stderr;
  }
}

type RecordEntry = {
  ready: SandboxReady;
  teardownTimeoutMs: number;
  egressConfigured: boolean;
  /**
   * Rebuilt from the projection rather than provisioned by this manager
   * generation. Teardown hooks cannot run against an adopted record -- the hook
   * declarations live in the manager's memory and died with the restart.
   */
  adopted?: boolean;
};

export class ContainerSandboxBackend implements ThreadSandboxBackend {
  readonly runtime: SandboxRuntime;
  readonly #binary: "docker" | "podman";
  readonly #executor: SandboxCommandExecutor;
  readonly #records = new Map<string, RecordEntry>();
  readonly #provisioning = new Map<string, Promise<SandboxReady>>();
  /**
   * Threads with a `stop` in flight.
   *
   * A stop used to run straight past a provision that was still creating
   * things: it tore down whatever existed at that instant, and the containers,
   * sidecars, networks, and volumes the provision created a moment later
   * survived with nothing left holding a reference to them. Held for the
   * duration of one stop, so a later legitimate provision is unaffected.
   */
  readonly #stopping = new Set<string>();
  #validatedRootless = false;

  constructor(runtime: "docker" | "podman", executor: SandboxCommandExecutor) {
    this.runtime = runtime;
    this.#binary = runtime;
    this.#executor = executor;
  }

  runtimeRef(threadIdValue: string): string | undefined {
    return this.#records.get(sanitizeId(threadIdValue, "threadId"))?.ready.containerName;
  }

  credentialProxyTarget(
    threadIdValue: string,
  ): { readonly networkName: string; readonly egressConfigured: boolean } | undefined {
    const record = this.#records.get(sanitizeId(threadIdValue, "threadId"));
    return record === undefined
      ? undefined
      : { networkName: record.ready.networkName, egressConfigured: record.egressConfigured };
  }

  async ensureReady(input: SandboxProvisionInput): Promise<SandboxReady> {
    validateBootstrap(input.bootstrap);
    const threadId = sanitizeId(input.bootstrap.threadId, "threadId");
    const ready = this.#records.get(threadId)?.ready;
    // A cache hit is the surviving-container case, and it has to report the
    // surviving-container disposition -- the same `preserved` the label-matched
    // reuse path below returns, for the same reason.
    //
    // Returning the recorded object verbatim reported whatever the ORIGINAL
    // provision did. A fresh container records `unavailable`, which is correct
    // at the time: nothing was restored because there was nothing to restore.
    // The provider then creates a conversation inside that container, a
    // re-provision hits this cache, and `unavailable` came back out -- so
    // `reconcileProviderStoreCursor` cleared a resume cursor that named a live
    // conversation, and it was lost.
    //
    // Only this field is recomputed, and the audit says why: every other field
    // on the record either derives from the thread and project ids
    // (`sandboxId`, and the container, network, and volume names), is fixed for
    // the backend (`runtime`), or describes the container that is still running
    // (`branchName`, `limits`, and the egress proxy names -- all taken from the
    // input the container was BUILT from). A re-provision arriving with a
    // different branch or different limits does not change what is running, so
    // reporting the built values is right, not stale. `providerStore` is the
    // only field that describes what a provision ATTEMPT did rather than what
    // the container is, which is exactly why it cannot be replayed.
    if (ready !== undefined) {
      await this.#configureGitRepository(
        ready.containerName,
        input.bootstrap,
        boundedTimeout(input.config?.setupTimeoutSeconds, 300),
      );
      return { ...ready, providerStore: "preserved" };
    }
    const pending = this.#provisioning.get(threadId);
    if (pending !== undefined) return pending;
    const provision = this.#provision(input).finally(() => this.#provisioning.delete(threadId));
    this.#provisioning.set(threadId, provision);
    return provision;
  }

  async #provision(input: SandboxProvisionInput): Promise<SandboxReady> {
    validateBootstrap(input.bootstrap);
    if (!/^[a-z0-9][a-z0-9._/-]{0,200}@sha256:[a-f0-9]{64}$/i.test(input.image)) {
      throw new SandboxRuntimeError("sandbox image must be pinned by sha256 digest");
    }
    for (const cache of input.caches ?? []) validateCache(cache);
    for (const hook of input.setup ?? []) validateHook(hook);
    await this.#validateRootless();

    const threadId = sanitizeId(input.bootstrap.threadId, "threadId");
    const projectId = sanitizeId(input.bootstrap.projectId, "projectId");
    const {
      containerName,
      networkName,
      workspaceVolumeName,
      desktopVolumeName,
      egressProxyContainerName,
      egressNetworkName,
    } = resourceNames(projectId, threadId);
    const config = input.config ?? {};
    const limits = { ...DEFAULT_SANDBOX_RESOURCE_LIMITS, ...config.limits };
    validateLimits(limits);
    const setupTimeoutMs = boundedTimeout(config.setupTimeoutSeconds, 300);
    const teardownTimeoutMs = boundedTimeout(config.teardownTimeoutSeconds, 120);

    // Set only once the archive is actually unpacked in the container.
    let providerStoreRestored = false;

    const inspected = await this.#run(["inspect", containerName], 10_000, true);
    if (inspected.exitCode === 0) {
      const matches = await this.#matchesThreadLabels(containerName, {
        threadId,
        projectId,
        image: input.image,
        baseCommit: input.bootstrap.baseCommit,
        branchName: input.bootstrap.branchName,
      });
      if (!matches) {
        throw new SandboxRuntimeError(`existing sandbox name collision for thread ${threadId}`);
      }
      // The container -- and with it the provider home holding the
      // conversation -- is exactly where the last generation left it. Nothing
      // was restored because nothing was lost, so a persisted resume cursor
      // still names a real conversation and must be kept.
      const existing = {
        ...makeReady(
          this.runtime,
          containerName,
          networkName,
          workspaceVolumeName,
          desktopVolumeName,
          input,
          limits,
        ),
        providerStore: "preserved" as const,
      };
      await this.#configureGitRepository(containerName, input.bootstrap, setupTimeoutMs);
      this.#records.set(threadId, {
        ready: existing,
        teardownTimeoutMs,
        egressConfigured:
          input.egressProxyImage !== undefined || input.egressProxyUrl !== undefined,
      });
      return existing;
    }

    try {
      await this.#mustRun(
        [
          "network",
          "create",
          "--internal",
          "--label",
          MANAGED_LABEL,
          "--label",
          `${THREAD_LABEL}=${threadId}`,
          networkName,
        ],
        30_000,
      );
      if (input.egressProxyImage !== undefined) {
        if (!/^[a-z0-9][a-z0-9._/-]{0,200}@sha256:[a-f0-9]{64}$/i.test(input.egressProxyImage))
          throw new SandboxRuntimeError("egress proxy image must be pinned by sha256 digest");
        await this.#mustRun(
          [
            "network",
            "create",
            "--label",
            MANAGED_LABEL,
            "--label",
            `${THREAD_LABEL}=${threadId}`,
            egressNetworkName,
          ],
          30_000,
        );
        await this.#mustRun(
          [
            "run",
            "--detach",
            "--name",
            egressProxyContainerName,
            "--label",
            MANAGED_LABEL,
            "--label",
            `${THREAD_LABEL}=${threadId}`,
            "--network",
            egressNetworkName,
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--pids-limit",
            "128",
            "--memory",
            EGRESS_PROXY_MEMORY,
            "--memory-swap",
            EGRESS_PROXY_MEMORY,
            "--cpus",
            EGRESS_PROXY_CPUS,
            // The rootfs is --read-only; without a tmpfs the proxy has no
            // writable scratch space at all. Same options as the credential
            // proxy sidecar's tmpfs.
            "--tmpfs",
            "/tmp:rw,nosuid,nodev,noexec,size=16m",
            input.egressProxyImage,
            "t3-egress-proxy",
            "serve",
            "--listen",
            "0.0.0.0:3128",
            "--deny-loopback",
            "--deny-private",
            "--deny-link-local",
            "--deny-metadata",
            "--resolve-before-connect",
          ],
          60_000,
        );
        await this.#mustRun(
          ["network", "connect", "--alias", "egress-proxy", networkName, egressProxyContainerName],
          30_000,
        );
      }
      const desktopQuota = `o=size=${Math.max(256 * 1024 ** 2, Math.floor(limits.diskBytes * 0.1))}`;
      await this.#mustRun(
        [
          "volume",
          "create",
          "--label",
          MANAGED_LABEL,
          "--label",
          `${THREAD_LABEL}=${threadId}`,
          ...(volumeStorageQuotaEnabled() ? ["--opt", desktopQuota] : []),
          desktopVolumeName,
        ],
        30_000,
      );
      if (volumeStorageQuotaEnabled()) {
        const desktopQuotaReadback = await this.#mustRun(
          ["volume", "inspect", "--format", `{{index .Options "o"}}`, desktopVolumeName],
          10_000,
        );
        if (desktopQuotaReadback.stdout.trim() !== desktopQuota.slice(2))
          throw new SandboxRuntimeError("runtime did not preserve the desktop volume quota");
      }
      const workspaceQuota = `o=size=${Math.floor(limits.diskBytes * 0.9)}`;
      await this.#mustRun(
        [
          "volume",
          "create",
          "--label",
          MANAGED_LABEL,
          "--label",
          `${THREAD_LABEL}=${threadId}`,
          ...(volumeStorageQuotaEnabled() ? ["--opt", workspaceQuota] : []),
          workspaceVolumeName,
        ],
        30_000,
      );
      if (volumeStorageQuotaEnabled()) {
        const workspaceQuotaReadback = await this.#mustRun(
          ["volume", "inspect", "--format", `{{index .Options "o"}}`, workspaceVolumeName],
          10_000,
        );
        if (workspaceQuotaReadback.stdout.trim() !== workspaceQuota.slice(2))
          throw new SandboxRuntimeError("runtime did not preserve the workspace volume quota");
      }
      for (const cache of input.caches ?? []) {
        const name = `t3-cache-${cache.digest.toLowerCase()}`;
        const existing = await this.#run(
          ["volume", "inspect", "--format", `{{index .Labels "${CACHE_DIGEST_LABEL}"}}`, name],
          10_000,
          true,
        );
        if (existing.exitCode === 0) {
          if (existing.stdout.trim() !== cache.digest.toLowerCase())
            throw new SandboxRuntimeError(`cache volume label mismatch for ${cache.digest}`);
        } else {
          await this.#mustRun(
            [
              "volume",
              "create",
              "--label",
              `${CACHE_DIGEST_LABEL}=${cache.digest.toLowerCase()}`,
              name,
            ],
            30_000,
          );
        }
      }

      const runArgs = [
        "run",
        "--detach",
        "--name",
        containerName,
        "--label",
        MANAGED_LABEL,
        "--label",
        `${THREAD_LABEL}=${threadId}`,
        "--label",
        `${PROJECT_LABEL}=${projectId}`,
        "--label",
        `${IMAGE_LABEL}=${input.image}`,
        "--label",
        `${BASE_LABEL}=${input.bootstrap.baseCommit}`,
        "--label",
        `${BRANCH_LABEL}=${input.bootstrap.branchName}`,
        "--label",
        `${ROLE_LABEL}=workspace`,
        "--network",
        networkName,
        "--mount",
        `type=volume,src=${workspaceVolumeName},dst=/workspace`,
        "--mount",
        `type=volume,src=${desktopVolumeName},dst=/thread-data`,
        "--cpus",
        String(limits.cpuCount),
        "--memory",
        String(limits.memoryBytes),
        // Equal to --memory: without it docker defaults swap to 2x memory,
        // letting the workload consume double its configured ceiling. Podman
        // accepts the flag identically.
        "--memory-swap",
        String(limits.memoryBytes),
        "--pids-limit",
        String(limits.processCount),
        // Off by default: `podman --remote` rejects `--storage-opt size=` and
        // every socket deployment is remote. Safe to omit -- the rootfs is
        // `--read-only`, and every writable path is either a quota'd volume
        // (/workspace, /thread-data) or a size-bounded tmpfs.
        ...(containerStorageQuotaEnabled() ? ["--storage-opt", `size=${limits.diskBytes}`] : []),
        "--read-only",
        "--init",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,noexec,size=1g",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--user",
        "1000:1000",
        "--workdir",
        "/workspace",
        ...(input.egressProxyImage === undefined && input.egressProxyUrl === undefined
          ? []
          : [
              "--env",
              `ALL_PROXY=${input.egressProxyImage === undefined ? validateProxy(input.egressProxyUrl!) : INTERNAL_EGRESS_PROXY_URL}`,
              "--env",
              `HTTPS_PROXY=${input.egressProxyImage === undefined ? validateProxy(input.egressProxyUrl!) : INTERNAL_EGRESS_PROXY_URL}`,
              "--env",
              `HTTP_PROXY=${input.egressProxyImage === undefined ? validateProxy(input.egressProxyUrl!) : INTERNAL_EGRESS_PROXY_URL}`,
              "--env",
              `NO_PROXY=${INTERNAL_NO_PROXY_HOSTS.join(",")}`,
            ]),
        ...(input.caches ?? []).flatMap((cache) => [
          "--mount",
          `type=volume,src=t3-cache-${cache.digest.toLowerCase()},dst=${cache.target},readonly`,
        ]),
        input.image,
        "sleep",
        "infinity",
      ];
      await this.#mustRun(runArgs, setupTimeoutMs);
      // The provider CLI runs with HOME here (see SANDBOX_PROVIDER_ENV) and
      // writes its config and session state on startup. The container rootfs is
      // read-only, so this must be created on the writable volume up front --
      // otherwise every provider spawn dies before the first token.
      await this.#mustExec(
        containerName,
        { executable: "mkdir", args: ["-p", PROVIDER_HOME] },
        30_000,
      );
      if (input.bootstrap.providerStorePath !== undefined) {
        // Extracted here, before the repository is seeded and long before any
        // provider can spawn, so the CLI's first look at its home already has
        // the earlier conversation in it.
        //
        // Best-effort: a store that fails to copy or extract leaves the home
        // empty, which is exactly the state a thread without a prior export
        // starts in. The provision continues either way -- the branch is the
        // part worth failing over. What the failure must not do is stay
        // silent: the caller decides whether to keep the thread's provider
        // resume cursor, and a cursor kept against a container whose store
        // never arrived makes every turn fail to resume. Hence
        // `providerStore` on the result, reporting what actually happened
        // rather than what was attempted.
        const containerArchive = "/tmp/t3-provider-store.tar";
        try {
          await this.#mustRun(
            ["cp", input.bootstrap.providerStorePath, `${containerName}:${containerArchive}`],
            setupTimeoutMs,
          );
          await this.#mustExec(
            containerName,
            {
              executable: "tar",
              args: ["--extract", "--file", containerArchive, "--directory", PROVIDER_HOME],
            },
            setupTimeoutMs,
          );
          // A successful extraction does not mean the conversation arrived.
          // The archive is built with credential exclusions, and an exclusion
          // aimed too broadly strips the transcripts while tar still exits 0 --
          // exactly what a bare `sessions` exclude did to Codex. Report a
          // restore only when a provider's conversation state is actually in
          // the home, so the caller's cursor decision is made on what is
          // there rather than on what was attempted.
          providerStoreRestored = await this.#providerStorePopulated(containerName, setupTimeoutMs);
        } catch {
          // Intentionally swallowed; see above.
        } finally {
          await this.#mustExec(
            containerName,
            { executable: "rm", args: ["-f", containerArchive] },
            10_000,
          ).catch(() => undefined);
        }
      }
      // A restore seeds from this thread's own previous export, which is the
      // only bundle that can carry a working-tree snapshot.
      const restoresFromExport = input.bootstrap.restoreCommit !== undefined;
      let restoreSnapshot: string | undefined;
      if (input.bootstrap.repositoryBundlePath !== undefined) {
        const containerBundle = "/tmp/t3-repository.bundle";
        const bundleRef = input.bootstrap.repositoryBundleRef;
        if (bundleRef === undefined)
          throw new SandboxRuntimeError(
            "repositoryBundlePath requires repositoryBundleRef: the bundle's ref cannot be guessed",
          );
        await this.#mustRun(
          ["cp", input.bootstrap.repositoryBundlePath, `${containerName}:${containerBundle}`],
          setupTimeoutMs,
        );
        // `git clone` cannot be used here: the seed bundle records the base
        // commit under a private ref, and clone only fetches what its default
        // refspec matches (`refs/heads/*`). It reports success, warns "you
        // appear to have cloned an empty repository", and leaves a repo with no
        // refs -- the checkout below then fails with "reference is not a tree".
        // `fetch` takes the refspec explicitly, and leaves behind no `origin`
        // remote pointing at a bundle that is deleted moments later.
        //
        // No `git bundle verify` either: it needs a repository to resolve
        // prerequisites against, and the fetch is the stronger check anyway --
        // verify passes on a bundle truncated mid-pack, a fetch does not.
        await this.#mustExec(
          containerName,
          { executable: "git", args: ["init", "--quiet", "/workspace/repo"] },
          setupTimeoutMs,
        );
        await this.#mustExec(
          containerName,
          {
            executable: "git",
            args: [
              "-C",
              "/workspace/repo",
              "fetch",
              "--no-tags",
              containerBundle,
              `${bundleRef}:${bundleRef}`,
            ],
          },
          setupTimeoutMs,
        );
        // The export's working-tree snapshot, when the bundle carries one. A
        // separate fetch with its own failure allowance rather than a second
        // refspec on the one above: bundles written before snapshots existed
        // (and exports that had nothing uncommitted) name no snapshot ref at
        // all, and a fetch that asks for a missing ref fails as a whole --
        // which would turn every older restore into a failed provision.
        //
        // A wildcard, because the ref is named by the commit it points at (see
        // `exportSnapshotRef`). That name is what makes a stale ref impossible
        // to mistake for this export's, and `#resolveExportSnapshot` below
        // holds it to that name AND to the commit the event log recorded, so a
        // truncated or rewritten bundle cannot pass a wrong tree off as the
        // user's work.
        if (restoresFromExport) {
          await this.#mustExec(
            containerName,
            {
              executable: "git",
              args: [
                "-C",
                "/workspace/repo",
                "fetch",
                "--no-tags",
                containerBundle,
                `${EXPORT_SNAPSHOT_NAMESPACE}/*:${EXPORT_SNAPSHOT_NAMESPACE}/*`,
              ],
              allowNonZeroExit: true,
            },
            setupTimeoutMs,
          );
          restoreSnapshot = await this.#resolveExportSnapshot(
            containerName,
            input.bootstrap.restoreSnapshotCommit,
            setupTimeoutMs,
          );
        }
        await this.#mustExec(
          containerName,
          { executable: "rm", args: ["-f", containerBundle] },
          10_000,
        );
      } else {
        await this.#mustExec(
          containerName,
          {
            executable: "git",
            args: ["clone", "--no-checkout", input.bootstrap.repositoryUrl, "/workspace/repo"],
          },
          setupTimeoutMs,
        );
      }
      // A restore seeds from a bundle of the thread's own previous sandbox, so
      // it lands on the work the thread had already done rather than the base
      // commit -- and its bundle already carries the thread branch, which is
      // why the switch below has to be `-C` rather than `-c`.
      const restoreCommit = input.bootstrap.restoreCommit;
      await this.#mustExec(
        containerName,
        {
          executable: "git",
          args: [
            "-C",
            "/workspace/repo",
            "checkout",
            "--detach",
            restoreCommit ?? input.bootstrap.baseCommit,
          ],
        },
        setupTimeoutMs,
      );
      await this.#mustExec(
        containerName,
        {
          executable: "git",
          args: [
            "-C",
            "/workspace/repo",
            "switch",
            restoreCommit === undefined ? "-c" : "-C",
            input.bootstrap.branchName,
          ],
        },
        setupTimeoutMs,
      );
      await this.#configureGitRepository(containerName, input.bootstrap, setupTimeoutMs);
      if (restoreSnapshot !== undefined)
        await this.#restoreExportSnapshot(containerName, restoreSnapshot, setupTimeoutMs);
      if (input.bootstrap.inheritedPatch !== undefined) {
        await this.#mustExec(
          containerName,
          {
            executable: "git",
            args: ["-C", "/workspace/repo", "apply", "--index", "--whitespace=error", "-"],
            stdin: input.bootstrap.inheritedPatch,
          },
          setupTimeoutMs,
        );
      }
      for (const hook of input.setup ?? [])
        await this.#mustExec(containerName, hook, setupTimeoutMs);
      // A stop landed while this was building. Everything above it is a
      // resource the stop could not see -- it waits on this promise, and the
      // record below is published after that wait would have read it. Unwind
      // here, where the names are all in hand, rather than hand the caller a
      // sandbox the deletion already accounted for as gone.
      if (this.#stopping.has(threadId))
        throw new SandboxRuntimeError(
          `sandbox for thread ${threadId} was stopped while provisioning`,
        );
    } catch (error) {
      await this.#cleanup(
        containerName,
        networkName,
        workspaceVolumeName,
        desktopVolumeName,
        teardownTimeoutMs,
        input.egressProxyImage === undefined
          ? undefined
          : { container: egressProxyContainerName, network: egressNetworkName },
      );
      // Sidecars this backend never created (credential/preview proxies, the
      // thread's service stack) also carry the thread label, and a stop that
      // raced this provision has already come and gone. Sweep them here or
      // they outlive the deletion with nothing left holding a reference.
      if (this.#stopping.has(threadId))
        await this.#removeManagedSiblingContainers(threadId, new Set());
      throw error;
    }
    const ready = {
      ...makeReady(
        this.runtime,
        containerName,
        networkName,
        workspaceVolumeName,
        desktopVolumeName,
        input,
        limits,
      ),
      // A brand-new container: the conversation is in it only if the archive
      // actually extracted. Anything else leaves the provider home empty, and
      // a cursor kept against it fails every following turn to resume.
      providerStore: providerStoreRestored ? ("restored" as const) : ("unavailable" as const),
    };
    this.#records.set(threadId, {
      ready,
      teardownTimeoutMs,
      egressConfigured: input.egressProxyImage !== undefined || input.egressProxyUrl !== undefined,
    });
    return ready;
  }

  async exec(threadIdValue: string, input: SandboxExecInput) {
    validateExec(input);
    const threadId = sanitizeId(threadIdValue, "threadId");
    const record = this.#records.get(threadId);
    if (record === undefined)
      throw new SandboxRuntimeError(`sandbox for thread ${threadId} is not ready`);
    return this.#mustExec(
      record.ready.containerName,
      input,
      Math.min(input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, MAX_HOOK_TIMEOUT_MS),
    );
  }

  /** Repair both new repositories and containers created before Git metadata was seeded. */
  async #configureGitRepository(
    containerName: string,
    bootstrap: SandboxProvisionInput["bootstrap"],
    timeoutMs: number,
  ): Promise<void> {
    const hasOrigin =
      bootstrap.repositoryBundlePath === undefined ||
      bootstrap.repositoryRemoteUrl !== undefined ||
      bootstrap.repositoryPushRemoteUrl !== undefined;
    const gitIdentity = resolveSandboxGitIdentity();
    const config: Array<readonly [string, string]> = [
      ["user.name", gitIdentity.name],
      ["user.email", gitIdentity.email],
      ["push.autoSetupRemote", "true"],
    ];
    const originUrl = bootstrap.repositoryRemoteUrl ?? bootstrap.repositoryPushRemoteUrl;
    if (originUrl !== undefined) config.push(["remote.origin.url", originUrl]);
    if (
      bootstrap.repositoryPushRemoteUrl !== undefined &&
      bootstrap.repositoryPushRemoteUrl !== originUrl
    )
      config.push(["remote.origin.pushurl", bootstrap.repositoryPushRemoteUrl]);
    if (hasOrigin)
      config.push(
        ["remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
        [`branch.${bootstrap.branchName}.remote`, "origin"],
        [`branch.${bootstrap.branchName}.merge`, `refs/heads/${bootstrap.branchName}`],
      );
    for (const [key, value] of config) {
      await this.#mustExec(
        containerName,
        { executable: "git", args: ["-C", "/workspace/repo", "config", key, value] },
        timeoutMs,
      );
    }
  }

  async exportBranch(threadIdValue: string, hint?: SandboxAdoptionHint): Promise<SandboxExport> {
    const threadId = sanitizeId(threadIdValue, "threadId");
    const record = await this.#resolveRecord(threadId, hint);
    if (record === undefined)
      throw new SandboxRuntimeError(`sandbox for thread ${threadId} is not ready`);
    const commit = await this.#mustExec(
      record.ready.containerName,
      { executable: "git", args: ["-C", "/workspace/repo", "rev-parse", "HEAD"] },
      30_000,
    );
    const exportIndex = "/tmp/t3-export-index";
    try {
      const env = { GIT_INDEX_FILE: exportIndex };
      await this.#mustExec(
        record.ready.containerName,
        { executable: "git", args: ["-C", "/workspace/repo", "read-tree", "HEAD"], env },
        30_000,
      );
      await this.#mustExec(
        record.ready.containerName,
        { executable: "git", args: ["-C", "/workspace/repo", "add", "-A"], env },
        60_000,
      );
      const fullPatch = await this.#mustExec(
        record.ready.containerName,
        {
          executable: "git",
          args: ["-C", "/workspace/repo", "diff", "--cached", "--binary", "HEAD"],
          env,
        },
        60_000,
      );
      const snapshot = await this.#writeExportSnapshot(record.ready.containerName, env);
      return {
        commit: commit.stdout.trim(),
        patch: fullPatch.stdout,
        ...(snapshot === undefined ? {} : { snapshotCommit: snapshot }),
      };
    } finally {
      await this.#mustExec(
        record.ready.containerName,
        { executable: "rm", args: ["-f", exportIndex] },
        10_000,
      ).catch(() => undefined);
    }
  }

  /**
   * Pin the working tree -- dirty tracked files AND untracked ones -- as a
   * commit under this export's own snapshot ref, so the bundle written next --
   * which names this namespace explicitly -- carries it out of the sandbox.
   *
   * Without this, an export saves only what was committed. The patch computed
   * above describes the rest, but a patch has nowhere to live: the manifest
   * records the bundle and the head commit, and restore checks that commit out
   * verbatim. Everything the user had edited or created and not committed was
   * silently destroyed by an automatic settle. A snapshot commit rides inside
   * the artifact that is already digest-verified, so no second artifact and no
   * second digest have to be kept in step.
   *
   * `env` carries the temporary `GIT_INDEX_FILE` the caller already populated
   * with `add -A`: the tree is written from that index, so the repository's
   * real index and working tree are never touched.
   *
   * Returns `undefined` for a CLEAN tree -- nothing uncommitted, so the branch
   * tip already carries everything and there is legitimately no snapshot to
   * write. Every other outcome is a throw. A dirty tree whose snapshot cannot
   * be written must fail the export loudly: the caller's alternative is to ship
   * a bundle that looks complete and silently drops the user's uncommitted
   * work, which an automatic settle then destroys. Failing here leaves the
   * container -- and the work -- intact for a retry.
   */
  async #writeExportSnapshot(
    containerName: string,
    env: Readonly<Record<string, string>>,
  ): Promise<string | undefined> {
    // Every snapshot ref this container still holds is from an EARLIER export
    // and describes a working tree that no longer exists. They are dropped so
    // they stop showing up in the user's `git log --all`; keeping the BUNDLE
    // to this export's own state is `exportBundle`'s job, and it does it by
    // naming the ref written below rather than by trusting this to have
    // succeeded.
    await this.#deleteExportSnapshotRefs(containerName, 30_000);
    const tree = (
      await this.#mustExec(
        containerName,
        { executable: "git", args: ["-C", "/workspace/repo", "write-tree"], env },
        60_000,
      )
    ).stdout.trim();
    const headTree = (
      await this.#mustExec(
        containerName,
        { executable: "git", args: ["-C", "/workspace/repo", "rev-parse", "HEAD^{tree}"] },
        30_000,
      )
    ).stdout.trim();
    // The one legitimate "no snapshot" case, and the only one the caller is
    // allowed to treat as success.
    if (tree === headTree) return undefined;
    // Past here the tree is dirty and every failure is fatal to the export.
    // Wrapped so the thread's recorded failure says what was at stake rather
    // than a bare "sandbox command git failed" -- an operator reading it has to
    // know the export was refused to protect uncommitted work, not that some
    // git call went wrong somewhere.
    try {
      const snapshotCommit = (
        await this.#mustExec(
          containerName,
          {
            executable: "git",
            args: [
              "-C",
              "/workspace/repo",
              "commit-tree",
              tree,
              "-p",
              "HEAD",
              "-m",
              "t3 sandbox export snapshot",
            ],
            env: { ...env, ...EXPORT_SNAPSHOT_IDENTITY },
          },
          60_000,
        )
      ).stdout.trim();
      if (!/^[0-9a-f]{40,64}$/.test(snapshotCommit))
        throw new SandboxRuntimeError(`commit-tree returned '${snapshotCommit}'`);
      // Named by the commit itself, so no earlier export's ref can be here and
      // nothing has to be deleted first for correctness.
      await this.#mustExec(
        containerName,
        {
          executable: "git",
          args: [
            "-C",
            "/workspace/repo",
            "update-ref",
            exportSnapshotRef(snapshotCommit),
            snapshotCommit,
          ],
        },
        30_000,
      );
      return snapshotCommit;
    } catch (error) {
      throw new SandboxRuntimeError(
        `sandbox export could not write the working-tree snapshot; refusing to export a bundle that would silently drop uncommitted work: ${String(error)}`,
        error instanceof SandboxRuntimeError ? error.stderr : "",
      );
    }
  }

  /**
   * Put the exported working tree back over the checked-out branch, then drop
   * the snapshot ref.
   *
   * `read-tree -u --reset` writes the snapshot's files into the working tree
   * without moving HEAD, so the branch still points at the exported head
   * commit; `reset --mixed` then rewrites the index from HEAD, which is what
   * makes the restored files show up as ordinary dirty and untracked changes
   * rather than as staged ones. The snapshot ref is deleted afterwards: it is
   * a transport detail, and leaving it behind would make the next export
   * bundle a stale one and show it in the user's `git log --all`.
   */
  async #restoreExportSnapshot(
    containerName: string,
    snapshotCommit: string,
    timeoutMs: number,
  ): Promise<void> {
    await this.#mustExec(
      containerName,
      {
        executable: "git",
        args: ["-C", "/workspace/repo", "read-tree", "-u", "--reset", snapshotCommit],
      },
      timeoutMs,
    );
    await this.#mustExec(
      containerName,
      { executable: "git", args: ["-C", "/workspace/repo", "reset", "--quiet", "--mixed", "HEAD"] },
      timeoutMs,
    );
    // Every ref in the namespace, not just the one that was unpacked: an older
    // bundle can carry more than one, and any left behind would ride out in
    // this sandbox's next export bundle and show up in the user's
    // `git log --all`.
    await this.#deleteExportSnapshotRefs(containerName, timeoutMs);
  }

  /**
   * The snapshot commit to unpack, or `undefined` to restore the branch alone.
   *
   * `expected` is what the EXPORT recorded, carried on the event log -- the
   * only record of it that verifies against anything, since a manifest beside
   * a bundle is written by whoever wrote that bundle. A bundle whose snapshot
   * ref is not that commit is not this export's snapshot: it is an earlier
   * export's ref that a failed deletion left behind, or a bundle that was
   * truncated or rewritten. Unpacking it would restore an OLD working tree
   * over the user's newer state, silently, and that is the failure this
   * validation exists to stop. So nothing is unpacked without a match, and an
   * export that recorded no snapshot (a clean tree; every bundle written
   * before snapshots existed) unpacks nothing at all -- which is correct for
   * both.
   *
   * The ref is additionally required to resolve to the SHA in its own name
   * (see `exportSnapshotRef`), so a ref cannot claim to be a commit it is not.
   *
   * A recorded snapshot that cannot be resolved -- the fetch dropped it, the
   * bundle never carried it, `for-each-ref` itself failed -- THROWS rather
   * than returning `undefined`. Both outcomes used to be the same
   * `undefined`, so a restore whose event log says "there was uncommitted
   * work" quietly provisioned a clean checkout of the branch head and the
   * dirty and untracked files were gone with nothing said. Failing here costs
   * a provision; degrading costs the work. Nothing in the namespace is deleted
   * on that path either: the ref is the only copy of that tree inside this
   * container, provisioning tears the container down anyway, and a delete
   * running blind after a listing that just failed is how the evidence for the
   * next diagnosis disappears.
   *
   * Anything left in the namespace that is not restored is deleted, on the
   * `expected === undefined` path where nothing is owed: it is a transport
   * detail, and leaving it behind would put it in this sandbox's own next
   * export bundle and in the user's `git log --all`.
   */
  async #resolveExportSnapshot(
    containerName: string,
    expected: string | undefined,
    timeoutMs: number,
  ): Promise<string | undefined> {
    const listed = await this.#mustExec(
      containerName,
      {
        executable: "git",
        args: [
          "-C",
          "/workspace/repo",
          "for-each-ref",
          "--format=%(refname)\t%(objectname)",
          EXPORT_SNAPSHOT_NAMESPACE,
        ],
        allowNonZeroExit: true,
      },
      timeoutMs,
    );
    if (expected !== undefined) {
      if (listed.exitCode === 0)
        for (const line of listed.stdout.split("\n")) {
          const [refname, objectname] = line.trim().split("\t");
          if (refname === undefined || objectname === undefined) continue;
          if (refname !== exportSnapshotRef(objectname)) continue;
          if (objectname !== expected) continue;
          return objectname;
        }
      throw new SandboxRuntimeError(
        `sandbox restore could not resolve the working-tree snapshot ${expected} its export recorded; refusing to provision a clean checkout that would silently drop the uncommitted work: ${
          listed.exitCode === 0
            ? "no ref in the restored bundle names that commit"
            : "listing the snapshot refs failed"
        }`,
        listed.stderr,
      );
    }
    // The export recorded no snapshot, so anything sitting in the namespace is
    // an older export's. Drop the lot rather than let it ride out again.
    await this.#deleteExportSnapshotRefs(containerName, timeoutMs);
    return undefined;
  }

  /**
   * Whether a provider's conversation state is actually present in the
   * container's provider home.
   *
   * `tar --extract` exiting 0 only proves the archive unpacked, not that the
   * conversation was in it: the archive is built with credential exclusions,
   * and one aimed too broadly (a bare `sessions`, which stripped Codex's
   * `~/.codex/sessions` transcripts) produces a tar that extracts cleanly and
   * restores nothing the provider can resume from. A cursor kept on the
   * strength of that fails every following turn with "No conversation found
   * with session ID", so the caller is told what is really there.
   *
   * Deliberately a directory-existence probe over the known provider stores
   * rather than a content check: what makes a cursor resolvable is the CLI's
   * own session directory being where it left it, and enumerating transcripts
   * would couple this to each provider's on-disk format.
   *
   * A union of the layouts rather than one per thread: the provision input
   * carries no provider identity (the same provider home is handed to whichever
   * CLI the thread's model selection resolves to, and that selection can change
   * between turns), so the probe has to accept every store a sandboxed provider
   * can leave behind. Being permissive is the safe direction here -- the two
   * failure modes are not symmetric. A missed layout reports `unavailable`,
   * which CLEARS the thread's resume cursor and silently loses the conversation
   * on every re-provision; a layout matched too eagerly costs at most one turn
   * a resume error. `sessions` alone was exactly the missed-layout case for
   * Claude, one of the two providers that can run sandboxed at all.
   */
  async #providerStorePopulated(containerName: string, timeoutMs: number): Promise<boolean> {
    const probed = await this.#mustExec(
      containerName,
      {
        executable: "find",
        args: [
          PROVIDER_HOME,
          "-mindepth",
          "1",
          "-maxdepth",
          "2",
          "-type",
          "d",
          "(",
          ...PROVIDER_STORE_DIRECTORIES.flatMap((name, index) =>
            index === 0 ? ["-name", name] : ["-o", "-name", name],
          ),
          ")",
        ],
        allowNonZeroExit: true,
      },
      timeoutMs,
    );
    return probed.exitCode === 0 && probed.stdout.trim().length > 0;
  }

  /**
   * Remove every snapshot ref left in the container.
   *
   * Hygiene, not correctness: `exportBundle` names the single ref its export
   * just wrote, so a ref this misses cannot ride out in a later bundle -- it
   * only clutters the user's `git log --all`. That is why a failed enumeration
   * returns quietly. It was NOT true while the bundle globbed the namespace,
   * and this silent return was then the whole of a data-retention bug: one
   * failed `for-each-ref` and the export bundled every stale ref, along with
   * the files the user had deleted since.
   */
  async #deleteExportSnapshotRefs(containerName: string, timeoutMs: number): Promise<void> {
    const listed = await this.#mustExec(
      containerName,
      {
        executable: "git",
        args: [
          "-C",
          "/workspace/repo",
          "for-each-ref",
          "--format=%(refname)",
          EXPORT_SNAPSHOT_NAMESPACE,
        ],
        allowNonZeroExit: true,
      },
      timeoutMs,
    );
    if (listed.exitCode !== 0) return;
    for (const refname of listed.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith(`${EXPORT_SNAPSHOT_NAMESPACE}/`))) {
      await this.#mustExec(
        containerName,
        { executable: "git", args: ["-C", "/workspace/repo", "update-ref", "-d", refname] },
        timeoutMs,
      );
    }
  }

  /**
   * Copy a self-contained Git bundle through the container runtime boundary
   * and verify it before the sandbox can be deleted.
   *
   * `snapshotCommit` is what the `exportBranch` immediately before this one
   * returned: the working-tree snapshot it pinned, or absent for a clean tree
   * that pinned none. It is named in the bundle explicitly -- see below for
   * why that, and not a glob over the snapshot namespace.
   */
  async exportBundle(
    threadIdValue: string,
    destination: string,
    options: {
      readonly snapshotCommit?: string;
      readonly hint?: SandboxAdoptionHint;
    } = {},
  ): Promise<void> {
    const hint = options.hint;
    const threadId = sanitizeId(threadIdValue, "threadId");
    const record = await this.#resolveRecord(threadId, hint);
    if (record === undefined)
      throw new SandboxRuntimeError(`sandbox for thread ${threadId} is not ready`);
    if (!destination.startsWith("/") || destination.includes("\0"))
      throw new SandboxRuntimeError("bundle destination must be an absolute host path");
    // The branch comes off a record that adoption may have rebuilt from a hint
    // rather than from a validated provision, and it lands here as a refspec.
    validateBranchName(record.ready.branchName);
    const containerBundle = "/tmp/t3-thread-export.bundle";
    try {
      // Exactly what a restore reads back -- the thread branch and this
      // export's own working-tree snapshot, by name -- and nothing else.
      //
      // `--all` was a data-retention bug, not merely wasteful. Every snapshot
      // ref an earlier export left in the repository rode out in every later
      // bundle, so a file the user deleted after one export was still
      // recoverable from a NEWER artifact that is supposed to represent
      // current state. The restore-side commit check stopped a stale snapshot
      // from being UNPACKED (see `#resolveExportSnapshot`), but the deleted
      // bytes were still in the artifact on disk.
      //
      // Narrowing that to a GLOB over the snapshot namespace did not fix it,
      // it just made the fix conditional on cleanup. The glob bundles whatever
      // is in the namespace, and what is in the namespace is only this
      // export's own snapshot if `#deleteExportSnapshotRefs` actually removed
      // the earlier ones -- and that started with a `for-each-ref` whose
      // failure was a silent `return`. One failed enumeration and the export
      // went on to bundle the whole namespace: stale refs, and the deleted
      // files reachable from them, straight into the new artifact.
      //
      // Naming the one ref this export just wrote takes cleanup out of the
      // correctness path entirely -- nothing else can be in the bundle,
      // whatever is left in the repository, so the deletions are hygiene
      // again. It also fails LOUDLY if that ref is not there, which a glob
      // could not: a glob matching nothing is not an error, so an export whose
      // snapshot had gone missing shipped a bundle the restore would then
      // refuse, having already torn the container down.
      //
      // A clean tree pins no snapshot and names none; restore holds whatever
      // arrives to the commit the event log recorded either way.
      await this.#mustExec(
        record.ready.containerName,
        {
          executable: "git",
          args: [
            "-C",
            "/workspace/repo",
            "bundle",
            "create",
            containerBundle,
            `refs/heads/${record.ready.branchName}`,
            ...(options.snapshotCommit === undefined
              ? []
              : [exportSnapshotRef(options.snapshotCommit)]),
          ],
        },
        120_000,
      );
      // Verify in the container, against the repository the bundle came from:
      // `bundle verify` resolves prerequisites against a repository and fails
      // with "need a repository to verify a bundle" if run from wherever the
      // server happens to live. Verifying before `cp` also keeps a bundle that
      // failed its own check from reaching the host artifact directory at all.
      await this.#mustExec(
        record.ready.containerName,
        {
          executable: "git",
          args: ["-C", "/workspace/repo", "bundle", "verify", containerBundle],
        },
        60_000,
      );
      await this.#mustRun(
        ["cp", `${record.ready.containerName}:${containerBundle}`, destination],
        120_000,
      );
    } finally {
      await this.#mustExec(
        record.ready.containerName,
        {
          executable: "rm",
          args: ["-f", containerBundle],
        },
        10_000,
      ).catch(() => undefined);
    }
  }

  /**
   * Copy the provider's conversation store out of the container so a
   * re-provisioned thread can resume the conversation instead of starting cold.
   *
   * Returns the archived byte count, or `undefined` when nothing was archived
   * -- an absent store, or one past `maxBytes`. Callers treat that as "no store
   * this time" and carry on: losing the conversation degrades the next turn,
   * losing the branch bundle would lose the user's work.
   *
   * The exclusions are not hygiene. The provider home also holds live
   * credentials (`.credentials.json`, `sessions/*.key`), so they are dropped at
   * archive time rather than filtered afterwards -- a credential that is never
   * written into the tar cannot leak out of one.
   */
  async exportProviderStore(
    threadIdValue: string,
    destination: string,
    maxBytes: number,
    hint?: SandboxAdoptionHint,
  ): Promise<number | undefined> {
    const threadId = sanitizeId(threadIdValue, "threadId");
    const record = await this.#resolveRecord(threadId, hint);
    if (record === undefined)
      throw new SandboxRuntimeError(`sandbox for thread ${threadId} is not ready`);
    if (!destination.startsWith("/") || destination.includes("\0"))
      throw new SandboxRuntimeError("store destination must be an absolute host path");
    const containerArchive = "/tmp/t3-provider-store.tar";
    try {
      const archived = await this.#mustExec(
        record.ready.containerName,
        {
          executable: "tar",
          args: [
            "--create",
            "--file",
            containerArchive,
            "--directory",
            PROVIDER_HOME,
            ...PROVIDER_STORE_EXCLUDES.flatMap((pattern) => ["--exclude", pattern]),
            ".",
          ],
          // An empty or absent provider home is the ordinary first-turn case,
          // not a failure worth failing the export over.
          allowNonZeroExit: true,
        },
        120_000,
      );
      if (archived.exitCode !== 0) return undefined;
      // Measured inside the container, before the copy: an oversized store
      // should never cross the boundary at all, let alone land in an artifact
      // directory that nothing prunes.
      const measured = await this.#mustExec(
        record.ready.containerName,
        { executable: "stat", args: ["-c", "%s", containerArchive], allowNonZeroExit: true },
        30_000,
      );
      const bytes = Number.parseInt(measured.stdout.trim(), 10);
      if (measured.exitCode !== 0 || !Number.isFinite(bytes)) return undefined;
      if (bytes > maxBytes) return undefined;
      await this.#mustRun(
        ["cp", `${record.ready.containerName}:${containerArchive}`, destination],
        120_000,
      );
      return bytes;
    } finally {
      await this.#mustExec(
        record.ready.containerName,
        { executable: "rm", args: ["-f", containerArchive] },
        10_000,
      ).catch(() => undefined);
    }
  }

  async sampleUsage(threadIdValue: string): Promise<SandboxUsageSample> {
    const threadId = sanitizeId(threadIdValue, "threadId");
    const record = this.#records.get(threadId);
    if (record === undefined)
      throw new SandboxRuntimeError(`sandbox for thread ${threadId} is not ready`);
    const stats = await this.#mustRun(
      ["stats", "--no-stream", "--format", "{{json .}}", record.ready.containerName],
      15_000,
    );
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(stats.stdout) as Record<string, unknown>;
    } catch {
      throw new SandboxRuntimeError("sandbox runtime returned malformed usage stats");
    }
    const cpu = parsePercent(value.CPUPerc ?? value.CPU);
    const memory = parseByteQuantity(
      String(value.MemUsage ?? value.MemUsageBytes ?? "")
        .split("/")[0]
        ?.trim() ?? "",
    );
    const pids = Number(value.PIDs ?? value.Pids ?? 0);
    const disk = await this.#mustExec(
      record.ready.containerName,
      {
        executable: "du",
        args: ["-sb", "/workspace", "/thread-data"],
      },
      15_000,
    );
    const diskBytes = disk.stdout
      .split("\n")
      .reduce((total, line) => total + (Number(line.split(/\s+/, 1)[0]) || 0), 0);
    if (![cpu, memory, pids, diskBytes].every(Number.isFinite) || pids < 0 || diskBytes < 0)
      throw new SandboxRuntimeError("sandbox runtime returned invalid usage stats");
    return {
      cpuPercent: Math.max(0, Math.min(100, cpu)),
      memoryBytes: Math.max(0, Math.floor(memory)),
      diskBytes: Math.floor(diskBytes),
      processCount: Math.floor(pids),
    };
  }

  async stop(
    threadIdValue: string,
    teardown: ReadonlyArray<SandboxHook> = [],
    hint?: SandboxAdoptionHint,
  ): Promise<void> {
    const threadId = sanitizeId(threadIdValue, "threadId");
    this.#stopping.add(threadId);
    try {
      // Let an in-flight provision finish before tearing anything down.
      //
      // A stop that ran concurrently with one destroyed whatever existed at
      // that instant and returned; the container, sidecars, network, and
      // volumes the provision created moments afterwards were left running
      // with nothing holding a reference to them -- unreachable, unaccounted
      // for, and never reclaimed. A forced deletion looked complete while the
      // workload was still up.
      //
      // Its outcome is irrelevant here: a provision that failed already
      // unwound itself, and one that succeeded left a record for the teardown
      // below to act on. Either way the tombstone above makes `#provision`
      // unwind rather than publish, so nothing survives this await.
      await this.#provisioning.get(threadId)?.catch(() => undefined);
      await this.#stopUnsynchronized(threadId, teardown, hint);
    } finally {
      this.#stopping.delete(threadId);
    }
  }

  async #stopUnsynchronized(
    threadId: string,
    teardown: ReadonlyArray<SandboxHook>,
    hint: SandboxAdoptionHint | undefined,
  ): Promise<void> {
    const record = await this.#resolveRecord(threadId, hint);
    if (record === undefined) return;
    const failures: string[] = [];
    // An adopted record carries no teardown hooks: the declarations were held
    // in the manager's memory and did not survive the restart. Reclaiming the
    // resources is still worth doing, so skip the hooks rather than the stop.
    for (const hook of record.adopted ? [] : teardown) {
      validateHook(hook);
      try {
        await this.#mustExec(record.ready.containerName, hook, record.teardownTimeoutMs);
      } catch (error) {
        failures.push(`teardown ${hook.executable}: ${String(error)}`);
      }
    }
    // Containers #cleanup below removes by name. The sibling phase must skip
    // them: removing one here makes the corresponding `rm --force <name>` in
    // #cleanup fail, which turns an orderly stop into a reported failure.
    failures.push(
      ...(await this.#removeManagedSiblingContainers(
        threadId,
        new Set(
          [record.ready.containerName, record.ready.egressProxyContainerName].filter(
            (name): name is string => name !== undefined,
          ),
        ),
      )),
    );
    failures.push(
      ...(await this.#cleanup(
        record.ready.containerName,
        record.ready.networkName,
        record.ready.workspaceVolumeName,
        record.ready.desktopVolumeName,
        record.teardownTimeoutMs,
        record.ready.egressProxyContainerName && record.ready.egressNetworkName
          ? {
              container: record.ready.egressProxyContainerName,
              network: record.ready.egressNetworkName,
              // An adopted record cannot know whether an egress sidecar was
              // ever provisioned, only what it would have been named. Removing
              // one that never existed is not a teardown failure.
              optional: record.adopted === true,
            }
          : undefined,
      )),
    );
    this.#records.delete(threadId);
    if (failures.length > 0)
      throw new SandboxRuntimeError(`sandbox cleanup failed: ${failures.join("; ")}`);
  }

  async reconcile(input: SandboxReconcileInput): Promise<SandboxReconcileResult> {
    const list = await this.#mustRun(
      [
        "ps",
        "--all",
        "--filter",
        `label=${MANAGED_LABEL}`,
        "--filter",
        `label=${ROLE_LABEL}=workspace`,
        "--filter",
        "status=running",
        "--format",
        `{{.ID}}\t{{.Label "${THREAD_LABEL}"}}\t{{.Label "${PROJECT_LABEL}"}}`,
      ],
      30_000,
    );
    const active = new Map<string, { runtimeRef: string; projectId: string }>();
    for (const line of list.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [runtimeRef, rawThreadId, rawProjectId, extra] = line.split("\t");
      if (
        !runtimeRef ||
        !rawThreadId ||
        !rawProjectId ||
        extra !== undefined ||
        !/^[a-f0-9]{12,64}$/i.test(runtimeRef)
      )
        continue;
      try {
        active.set(sanitizeId(rawThreadId, "thread label"), {
          runtimeRef,
          projectId: sanitizeId(rawProjectId, "project label"),
        });
      } catch {
        /* Ignore malformed untrusted labels. */
      }
    }
    const expected = new Set(
      [...input.expectedThreadIds].map((id) => sanitizeId(id, "expected threadId")),
    );
    const orphanThreadIds = [...active.keys()].filter((id) => !expected.has(id));
    const removedRuntimeRefs: string[] = [];
    if (input.removeOrphans) {
      for (const threadId of orphanThreadIds) {
        const runtimeRef = active.get(threadId)!.runtimeRef;
        const inspect = await this.#mustRun(
          [
            "inspect",
            "--format",
            `{{index .Config.Labels "${THREAD_LABEL}"}}\t{{index .Config.Labels "com.t3tools.sandbox.managed"}}`,
            runtimeRef,
          ],
          10_000,
        );
        if (inspect.stdout.trim() !== `${threadId}\ttrue`) continue;
        const threadContainers = await this.#mustRun(
          [
            "ps",
            "--all",
            "--filter",
            `label=${MANAGED_LABEL}`,
            "--filter",
            `label=${THREAD_LABEL}=${threadId}`,
            "--format",
            "{{.ID}}",
          ],
          30_000,
        );
        for (const candidate of threadContainers.stdout
          .split("\n")
          .map((item) => item.trim())
          .filter((item) => /^[a-f0-9]{12,64}$/i.test(item))) {
          const candidateInspect = await this.#mustRun(
            [
              "inspect",
              "--format",
              `{{index .Config.Labels "${THREAD_LABEL}"}}\t{{index .Config.Labels "com.t3tools.sandbox.managed"}}`,
              candidate,
            ],
            10_000,
          );
          if (candidateInspect.stdout.trim() !== `${threadId}\ttrue`) continue;
          await this.#mustRun(["rm", "--force", candidate], 30_000);
          removedRuntimeRefs.push(candidate);
        }
      }
      for (const kind of ["network", "volume"] as const) {
        const resources = await this.#mustRun(
          [
            kind,
            "ls",
            "--filter",
            `label=${MANAGED_LABEL}`,
            "--format",
            `{{.Name}}\t{{.Label "${THREAD_LABEL}"}}`,
          ],
          30_000,
        );
        for (const line of resources.stdout.split("\n")) {
          const [name, rawThreadId, extra] = line.split("\t");
          if (!name || !rawThreadId || extra !== undefined) continue;
          let resourceThreadId: string;
          try {
            resourceThreadId = sanitizeId(rawThreadId, "thread label");
          } catch {
            continue;
          }
          if (expected.has(resourceThreadId)) continue;
          const inspect = await this.#mustRun(
            [
              kind,
              "inspect",
              "--format",
              `{{index .Labels "${THREAD_LABEL}"}}\t{{index .Labels "com.t3tools.sandbox.managed"}}`,
              name,
            ],
            10_000,
          );
          if (inspect.stdout.trim() !== `${resourceThreadId}\ttrue`) continue;
          await this.#mustRun([kind, "rm", name], 30_000);
          removedRuntimeRefs.push(name);
        }
      }
    }
    // A running workspace label alone cannot prove the project declarations,
    // teardown hooks, services, credentials, caches, or egress generation that
    // produced it. Records retained by this manager generation are adopted
    // outright and are genuinely usable.
    //
    // A restart-discovered container is different. Its label signature proves
    // identity and provenance, which is enough to export and tear it down --
    // but not enough to resume: the declarations that would re-arm credentials,
    // preview routes, and automation targets died with the restart, and
    // adoption is deliberately never cached in `#records`, so `exec`,
    // `runtimeRef`, and checkpointing all still throw. Reporting such a thread
    // as active claimed a sandbox the caller could not use anywhere -- the
    // projection said `ready` while every operation failed. It is reported
    // separately instead: still missing (so a caller that ignores the
    // distinction fails the thread and lets it re-provision, the fail-closed
    // outcome), and additionally unresumable, so a caller that understands the
    // state can stop it -- which exports its work first -- rather than
    // abandoning a container holding the user's commits.
    //
    // A discovered container that cannot be verified at all is stopped rather
    // than left running unaccounted: a container nothing can address or tear
    // down must not keep running the workload.
    const adopted: string[] = [];
    const unresumable: string[] = [];
    for (const [id, info] of active) {
      if (!expected.has(id)) continue;
      if (this.#records.has(id)) {
        adopted.push(id);
        continue;
      }
      const hint = input.adoptionHints?.get(id);
      if (hint !== undefined) {
        const projectId = sanitizeId(hint.projectId, "projectId");
        const matches = await this.#matchesThreadLabels(
          resourceNames(projectId, id).containerName,
          {
            threadId: id,
            projectId,
            image: hint.image,
            baseCommit: hint.baseCommit,
            branchName: hint.branchName,
          },
        );
        if (matches) {
          unresumable.push(id);
          continue;
        }
      }
      if (!input.removeOrphans) continue;
      const inspect = await this.#run(
        [
          "inspect",
          "--format",
          `{{index .Config.Labels "${THREAD_LABEL}"}}\t{{index .Config.Labels "com.t3tools.sandbox.managed"}}`,
          info.runtimeRef,
        ],
        10_000,
        true,
      );
      if (inspect.exitCode !== 0 || inspect.stdout.trim() !== `${id}\ttrue`) continue;
      await this.#mustRun(["rm", "--force", info.runtimeRef], 30_000);
      removedRuntimeRefs.push(info.runtimeRef);
    }
    return {
      activeThreadIds: adopted,
      missingThreadIds: [...expected].filter((id) => !adopted.includes(id)),
      unresumableThreadIds: unresumable,
      orphanThreadIds,
      removedRuntimeRefs,
    };
  }

  async #validateRootless(): Promise<void> {
    if (this.#validatedRootless) return;
    const args =
      this.#binary === "docker"
        ? ["info", "--format", "{{json .SecurityOptions}}"]
        : ["info", "--format", "{{.Host.Security.Rootless}}"];
    const result = await this.#mustRun(args, 15_000);
    const rootless =
      this.#binary === "docker"
        ? result.stdout.toLowerCase().includes("rootless")
        : result.stdout.trim() === "true";
    if (!rootless) throw new SandboxRuntimeError(`${this.#binary} must run in rootless mode`);
    this.#validatedRootless = true;
  }

  /**
   * Whether the container is the running workspace this exact thread
   * provisioned. The label set is stamped once at `docker run` and never
   * updated, so a match proves identity and provenance -- not that setup hooks
   * completed, that sidecars are still up, or that any of it is safe to resume.
   */
  async #matchesThreadLabels(
    containerName: string,
    expected: {
      readonly threadId: string;
      readonly projectId: string;
      readonly image: string;
      readonly baseCommit: string;
      readonly branchName: string;
    },
  ): Promise<boolean> {
    const labels = await this.#run(
      [
        "inspect",
        "--format",
        `{{index .Config.Labels "${THREAD_LABEL}"}}\t{{index .Config.Labels "${PROJECT_LABEL}"}}\t{{index .Config.Labels "com.t3tools.sandbox.managed"}}\t{{index .Config.Labels "${IMAGE_LABEL}"}}\t{{index .Config.Labels "${BASE_LABEL}"}}\t{{index .Config.Labels "${BRANCH_LABEL}"}}\t{{index .Config.Labels "${ROLE_LABEL}"}}\t{{.State.Running}}`,
        containerName,
      ],
      10_000,
      true,
    );
    if (labels.exitCode !== 0) return false;
    return (
      labels.stdout.trim() ===
      `${expected.threadId}\t${expected.projectId}\ttrue\t${expected.image}\t${expected.baseCommit}\t${expected.branchName}\tworkspace\ttrue`
    );
  }

  /**
   * The record for a thread, rebuilding it from `hint` when this manager
   * generation never provisioned the sandbox -- a server restart empties
   * `#records`, which otherwise strands the thread's commits inside a volume
   * that can no longer be exported or removed.
   *
   * Adoption here is deliberately narrower than `reconcile`'s: it is granted
   * only for export and teardown, only for a container whose labels still match
   * the thread that provisioned it, and it re-arms nothing.
   */
  async #resolveRecord(
    threadId: string,
    hint: SandboxAdoptionHint | undefined,
  ): Promise<RecordEntry | undefined> {
    const record = this.#records.get(threadId);
    if (record !== undefined) return record;
    if (hint === undefined) return undefined;
    const projectId = sanitizeId(hint.projectId, "projectId");
    const names = resourceNames(projectId, threadId);
    const matches = await this.#matchesThreadLabels(names.containerName, {
      threadId,
      projectId,
      image: hint.image,
      baseCommit: hint.baseCommit,
      branchName: hint.branchName,
    });
    if (!matches) return undefined;
    // Not cached in `#records`: an adopted container is only ever addressed for
    // the operation that adopted it. Caching would make it reachable from
    // `exec` and `runtimeRef`, which is exactly the resumption reconcile
    // refuses.
    return {
      ready: {
        sandboxId: threadId,
        runtime: this.runtime,
        containerName: names.containerName,
        networkName: names.networkName,
        workspaceVolumeName: names.workspaceVolumeName,
        desktopVolumeName: names.desktopVolumeName,
        // Whether an egress sidecar was ever started is not recorded anywhere,
        // so cleanup probes for it rather than assuming either way.
        egressProxyContainerName: names.egressProxyContainerName,
        egressNetworkName: names.egressNetworkName,
        branchName: hint.branchName,
        limits: DEFAULT_SANDBOX_RESOURCE_LIMITS,
      },
      teardownTimeoutMs: hint.teardownTimeoutMs ?? boundedTimeout(undefined, 120),
      egressConfigured: false,
      adopted: true,
    };
  }

  async #removeManagedSiblingContainers(
    threadId: string,
    ownedContainers: ReadonlySet<string>,
  ): Promise<string[]> {
    const failures: string[] = [];
    const listed = await this.#run(
      [
        "ps",
        "--all",
        "--filter",
        `label=${MANAGED_LABEL}`,
        "--filter",
        `label=${THREAD_LABEL}=${threadId}`,
        "--format",
        "{{.ID}}\t{{.Names}}",
      ],
      30_000,
      true,
    );
    if (listed.exitCode !== 0) return [`list sibling containers: ${listed.stderr}`];
    for (const line of listed.stdout.split("\n")) {
      const [rawId, rawNames] = line.split("\t");
      const candidate = rawId?.trim() ?? "";
      if (candidate.length === 0 || !/^[A-Za-z0-9_.-]{1,128}$/.test(candidate)) continue;
      // The listing filters on the exact labels the workspace container itself
      // carries, so it is always part of its own listing. Excluding it by
      // comparing the listed ID against the workspace NAME can never match --
      // that comparison force-removed the workspace container as its own
      // "sibling", made #cleanup's `rm --force <name>` fail, and wedged the
      // thread in `stopping`. `{{.Names}}` prints the plain name under
      // --format on both docker and podman (no leading slash, same tab-column
      // parsing as `reconcile`'s label listing), so compare name to name.
      const names = (rawNames ?? "").split(",").map((item) => item.trim());
      if (names.some((name) => ownedContainers.has(name))) continue;
      const inspected = await this.#run(
        [
          "inspect",
          "--format",
          `{{index .Config.Labels "${THREAD_LABEL}"}}\t{{index .Config.Labels "com.t3tools.sandbox.managed"}}`,
          candidate,
        ],
        10_000,
        true,
      );
      if (inspected.exitCode !== 0 || inspected.stdout.trim() !== `${threadId}\ttrue`) continue;
      const removed = await this.#run(["rm", "--force", candidate], 30_000, true);
      if (removed.exitCode !== 0) failures.push(`remove sibling ${candidate}: ${removed.stderr}`);
    }
    return failures;
  }

  async #cleanup(
    container: string,
    network: string,
    volume: string,
    desktopVolume: string,
    timeoutMs: number,
    egress?: {
      readonly container: string;
      readonly network: string;
      readonly optional?: boolean;
    },
  ): Promise<string[]> {
    const failures: string[] = [];
    const egressOptional = egress?.optional === true;
    for (const [args, optional] of [
      [["rm", "--force", container], false],
      ...(egress ? [[["rm", "--force", egress.container], egressOptional] as const] : []),
      [["network", "rm", network], false],
      ...(egress ? [[["network", "rm", egress.network], egressOptional] as const] : []),
      [["volume", "rm", volume], false],
      [["volume", "rm", desktopVolume], false],
    ] as ReadonlyArray<readonly [ReadonlyArray<string>, boolean]>) {
      const result = await this.#run(args, timeoutMs, true).catch((error) => ({
        exitCode: 1,
        stdout: "",
        stderr: String(error),
      }));
      if (result.exitCode !== 0 && !optional)
        failures.push(`${args[0]} ${args.at(-1)}: ${result.stderr}`);
    }
    return failures;
  }

  #run(args: ReadonlyArray<string>, timeoutMs: number, allowFailure = false) {
    return this.#executor.run({ executable: this.#binary, args, timeoutMs }).then((result) => {
      if (!allowFailure && result.exitCode !== 0)
        throw new SandboxRuntimeError(
          `${this.#binary} ${args[0]} failed${quotaUnsupportedHint(args, result.stderr)}`,
          result.stderr,
        );
      return result;
    });
  }

  async #mustRun(args: ReadonlyArray<string>, timeoutMs: number) {
    return this.#run(args, timeoutMs);
  }

  #mustExec(containerName: string, input: SandboxExecInput | SandboxHook, timeoutMs: number) {
    validateExec(input);
    const cwd = "cwd" in input ? input.cwd : undefined;
    const args = [
      "exec",
      "--user",
      "1000:1000",
      ...(cwd ? ["--workdir", cwd] : []),
      ...Object.entries(input.env ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      "--",
      containerName,
      input.executable,
      ...(input.args ?? []),
    ];
    const command = {
      executable: this.#binary,
      args,
      timeoutMs,
      ...("stdin" in input && input.stdin !== undefined ? { stdin: input.stdin } : {}),
    };
    const allowNonZeroExit = "allowNonZeroExit" in input && input.allowNonZeroExit === true;
    return this.#executor.run(command).then((result) => {
      if (result.exitCode !== 0 && !allowNonZeroExit)
        throw new SandboxRuntimeError(`sandbox command ${input.executable} failed`, result.stderr);
      return result;
    });
  }
}

/**
 * Every per-thread resource name derives from `(projectId, threadId)` alone, so
 * a sandbox provisioned by an earlier server generation can be addressed again
 * without consulting any in-memory state.
 */
function resourceNames(projectId: string, threadId: string) {
  const suffix = NodeCrypto.createHash("sha256")
    .update(`${projectId}\0${threadId}`)
    .digest("hex")
    .slice(0, 32);
  return {
    containerName: `t3-thread-${suffix}`,
    networkName: `t3-net-${suffix}`,
    workspaceVolumeName: `t3-workspace-${suffix}`,
    desktopVolumeName: `t3-desktop-${suffix}`,
    egressProxyContainerName: `t3-egress-${suffix}`,
    egressNetworkName: `t3-egress-net-${suffix}`,
  };
}

function makeReady(
  runtime: SandboxRuntime,
  containerName: string,
  networkName: string,
  workspaceVolumeName: string,
  desktopVolumeName: string,
  input: SandboxProvisionInput,
  limits: typeof DEFAULT_SANDBOX_RESOURCE_LIMITS,
): SandboxReady {
  return {
    sandboxId: sanitizeId(input.bootstrap.threadId, "threadId"),
    runtime,
    containerName,
    networkName,
    workspaceVolumeName,
    desktopVolumeName,
    ...(input.egressProxyImage === undefined
      ? {}
      : (({ egressProxyContainerName, egressNetworkName }) => ({
          egressProxyContainerName,
          egressNetworkName,
        }))(
          resourceNames(
            sanitizeId(input.bootstrap.projectId, "projectId"),
            sanitizeId(input.bootstrap.threadId, "threadId"),
          ),
        )),
    branchName: input.bootstrap.branchName,
    limits,
  };
}

/**
 * Whether the container's writable layer carries `--storage-opt size=`.
 *
 * Off unless `T3_SANDBOX_CONTAINER_STORAGE_QUOTA=enabled`. `podman --remote`
 * rejects the flag outright, and every socket deployment is remote by
 * construction (see `deploy/openclaw/sandbox/podman-wrapper.sh`), so a default
 * of "on" made provisioning fail on exactly the hosts this runtime targets.
 * Dropping it costs no disk bound: the rootfs is `--read-only`, and every
 * writable path is either a quota-bearing volume or a size-bounded tmpfs.
 *
 * Deployments on a local daemon that does accept it can opt back in.
 */
function containerStorageQuotaEnabled(): boolean {
  return process.env.T3_SANDBOX_CONTAINER_STORAGE_QUOTA?.trim().toLowerCase() === "enabled";
}

/**
 * Whether the workspace and desktop volumes carry `--opt o=size=` XFS project
 * quotas.
 *
 * On unless `T3_SANDBOX_VOLUME_STORAGE_QUOTA=disabled`. These are the real
 * per-thread disk bound in a socket deployment, and they work over
 * `--remote` -- which is why they are governed separately from the container
 * flag above. A single switch over both left no configuration that was
 * simultaneously working and bounded: enabling it broke provisioning on remote
 * podman, and disabling it also threw away the volume limits that do hold.
 *
 * The opt-out exists for hosts where quotas cannot be administered at all
 * (rootless podman needs `CAP_SYS_ADMIN` in the filesystem's owning namespace
 * for XFS project quotas, or a privileged helper): there, a quota-bearing
 * volume create fails outright rather than going quietly unenforced.
 *
 * With the new variable unset, a legacy `T3_SANDBOX_CONTAINER_STORAGE_QUOTA=
 * disabled` is honoured as the same opt-out -- that one switch used to gate
 * both controls, and the hosts that set it are precisely the ones that cannot
 * administer quotas.
 */
/**
 * Names the switch when a host simply cannot administer XFS project quotas.
 *
 * The runtime's own wording ("Filesystem does not support Project Quota") says
 * what failed but not what to do, and quotas are on by default -- so without
 * this an operator on such a host sees provisioning die with a message that
 * never mentions the flag that fixes it.
 */
function quotaUnsupportedHint(args: ReadonlyArray<string>, stderr: string): string {
  if (args[0] !== "volume" || !/project quota/i.test(stderr)) return "";
  return " (this host cannot administer XFS project quotas; set T3_SANDBOX_VOLUME_STORAGE_QUOTA=disabled to provision without per-volume limits)";
}

/**
 * Warned at most once per process: the answer is read several times per
 * provision, and a deprecation notice repeated per volume create would bury
 * the provisioning log it is meant to appear in.
 */
let warnedLegacyVolumeQuotaOptOut = false;

function volumeStorageQuotaEnabled(): boolean {
  const explicit = process.env.T3_SANDBOX_VOLUME_STORAGE_QUOTA?.trim().toLowerCase();
  // An explicit value for the variable that governs volume quotas always wins,
  // including an explicit re-enable on a host that still sets the legacy one.
  if (explicit !== undefined && explicit.length > 0) return explicit !== "disabled";
  // Before the two controls were split, `T3_SANDBOX_CONTAINER_STORAGE_QUOTA`
  // gated BOTH, and hosts that cannot administer XFS project quotas were
  // documented to set it to `disabled`. Honouring only the new variable would
  // silently re-enable volume quotas on exactly those hosts at upgrade time,
  // and every provision would then die on the first quota-bearing `volume
  // create`. The legacy value keeps them off until the host is migrated.
  if (process.env.T3_SANDBOX_CONTAINER_STORAGE_QUOTA?.trim().toLowerCase() !== "disabled")
    return true;
  if (!warnedLegacyVolumeQuotaOptOut) {
    warnedLegacyVolumeQuotaOptOut = true;
    Effect.runFork(
      Effect.logWarning(
        "T3_SANDBOX_CONTAINER_STORAGE_QUOTA=disabled is deprecated for volume quotas; set T3_SANDBOX_VOLUME_STORAGE_QUOTA=disabled instead",
      ),
    );
  }
  return false;
}

function boundedTimeout(seconds: number | undefined, fallback: number): number {
  const value = seconds ?? fallback;
  if (!Number.isInteger(value) || value < 1 || value > 600)
    throw new SandboxRuntimeError("hook timeout must be between 1 and 600 seconds");
  return value * 1000;
}

function validateLimits(limits: typeof DEFAULT_SANDBOX_RESOURCE_LIMITS): void {
  if (
    !(limits.cpuCount > 0 && limits.cpuCount <= 64) ||
    !Number.isInteger(limits.memoryBytes) ||
    limits.memoryBytes < 128 * 1024 ** 2 ||
    !Number.isInteger(limits.processCount) ||
    limits.processCount < 16 ||
    !Number.isInteger(limits.diskBytes) ||
    limits.diskBytes < 1024 ** 3
  ) {
    throw new SandboxRuntimeError("sandbox resource limits are invalid");
  }
}

function validateProxy(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new SandboxRuntimeError("egress proxy must use http or https");
  if (url.username || url.password)
    throw new SandboxRuntimeError(
      "egress proxy credentials must be brokered outside configuration",
    );
  return url.toString();
}

function parsePercent(value: unknown): number {
  return Number(
    String(value ?? "0")
      .trim()
      .replace(/%$/, ""),
  );
}

function parseByteQuantity(value: string): number {
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*([kmgtpe]?i?b)?$/i.exec(value);
  if (!match) return Number.NaN;
  const unit = (match[2] ?? "b").toLowerCase();
  const powers: Record<string, number> = {
    b: 0,
    kb: 1,
    kib: 1,
    mb: 2,
    mib: 2,
    gb: 3,
    gib: 3,
    tb: 4,
    tib: 4,
    pb: 5,
    pib: 5,
    eb: 6,
    eib: 6,
  };
  const power = powers[unit];
  return power === undefined ? Number.NaN : Number(match[1]) * 1024 ** power;
}
