import type * as Path from "effect/Path";

/** Repository provisioning never accepts local paths, insecure transports, or embedded secrets. */
export function isProvisionableRepositoryRemote(remoteRef: string): boolean {
  const trimmed = remoteRef.trim();
  if (
    trimmed.length === 0 ||
    trimmed !== remoteRef ||
    /[\r\n]/u.test(trimmed) ||
    trimmed.includes("\0")
  ) {
    return false;
  }

  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/u.test(trimmed)) {
    const repositoryPath = trimmed.slice(trimmed.indexOf(":") + 1);
    return !repositoryPath.split("/").includes("..");
  }

  try {
    const remote = new URL(trimmed);
    if (remote.hostname.length === 0 || remote.password.length > 0) return false;
    if (remote.search.length > 0 || remote.hash.length > 0) return false;
    if (remote.protocol === "https:") {
      return remote.username.length === 0 && remote.pathname.replace(/^\/+|\/+$/gu, "").length > 0;
    }
    if (remote.protocol === "ssh:") {
      return remote.pathname.replace(/^\/+|\/+$/gu, "").length > 0;
    }
    return false;
  } catch {
    return false;
  }
}

/** Managed repositories must be direct children of the runtime repository directory. */
export function isManagedRepositoryWorkspacePath(input: {
  readonly managedRepositoriesRoot: string;
  readonly workspaceRoot: string;
  readonly path: Pick<Path.Path, "isAbsolute" | "relative" | "sep">;
}): boolean {
  const relative = input.path.relative(input.managedRepositoriesRoot, input.workspaceRoot);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${input.path.sep}`) &&
    !input.path.isAbsolute(relative) &&
    !relative.includes(input.path.sep)
  );
}
