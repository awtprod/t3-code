export type SandboxGitIdentity = {
  readonly name: string;
  readonly email: string;
};

export const DEFAULT_SANDBOX_GIT_IDENTITY: SandboxGitIdentity = {
  name: "Command Center",
  email: "commandcenter@example.com",
};

/** Resolve a complete identity; a partial operator override never leaks through. */
export function resolveSandboxGitIdentity(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SandboxGitIdentity {
  const name = environment.T3_SANDBOX_GIT_USER_NAME?.trim();
  const email = environment.T3_SANDBOX_GIT_USER_EMAIL?.trim();
  return name && email ? { name, email } : DEFAULT_SANDBOX_GIT_IDENTITY;
}

/**
 * Only network remotes are meaningful inside a sandbox. Local paths point at
 * the host filesystem and must be omitted rather than making provisioning fail.
 */
export function asSandboxGitRemoteUrl(value: string | undefined): string | undefined {
  const remote = value?.trim();
  if (!remote || remote.length > 4096 || /[\0\r\n]/.test(remote)) return undefined;
  try {
    const parsed = new URL(remote);
    return new Set(["https:", "ssh:"]).has(parsed.protocol) &&
      parsed.password.length === 0 &&
      (parsed.protocol !== "https:" || parsed.username.length === 0)
      ? remote
      : undefined;
  } catch {
    return /^[a-z0-9._-]+@[a-z0-9.-]+:[^\s]+$/i.test(remote) ? remote : undefined;
  }
}
