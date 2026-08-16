// @effect-diagnostics nodeBuiltinImport:off - provider subprocesses cross the Node/container boundary.
import * as NodeChildProcess from "node:child_process";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { ChildProcess as EffectChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as Effect from "effect/Effect";
import type { SandboxExecutionTarget } from "./ThreadSandboxRuntime.ts";
import { redeemSandboxProviderEnvironment } from "./SandboxRuntimeManager.ts";

export type SandboxProviderBindingOwner = symbol;
type SandboxProviderBinding = {
  readonly target: SandboxExecutionTarget;
  readonly owners: Set<SandboxProviderBindingOwner>;
};
const targets = new Map<string, SandboxProviderBinding>();
const PROVIDER_ENV_ALLOWLIST =
  /^(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|CODEX_API_KEY|CODEX_TOKEN|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|LANG|LC_ALL|TERM)$/;
const PERSISTENT_PROVIDER_CREDENTIAL =
  /^(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|CODEX_API_KEY|CODEX_TOKEN)$/;
const SANDBOX_PROVIDER_ENV = {
  HOME: "/thread-data/provider-home",
  TMPDIR: "/tmp",
  USER: "sandbox",
} as const;

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
  const requestedEnvironment = {
    ...SANDBOX_PROVIDER_ENV,
    ...Object.fromEntries(
      Object.entries(env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && PROVIDER_ENV_ALLOWLIST.test(entry[0]),
      ),
    ),
  };
  const persistentCredential = Object.keys(requestedEnvironment).find((key) =>
    PERSISTENT_PROVIDER_CREDENTIAL.test(key),
  );
  if (persistentCredential !== undefined) {
    throw new Error(
      `direct forwarding of persistent provider credential ${persistentCredential} is denied; use a thread-scoped credential proxy`,
    );
  }
  const forwardedEnvironment = redeemSandboxProviderEnvironment(
    target.threadId,
    requestedEnvironment,
  );
  return {
    executable: target.runtime,
    args: execArgs(target, command, args, cwd, forwardedEnvironment),
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
