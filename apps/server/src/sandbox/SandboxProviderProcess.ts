// @effect-diagnostics nodeBuiltinImport:off - provider subprocesses cross the Node/container boundary.
import * as NodeChildProcess from "node:child_process";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { ChildProcess as EffectChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as Effect from "effect/Effect";
import type { SandboxExecutionTarget } from "./ThreadSandboxRuntime.ts";
import { redeemSandboxProviderEnvironment } from "./SandboxRuntimeManager.ts";
import { threadCredentialProxyBinding } from "./SandboxCredentialProxy.ts";

export type SandboxProviderBindingOwner = symbol;
type SandboxProviderBinding = {
  readonly target: SandboxExecutionTarget;
  readonly owners: Set<SandboxProviderBindingOwner>;
};
const targets = new Map<string, SandboxProviderBinding>();
const PROVIDER_ENV_ALLOWLIST =
  /^(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|CODEX_API_KEY|CODEX_TOKEN|ANTHROPIC_BASE_URL|ANTHROPIC_AUTH_TOKEN|OPENAI_BASE_URL|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|LANG|LC_ALL|TERM)$/;
/**
 * Credentials that must never cross into a sandbox from the host environment.
 *
 * `ANTHROPIC_AUTH_TOKEN` belongs here even though the proxy path also sets it:
 * it is the bearer credential Claude Code reads and exactly what
 * `claude setup-token` mints, so a host that is configured for this feature is
 * the most likely place for a real long-lived one to sit. The guard below runs
 * on host-derived env only, so the proxy's opaque per-thread token is exempt by
 * construction rather than by being absent from this list.
 */
const PERSISTENT_PROVIDER_CREDENTIAL =
  /^(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|CODEX_API_KEY|CODEX_TOKEN)$/;
const SANDBOX_PROVIDER_ENV = {
  HOME: "/thread-data/provider-home",
  TMPDIR: "/tmp",
  USER: "sandbox",
} as const;
const IN_IMAGE_PROVIDER_COMMANDS = ["claude", "codex"] as const;

/**
 * Maps a host-resolved provider binary onto its in-image command name.
 *
 * Provider spawn inside a sandbox goes through `podman exec`, so a host path
 * like `/usr/local/bin/claude` or an nvm shim does not exist in the image.
 * Only the basename is inspected, and only for the providers the image ships;
 * anything else is passed through untouched so the exec fails loudly rather
 * than silently running the wrong program.
 */
export function inImageProviderCommand(command: string): string {
  const basename = command.split("/").pop() ?? command;
  const match = IN_IMAGE_PROVIDER_COMMANDS.find(
    (candidate) => basename === candidate || basename === `${candidate}.js`,
  );
  return match ?? command;
}

export function makeSandboxProviderBindingOwner(): SandboxProviderBindingOwner {
  return Symbol("sandbox-provider-binding-owner");
}

export function bindSandboxProviderTarget(
  target: SandboxExecutionTarget,
  owner: SandboxProviderBindingOwner,
): void {
  const current = targets.get(target.threadId);
  if (current !== undefined && current.target.sandboxId !== target.sandboxId) {
    throw new Error(`thread ${target.threadId} is already bound to a different sandbox generation`);
  }
  if (current !== undefined) {
    current.owners.add(owner);
    return;
  }
  targets.set(target.threadId, { target, owners: new Set([owner]) });
}

export function unbindSandboxProviderTarget(
  threadId: string,
  owner: SandboxProviderBindingOwner,
): void {
  const current = targets.get(threadId);
  if (current === undefined) return;
  current.owners.delete(owner);
  if (current.owners.size === 0) targets.delete(threadId);
}

export function unbindAllSandboxProviderTargets(owner: SandboxProviderBindingOwner): void {
  for (const [threadId, binding] of targets) {
    binding.owners.delete(owner);
    if (binding.owners.size === 0) targets.delete(threadId);
  }
}

export function sandboxProviderTarget(threadId: string): SandboxExecutionTarget | undefined {
  return targets.get(threadId)?.target;
}

function execArgs(
  target: SandboxExecutionTarget,
  command: string,
  args: ReadonlyArray<string>,
  cwd: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  return [
    "exec",
    "--interactive",
    "--user",
    "1000:1000",
    "--workdir",
    target.workspaceCwd,
    ...Object.entries(env).flatMap(([key, value]) => (value === undefined ? [] : ["--env", key])),
    "--",
    target.runtimeRef,
    command,
    ...args,
  ];
}

export function sandboxProviderInvocation(
  target: SandboxExecutionTarget,
  command: string,
  args: ReadonlyArray<string>,
  cwd: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
) {
  void cwd;
  const allowedEnvironment = Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && PROVIDER_ENV_ALLOWLIST.test(entry[0]),
    ),
  );
  // A bound proxy makes every persistent credential redundant: the sidecar holds
  // the real secret, so they are all dropped here regardless of which upstreams
  // are configured. An openai-only binding must still not leak a host Anthropic
  // token just because nothing would overwrite it.
  const proxy = threadCredentialProxyBinding(target.threadId);
  if (proxy !== undefined) {
    for (const key of Object.keys(allowedEnvironment)) {
      if (PERSISTENT_PROVIDER_CREDENTIAL.test(key)) delete allowedEnvironment[key];
    }
  }
  // Guard the host-derived environment before proxy values are merged in. Doing
  // it in this order is what lets the proxy inject an `ANTHROPIC_AUTH_TOKEN`
  // without tripping a check aimed at the host's own copy of that variable.
  const persistentCredential = Object.keys(allowedEnvironment).find((key) =>
    PERSISTENT_PROVIDER_CREDENTIAL.test(key),
  );
  if (persistentCredential !== undefined) {
    throw new Error(
      `direct forwarding of persistent provider credential ${persistentCredential} is denied; use a thread-scoped credential proxy`,
    );
  }
  const proxyEnvironment: Record<string, string> = {};
  if (proxy !== undefined) {
    if (proxy.upstreamNames.includes("anthropic")) {
      proxyEnvironment.ANTHROPIC_BASE_URL = `${proxy.baseUrl}/anthropic`;
      proxyEnvironment.ANTHROPIC_AUTH_TOKEN = proxy.threadToken;
    }
    if (proxy.upstreamNames.includes("openai")) {
      proxyEnvironment.OPENAI_BASE_URL = `${proxy.baseUrl}/openai`;
    }
  }
  const requestedEnvironment = {
    ...SANDBOX_PROVIDER_ENV,
    ...allowedEnvironment,
    ...proxyEnvironment,
  };
  const forwardedEnvironment = redeemSandboxProviderEnvironment(
    target.threadId,
    requestedEnvironment,
  );
  return {
    executable: target.runtime,
    args: execArgs(target, inImageProviderCommand(command), args, cwd, forwardedEnvironment),
    env: { PATH: process.env.PATH, ...forwardedEnvironment } as Record<string, string | undefined>,
  } as const;
}

export function makeSandboxChildProcessSpawner(
  target: SandboxExecutionTarget,
  hostSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
): ChildProcessSpawner.ChildProcessSpawner["Service"] {
  return ChildProcessSpawner.make((command) => {
    if (command._tag !== "StandardCommand") {
      return Effect.die(
        new Error("sandbox provider pipelines are unsupported; host fallback denied"),
      );
    }
    const invocation = sandboxProviderInvocation(
      target,
      command.command,
      command.args,
      command.options.cwd,
      command.options.env ?? {},
    );
    return hostSpawner.spawn(
      EffectChildProcess.make(invocation.executable, invocation.args, {
        ...command.options,
        cwd: undefined,
        env: { ...invocation.env, PATH: invocation.env.PATH ?? "" },
        extendEnv: false,
        shell: false,
      }),
    );
  });
}

export function spawnClaudeInSandbox(
  target: SandboxExecutionTarget,
  options: SpawnOptions,
): SpawnedProcess {
  const invocation = sandboxProviderInvocation(
    target,
    options.command,
    options.args,
    options.cwd,
    options.env,
  );
  const child: NodeChildProcess.ChildProcess = NodeChildProcess.spawn(
    invocation.executable,
    invocation.args,
    {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: invocation.env,
      signal: options.signal,
      windowsHide: true,
    },
  );
  return child as SpawnedProcess;
}
