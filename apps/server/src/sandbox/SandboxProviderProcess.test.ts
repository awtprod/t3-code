// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - test spawns a real fixture process and waits on its stdin EPIPE at the Node boundary.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

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
            NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
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

  it("drops API credentials when external ChatGPT auth is selected", () => {
    const invocation = sandboxProviderInvocation(
      target,
      "codex",
      [],
      undefined,
      {
        OPENAI_API_KEY: "host-api-key",
        CODEX_API_KEY: "host-codex-key",
        CODEX_TOKEN: "host-codex-token",
        OPENAI_BASE_URL: "https://api-host.example.test",
      },
      { externalChatgptAuth: true },
    );

    expect(invocation.env.OPENAI_API_KEY).toBeUndefined();
    expect(invocation.env.CODEX_API_KEY).toBeUndefined();
    expect(invocation.env.CODEX_TOKEN).toBeUndefined();
    expect(invocation.env.OPENAI_BASE_URL).toBeUndefined();
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
    expect(invocation.args).toContain("HOME=/thread-data/provider-home");
  });

  it("keeps the container HOME out of the host runtime process environment", () => {
    // Bare `--env HOME` makes the runtime CLI read HOME from its own process
    // env, so a container-only value there becomes the *host* CLI's config
    // root: podman exits with "cannot resolve /thread-data/provider-home"
    // before it ever reaches the container, and the turn fails with nothing
    // but "process exited with code 1".
    const invocation = sandboxProviderInvocation(target, "codex", [], undefined, {
      LANG: "C.UTF-8",
    });
    expect(invocation.env.HOME).not.toBe("/thread-data/provider-home");
    expect(invocation.env.TMPDIR).toBeUndefined();
    expect(invocation.env.USER).toBeUndefined();
    // Inlined into argv instead, so the container still gets them. These are
    // non-secret literals, unlike the credential values that stay bare.
    expect(invocation.args).toContain("HOME=/thread-data/provider-home");
    expect(invocation.args).toContain("USER=sandbox");
    expect(invocation.args).toContain("LANG");
    expect(invocation.args).not.toContain("LANG=C.UTF-8");
  });

  it("carries the runtime-locating environment provisioning uses, and no secrets", () => {
    // Provisioning spawns the container CLI through NodeSandboxCommandExecutor,
    // which forwards a wider non-secret allowlist because rootless podman needs
    // `XDG_RUNTIME_DIR` to find its user socket and a remote one needs
    // `CONTAINER_HOST`/`DOCKER_HOST`. Exec used to pass `PATH`/`HOME` only, so a
    // deployment could provision a container and then exec against a different
    // daemon -- or none at all.
    const previous = {
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      CONTAINER_HOST: process.env.CONTAINER_HOST,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
    };
    process.env.XDG_RUNTIME_DIR = "/run/user/1000";
    process.env.CONTAINER_HOST = "unix:///run/user/1000/podman/podman.sock";
    process.env.ANTHROPIC_API_KEY = "sk-host-secret";
    process.env.SSH_AUTH_SOCK = "/host/agent.sock";
    try {
      const invocation = sandboxProviderInvocation(target, "codex", [], undefined, {
        LANG: "C.UTF-8",
      });
      expect(invocation.env.XDG_RUNTIME_DIR).toBe("/run/user/1000");
      expect(invocation.env.CONTAINER_HOST).toBe("unix:///run/user/1000/podman/podman.sock");
      // Credential stripping is unchanged: the allowlist names only variables
      // that locate the runtime, so nothing secret rides along with them.
      expect(invocation.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(invocation.env.SSH_AUTH_SOCK).toBeUndefined();
      expect(Object.values(invocation.env)).not.toContain("sk-host-secret");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
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
