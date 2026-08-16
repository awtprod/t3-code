import { describe, expect, it } from "@effect/vitest";
import { SandboxId, ThreadId } from "@t3tools/contracts";
import {
  bindSandboxProviderTarget,
  makeSandboxProviderBindingOwner,
  sandboxProviderInvocation,
  sandboxProviderTarget,
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
