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
