import * as NodePath from "node:path";
import * as NodeUrl from "node:url";

import { describe, expect, it } from "@effect/vitest";
import { SandboxId, ThreadId } from "@t3tools/contracts";
import {
  bindSandboxProviderTarget,
  makeSandboxProviderBindingOwner,
  sandboxProviderInvocation,
  sandboxProviderTarget,
  spawnClaudeInSandbox,
  unbindSandboxProviderTarget,
} from "./SandboxProviderProcess.ts";

const target = {
  kind: "sandbox" as const,
  threadId: ThreadId.make("thread-provider-process"),
  sandboxId: SandboxId.make("sandbox-a"),
  runtimeRef: "t3-thread-project-thread",
  runtime: "podman" as const,
  workspaceCwd: "/workspace/repo",
};

describe("SandboxProviderProcess", () => {
  it("survives a sandbox process that closes stdin while the SDK is still writing", async () => {
    // The real failure shape: the container is up but the process inside it has
    // closed stdin, and the SDK keeps streaming into it. Node delivers that
    // EPIPE as an 'error' event on stdin, which has no default listener -- so
    // unhandled it terminates the whole server, taking every other thread's
    // session down with one thread's broken container.
    const owner = makeSandboxProviderBindingOwner();
    const spawnTarget = { ...target, threadId: ThreadId.make("thread-stdin-epipe") };
    bindSandboxProviderTarget(spawnTarget, owner);
    const errors: Array<unknown> = [];
    const capture = (cause: unknown) => errors.push(cause);
    process.on("uncaughtException", capture);
    try {
      const child = spawnClaudeInSandbox(
        {
          ...spawnTarget,
          runtime: NodePath.join(
            NodePath.dirname(NodeUrl.fileURLToPath(import.meta.url)),
            "__fixtures__",
            "fake-runtime-closed-stdin.sh",
          ) as unknown as (typeof spawnTarget)["runtime"],
        },
        { command: "claude", args: [], cwd: undefined, env: {} } as never,
      ) as unknown as { readonly stdin: NodeJS.WritableStream };
      await new Promise((resolve) => setTimeout(resolve, 150));
      for (let attempt = 0; attempt < 40; attempt += 1) {
        child.stdin.write("x".repeat(1024));
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(errors).toEqual([]);
    } finally {
      process.off("uncaughtException", capture);
      unbindSandboxProviderTarget(spawnTarget.threadId, owner);
    }
  });

  it("keeps credential values out of process argv", () => {
    const invocation = sandboxProviderInvocation(target, "codex", ["app-server"], undefined, {
      HTTPS_PROXY: "http://credential-proxy.example:8080",
    });
    expect(invocation.args).toContain("HTTPS_PROXY");
    expect(invocation.args.join(" ")).not.toContain("credential-proxy.example");
    expect(invocation.args).toEqual(
      expect.arrayContaining([
        "--workdir",
        "/workspace/repo",
        "--env",
        "HTTPS_PROXY",
        "--",
        "t3-thread-project-thread",
        "codex",
        "app-server",
      ]),
    );
  });

  it("fails closed instead of forwarding persistent provider credentials", () => {
    expect(() =>
      sandboxProviderInvocation(target, "codex", [], undefined, { CODEX_TOKEN: "persistent" }),
    ).toThrow("thread-scoped credential proxy");
  });

  it("ignores arbitrary cwd and host environment while fixing sandbox HOME", () => {
    const invocation = sandboxProviderInvocation(target, "codex", [], "/host/escape", {
      SSH_AUTH_SOCK: "/host/agent.sock",
      HOME: "/host/home",
      LANG: "C.UTF-8",
    });
    expect(invocation.args).toContain("/workspace/repo");
    expect(invocation.args).not.toContain("/host/escape");
    expect(invocation.args).not.toContain("SSH_AUTH_SOCK");
    expect(invocation.env.HOME).toBe("/thread-data/provider-home");
  });

  it("rejects replacing a live binding with another sandbox generation", () => {
    const owner = makeSandboxProviderBindingOwner();
    bindSandboxProviderTarget(target, owner);
    expect(() =>
      bindSandboxProviderTarget(
        { ...target, sandboxId: SandboxId.make("sandbox-b") },
        makeSandboxProviderBindingOwner(),
      ),
    ).toThrow("different sandbox generation");
    expect(sandboxProviderTarget(target.threadId)).toEqual(target);
    unbindSandboxProviderTarget(target.threadId, owner);
    expect(sandboxProviderTarget(target.threadId)).toBeUndefined();
  });

  it("allows a new sandbox generation after the active binding is released", () => {
    const firstOwner = makeSandboxProviderBindingOwner();
    const secondOwner = makeSandboxProviderBindingOwner();
    const nextTarget = { ...target, sandboxId: SandboxId.make("sandbox-b") };

    bindSandboxProviderTarget(target, firstOwner);
    unbindSandboxProviderTarget(target.threadId, firstOwner);
    bindSandboxProviderTarget(nextTarget, secondOwner);

    expect(sandboxProviderTarget(target.threadId)).toEqual(nextTarget);
    unbindSandboxProviderTarget(target.threadId, secondOwner);
  });
});
