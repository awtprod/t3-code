import { describe, expect, it } from "@effect/vitest";
import { ContainerSandboxBackend } from "./ContainerSandboxBackend.ts";
import { CREDENTIAL_PROXY_ALIAS } from "./SandboxCredentialProxy.ts";
import type {
  SandboxCommand,
  SandboxCommandExecutor,
  SandboxCommandResult,
  SandboxProvisionInput,
} from "./types.ts";

class FakeExecutor implements SandboxCommandExecutor {
  readonly commands: SandboxCommand[] = [];
  readonly respond: ((command: SandboxCommand) => SandboxCommandResult) | undefined;
  constructor(respond?: (command: SandboxCommand) => SandboxCommandResult) {
    this.respond = respond;
  }
  async run(command: SandboxCommand): Promise<SandboxCommandResult> {
    this.commands.push(command);
    return this.respond?.(command) ?? { exitCode: 0, stdout: "", stderr: "" };
  }
}

const input = (overrides: Partial<SandboxProvisionInput> = {}): SandboxProvisionInput => ({
  bootstrap: {
    threadId: "thread-1",
    projectId: "project-1",
    repositoryUrl: "https://example.test/repository.git",
    baseCommit: "a".repeat(40),
    branchName: "thread/thread-1",
  },
  image: "sandbox@sha256:" + "b".repeat(64),
  ...overrides,
});

function successfulExecutor() {
  return new FakeExecutor((command) => {
    if (command.args[0] === "info") return { exitCode: 0, stdout: '["name=rootless"]', stderr: "" };
    if (command.args[0] === "inspect" && command.args.length === 2)
      return { exitCode: 1, stdout: "", stderr: "missing" };
    if (command.args[0] === "volume" && command.args[1] === "inspect") {
      const name = command.args.at(-1) ?? "";
      if (name.startsWith("t3-cache-")) return { exitCode: 1, stdout: "", stderr: "missing" };
      const bytes = name.startsWith("t3-desktop-")
        ? Math.max(256 * 1024 ** 2, Math.floor(20 * 1024 ** 3 * 0.1))
        : Math.floor(20 * 1024 ** 3 * 0.9);
      return { exitCode: 0, stdout: `size=${bytes}\n`, stderr: "" };
    }
    if (command.args[0] === "exec" && command.args.includes("rev-parse"))
      return { exitCode: 0, stdout: `${"c".repeat(40)}\n`, stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  });
}

describe("ContainerSandboxBackend", () => {
  it("constructs a hardened, per-thread container without host bind mounts", async () => {
    const executor = successfulExecutor();
    const backend = new ContainerSandboxBackend("docker", executor);
    const ready = await backend.ensureReady(
      input({ caches: [{ digest: "d".repeat(64), target: "/cache/deps" }] }),
    );
    expect(ready.containerName).toBe("t3-thread-921ca543f9cf4d28fe0b81d81cdb33b5");
    const run = executor.commands.find(
      (command) => command.args[0] === "run" && command.args.includes(input().image),
    )!;
    expect(run.args).toEqual(
      expect.arrayContaining([
        "--read-only",
        "--init",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "512",
        "--storage-opt",
        `size=${20 * 1024 ** 3}`,
      ]),
    );
    expect(run.args.join(" ")).not.toContain("type=bind");
    expect(run.args.join(" ")).not.toContain("/var/run/docker.sock");
    expect(executor.commands.find((command) => command.args[0] === "network")?.args).toContain(
      "--internal",
    );
  });

  it("creates the provider HOME on the writable volume before any provider spawn", async () => {
    // Provider spawns run with HOME=/thread-data/provider-home and the CLI
    // writes its config there on startup. The image only creates /thread-data
    // and the rootfs is read-only, so nothing else can create this directory.
    const executor = successfulExecutor();
    await new ContainerSandboxBackend("docker", executor).ensureReady(input());
    const mkdir = executor.commands.findIndex(
      (command) =>
        command.args[0] === "exec" && command.args.includes("/thread-data/provider-home"),
    );
    expect(mkdir).toBeGreaterThanOrEqual(0);
    const run = executor.commands.findIndex((command) => command.args[0] === "run");
    expect(mkdir).toBeGreaterThan(run);
  });

  it("coalesces concurrent provisioning and is idempotent once ready", async () => {
    const executor = successfulExecutor();
    const backend = new ContainerSandboxBackend("docker", executor);
    const [first, second] = await Promise.all([
      backend.ensureReady(input()),
      backend.ensureReady(input()),
    ]);
    expect(first).toBe(second);
    await backend.ensureReady(input());
    expect(executor.commands.filter((command) => command.args[0] === "run")).toHaveLength(1);
  });

  it("derives collision-resistant names from exact thread ids", async () => {
    const first = await new ContainerSandboxBackend("docker", successfulExecutor()).ensureReady(
      input({ bootstrap: { ...input().bootstrap, threadId: "Thread_A" } }),
    );
    const second = await new ContainerSandboxBackend("docker", successfulExecutor()).ensureReady(
      input({ bootstrap: { ...input().bootstrap, threadId: "thread-a" } }),
    );
    const third = await new ContainerSandboxBackend("docker", successfulExecutor()).ensureReady(
      input({ bootstrap: { ...input().bootstrap, threadId: "Thread-A" } }),
    );
    expect(new Set([first.containerName, second.containerName, third.containerName]).size).toBe(3);
  });

  it("keeps workloads internal and routes egress through a hardened sidecar", async () => {
    const executor = successfulExecutor();
    await new ContainerSandboxBackend("docker", executor).ensureReady(
      input({ egressProxyImage: `egress@sha256:${"e".repeat(64)}` }),
    );
    const network = executor.commands.find((command) => command.args[0] === "network")!;
    const run = executor.commands.find(
      (command) => command.args[0] === "run" && command.args.includes(input().image),
    )!;
    // The workload network remains internal even with a proxy configured so
    // direct public egress cannot bypass the authenticated proxy hop.
    expect(network.args).toContain("--internal");
    expect(run.args).toEqual(
      expect.arrayContaining([
        "--env",
        `ALL_PROXY=${["http:/", "/egress-proxy:3128"].join("")}`,
        "--env",
        "NO_PROXY=localhost,127.0.0.1,::1,credential-proxy",
      ]),
    );
    const proxy = executor.commands.find((command) => command.args.includes("t3-egress-proxy"))!;
    expect(proxy.args).toEqual(
      expect.arrayContaining(["--deny-private", "--deny-metadata", "--resolve-before-connect"]),
    );
  });

  it("bypasses the egress proxy for the credential proxy sidecar", async () => {
    const executor = successfulExecutor();
    await new ContainerSandboxBackend("docker", executor).ensureReady(
      input({ egressProxyImage: `egress@sha256:${"e".repeat(64)}` }),
    );
    const run = executor.commands.find(
      (command) => command.args[0] === "run" && command.args.includes(input().image),
    )!;
    const entry = run.args.find((arg) => arg.startsWith("NO_PROXY="))!;
    // The credential proxy answers on a private address and the egress proxy
    // denies those, so a provider CLI reaching it through the proxy env is
    // refused by our own policy -- surfacing as "403 egress denied: private
    // address", which Claude Code reports as an authentication failure.
    expect(entry.slice("NO_PROXY=".length).split(",")).toContain(CREDENTIAL_PROXY_ALIAS);
  });

  it("cleans container, network, and workspace volume after setup failure and stop", async () => {
    const failing = successfulExecutor();
    const original = failing.respond!;
    const executor = new FakeExecutor((command) =>
      command.args[0] === "exec" && command.args.includes("clone")
        ? { exitCode: 1, stdout: "", stderr: "clone failed" }
        : original(command),
    );
    await expect(
      new ContainerSandboxBackend("docker", executor).ensureReady(input()),
    ).rejects.toThrow("git failed");
    expect(
      executor.commands
        .filter((command) => command.args[0] === "rm" || command.args[1] === "rm")
        .map((command) => command.args.at(-1)),
    ).toEqual([
      "t3-thread-921ca543f9cf4d28fe0b81d81cdb33b5",
      "t3-net-921ca543f9cf4d28fe0b81d81cdb33b5",
      "t3-workspace-921ca543f9cf4d28fe0b81d81cdb33b5",
      "t3-desktop-921ca543f9cf4d28fe0b81d81cdb33b5",
    ]);

    const stoppingExecutor = successfulExecutor();
    const backend = new ContainerSandboxBackend("docker", stoppingExecutor);
    await backend.ensureReady(input());
    await backend.stop("thread-1");
    expect(
      stoppingExecutor.commands
        .filter((command) => command.args[0] === "rm" || command.args[1] === "rm")
        .map((command) => command.args.at(-1)),
    ).toEqual([
      "t3-thread-921ca543f9cf4d28fe0b81d81cdb33b5",
      "t3-net-921ca543f9cf4d28fe0b81d81cdb33b5",
      "t3-workspace-921ca543f9cf4d28fe0b81d81cdb33b5",
      "t3-desktop-921ca543f9cf4d28fe0b81d81cdb33b5",
    ]);
  });

  it("attempts every cleanup after a teardown hook fails", async () => {
    const base = successfulExecutor();
    const respond = base.respond!;
    const executor = new FakeExecutor((command) =>
      command.args[0] === "exec" && command.args.includes("failing-teardown")
        ? { exitCode: 1, stdout: "", stderr: "hook failed" }
        : respond(command),
    );
    const backend = new ContainerSandboxBackend("docker", executor);
    await backend.ensureReady(input());
    await expect(backend.stop("thread-1", [{ executable: "failing-teardown" }])).rejects.toThrow(
      "teardown failing-teardown",
    );
    expect(
      executor.commands
        .filter((command) => command.args[0] === "rm" || command.args[1] === "rm")
        .map((command) => command.args.at(-1)),
    ).toEqual([
      "t3-thread-921ca543f9cf4d28fe0b81d81cdb33b5",
      "t3-net-921ca543f9cf4d28fe0b81d81cdb33b5",
      "t3-workspace-921ca543f9cf4d28fe0b81d81cdb33b5",
      "t3-desktop-921ca543f9cf4d28fe0b81d81cdb33b5",
    ]);
  });

  it("rejects malformed commits, paths, mounts, and environment keys before container launch", async () => {
    const executor = successfulExecutor();
    const backend = new ContainerSandboxBackend("docker", executor);
    await expect(
      backend.ensureReady(input({ bootstrap: { ...input().bootstrap, baseCommit: "main" } })),
    ).rejects.toThrow("immutable full commit");
    await expect(
      backend.ensureReady(input({ bootstrap: { ...input().bootstrap, threadId: "../other" } })),
    ).rejects.toThrow("unsafe");
    await expect(
      backend.ensureReady(input({ caches: [{ digest: "d".repeat(64), target: "/etc/ssh" }] })),
    ).rejects.toThrow("protected path");
    await expect(backend.ensureReady(input({ image: "sandbox:latest" }))).rejects.toThrow(
      "pinned by sha256",
    );
    expect(executor.commands.some((command) => command.args[0] === "run")).toBe(false);
  });

  it("requires a rootless daemon", async () => {
    const executor = new FakeExecutor(() => ({ exitCode: 0, stdout: "false", stderr: "" }));
    await expect(
      new ContainerSandboxBackend("podman", executor).ensureReady(input()),
    ).rejects.toThrow("rootless mode");
  });

  it("removes only confirmed labeled orphan containers", async () => {
    const executor = new FakeExecutor((command) => {
      if (command.args[0] === "ps")
        if (command.args.includes("label=com.t3tools.sandbox.thread=orphan-1"))
          return { exitCode: 0, stdout: "abcdef654321\n", stderr: "" };
      if (command.args[0] === "ps")
        return {
          exitCode: 0,
          stdout: "abcdef123456\tthread-1\tproject-1\nabcdef654321\torphan-1\tproject-1\n",
          stderr: "",
        };
      if (command.args[0] === "inspect")
        return { exitCode: 0, stdout: "orphan-1\ttrue\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const backend = new ContainerSandboxBackend("docker", executor);
    const result = await backend.reconcile({
      expectedThreadIds: new Set(["thread-1", "missing-1"]),
      removeOrphans: true,
    });
    expect(result).toEqual({
      activeThreadIds: [],
      missingThreadIds: ["thread-1", "missing-1"],
      orphanThreadIds: ["orphan-1"],
      removedRuntimeRefs: ["abcdef654321"],
    });
    expect(
      executor.commands
        .filter((command) => command.args[0] === "rm")
        .map((command) => command.args.at(-1)),
    ).toEqual(["abcdef654321"]);
    await expect(backend.exec("thread-1", { executable: "true" })).rejects.toThrow("not ready");
  });

  it("returns the result of a non-zero exec when the caller allows it", async () => {
    // A checkpoint ref probe runs `git rev-parse --verify <ref>`, which exits 1
    // when the ref does not exist yet -- the normal state on a thread's first
    // turn. Throwing on that made `CheckpointStore.sandboxGit`'s `allowNonZero`
    // branch unreachable and failed every pre-turn baseline for a sandboxed
    // thread.
    const executor = new FakeExecutor((command) => {
      if (command.args[0] === "info")
        return { exitCode: 0, stdout: '["name=rootless"]', stderr: "" };
      if (command.args[0] === "inspect" && command.args.length === 2)
        return { exitCode: 1, stdout: "", stderr: "missing" };
      if (command.args[0] === "volume" && command.args[1] === "inspect") {
        const name = command.args.at(-1) ?? "";
        if (name.startsWith("t3-cache-")) return { exitCode: 1, stdout: "", stderr: "missing" };
        const bytes = name.startsWith("t3-desktop-")
          ? Math.max(256 * 1024 ** 2, Math.floor(20 * 1024 ** 3 * 0.1))
          : Math.floor(20 * 1024 ** 3 * 0.9);
        return { exitCode: 0, stdout: `size=${bytes}\n`, stderr: "" };
      }
      if (command.args[0] === "exec" && command.args.includes("rev-parse"))
        return { exitCode: 1, stdout: "", stderr: "fatal: Needed a single revision\n" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const backend = new ContainerSandboxBackend("docker", executor);
    await backend.ensureReady(input());

    const probe = await backend.exec("thread-1", {
      executable: "git",
      args: ["rev-parse", "--verify", "refs/t3/checkpoint^{commit}"],
      allowNonZeroExit: true,
    });
    expect(probe.exitCode).toBe(1);
    expect(probe.stderr).toContain("Needed a single revision");

    // Without the flag the same failure is still an error.
    await expect(
      backend.exec("thread-1", { executable: "git", args: ["rev-parse", "--verify", "HEAD"] }),
    ).rejects.toThrow("sandbox command git failed");
  });

  it("exports commit and patch through argv-only exec", async () => {
    const executor = successfulExecutor();
    const backend = new ContainerSandboxBackend("docker", executor);
    await backend.ensureReady(input());
    const exported = await backend.exportBranch("thread-1");
    expect(exported.commit).toBe("c".repeat(40));
    expect(
      executor.commands
        .filter((command) => command.args[0] === "exec")
        .every((command) => !command.args.includes("sh")),
    ).toBe(true);
  });

  it("exports and verifies a self-contained Git bundle before cleanup", async () => {
    const executor = successfulExecutor();
    const backend = new ContainerSandboxBackend("docker", executor);
    await backend.ensureReady(input());
    await backend.exportBundle("thread-1", "/tmp/thread-1.bundle");
    expect(executor.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          executable: "docker",
          args: expect.arrayContaining([
            "bundle",
            "create",
            "/tmp/t3-thread-export.bundle",
            "--all",
          ]),
        }),
        expect.objectContaining({
          executable: "docker",
          args: [
            "cp",
            expect.stringContaining(":/tmp/t3-thread-export.bundle"),
            "/tmp/thread-1.bundle",
          ],
        }),
      ]),
    );

    // Verification runs in the container against the repository the bundle came
    // from -- `git bundle verify` needs a repository to resolve prerequisites
    // against, so a host-side check with no `-C` fails outright. It also has to
    // precede the `cp`, so a bad bundle never reaches the host.
    const verifyIndex = executor.commands.findIndex(
      (command) => command.args.includes("bundle") && command.args.includes("verify"),
    );
    const copyIndex = executor.commands.findIndex((command) => command.args[0] === "cp");
    expect(verifyIndex).toBeGreaterThanOrEqual(0);
    expect(executor.commands[verifyIndex]).toMatchObject({
      executable: "docker",
      args: expect.arrayContaining(["-C", "/workspace/repo", "bundle", "verify"]),
    });
    expect(verifyIndex).toBeLessThan(copyIndex);
  });

  it("fetches the seed bundle by its ref instead of cloning it", async () => {
    const executor = successfulExecutor();
    const backend = new ContainerSandboxBackend("docker", executor);
    const base = input();
    const bundleRef = "refs/t3-sandbox-seed/abc123.42";
    await backend.ensureReady({
      ...base,
      bootstrap: {
        ...base.bootstrap,
        repositoryBundlePath: "/var/lib/t3/seeds/seed.bundle",
        repositoryBundleRef: bundleRef,
      },
    });

    const containerBundle = "/tmp/t3-repository.bundle";
    // `git clone` only fetches `refs/heads/*`, so cloning a bundle whose only
    // ref is private succeeds while landing nothing -- and the checkout that
    // follows fails with "reference is not a tree". The refspec must be explicit.
    expect(
      executor.commands.some(
        (command) => command.args.includes("clone") && command.args.includes(containerBundle),
      ),
    ).toBe(false);
    expect(
      executor.commands.some(
        (command) =>
          command.args.includes("fetch") &&
          command.args.includes(containerBundle) &&
          command.args.includes(`${bundleRef}:${bundleRef}`),
      ),
    ).toBe(true);
    // Nothing verifies the bundle beforehand: there is no repository to verify
    // against, and the fetch rejects a truncated bundle that verify accepts.
    expect(
      executor.commands.some(
        (command) =>
          command.args.includes("bundle") &&
          command.args.includes("verify") &&
          command.args.includes(containerBundle),
      ),
    ).toBe(false);
  });

  it("refuses a seed bundle whose ref was not supplied", async () => {
    const executor = successfulExecutor();
    const backend = new ContainerSandboxBackend("docker", executor);
    const base = input();
    await expect(
      backend.ensureReady({
        ...base,
        bootstrap: { ...base.bootstrap, repositoryBundlePath: "/var/lib/t3/seeds/seed.bundle" },
      }),
    ).rejects.toThrow(/repositoryBundleRef/);
  });

  it("samples bounded runtime and writable-volume usage", async () => {
    const base = successfulExecutor();
    const executor = new FakeExecutor((command) => {
      if (command.args[0] === "stats")
        return {
          exitCode: 0,
          stdout: JSON.stringify({ CPUPerc: "12.5%", MemUsage: "256MiB / 4GiB", PIDs: "7" }),
          stderr: "",
        };
      if (command.args[0] === "exec" && command.args.includes("du"))
        return { exitCode: 0, stdout: "1024\t/workspace\n2048\t/thread-data\n", stderr: "" };
      return base.respond!(command);
    });
    const backend = new ContainerSandboxBackend("docker", executor);
    await backend.ensureReady(input());
    expect(await backend.sampleUsage("thread-1")).toEqual({
      cpuPercent: 12.5,
      memoryBytes: 256 * 1024 ** 2,
      diskBytes: 3072,
      processCount: 7,
    });
  });
});
