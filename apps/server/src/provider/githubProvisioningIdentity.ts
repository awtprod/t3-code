/**
 * githubProvisioningIdentity: pins an instance's GitHub identity into the CLI's
 * env. The host `gh` wrapper uses the cwd's mapped path, else the provisioning
 * variable, else refuses; thread worktrees host every identity, so can't be mapped.
 * @module provider/githubProvisioningIdentity
 */
import type {
  ProviderInstanceConfig,
  ProviderInstanceEnvironment,
  ProviderInstanceId,
} from "@t3tools/contracts";

export const GITHUB_IDENTITY_VARIABLE = "COMMAND_CENTER_GITHUB_IDENTITY";
export const GITHUB_PROVISIONING_IDENTITY_VARIABLE = "COMMAND_CENTER_GITHUB_PROVISIONING_IDENTITY";

function resolveProviderInstanceGitHubIdentity(
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
 * identity appended when it can be resolved. An explicit provisioning variable
 * in the instance config always wins, even a redacted one: the value is held
 * elsewhere and must not be shadowed by a derived guess.
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
  // Only the session's own identity is lifted to the unmapped-directory case.
  // `COMMAND_CENTER_GITHUB_IDENTITY` is left untouched, so the wrapper's mismatch
  // check still rejects this session inside another identity's mapped directory.
  return [
    ...environment,
    {
      name: GITHUB_PROVISIONING_IDENTITY_VARIABLE,
      value: identity,
      sensitive: false,
    },
  ];
}
