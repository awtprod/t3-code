// @effect-diagnostics nodeBuiltinImport:off - This is the production adapter at the Node process boundary.
// @effect-diagnostics globalTimers:off - The executor owns a native process timeout and process-group kill.
import { spawn } from "node:child_process";
import type { SandboxCommand, SandboxCommandExecutor, SandboxCommandResult } from "./types.ts";

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export class NodeSandboxCommandExecutor implements SandboxCommandExecutor {
  run(command: SandboxCommand): Promise<SandboxCommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command.executable, [...command.args], {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        env: { PATH: process.env.PATH },
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
          process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
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
