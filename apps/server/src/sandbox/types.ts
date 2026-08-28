import type { SandboxConfig, SandboxResourceLimits, SandboxRuntime } from "@t3tools/contracts";

export type SandboxCommand = {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin?: string;
  readonly timeoutMs: number;
};

export type SandboxCommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export interface SandboxCommandExecutor {
  readonly run: (command: SandboxCommand) => Promise<SandboxCommandResult>;
}

export type SandboxCache = {
  /** A content-addressed, runtime-managed volume name. Host paths are not accepted. */
  readonly digest: string;
  readonly target: string;
};

export type SandboxHook = {
  readonly executable: string;
  readonly args?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
};

export type SandboxBootstrap = {
  readonly threadId: string;
  readonly projectId: string;
  readonly repositoryUrl: string;
  /** Real Git remote restored after a local checkout is transferred by bundle. */
  readonly repositoryRemoteUrl?: string;
  /** Effective push URL when it differs from the fetch URL. */
  readonly repositoryPushRemoteUrl?: string;
  readonly baseCommit: string;
  readonly branchName: string;
  readonly parentThreadId?: string;
  readonly inheritedPatch?: string;
  /** Manager-generated verified bundle path; never a user-supplied mount. */
  readonly repositoryBundlePath?: string;
  /**
   * Ref the bundle records the base commit under. Set with
   * `repositoryBundlePath`: the bundle names exactly this ref, and `git clone`
   * would ignore it (its default refspec only matches `refs/heads/*`), so the
   * seeding fetch has to ask for it by name.
   */
  readonly repositoryBundleRef?: string;
  /**
   * Commit to check the thread branch out at, when the bundle above is a
   * previously exported sandbox rather than a fresh seed of `baseCommit`.
   *
   * `baseCommit` deliberately keeps naming the thread's recorded base: it is
   * part of the label signature stamped on the container, and a restore that
   * moved it would make the sandbox unrecognizable to label-verified adoption.
   */
  readonly restoreCommit?: string;
  /**
   * Commit the export recorded its working-tree snapshot at, carried from the
   * event log rather than read out of the bundle.
   *
   * The restore refuses to unpack a snapshot that does not match: the ref in
   * the bundle is named by its own commit, so a ref naming anything else is a
   * bundle that was truncated, rewritten, or built by a different export, and
   * unpacking its tree would overwrite the user's checkout with someone
   * else's. Absent when the export's tree was clean and for bundles written
   * before snapshots existed -- both correctly restore to the exported head.
   */
  readonly restoreSnapshotCommit?: string;
  /**
   * Manager-generated verified tar of a previously exported provider
   * conversation store, extracted over the container's provider home before
   * any provider can spawn.
   *
   * Absent whenever the store could not be carried across -- no prior export,
   * a digest mismatch, an oversized store. The thread still provisions; the
   * provider just starts without the earlier conversation.
   */
  readonly providerStorePath?: string;
};

/**
 * A previously exported branch bundle to seed a re-provisioned sandbox from,
 * so a thread that was settled, stopped, or idle-reaped comes back with its
 * work rather than at the project's base commit.
 *
 * The manager resolves this against its artifact root and verifies the digest
 * before use; a missing or corrupt artifact degrades to a normal clone at
 * `bootstrap.baseCommit` rather than failing the provision.
 */
export type SandboxRestoreSource = {
  readonly artifactId: string;
  readonly bundleSha256: string;
  readonly headCommit: string;
  readonly branchName: string;
  /**
   * Digest of the archived provider conversation store, when the export
   * captured one. Absent for exports written before stores were captured, and
   * for stores skipped as oversized -- the restore then seeds the repository
   * but leaves the provider without prior context.
   */
  readonly storeSha256?: string;
  /**
   * Commit the export pinned its working-tree snapshot at, when the tree was
   * dirty.
   *
   * Restore requires the bundle's snapshot ref to resolve to exactly this
   * commit before it will unpack that tree over the checked-out branch: the
   * ref is named by its own commit, so a mismatch means the bundle was
   * truncated, rewritten, or assembled from a different export. Absent when
   * the tree was clean, and for exports written before snapshots existed.
   */
  readonly snapshotCommit?: string;
};

export type SandboxProvisionInput = {
  readonly bootstrap: SandboxBootstrap;
  readonly restore?: SandboxRestoreSource;
  readonly config?: SandboxConfig;
  readonly image: string;
  readonly caches?: ReadonlyArray<SandboxCache>;
  readonly setup?: ReadonlyArray<SandboxHook>;
  readonly teardown?: ReadonlyArray<SandboxHook>;
  /**
   * Proxy URL used for public traffic. Direct egress is disabled when omitted.
   * The proxy is a trusted boundary and must reject private, link-local,
   * metadata, loopback, and cross-sandbox destinations.
   */
  readonly egressProxyUrl?: string;
  readonly egressProxyImage?: string;
  readonly previewPorts?: ReadonlyArray<number>;
};

export type SandboxReady = {
  readonly sandboxId: string;
  readonly runtime: SandboxRuntime;
  readonly containerName: string;
  readonly networkName: string;
  readonly workspaceVolumeName: string;
  readonly desktopVolumeName: string;
  readonly egressProxyContainerName?: string;
  readonly egressNetworkName?: string;
  readonly branchName: string;
  readonly limits: SandboxResourceLimits;
  /**
   * What this provision did to the provider's conversation store, and thus
   * whether the thread's persisted resume cursor still names something real.
   *
   * A boolean could not express this. "Not restored" conflated the two cases
   * that matter most: a container that SURVIVED (nothing needed restoring, and
   * the conversation is exactly where the cursor left it) reported the same
   * `false` as a fresh container whose archive never arrived -- so a valid
   * cursor was thrown away on every re-attach.
   *
   * Absent from a record rebuilt by adoption, which provisioned nothing.
   */
  readonly providerStore?: SandboxProviderStoreDisposition;
};

/**
 * - `preserved` -- the same container and provider home are still there;
 *   nothing was restored because nothing had been lost.
 * - `restored` -- a fresh container, and the exported archive really was
 *   extracted into its provider home.
 * - `unavailable` -- a fresh container with no prior conversation in it: no
 *   store was carried across, or one was supplied and failed to copy or
 *   extract (which is best-effort and never fails the provision).
 *
 * A caller deciding whether to keep the thread's provider resume cursor reads
 * this rather than the recorded `storeSha256`: the artifact may have been
 * swept, or the extraction may have failed silently, and a cursor kept against
 * a container with no conversation in it makes every following turn fail to
 * resume.
 */
export type SandboxProviderStoreDisposition = "preserved" | "restored" | "unavailable";

export type SandboxExecInput = {
  readonly executable: string;
  readonly args?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly stdin?: string;
  /**
   * Return the result instead of throwing when the command exits non-zero.
   *
   * Probes need this: `git rev-parse --verify <ref>` exits 1 for a ref that does
   * not exist yet, which is an answer, not a failure. Mirrors
   * `allowNonZeroExit` on the host-side git driver.
   */
  readonly allowNonZeroExit?: boolean;
};

/**
 * Everything needed to rebuild a lost in-memory sandbox record from the
 * projection. Container/network/volume names derive from
 * `(projectId, threadId)`, and the remaining fields reproduce the label
 * signature stamped at provision time, so a container found at the derived
 * name can be proven to be the one this thread provisioned.
 *
 * Only export and teardown accept a hint. Both act on a container the caller
 * is finished with; neither re-arms credentials, preview routes, or automation
 * targets, which is what reconcile's fail-closed adoption refusal protects.
 */
export type SandboxAdoptionHint = {
  readonly projectId: string;
  readonly image: string;
  readonly baseCommit: string;
  readonly branchName: string;
  readonly teardownTimeoutMs?: number;
};

export type SandboxExport = {
  readonly commit: string;
  readonly patch: string;
  /**
   * Commit pinned under `refs/t3/export-snapshot` in the exported bundle,
   * capturing the working tree -- dirty tracked files and untracked ones --
   * at export time.
   *
   * Absent when the working tree was clean, and when the snapshot could not be
   * written (the branch still exports; the export never fails over a
   * snapshot). A restore that finds the ref in the bundle unpacks it over the
   * checked-out head commit, which is what stops an automatic settle from
   * destroying uncommitted work.
   */
  readonly snapshotCommit?: string;
};
export type SandboxArtifactExport = SandboxExport & {
  readonly artifactId: string;
  readonly bundleSha256: string;
  /**
   * Digest of the archived provider conversation store, when the export
   * captured one. Absent when there was no store to archive, or when it
   * exceeded the size ceiling -- the branch still exported either way.
   */
  readonly storeSha256?: string;
};
export type SandboxUsageSample = {
  readonly cpuPercent: number;
  readonly memoryBytes: number;
  readonly diskBytes: number;
  readonly processCount: number;
};

export type SandboxReconcileInput = {
  readonly expectedThreadIds: ReadonlySet<string>;
  readonly removeOrphans?: boolean;
  /**
   * Label signatures for expected threads, so a reconcile that runs after a
   * restart (empty in-memory records) can prove a surviving container is the
   * one its thread provisioned instead of reporting it missing. Adoption here
   * is for reconcile accounting only -- verified containers are never cached
   * for `exec`, which stays fail-closed on the in-memory record.
   */
  readonly adoptionHints?: ReadonlyMap<string, SandboxAdoptionHint>;
};

export type SandboxReconcileResult = {
  /**
   * Threads whose sandbox this manager generation provisioned and can still
   * drive: `exec`, checkpointing, and provider spawn all work against them.
   */
  readonly activeThreadIds: ReadonlyArray<string>;
  readonly missingThreadIds: ReadonlyArray<string>;
  /**
   * Threads whose container survived a restart and proved its identity by
   * label signature, but which this manager generation cannot drive: adoption
   * grants export and teardown only, never `exec`, so nothing can run in them.
   *
   * These are reported in `missingThreadIds` as well, deliberately. A caller
   * that does nothing special still fails the thread and lets it
   * re-provision -- the fail-closed outcome -- instead of leaving a projection
   * that says `ready` while every operation throws "not ready". A caller that
   * reads this list can do better: the container is intact and addressable
   * with an adoption hint, so stopping it exports the thread's work first and
   * the re-provision restores from that export.
   *
   * Optional so a stub reconcile that reports nothing unresumable can stay
   * silent; absent means none.
   */
  readonly unresumableThreadIds?: ReadonlyArray<string>;
  readonly orphanThreadIds: ReadonlyArray<string>;
  readonly removedRuntimeRefs: ReadonlyArray<string>;
};

export interface ThreadSandboxBackend {
  readonly runtime: SandboxRuntime;
  readonly ensureReady: (input: SandboxProvisionInput) => Promise<SandboxReady>;
  readonly exec: (threadId: string, input: SandboxExecInput) => Promise<SandboxCommandResult>;
  readonly exportBranch: (threadId: string, hint?: SandboxAdoptionHint) => Promise<SandboxExport>;
  /**
   * `snapshotCommit` is the one the preceding `exportBranch` returned. The
   * bundle names that ref explicitly, so what an export ships never depends on
   * an earlier export's refs having been cleaned up.
   */
  readonly exportBundle: (
    threadId: string,
    destination: string,
    options?: {
      readonly snapshotCommit?: string;
      readonly hint?: SandboxAdoptionHint;
    },
  ) => Promise<void>;
  readonly sampleUsage: (threadId: string) => Promise<SandboxUsageSample>;
  readonly stop: (
    threadId: string,
    teardown?: ReadonlyArray<SandboxHook>,
    hint?: SandboxAdoptionHint,
  ) => Promise<void>;
  readonly reconcile: (input: SandboxReconcileInput) => Promise<SandboxReconcileResult>;
}
