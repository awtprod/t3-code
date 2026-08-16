import { describe, expect, it } from "@effect/vitest";
import { ContainerSandboxBackend } from "./ContainerSandboxBackend.ts";
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
        "NO_PROXY=localhost,127.0.0.1,::1",
      ]),
    );
    const proxy = executor.commands.find((command) => command.args.includes("t3-egress-proxy"))!;
    expect(proxy.args).toEqual(
      expect.arrayContaining(["--deny-private", "--deny-metadata", "--resolve-before-connect"]),
    );
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
        expect.objectContaining({
          executable: "git",
          args: ["bundle", "verify", "/tmp/thread-1.bundle"],
        }),
      ]),
    );
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
