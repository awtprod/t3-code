import { describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import { NodeSandboxCommandExecutor } from "./NodeSandboxCommandExecutor.ts";

describe("NodeSandboxCommandExecutor", () => {
  it.effect("executes argv directly and captures bounded output", () =>
    Effect.gen(function* () {
      const hostPlatform = yield* HostProcessPlatform;
      const result = yield* Effect.promise(() =>
        new NodeSandboxCommandExecutor(hostPlatform).run({
          executable: process.execPath,
          args: [
            "-e",
            "process.stdout.write(process.argv[1]); process.stderr.write('err')",
            "literal;$HOME",
          ],
          timeoutMs: 5_000,
        }),
      );
      expect(result).toEqual({ exitCode: 0, stdout: "literal;$HOME", stderr: "err" });
    }),
  );

  it.effect("forwards the container runtime's own variables and nothing else", () =>
    Effect.gen(function* () {
      const hostPlatform = yield* HostProcessPlatform;
      // Rootless podman fails at `podman info` without XDG_RUNTIME_DIR, so the
      // allowlist has to carry it -- while still dropping ambient secrets.
      const priorRuntimeDir = process.env.XDG_RUNTIME_DIR;
      process.env.XDG_RUNTIME_DIR = priorRuntimeDir ?? "/run/user/test";
      process.env.SANDBOX_CANARY_SECRET = "must-not-be-forwarded";
      const result = yield* Effect.promise(() =>
        new NodeSandboxCommandExecutor(hostPlatform).run({
          executable: process.execPath,
          args: [
            "-e",
            "process.stdout.write(Object.keys(process.env).sort().join(String.fromCharCode(10)))",
          ],
          timeoutMs: 5_000,
        }),
      );
      const forwarded = result.stdout.split(String.fromCharCode(10)).filter(Boolean);
      expect(forwarded).toContain("PATH");
      expect(forwarded).toContain("XDG_RUNTIME_DIR");
      expect(forwarded).toContain("HOME");
      expect(forwarded).not.toContain("ANTHROPIC_API_KEY");
      expect(forwarded).not.toContain("SANDBOX_CANARY_SECRET");
      delete process.env.SANDBOX_CANARY_SECRET;
      if (priorRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
    }),
  );

  it.effect("kills commands that exceed their deadline", () =>
    Effect.gen(function* () {
      const hostPlatform = yield* HostProcessPlatform;
      const failure = yield* Effect.promise(() =>
        new NodeSandboxCommandExecutor(hostPlatform)
          .run({
            executable: process.execPath,
            args: ["-e", "setInterval(() => {}, 1000)"],
            timeoutMs: 25,
          })
          .then(
            () => null,
            (error: unknown) => error,
          ),
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("timed out");
    }),
  );
});
