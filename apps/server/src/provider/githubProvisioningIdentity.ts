/**
 * githubProvisioningIdentity — resolves a provider instance's GitHub
 * identity and pins it into the spawned CLI's environment.
 *
 * The host `gh` wrapper (`/opt/command-center/bin/gh`) decides which
 * credential store to use from three inputs, in order:
 *
 *   1. the working directory, when it falls inside an identity-mapped
 *      path (a workspace root or a project home);
 *   2. `COMMAND_CENTER_GITHUB_PROVISIONING_IDENTITY`, for callers that
 *      run outside any mapped path;
 *   3. otherwise it refuses.
 *
 * `COMMAND_CENTER_GITHUB_IDENTITY` alone never satisfies (2) — it only
 * feeds the wrapper's mismatch check, which rejects a session whose
 * identity disagrees with the mapped directory it is standing in. So a
 * session that sets only `COMMAND_CENTER_GITHUB_IDENTITY` works inside a
 * mapped path and is refused everywhere else, which is what thread
 * worktrees under `COMMAND_CENTER_HOME/worktrees/<project>/<thread>` hit:
 * that path hosts every identity's worktrees, so it cannot be mapped by
 * prefix.
 *
 * Setting the provisioning variable to the session's *own* identity
 * closes that gap without widening access. The mismatch check still
 * fires, because it reads `COMMAND_CENTER_GITHUB_IDENTITY`, which this
 * module leaves untouched: a session pinned to one identity is still
 * rejected inside another identity's mapped directory. Only the
 * unmapped-directory refusal is lifted, and only to the identity the
 * session already had.
 *
 * `SandboxCredentialProxy` sets the same pair for the same reason when it
 * shells out to `gh` from the server process.
 *
 * @module provider/githubProvisioningIdentity
 */
import type {
  ProviderInstanceConfig,
  ProviderInstanceEnvironment,
  ProviderInstanceId,
} from "@t3tools/contracts";

export const GITHUB_IDENTITY_VARIABLE = "COMMAND_CENTER_GITHUB_IDENTITY";
export const GITHUB_PROVISIONING_IDENTITY_VARIABLE = "COMMAND_CENTER_GITHUB_PROVISIONING_IDENTITY";

export function resolveProviderInstanceGitHubIdentity(
  instanceId: ProviderInstanceId,
  instance: ProviderInstanceConfig | undefined,
): string | undefined {
  const configured = instance?.environment?.find(
    (variable) => variable.name === GITHUB_IDENTITY_VARIABLE && variable.valueRedacted !== true,
  )?.value;
  if (configured && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(configured.trim())) {
    return configured.trim();
  }
  const config = instance?.config;
  const binaryPath =
    typeof config === "object" && config !== null && "binaryPath" in config
      ? (config as { readonly binaryPath?: unknown }).binaryPath
      : undefined;
  const candidates = [
    typeof binaryPath === "string" ? binaryPath.split("/").pop() : undefined,
    instanceId,
  ];
  for (const candidate of candidates) {
    const identity = /-([a-z0-9][a-z0-9_-]{0,63})$/i.exec(candidate ?? "")?.[1];
    if (identity) return identity;
  }
  return undefined;
}

/**
 * Returns the instance's configured environment with the provisioning
 * identity appended when it can be resolved.
 *
 * An explicit `COMMAND_CENTER_GITHUB_PROVISIONING_IDENTITY` in the
 * instance config always wins, including a redacted one: the value is
 * held elsewhere and must not be shadowed by a derived guess.
 */
export function withGitHubProvisioningIdentity(
  instanceId: ProviderInstanceId,
  instance: ProviderInstanceConfig | undefined,
): ProviderInstanceEnvironment {
  const environment = instance?.environment ?? [];
  if (environment.some((variable) => variable.name === GITHUB_PROVISIONING_IDENTITY_VARIABLE)) {
    return environment;
  }
  const identity = resolveProviderInstanceGitHubIdentity(instanceId, instance);
  if (identity === undefined) return environment;
  return [
    ...environment,
    {
      name: GITHUB_PROVISIONING_IDENTITY_VARIABLE,
      value: identity,
      sensitive: false,
    },
  ];
}
