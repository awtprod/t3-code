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

/**
 * A responder that answers every command a clean provision issues.
 *
 * `override` runs first and wins whenever it returns a result, so a test that
 * cares about one command -- a `stat` size, a failing `tar` -- says only that
 * much and still gets a container out the other end.
 */
function successfulExecutor(
  override?: (command: SandboxCommand) => SandboxCommandResult | undefined,
) {
  return new FakeExecutor((command) => {
    const overridden = override?.(command);
    if (overridden !== undefined) return overridden;
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
    // `rev-parse HEAD`, `rev-parse HEAD^{tree}`, and `write-tree` all answer
    // the same object here: a freshly provisioned container has a clean
    // working tree, so the export writes no snapshot. A test that wants a
    // dirty tree overrides `write-tree`.
    if (
      command.args[0] === "exec" &&
      (command.args.includes("rev-parse") || command.args.includes("write-tree"))
    )
      return { exitCode: 0, stdout: `${"c".repeat(40)}\n`, stderr: "" };
    // The post-extraction probe for a provider's own session directory. An
    // archive that unpacked cleanly but carried no conversation would answer
    // empty here, which is the case the probe exists for.
    if (command.args[0] === "exec" && command.args.includes("find"))
      return {
        exitCode: 0,
        stdout: "/thread-data/provider-home/.codex/sessions\n",
        stderr: "",
      };
    return { exitCode: 0, stdout: "", stderr: "" };
  });
}

/**
 * Answers a `find` the way the container's own `find` would, against a fixed
 * set of directories.
 *
 * The probe under test is entirely about WHICH directory names it asks for, so
 * a responder that returned a canned hit would pass no matter what the argv
 * said. This reads the `-name` predicates and the depth bounds out of the
 * command and matches them, so a probe that stops asking for a provider's
 * layout stops finding that provider's store.
 */
function findAgainst(
  command: SandboxCommand,
  present: ReadonlyArray<string>,
): SandboxCommandResult {
  const args = command.args;
  const root = args[args.indexOf("find") + 1] ?? "";
  const names = new Set(
    args.flatMap((value, index) => (value === "-name" ? [args[index + 1] ?? ""] : [])),
  );
  const bound = (flag: string, fallback: number) => {
    const at = args.indexOf(flag);
    return at === -1 ? fallback : Number.parseInt(args[at + 1] ?? "", 10);
  };
  const minimum = bound("-mindepth", 0);
  const maximum = bound("-maxdepth", Number.POSITIVE_INFINITY);
  const matched = present.filter((path) => {
    if (!path.startsWith(`${root}/`)) return false;
    const segments = path.slice(root.length + 1).split("/");
    if (segments.length < minimum || segments.length > maximum) return false;
    return names.has(segments.at(-1) ?? "");
  });
  return { exitCode: 0, stdout: matched.map((path) => `${path}\n`).join(""), stderr: "" };
}

describe("ContainerSandboxBackend", () => {
  it("names the opt-out when the host cannot administer project quotas", async () => {
    // Volume quotas are on by default, and podman's own wording says what
    // failed but not what to set -- so on a host that cannot administer XFS
    // project quotas at all, provisioning died without ever mentioning the
    // flag that fixes it.
    const executor = successfulExecutor((command) =>
      command.args[0] === "volume" && command.args[1] === "create"
        ? {
            exitCode: 125,
            stdout: "",
            stderr:
              "Error: volume options size and inodes not supported. Filesystem does not support Project Quota",
          }
        : undefined,
    );
    const backend = new ContainerSandboxBackend("docker", executor);
    const failure = await backend.ensureReady(input()).then(
      () => null,
      (error: unknown) => error,
    );
    expect(String(failure)).toContain("T3_SANDBOX_VOLUME_STORAGE_QUOTA=disabled");
  });

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
        // Swap pinned to the memory limit: docker's default of 2x memory
        // would let the workload consume double its configured ceiling.
        "--memory",
        String(4 * 1024 ** 3),
        "--memory-swap",
        String(4 * 1024 ** 3),
      ]),
    );
    // `--storage-opt size=` is off unless a deployment opts in: podman
    // --remote rejects it, and the writable-layer bound it would add is
    // already covered by the read-only rootfs plus quota'd volumes.
    expect(run.args).not.toContain("--storage-opt");
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

  it("never archives provider credentials into an exported store", async () => {
    // The provider home holds live auth material (.credentials.json,
    // sessions/*.key, .codex/auth.json) beside the transcripts, and the archive
    // outlives the container in a host directory. The exclusions are the
    // security boundary, so they are asserted directly rather than assumed
    // from the happy path.
    const executor = successfulExecutor((command) =>
      command.args[0] === "exec" && command.args.includes("stat")
        ? { exitCode: 0, stdout: "4096\n", stderr: "" }
        : undefined,
    );
    const backend = new ContainerSandboxBackend("docker", executor);
    await backend.ensureReady(input());
    await backend.exportProviderStore("thread-1", "/artifacts/store.tar", 50 * 1024 * 1024);

    const tar = executor.commands.find(
      (command) => command.args[0] === "exec" && command.args.includes("tar"),
    );
    expect(tar).toBeDefined();
    for (const denied of [
      ".credentials.json",
      "*.credentials.json",
      // Covers private key material anywhere under the home, including inside
      // a `sessions/` directory -- a tar exclude glob matches across `/`.
      "*.key",
      "*token*",
      // Codex's ~/.codex/auth.json.
      "*auth*",
    ]) {
      const at = tar!.args.indexOf(denied);
      expect(at).toBeGreaterThan(0);
      expect(tar!.args[at - 1]).toBe("--exclude");
    }
    // ...but NOT a bare `sessions`. That stripped Codex's ~/.codex/sessions
    // transcripts -- the very conversation the archive exists to carry -- while
    // tar still exited 0, so the thread came back with a retained cursor
    // naming a conversation that was never in the tar.
    expect(tar!.args).not.toContain("sessions");
    // Archived from the provider home itself, so nothing outside it -- the
    // workspace, /tmp -- can ride along.
    expect(tar!.args).toContain("/thread-data/provider-home");
  });

  it("skips a provider store larger than the ceiling instead of copying it out", async () => {
    // Nothing prunes the artifact directory, so an oversized store is dropped
    // at the boundary: it must never reach the host.
    const executor = successfulExecutor((command) =>
      command.args[0] === "exec" && command.args.includes("stat")
        ? { exitCode: 0, stdout: `${256 * 1024 * 1024}\n`, stderr: "" }
        : undefined,
    );
    const backend = new ContainerSandboxBackend("docker", executor);
    await backend.ensureReady(input());
    const bytes = await backend.exportProviderStore(
      "thread-1",
      "/artifacts/store.tar",
      50 * 1024 * 1024,
    );

    expect(bytes).toBeUndefined();
    expect(
      executor.commands.some(
        (command) => command.args[0] === "cp" && command.args.includes("/artifacts/store.tar"),
      ),
    ).toBe(false);
  });

  it("restores a provider store into the container home before the repository is seeded", async () => {
    // The CLI reads its home on first spawn, so the store has to be in place
    // before anything can run -- and before the repo work that follows.
    const executor = successfulExecutor();
    const backend = new ContainerSandboxBackend("docker", executor);
    await backend.ensureReady(
      input({
        bootstrap: {
          ...input().bootstrap,
          providerStorePath: "/artifacts/thread-1.store.tar",
        },
      }),
    );

    const extract = executor.commands.findIndex(
      (command) => command.args[0] === "exec" && command.args.includes("--extract"),
    );
    const clone = executor.commands.findIndex(
      (command) => command.args[0] === "exec" && command.args.includes("clone"),
    );
    expect(extract).toBeGreaterThanOrEqual(0);
    expect(extract).toBeLessThan(clone);
  });

  it("provisions anyway when a restored provider store fails to extract", async () => {
    // Losing the conversation costs the next turn its context; failing the
    // provision would cost the user the thread.
    const executor = successfulExecutor((command) =>
      command.args[0] === "exec" && command.args.includes("--extract")
        ? { exitCode: 1, stdout: "", stderr: "corrupt archive" }
        : undefined,
    );
    const backend = new ContainerSandboxBackend("docker", executor);
    const ready = await backend.ensureReady(
      input({
        bootstrap: {
          ...input().bootstrap,
          providerStorePath: "/artifacts/thread-1.store.tar",
        },
      }),
    );

    expect(ready.containerName).toContain("t3-thread-");
  });

  it("reports the provider store disposition for each of the three provisioning outcomes", async () => {
    // A boolean could not say this. "Not restored" conflated a fresh container
    // whose archive never arrived with a container that SURVIVED and never
    // needed restoring -- and the caller, deciding whether to keep the thread's
    // provider resume cursor, threw away a perfectly valid cursor on every
    // re-attach.
    const withStore = input({
      bootstrap: { ...input().bootstrap, providerStorePath: "/artifacts/thread-1.store.tar" },
    });

    const restored = await new ContainerSandboxBackend("docker", successfulExecutor()).ensureReady(
      withStore,
    );
    expect(restored.providerStore).toBe("restored");

    // The archive is supplied but never lands: the provider home comes up
    // empty, exactly as for a thread with no prior export.
    const failedExtract = await new ContainerSandboxBackend(
      "docker",
      successfulExecutor((command) =>
        command.args[0] === "exec" && command.args.includes("--extract")
          ? { exitCode: 1, stdout: "", stderr: "corrupt archive" }
          : undefined,
      ),
    ).ensureReady(withStore);
    expect(failedExtract.providerStore).toBe("unavailable");

    // No store to carry across at all.
    const noStore = await new ContainerSandboxBackend("docker", successfulExecutor()).ensureReady(
      input(),
    );
    expect(noStore.providerStore).toBe("unavailable");

    // A container that is already there, with its provider home intact: the
    // conversation is where it was left, so nothing needed restoring.
    const survivor = await new ContainerSandboxBackend(
      "docker",
      successfulExecutor((command) =>
        command.args[0] === "inspect"
          ? {
              exitCode: 0,
              stdout: [
                "thread-1",
                "project-1",
                "true",
                input().image,
                "a".repeat(40),
                "thread/thread-1",
                "workspace",
                "true",
              ].join("\t"),
              stderr: "",
            }
          : undefined,
      ),
    ).ensureReady(input());
    expect(survivor.providerStore).toBe("preserved");
  });

  it("reports no restored store when the archive unpacked without a conversation", async () => {
    // `tar --extract` exiting 0 only proves the archive unpacked. The archive
    // is built with credential exclusions, and one aimed too broadly -- the
    // bare `sessions` this list used to carry, which took Codex's
    // ~/.codex/sessions transcripts with it -- produces a tar that extracts
    // cleanly and restores nothing resumable. Reporting that as restored kept
    // a cursor naming a conversation that was never in the tar, and every
    // following turn died on "No conversation found with session ID".
    const executor = successfulExecutor((command) =>
      command.args[0] === "exec" && command.args.includes("find")
        ? { exitCode: 0, stdout: "", stderr: "" }
        : undefined,
    );
    const ready = await new ContainerSandboxBackend("docker", executor).ensureReady(
      input({
        bootstrap: {
          ...input().bootstrap,
          providerStorePath: "/artifacts/thread-1.store.tar",
        },
      }),
    );

    // The thread still comes back -- losing the conversation must not cost the
    // user their branch.
    expect(ready.containerName).toContain("t3-thread-");
    expect(ready.providerStore).toBe("unavailable");
  });

  it("reports a restored store for Claude's projects layout, not just Codex's sessions", async () => {
    // Claude is one of only two providers that can run sandboxed, and it does
    // not use Codex's `sessions` directory: a default install nests transcripts
    // under `~/.claude/projects` (the same layout `UsageService` probes for on
    // the host). A probe that accepted only `sessions` classified EVERY valid
    // Claude restore as `unavailable`, which clears the thread's resume cursor
    // -- so a Claude thread silently lost its conversation on every
    // re-provision, with the archive sitting correctly extracted in the
    // container.
    const executor = successfulExecutor((command) =>
      command.args[0] === "exec" && command.args.includes("find")
        ? findAgainst(command, ["/thread-data/provider-home/.claude/projects"])
        : undefined,
    );
    const ready = await new ContainerSandboxBackend("docker", executor).ensureReady(
      input({
        bootstrap: {
          ...input().bootstrap,
          providerStorePath: "/artifacts/thread-1.store.tar",
        },
      }),
    );

    expect(ready.providerStore).toBe("restored");
  });

  it("still reports a restored store for Codex's sessions layout", async () => {
    // The Claude layout is accepted IN ADDITION to Codex's, not instead of it.
    const executor = successfulExecutor((command) =>
      command.args[0] === "exec" && command.args.includes("find")
        ? findAgainst(command, ["/thread-data/provider-home/.codex/sessions"])
        : undefined,
    );
    const ready = await new ContainerSandboxBackend("docker", executor).ensureReady(
      input({
        bootstrap: {
          ...input().bootstrap,
          providerStorePath: "/artifacts/thread-1.store.tar",
        },
      }),
    );

    expect(ready.providerStore).toBe("restored");
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
    // The sidecar is bounded like the workload: memory (with swap pinned to
    // it), cpu, and -- since the rootfs is --read-only -- a tmpfs for scratch.
    expect(proxy.args).toEqual(
      expect.arrayContaining([
        "--memory",
        "256m",
        "--memory-swap",
        "256m",
        "--cpus",
        "0.5",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,noexec,size=16m",
      ]),
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

  it("leaves nothing running when a stop lands in the middle of a provision", async () => {
    // A stop used to run straight past an in-flight provision: it tore down
    // whatever existed at that instant and returned, while the container,
    // sidecars, network, and volumes the provision created moments later
    // survived with nothing holding a reference to them. A forced deletion
    // looked complete while the workload was still up.
    // The provision parks inside its setup hook -- the container, network, and
    // both volumes exist by then and the record has not been published, which
    // is precisely the window the stop used to run through.
    let reachedSetupHook = () => {};
    const atSetupHook = new Promise<void>((resolve) => {
      reachedSetupHook = resolve;
    });
    let releaseSetupHook = () => {};
    const setupHookReleased = new Promise<void>((resolve) => {
      releaseSetupHook = resolve;
    });
    const respond = successfulExecutor().respond!;
    const executor = new (class extends FakeExecutor {
      override async run(command: SandboxCommand): Promise<SandboxCommandResult> {
        if (command.args[0] === "exec" && command.args.includes("provision-marker")) {
          this.commands.push(command);
          reachedSetupHook();
          await setupHookReleased;
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return super.run(command);
      }
    })(respond);
    const backend = new ContainerSandboxBackend("docker", executor);

    const provisioning = backend
      .ensureReady(input({ setup: [{ executable: "provision-marker" }] }))
      .then(
        (ready) => ({ ready, error: undefined }),
        (error: unknown) => ({ ready: undefined, error }),
      );
    await atSetupHook;
    // Issued while the provision is still inside the hook.
    const stopping = backend.stop("thread-1");
    releaseSetupHook();
    await stopping;
    const outcome = await provisioning;

    // The provision does not hand back a sandbox the deletion already
    // accounted for as gone.
    expect(outcome.ready).toBeUndefined();
    expect(String(outcome.error)).toContain("stopped while provisioning");
    // ...and every resource it created was reclaimed.
    const removals = executor.commands
      .filter(
        (command) =>
          (command.args[0] === "rm" && command.args[1] === "--force") ||
          ((command.args[0] === "network" || command.args[0] === "volume") &&
            command.args[1] === "rm"),
      )
      .map((command) => command.args.at(-1));
    expect(removals).toEqual(
      expect.arrayContaining([
        "t3-thread-921ca543f9cf4d28fe0b81d81cdb33b5",
        "t3-net-921ca543f9cf4d28fe0b81d81cdb33b5",
        "t3-workspace-921ca543f9cf4d28fe0b81d81cdb33b5",
        "t3-desktop-921ca543f9cf4d28fe0b81d81cdb33b5",
      ]),
    );
    // Nothing is left addressable: a later exec finds no record at all.
    await expect(backend.exec("thread-1", { executable: "true" })).rejects.toThrow("not ready");
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

  it("never removes its own workspace container as a sibling during stop", async () => {
    // The sibling listing filters on the exact labels the workspace container
    // carries, so the workspace container is always part of its own listing.
    // The exclusion used to compare the listed container ID against the
    // workspace NAME -- never equal -- so stop() force-removed its own
    // workspace container as a "sibling", the later cleanup `rm` by name
    // failed, and the thread wedged in `stopping`. Every prior stop test
    // stubbed `ps` as empty, which is exactly why this was missed.
    const base = successfulExecutor();
    const respond = base.respond!;
    const workspaceName = "t3-thread-921ca543f9cf4d28fe0b81d81cdb33b5";
    const workspaceId = "aaaa1111bbbb";
    const executor = new FakeExecutor((command) => {
      // Answer whichever `ps` format the implementation asked for, so a code
      // change that narrows the listing back to bare IDs still receives a
      // non-empty listing (and this test then catches the regression).
      if (command.args[0] === "ps") {
        const format = command.args.at(-1) ?? "";
        return {
          exitCode: 0,
          stdout: format.includes("{{.Names}}")
            ? `${workspaceId}\t${workspaceName}\n`
            : `${workspaceId}\n`,
          stderr: "",
        };
      }
      // The per-candidate label verification, confirming the listed container
      // really is this thread's -- which the workspace container is.
      if (command.args[0] === "inspect" && command.args.at(-1) === workspaceId)
        return { exitCode: 0, stdout: "thread-1\ttrue\n", stderr: "" };
      return respond(command);
    });
    const backend = new ContainerSandboxBackend("docker", executor);
    await backend.ensureReady(input());
    await backend.stop("thread-1");
    // The only container removal is cleanup's, by name. A second `rm` naming
    // the workspace ID is the sibling phase destroying its own container.
    expect(
      executor.commands
        .filter((command) => command.args[0] === "rm")
        .map((command) => command.args.at(-1)),
    ).toEqual([workspaceName]);
  });

  it("removes a genuine labeled sibling container during stop", async () => {
    const base = successfulExecutor();
    const respond = base.respond!;
    const workspaceName = "t3-thread-921ca543f9cf4d28fe0b81d81cdb33b5";
    const workspaceId = "aaaa1111bbbb";
    const siblingId = "cccc2222dddd";
    const executor = new FakeExecutor((command) => {
      if (command.args[0] === "ps") {
        const format = command.args.at(-1) ?? "";
        return {
          exitCode: 0,
          stdout: format.includes("{{.Names}}")
            ? `${workspaceId}\t${workspaceName}\n${siblingId}\tt3-svc-thread-1-db\n`
            : `${workspaceId}\n${siblingId}\n`,
          stderr: "",
        };
      }
      if (
        command.args[0] === "inspect" &&
        (command.args.at(-1) === siblingId || command.args.at(-1) === workspaceId)
      )
        return { exitCode: 0, stdout: "thread-1\ttrue\n", stderr: "" };
      return respond(command);
    });
    const backend = new ContainerSandboxBackend("docker", executor);
    await backend.ensureReady(input());
    await backend.stop("thread-1");
    expect(
      executor.commands
        .filter((command) => command.args[0] === "rm")
        .map((command) => command.args.at(-1)),
    ).toEqual([siblingId, workspaceName]);
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
      unresumableThreadIds: [],
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

  it("names the snapshot ref it was given rather than globbing the namespace", async () => {
    // A dirty tree's export pins a snapshot and hands its commit to the bundle.
    // The bundle names THAT ref: a glob over the namespace would also carry
    // every stale ref an earlier export left behind, which is what shipped
    // files the user had deleted whenever the cleanup failed.
    const executor = successfulExecutor();
    const backend = new ContainerSandboxBackend("docker", executor);
    await backend.ensureReady(input());
    const snapshotCommit = "d".repeat(40);
    await backend.exportBundle("thread-1", "/tmp/thread-1.bundle", { snapshotCommit });
    const bundled = executor.commands.find(
      (command) => command.args.includes("bundle") && command.args.includes("create"),
    );
    expect(bundled?.args.slice(-3)).toEqual([
      "/tmp/t3-thread-export.bundle",
      "refs/heads/thread/thread-1",
      `refs/t3/export-snapshot/${snapshotCommit}`,
    ]);
    expect(bundled?.args.some((argument) => argument.includes("--glob"))).toBe(false);
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
          // The thread branch alone for a clean tree, which pins no snapshot.
          // Neither `--all` nor a glob over the snapshot namespace: both put
          // an earlier export's snapshot -- and the files the user has since
          // deleted -- into this artifact, the glob whenever the cleanup that
          // was supposed to have removed those refs did not run or failed.
          // Asserted as the exact TAIL of the argv rather than a subset: a
          // subset match cannot see an extra ref appended after the branch,
          // which is precisely what the bug shipped.
          args: [
            "exec",
            "--user",
            "1000:1000",
            "--",
            "t3-thread-921ca543f9cf4d28fe0b81d81cdb33b5",
            "git",
            "-C",
            "/workspace/repo",
            "bundle",
            "create",
            "/tmp/t3-thread-export.bundle",
            "refs/heads/thread/thread-1",
          ],
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

  // A server restart empties the backend's in-memory records. Until these
  // cases existed, the adopt path had no coverage at all -- `successfulExecutor`
  // answers the bare `inspect` with exit 1 precisely so every other test takes
  // the create path.
  const ADOPTED_LABELS = [
    "thread-1",
    "project-1",
    "true",
    `sandbox@sha256:${"b".repeat(64)}`,
    "a".repeat(40),
    "thread/thread-1",
    "workspace",
    "true",
  ].join("\t");

  const hint = () => ({
    projectId: "project-1",
    image: `sandbox@sha256:${"b".repeat(64)}`,
    baseCommit: "a".repeat(40),
    branchName: "thread/thread-1",
  });

  function adoptedExecutor(labels = ADOPTED_LABELS) {
    return new FakeExecutor((command) => {
      if (command.args[0] === "inspect" && command.args[1] === "--format")
        return { exitCode: 0, stdout: `${labels}\n`, stderr: "" };
      // Same object for `rev-parse` and `write-tree`: a clean working tree, so
      // the export writes no working-tree snapshot.
      if (
        command.args[0] === "exec" &&
        (command.args.includes("rev-parse") || command.args.includes("write-tree"))
      )
        return { exitCode: 0, stdout: `${"c".repeat(40)}\n`, stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
  }

  it("exports a branch from a sandbox this process never provisioned", async () => {
    const executor = adoptedExecutor();
    const backend = new ContainerSandboxBackend("docker", executor);
    // No `ensureReady` -- this is the post-restart state exactly.
    const exported = await backend.exportBranch("thread-1", hint());
    expect(exported.commit).toBe("c".repeat(40));
    expect(
      executor.commands
        .filter((command) => command.args[0] === "exec")
        .every((command) => command.args.includes("t3-thread-921ca543f9cf4d28fe0b81d81cdb33b5")),
    ).toBe(true);
  });

  it("refuses to adopt a container whose labels do not match the thread", async () => {
    // Same derived name, different provenance: another thread's project, or a
    // container left over from an earlier base commit.
    const executor = adoptedExecutor(ADOPTED_LABELS.replace("project-1", "project-2"));
    const backend = new ContainerSandboxBackend("docker", executor);
    await expect(backend.exportBranch("thread-1", hint())).rejects.toThrow("not ready");
    await expect(
      backend.exportBundle("thread-1", "/tmp/thread-1.bundle", { hint: hint() }),
    ).rejects.toThrow("not ready");
    // Adoption never widens to resumption: `exec` has no hint parameter at all.
    await expect(backend.exec("thread-1", { executable: "true" })).rejects.toThrow("not ready");
    expect(executor.commands.some((command) => command.args[0] === "exec")).toBe(false);
  });

  it("tears down a sandbox this process never provisioned", async () => {
    const executor = new FakeExecutor((command) => {
      if (command.args[0] === "inspect" && command.args[1] === "--format")
        return { exitCode: 0, stdout: `${ADOPTED_LABELS}\n`, stderr: "" };
      // Whether an egress sidecar was ever provisioned is not recorded, so its
      // absence must not turn teardown into a failure.
      if (command.args.at(-1)?.startsWith("t3-egress-"))
        return { exitCode: 1, stdout: "", stderr: "no such container" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const backend = new ContainerSandboxBackend("docker", executor);
    await backend.stop("thread-1", [{ executable: "should-not-run" }], hint());
    expect(
      executor.commands
        .filter((command) => command.args[0] === "rm" || command.args[1] === "rm")
        .map((command) => command.args.at(-1)),
    ).toEqual([
      "t3-thread-921ca543f9cf4d28fe0b81d81cdb33b5",
      "t3-egress-921ca543f9cf4d28fe0b81d81cdb33b5",
      "t3-net-921ca543f9cf4d28fe0b81d81cdb33b5",
      "t3-egress-net-921ca543f9cf4d28fe0b81d81cdb33b5",
      "t3-workspace-921ca543f9cf4d28fe0b81d81cdb33b5",
      "t3-desktop-921ca543f9cf4d28fe0b81d81cdb33b5",
    ]);
    // The hook declarations died with the restart, so an adopted record runs
    // none of them rather than pretending it can.
    expect(executor.commands.some((command) => command.args.includes("should-not-run"))).toBe(
      false,
    );
  });

  it("does nothing for a thread with no record and no hint", async () => {
    const executor = adoptedExecutor();
    const backend = new ContainerSandboxBackend("docker", executor);
    await backend.stop("thread-1");
    expect(executor.commands).toEqual([]);
  });

  it("reports a label-verified survivor as unresumable rather than active", async () => {
    // A server restart empties `#records`, but the containers keep running.
    // Verifying the label signature proves the container is this thread's, and
    // is enough to export and tear it down -- but adoption is never cached, so
    // `exec`, `runtimeRef`, and checkpointing all still throw. Reporting it
    // active left the projection claiming `ready` for a sandbox in which
    // nothing could run. It is reported missing (so the thread fails and
    // re-provisions) AND unresumable (so a caller can stop it, exporting its
    // work, instead of abandoning the container).
    const workspaceName = "t3-thread-921ca543f9cf4d28fe0b81d81cdb33b5";
    const executor = new FakeExecutor((command) => {
      if (command.args[0] === "ps")
        return { exitCode: 0, stdout: "abcdef123456\tthread-1\tproject-1\n", stderr: "" };
      // The label-signature verification, addressed by the derived name.
      if (command.args[0] === "inspect" && command.args.at(-1) === workspaceName)
        return { exitCode: 0, stdout: `${ADOPTED_LABELS}\n`, stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const backend = new ContainerSandboxBackend("docker", executor);
    const result = await backend.reconcile({
      expectedThreadIds: new Set(["thread-1"]),
      removeOrphans: true,
      adoptionHints: new Map([["thread-1", hint()]]),
    });
    expect(result.activeThreadIds).toEqual([]);
    expect(result.unresumableThreadIds).toEqual(["thread-1"]);
    expect(result.missingThreadIds).toEqual(["thread-1"]);
    // Verified: not removed, so its commits are still exportable with a hint.
    expect(result.removedRuntimeRefs).toEqual([]);
    // Adoption never widens to resumption.
    await expect(backend.exec("thread-1", { executable: "true" })).rejects.toThrow("not ready");
    expect(backend.runtimeRef("thread-1")).toBeUndefined();
  });

  it("stops an expected container whose label signature cannot be verified", async () => {
    // Fail-closed both ways: the thread is still reported missing (nothing can
    // prove the container is safe to resume), AND the unverifiable container
    // is removed rather than left running unaccounted -- expected threads are
    // skipped by removeOrphans, so nothing else would ever reclaim it.
    const workspaceName = "t3-thread-921ca543f9cf4d28fe0b81d81cdb33b5";
    const executor = new FakeExecutor((command) => {
      if (command.args[0] === "ps")
        return { exitCode: 0, stdout: "abcdef123456\tthread-1\tproject-1\n", stderr: "" };
      // Signature check by name fails (another base commit's container)...
      if (command.args[0] === "inspect" && command.args.at(-1) === workspaceName)
        return {
          exitCode: 0,
          stdout: `${ADOPTED_LABELS.replace("a".repeat(40), "f".repeat(40))}\n`,
          stderr: "",
        };
      // ...but the managed-label check by id still confirms it is ours to stop.
      if (command.args[0] === "inspect" && command.args.at(-1) === "abcdef123456")
        return { exitCode: 0, stdout: "thread-1\ttrue\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const backend = new ContainerSandboxBackend("docker", executor);
    const result = await backend.reconcile({
      expectedThreadIds: new Set(["thread-1"]),
      removeOrphans: true,
      adoptionHints: new Map([["thread-1", hint()]]),
    });
    expect(result.activeThreadIds).toEqual([]);
    expect(result.missingThreadIds).toEqual(["thread-1"]);
    // Nothing proved this container is the thread's, so it is not exportable
    // either -- unresumable is for survivors worth stopping gracefully.
    expect(result.unresumableThreadIds).toEqual([]);
    expect(result.removedRuntimeRefs).toEqual(["abcdef123456"]);
    expect(
      executor.commands
        .filter((command) => command.args[0] === "rm")
        .map((command) => command.args.at(-1)),
    ).toEqual(["abcdef123456"]);
  });

  it("still adopts in-memory records without any hint", async () => {
    // The pre-restart path is unchanged: a record this generation provisioned
    // is adopted outright, no hint or extra inspect required.
    const executor = successfulExecutor((command) =>
      command.args[0] === "ps"
        ? { exitCode: 0, stdout: "abcdef123456\tthread-1\tproject-1\n", stderr: "" }
        : undefined,
    );
    const backend = new ContainerSandboxBackend("docker", executor);
    await backend.ensureReady(input());
    const result = await backend.reconcile({
      expectedThreadIds: new Set(["thread-1"]),
      removeOrphans: true,
    });
    expect(result.activeThreadIds).toEqual(["thread-1"]);
    expect(result.missingThreadIds).toEqual([]);
    // A record this generation holds is usable, so it is never unresumable.
    expect(result.unresumableThreadIds).toEqual([]);
    expect(backend.runtimeRef("thread-1")).toBe("t3-thread-921ca543f9cf4d28fe0b81d81cdb33b5");
  });
});
