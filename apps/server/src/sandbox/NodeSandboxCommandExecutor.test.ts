import { describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import { NodeSandboxCommandExecutor } from "./NodeSandboxCommandExecutor.ts";

const hostPlatform = Effect.runSync(HostProcessPlatform);

describe("NodeSandboxCommandExecutor", () => {
  it("executes argv directly and captures bounded output", async () => {
    const result = await new NodeSandboxCommandExecutor(hostPlatform).run({
      executable: process.execPath,
      args: [
        "-e",
        "process.stdout.write(process.argv[1]); process.stderr.write('err')",
        "literal;$HOME",
      ],
      timeoutMs: 5_000,
    });
    expect(result).toEqual({ exitCode: 0, stdout: "literal;$HOME", stderr: "err" });
  });

  it("kills commands that exceed their deadline", async () => {
    await expect(
      new NodeSandboxCommandExecutor(hostPlatform).run({
        executable: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        timeoutMs: 25,
      }),
    ).rejects.toThrow("timed out");
  });
});
