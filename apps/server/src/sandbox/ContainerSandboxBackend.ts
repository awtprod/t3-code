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
  validateBootstrap,
  validateCache,
  validateExec,
  validateHook,
} from "./validation.ts";
import { CREDENTIAL_PROXY_ALIAS } from "./SandboxCredentialProxy.ts";
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
 * Paths excluded from the archived provider store, relative to `PROVIDER_HOME`.
 *
 * Credentials first: the provider home holds live auth material next to the
 * transcripts, and an exported archive lands in a host directory that outlives
 * the container. Excluding at archive time means a credential is never written
 * into the tar in the first place. The rest is churn -- crash-time temp files
 * and caches that a restored store is better off without.
 */
const PROVIDER_STORE_EXCLUDES = [
  ".credentials.json",
  "*.credentials.json",
  ".claude.json.tmp.*",
  "sessions",
  "*.key",
  "*token*",
  "*auth*",
  ".cache",
] as const;

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
  #validatedRootless = false;

  constructor(runtime: "docker" | "podman", executor: SandboxCommandExecutor) {
    this.runtime = runtime;
    this.#binary = runtime;
    this.#executor = executor;
  }

  runtimeRef(threadIdValue: string): string | undefined {
    return this.#records.get(sanitizeId(threadIdValue, "threadId"))?.ready.containerName;
  }

  async ensureReady(input: SandboxProvisionInput): Promise<SandboxReady> {
    const threadId = sanitizeId(input.bootstrap.threadId, "threadId");
    const ready = this.#records.get(threadId)?.ready;
    if (ready !== undefined) return Promise.resolve(ready);
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
      const existing = makeReady(
        this.runtime,
        containerName,
        networkName,
        workspaceVolumeName,
        desktopVolumeName,
        input,
        limits,
      );
      this.#records.set(threadId, { ready: existing, teardownTimeoutMs });
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
          ...(storageQuotaDisabled() ? [] : ["--opt", desktopQuota]),
          desktopVolumeName,
        ],
        30_000,
      );
      if (!storageQuotaDisabled()) {
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
          ...(storageQuotaDisabled() ? [] : ["--opt", workspaceQuota]),
          workspaceVolumeName,
        ],
        30_000,
      );
      if (!storageQuotaDisabled()) {
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
        "--pids-limit",
        String(limits.processCount),
        // `podman --remote` rejects `--storage-opt size=`, so deployments that
        // talk to a user socket opt out. Dropping it is safe: the container
        // rootfs is `--read-only`, and every writable path is either a
        // quota'd volume (/workspace, /thread-data) or a size-bounded tmpfs.
        ...(storageQuotaDisabled() ? [] : ["--storage-opt", `size=${limits.diskBytes}`]),
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
        // part worth failing over, and the reactor clears the now-stale resume
        // cursor so the next turn starts a fresh conversation cleanly.
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
      const gitIdentity = sandboxGitIdentity();
      if (gitIdentity !== undefined) {
        for (const [key, value] of [
          ["user.name", gitIdentity.name],
          ["user.email", gitIdentity.email],
        ] as const) {
          await this.#mustExec(
            containerName,
            { executable: "git", args: ["-C", "/workspace/repo", "config", key, value] },
            setupTimeoutMs,
          );
        }
      }
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
      throw error;
    }
    const ready = makeReady(
      this.runtime,
      containerName,
      networkName,
      workspaceVolumeName,
      desktopVolumeName,
      input,
      limits,
    );
    this.#records.set(threadId, { ready, teardownTimeoutMs });
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
      return { commit: commit.stdout.trim(), patch: fullPatch.stdout };
    } finally {
      await this.#mustExec(
        record.ready.containerName,
        { executable: "rm", args: ["-f", exportIndex] },
        10_000,
      ).catch(() => undefined);
    }
  }

  /** Copy a self-contained Git bundle through the container runtime boundary
   * and verify it before the sandbox can be deleted. */
  async exportBundle(
    threadIdValue: string,
    destination: string,
    hint?: SandboxAdoptionHint,
  ): Promise<void> {
    const threadId = sanitizeId(threadIdValue, "threadId");
    const record = await this.#resolveRecord(threadId, hint);
    if (record === undefined)
      throw new SandboxRuntimeError(`sandbox for thread ${threadId} is not ready`);
    if (!destination.startsWith("/") || destination.includes("\0"))
      throw new SandboxRuntimeError("bundle destination must be an absolute host path");
    const containerBundle = "/tmp/t3-thread-export.bundle";
    try {
      await this.#mustExec(
        record.ready.containerName,
        {
          executable: "git",
          args: ["-C", "/workspace/repo", "bundle", "create", containerBundle, "--all"],
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
        `{{.ID}}\t{{.Label \"${THREAD_LABEL}\"}}\t{{.Label \"${PROJECT_LABEL}\"}}`,
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
            `{{index .Config.Labels \"${THREAD_LABEL}\"}}\t{{index .Config.Labels \"com.t3tools.sandbox.managed\"}}`,
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
            `{{.Name}}\t{{.Label \"${THREAD_LABEL}\"}}`,
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
              `{{index .Labels \"${THREAD_LABEL}\"}}\t{{index .Labels \"com.t3tools.sandbox.managed\"}}`,
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
    // produced it. Only records retained by this manager generation are safe to
    // adopt; restart-discovered containers remain fail-closed for reconciliation.
    const adopted = [...active.keys()].filter((id) => expected.has(id) && this.#records.has(id));
    return {
      activeThreadIds: adopted,
      missingThreadIds: [...expected].filter((id) => !adopted.includes(id)),
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
        throw new SandboxRuntimeError(`${this.#binary} ${args[0]} failed`, result.stderr);
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
 * `T3_SANDBOX_CONTAINER_STORAGE_QUOTA=disabled` omits the container's
 * `--storage-opt` pair and the workspace/desktop volumes' `--opt o=size=`
 * pair. Rootless podman needs `CAP_SYS_ADMIN` in the filesystem's owning
 * namespace to administer XFS project quotas, which it never has -- so on
 * hosts without a privileged quota helper, every quota-bearing volume create
 * fails outright, not just the container's own storage-opt.
 */
function storageQuotaDisabled(): boolean {
  return process.env.T3_SANDBOX_CONTAINER_STORAGE_QUOTA?.trim().toLowerCase() === "disabled";
}

/**
 * Git identity for in-sandbox commits, applied locally to the cloned repo.
 * A fresh clone inherits no identity and the container has no global config,
 * so without this every `git commit` inside the sandbox fails.
 */
function sandboxGitIdentity(): { readonly name: string; readonly email: string } | undefined {
  const name = process.env.T3_SANDBOX_GIT_USER_NAME?.trim();
  const email = process.env.T3_SANDBOX_GIT_USER_EMAIL?.trim();
  return name && email ? { name, email } : undefined;
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
