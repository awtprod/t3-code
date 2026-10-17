// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Standalone Git release-sync utility.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const INITIAL_PUBLIC_BASELINE = "b511227b7ad421c422f1ebca65116776020e4799";
export const PUBLIC_BASELINE_FILE = ".command-center-public-baseline";

export interface UpstreamSyncPlanOptions {
  readonly repositoryPath: string;
  readonly upstreamRef: string;
  /** When provided, the fetched ref must resolve to exactly this commit. */
  readonly expectedCommit?: string | undefined;
  readonly baseRef?: string | undefined;
  readonly initialBaseline?: string | undefined;
  readonly requireCleanWorktree?: boolean | undefined;
}

export interface UpstreamSyncPlan {
  readonly schemaVersion: 2;
  readonly initialBaseline: string;
  readonly currentBaseline: string;
  readonly baseCommit: string;
  readonly targetCommit: string;
  /** The newest upstream commit already contained in the sync base. */
  readonly mergeBase: string;
  readonly upstreamRef: string;
  readonly status: "needs-sync" | "already-contained";
  readonly branchName: string | null;
}

const FULL_COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const SAFE_UPSTREAM_REF_PATTERN = /^refs\/(?:tags|remotes\/upstream)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const UPSTREAM_REF_PREFIX_PATTERN = /^refs\/(?:tags|remotes\/upstream)\//;
const SYNC_BRANCH_PREFIX = "upstream-sync/";

export function validateUpstreamRef(value: string): string {
  if (
    !SAFE_UPSTREAM_REF_PATTERN.test(value) ||
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{") ||
    value.endsWith("/") ||
    value.endsWith(".")
  ) {
    throw new Error(
      "Upstream ref must be an exact refs/tags/... or refs/remotes/upstream/... name.",
    );
  }
  return value;
}

/**
 * One sync branch per tracked upstream ref, so a daily run against `refs/remotes/upstream/main`
 * keeps refreshing `upstream-sync/main` instead of piling up a branch per commit.
 */
export function syncBranchName(upstreamRef: string): string {
  return `${SYNC_BRANCH_PREFIX}${validateUpstreamRef(upstreamRef).replace(UPSTREAM_REF_PREFIX_PATTERN, "")}`;
}

export function validateCommit(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!FULL_COMMIT_PATTERN.test(normalized)) {
    throw new Error(`${label} must be a full 40-character hexadecimal Git commit ID.`);
  }
  return normalized;
}

export function readPublicBaseline(repositoryPath: string): string {
  const baselinePath = NodePath.join(repositoryPath, PUBLIC_BASELINE_FILE);
  if (!NodeFS.existsSync(baselinePath)) {
    throw new Error(`Pinned public baseline is missing: ${baselinePath}`);
  }
  return validateCommit(NodeFS.readFileSync(baselinePath, "utf8"), "Pinned public baseline");
}

export function planUpstreamSync(options: UpstreamSyncPlanOptions): UpstreamSyncPlan {
  const repositoryPath = NodePath.resolve(options.repositoryPath);
  const upstreamRef = validateUpstreamRef(options.upstreamRef);
  const expectedCommit =
    options.expectedCommit === undefined
      ? undefined
      : validateCommit(options.expectedCommit, "Expected upstream commit");
  const initialBaseline = validateCommit(
    options.initialBaseline ?? INITIAL_PUBLIC_BASELINE,
    "Initial public baseline",
  );
  const currentBaseline = readPublicBaseline(repositoryPath);

  if (options.requireCleanWorktree !== false && git(repositoryPath, ["status", "--porcelain"])) {
    throw new Error("Upstream sync requires a clean worktree.");
  }

  assertCommitExists(repositoryPath, initialBaseline, "Initial public baseline");
  assertCommitExists(repositoryPath, currentBaseline, "Pinned public baseline");
  const targetCommit = resolveCommit(repositoryPath, upstreamRef);
  if (expectedCommit !== undefined && targetCommit !== expectedCommit) {
    throw new Error(
      `Fetched upstream ref resolved to ${targetCommit}, not the explicitly expected ${expectedCommit}.`,
    );
  }
  const baseCommit = resolveCommit(repositoryPath, options.baseRef ?? "HEAD");

  assertAncestor(
    repositoryPath,
    initialBaseline,
    currentBaseline,
    "Pinned public baseline does not descend from the original T3 Code baseline.",
  );
  assertAncestor(
    repositoryPath,
    currentBaseline,
    baseCommit,
    "The sync base does not contain the currently pinned public baseline.",
  );
  // The pinned public baseline may be a Command Center merge commit rather than an upstream commit,
  // so upstream lineage is proven against the original T3 Code baseline and the integrated point is
  // read from Git itself rather than from the pin.
  assertAncestor(
    repositoryPath,
    initialBaseline,
    targetCommit,
    "The requested upstream target does not descend from the original T3 Code baseline.",
  );
  const mergeBase = validateCommit(
    git(repositoryPath, ["merge-base", baseCommit, targetCommit]),
    "Merge base",
  );

  const alreadyContained = isAncestor(repositoryPath, targetCommit, baseCommit);
  return {
    schemaVersion: 2,
    initialBaseline,
    currentBaseline,
    baseCommit,
    targetCommit,
    mergeBase,
    upstreamRef,
    status: alreadyContained ? "already-contained" : "needs-sync",
    branchName: alreadyContained ? null : syncBranchName(upstreamRef),
  };
}

/** Command Center re-platformed onto upstream orchestration v2 at this tag. */
export const STABLE_TAG_FLOOR = "v0.1.0";

export interface StableUpstreamTag {
  readonly ref: string;
  readonly commit: string;
}

const STABLE_TAG_PATTERN = /^v(\d+)\.(\d+)\.(\d+)$/;

function stableTagVersion(tag: string): readonly [number, number, number] | undefined {
  const match = STABLE_TAG_PATTERN.exec(tag);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

/**
 * Picks the newest stable upstream release from `git ls-remote --tags --refs` output.
 * Only exact `vMAJOR.MINOR.PATCH` tags count: nightly and preview builds never become a sync
 * target. A release older than the re-platform floor is refused rather than synced backwards.
 */
export function selectLatestStableTag(
  lsRemoteOutput: string,
  floor: string = STABLE_TAG_FLOOR,
): StableUpstreamTag {
  const floorVersion = stableTagVersion(floor);
  if (!floorVersion) throw new Error(`Stable tag floor must look like v1.2.3: ${floor}`);
  let best:
    | { readonly version: readonly [number, number, number]; readonly tag: StableUpstreamTag }
    | undefined;
  for (const line of lsRemoteOutput.split("\n")) {
    const [commitField, refField] = line.trim().split(/\s+/);
    if (!commitField || !refField?.startsWith("refs/tags/")) continue;
    const version = stableTagVersion(refField.slice("refs/tags/".length));
    if (!version) continue;
    const commit = validateCommit(commitField, `Commit for ${refField}`);
    if (!best || compareVersions(version, best.version) > 0) {
      best = { version, tag: { ref: validateUpstreamRef(refField), commit } };
    }
  }
  if (!best) throw new Error("Upstream has no stable vMAJOR.MINOR.PATCH release tag.");
  if (compareVersions(best.version, floorVersion) < 0) {
    throw new Error(`Newest upstream release ${best.tag.ref} is older than the floor ${floor}.`);
  }
  return best.tag;
}

/** Lists the remote's tags (a read; nothing is fetched) and picks the newest stable release. */
export function resolveLatestStableTag(repositoryPath: string, remote: string): StableUpstreamTag {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote)) {
    throw new Error(`Remote must be a plain remote name: ${remote}`);
  }
  return selectLatestStableTag(
    git(NodePath.resolve(repositoryPath), ["ls-remote", "--tags", "--refs", remote]),
  );
}

export function advancePublicBaseline(
  repositoryPath: string,
  targetCommit: string,
  options: { readonly initialBaseline?: string | undefined } = {},
): void {
  const root = NodePath.resolve(repositoryPath);
  const target = validateCommit(targetCommit, "New public baseline");
  const initialBaseline = validateCommit(
    options.initialBaseline ?? INITIAL_PUBLIC_BASELINE,
    "Initial public baseline",
  );
  const currentBaseline = readPublicBaseline(root);

  assertCommitExists(root, target, "New public baseline");
  assertAncestor(
    root,
    initialBaseline,
    target,
    "New public baseline does not descend from the original T3 Code baseline.",
  );
  assertAncestor(
    root,
    currentBaseline,
    target,
    "New public baseline does not advance the currently pinned baseline.",
  );
  assertAncestor(
    root,
    target,
    resolveCommit(root, "HEAD"),
    "Refusing to pin a public baseline that is not contained in HEAD.",
  );

  const baselinePath = NodePath.join(root, PUBLIC_BASELINE_FILE);
  const temporaryPath = `${baselinePath}.tmp`;
  NodeFS.writeFileSync(temporaryPath, `${target}\n`, { encoding: "utf8", mode: 0o644 });
  NodeFS.renameSync(temporaryPath, baselinePath);
}

function assertCommitExists(repositoryPath: string, commit: string, label: string): void {
  const result = runGit(repositoryPath, ["cat-file", "-e", `${commit}^{commit}`], true);
  if (result.status !== 0) throw new Error(`${label} is not available in the fetched Git history.`);
}

function resolveCommit(repositoryPath: string, ref: string): string {
  return validateCommit(git(repositoryPath, ["rev-parse", "--verify", `${ref}^{commit}`]), ref);
}

function assertAncestor(
  repositoryPath: string,
  ancestor: string,
  descendant: string,
  message: string,
): void {
  if (!isAncestor(repositoryPath, ancestor, descendant)) throw new Error(message);
}

function isAncestor(repositoryPath: string, ancestor: string, descendant: string): boolean {
  const result = runGit(
    repositoryPath,
    ["merge-base", "--is-ancestor", ancestor, descendant],
    true,
  );
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(result.stderr.trim() || "Git ancestry validation failed.");
}

function git(repositoryPath: string, args: readonly string[]): string {
  const result = runGit(repositoryPath, args, false);
  return result.stdout.trim();
}

function runGit(repositoryPath: string, args: readonly string[], allowFailure: boolean) {
  const result = NodeChildProcess.spawnSync("git", ["-C", repositoryPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  const status = result.status ?? 1;
  if (!allowFailure && status !== 0) {
    throw new Error(result.stderr.trim() || `Git command failed (${args[0] ?? "unknown"}).`);
  }
  return { status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
