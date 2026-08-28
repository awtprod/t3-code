import type { SandboxBootstrap, SandboxCache, SandboxExecInput, SandboxHook } from "./types.ts";
import { asSandboxGitRemoteUrl } from "./SandboxGitIdentity.ts";

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const COMMIT = /^[0-9a-f]{40,64}$/i;
const SAFE_ABSOLUTE_PATH = /^\/(?:[a-zA-Z0-9._-]+\/?)+$/;
const SAFE_ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;
const SAFE_BRANCH = /^(?![-/.])(?!.*(?:\.\.|\/\/|@\{|[~^:?*[\u005c]))[a-zA-Z0-9._/-]{1,200}$/;
const FORBIDDEN_TARGETS = ["/", "/home", "/root", "/run", "/tmp", "/etc", "/usr", "/var/run"];

export class SandboxValidationError extends Error {
  override readonly name = "SandboxValidationError";
}

export function sanitizeId(value: string, field: string): string {
  if (!SAFE_ID.test(value) || value.includes("..")) {
    throw new SandboxValidationError(`${field} contains unsafe characters`);
  }
  return value;
}

/**
 * Shape check for a branch name that is about to land on a git command line.
 *
 * Shared rather than re-inlined: the provision path validates the bootstrap's
 * branch, and the export path names the same branch as a bundle refspec from a
 * record that may have been rebuilt by adoption rather than provisioned here.
 * Two copies of this rule would drift.
 */
export function validateBranchName(branchName: string): void {
  if (!SAFE_BRANCH.test(branchName) || branchName.endsWith("/") || branchName.endsWith(".lock")) {
    throw new SandboxValidationError("branchName is unsafe");
  }
}

export function validateBootstrap(input: SandboxBootstrap): void {
  sanitizeId(input.threadId, "threadId");
  sanitizeId(input.projectId, "projectId");
  if (!COMMIT.test(input.baseCommit))
    throw new SandboxValidationError("baseCommit must be an immutable full commit hash");
  validateBranchName(input.branchName);
  if (input.repositoryBundlePath === undefined) {
    let url: URL;
    try {
      url = new URL(input.repositoryUrl);
    } catch {
      throw new SandboxValidationError("repositoryUrl must be an absolute URL");
    }
    if (!new Set(["https:", "ssh:"]).has(url.protocol)) {
      throw new SandboxValidationError("repositoryUrl must use https or ssh");
    }
  } else if (
    !SAFE_ABSOLUTE_PATH.test(input.repositoryBundlePath) ||
    input.repositoryBundlePath.includes("..")
  ) {
    throw new SandboxValidationError("repository bundle path is invalid");
  }
  if (input.repositoryRemoteUrl !== undefined) {
    if (asSandboxGitRemoteUrl(input.repositoryRemoteUrl) === undefined) {
      throw new SandboxValidationError("repositoryRemoteUrl must be a supported Git remote URL");
    }
  }
  if (
    input.repositoryPushRemoteUrl !== undefined &&
    asSandboxGitRemoteUrl(input.repositoryPushRemoteUrl) === undefined
  ) {
    throw new SandboxValidationError("repositoryPushRemoteUrl must be a supported Git remote URL");
  }
  // Server-generated, but it lands on a git command line as a refspec, so it
  // gets the same shape check as every other value that does.
  if (
    input.repositoryBundleRef !== undefined &&
    (!input.repositoryBundleRef.startsWith("refs/") ||
      !SAFE_BRANCH.test(input.repositoryBundleRef) ||
      input.repositoryBundleRef.endsWith("/") ||
      input.repositoryBundleRef.endsWith(".lock"))
  ) {
    throw new SandboxValidationError("repository bundle ref is unsafe");
  }
  if (input.restoreCommit !== undefined && !COMMIT.test(input.restoreCommit))
    throw new SandboxValidationError("restoreCommit must be an immutable full commit hash");
  // Server-generated like the bundle path above, and lands on a command line
  // the same way, so it gets the same shape check.
  if (
    input.providerStorePath !== undefined &&
    (!SAFE_ABSOLUTE_PATH.test(input.providerStorePath) || input.providerStorePath.includes(".."))
  ) {
    throw new SandboxValidationError("provider store path is invalid");
  }
  if (
    input.inheritedPatch !== undefined &&
    Buffer.byteLength(input.inheritedPatch) > 16 * 1024 * 1024
  ) {
    throw new SandboxValidationError("inheritedPatch exceeds 16 MiB");
  }
}

export function validateCache(cache: SandboxCache): void {
  if (!/^[a-f0-9]{32,128}$/i.test(cache.digest))
    throw new SandboxValidationError("cache digest is invalid");
  validateSandboxPath(cache.target, "cache target");
  if (
    FORBIDDEN_TARGETS.some(
      (path) => cache.target === path || (path !== "/" && cache.target.startsWith(`${path}/`)),
    )
  ) {
    throw new SandboxValidationError(`cache target ${cache.target} overlaps a protected path`);
  }
}

export function validateSandboxPath(path: string, field: string): void {
  if (!SAFE_ABSOLUTE_PATH.test(path) || path.includes("..") || path.includes("//")) {
    throw new SandboxValidationError(`${field} must be a normalized absolute sandbox path`);
  }
}

export function validateHook(hook: SandboxHook): void {
  if (!hook.executable || hook.executable.includes("\0"))
    throw new SandboxValidationError("hook executable is invalid");
  validateEnvironment(hook.env);
  for (const arg of hook.args ?? [])
    if (arg.includes("\0")) throw new SandboxValidationError("hook argument contains NUL");
}

export function validateExec(input: SandboxExecInput): void {
  if (!input.executable || input.executable.includes("\0"))
    throw new SandboxValidationError("executable is invalid");
  if (input.cwd !== undefined) validateSandboxPath(input.cwd, "cwd");
  validateEnvironment(input.env);
  for (const arg of input.args ?? [])
    if (arg.includes("\0")) throw new SandboxValidationError("argument contains NUL");
}

function validateEnvironment(env?: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!SAFE_ENV_KEY.test(key) || value.includes("\0"))
      throw new SandboxValidationError(`environment entry ${key} is invalid`);
  }
}
