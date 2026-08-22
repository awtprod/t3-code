// @effect-diagnostics nodeBuiltinImport:off - This is the production adapter at the Node process boundary.
// @effect-diagnostics globalTimers:off - The executor owns a native process timeout and process-group kill.
import * as NodeChildProcess from "node:child_process";
import type { SandboxCommand, SandboxCommandExecutor, SandboxCommandResult } from "./types.ts";

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * Host variables forwarded to the container CLI, on top of `PATH`.
 *
 * The spawn environment is an allowlist rather than the host's: a sandbox
 * command must never inherit provider credentials or anything else ambient.
 * These few entries are what the CLI needs to find the runtime it is supposed
 * to talk to, and none of them carry a secret.
 *
 * `XDG_RUNTIME_DIR` is load-bearing for rootless podman -- it locates the user
 * socket and libpod's runtime root, and without it every command fails at
 * `podman info` with "set sticky bit on: chmod /run/user/<uid>/libpod", which
 * surfaces as a provisioning failure no unit test can catch (they all fake this
 * executor). `HOME` resolves the rootless storage config; `CONTAINER_HOST` and
 * `DOCKER_HOST` name a remote socket when the deployment uses one, which is
 * otherwise only deliverable through a PATH wrapper (see
 * `deploy/openclaw/sandbox/podman-wrapper.sh`).
 */
export const FORWARDED_RUNTIME_ENV = [
  "XDG_RUNTIME_DIR",
  "HOME",
  "CONTAINER_HOST",
  "DOCKER_HOST",
  "CONTAINERS_CONF",
  "CONTAINERS_STORAGE_CONF",
] as const;

export const runtimeEnvironment = (): Record<string, string> => {
  const environment: Record<string, string> = {};
  if (process.env.PATH !== undefined) environment.PATH = process.env.PATH;
  for (const name of FORWARDED_RUNTIME_ENV) {
    const value = process.env[name];
    if (value !== undefined && value !== "") environment[name] = value;
  }
  return environment;
};

export class NodeSandboxCommandExecutor implements SandboxCommandExecutor {
  private readonly platform: NodeJS.Platform;

  constructor(platform: NodeJS.Platform) {
    this.platform = platform;
  }

  run(command: SandboxCommand): Promise<SandboxCommandResult> {
    return new Promise((resolve, reject) => {
      const child = NodeChildProcess.spawn(command.executable, [...command.args], {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        detached: this.platform !== "win32",
        env: runtimeEnvironment(),
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let pendingError: Error | undefined;
      let reapTimer: NodeJS.Timeout | undefined;
      const settleError = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (reapTimer !== undefined) clearTimeout(reapTimer);
        reject(error);
      };
      const terminate = () => {
        if (child.pid === undefined) return;
        try {
          process.kill(this.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
        } catch {
          /* Process already exited. */
        }
      };
      const failAfterClose = (error: Error) => {
        if (pendingError !== undefined) return;
        pendingError = error;
        terminate();
        reapTimer = setTimeout(() => settleError(error), 5_000);
      };
      const timer = setTimeout(
        () => failAfterClose(new Error(`sandbox command timed out after ${command.timeoutMs}ms`)),
        command.timeoutMs,
      );
      const collect = (chunks: Buffer[], current: number, chunk: Buffer) => {
        if (current + chunk.length > MAX_OUTPUT_BYTES) {
          failAfterClose(new Error(`sandbox command output exceeded ${MAX_OUTPUT_BYTES} bytes`));
          return current;
        }
        chunks.push(chunk);
        return current + chunk.length;
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes = collect(stdout, stdoutBytes, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes = collect(stderr, stderrBytes, chunk);
      });
      child.once("error", (error) => {
        settleError(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (reapTimer !== undefined) clearTimeout(reapTimer);
        if (!settled) {
          settled = true;
          if (pendingError !== undefined) reject(pendingError);
          else
            resolve({
              exitCode: code ?? -1,
              stdout: Buffer.concat(stdout).toString("utf8"),
              stderr: Buffer.concat(stderr).toString("utf8"),
            });
        }
      });
      if (command.stdin === undefined) child.stdin.end();
      else child.stdin.end(command.stdin);
    });
  }
}
