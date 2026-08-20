// @effect-diagnostics nodeBuiltinImport:off - test creates a real scratch directory for the seed bundle.
import { describe, expect, it } from "@effect/vitest";
import { afterEach } from "vite-plus/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as NodeCrypto from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { SandboxId, ThreadId } from "@t3tools/contracts";
import { ContainerSandboxBackend } from "./ContainerSandboxBackend.ts";
import {
  provisionThreadCredentialProxy,
  resolveSandboxCredentialUpstreams,
  ThreadCredentialProxySidecar,
  threadCredentialProxyBinding,
  unregisterThreadCredentialProxySidecar,
  CREDENTIAL_PROXY_BASE_URL,
} from "./SandboxCredentialProxy.ts";
import { inImageProviderCommand, sandboxProviderInvocation } from "./SandboxProviderProcess.ts";
import { makeSandboxRuntimeManager, resolveSandboxRuntime } from "./SandboxRuntimeManager.ts";
import type {
  SandboxCommand,
  SandboxCommandExecutor,
  SandboxCommandResult,
  SandboxProvisionInput,
} from "./types.ts";

const SECRET = "sk-ant-oat01-test-only-not-a-real-token";
const PREVIEW_IMAGE = `preview@sha256:${"a".repeat(64)}`;
const CREDENTIAL_IMAGE = `credential@sha256:${"c".repeat(64)}`;
const SANDBOX_IMAGE = `sandbox@sha256:${"b".repeat(64)}`;

class FakeExecutor implements SandboxCommandExecutor {
  readonly commands: SandboxCommand[] = [];
  readonly #respond: (command: SandboxCommand) => SandboxCommandResult;
  constructor(respond?: (command: SandboxCommand) => SandboxCommandResult) {
    this.#respond = respond ?? defaultRespond;
  }
  async run(command: SandboxCommand): Promise<SandboxCommandResult> {
    this.commands.push(command);
    return this.#respond(command);
  }
}

function defaultRespond(command: SandboxCommand): SandboxCommandResult {
  if (command.args[0] === "info")
    return command.args.includes("{{.Host.Security.Rootless}}")
      ? { exitCode: 0, stdout: "true\n", stderr: "" }
      : { exitCode: 0, stdout: '["name=rootless"]', stderr: "" };
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
}

const provisionInput = (overrides: Partial<SandboxProvisionInput> = {}): SandboxProvisionInput => ({
  bootstrap: {
    threadId: "thread-headless",
    projectId: "project-1",
    repositoryUrl: "https://example.test/repository.git",
    baseCommit: "a".repeat(40),
    branchName: "thread/thread-headless",
  },
  image: SANDBOX_IMAGE,
  ...overrides,
});

const target = {
  kind: "sandbox" as const,
  threadId: ThreadId.make("thread-credential"),
  sandboxId: SandboxId.make("sandbox-a"),
  runtimeRef: "t3-thread-credential",
  runtime: "podman" as const,
  workspaceCwd: "/workspace/repo",
};

/** Restores every variable this suite touches so ordering cannot leak state. */
const MUTATED_ENV = [
  "T3_SANDBOX_DESKTOP",
  "T3_SANDBOX_PREVIEW_PROXY_IMAGE",
  "T3_SANDBOX_CREDENTIAL_PROXY_IMAGE",
  "T3_SANDBOX_CONTAINER_STORAGE_QUOTA",
  "T3_SANDBOX_GIT_USER_NAME",
  "T3_SANDBOX_GIT_USER_EMAIL",
  "T3_SANDBOX_ANTHROPIC_AUTH_TOKEN",
  "T3_SANDBOX_ANTHROPIC_API_KEY",
  "T3_SANDBOX_OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "T3_SANDBOX_RUNTIME",
] as const;
const originalEnv = new Map(MUTATED_ENV.map((key) => [key, process.env[key]] as const));

afterEach(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  unregisterThreadCredentialProxySidecar(target.threadId);
  unregisterThreadCredentialProxySidecar("thread-headless");
});

describe("headless sandbox provisioning", () => {
  it.effect("skips the desktop runtime while still starting the preview sidecar", () =>
    Effect.gen(function* () {
      process.env.T3_SANDBOX_DESKTOP = "disabled";
      process.env.T3_SANDBOX_PREVIEW_PROXY_IMAGE = PREVIEW_IMAGE;
      delete process.env.T3_SANDBOX_CREDENTIAL_PROXY_IMAGE;
      const executor = new FakeExecutor();
      const manager = makeSandboxRuntimeManager(undefined, "linux", executor);
      const ready = yield* manager.provision(provisionInput());

      // Headless readiness carries no desktop identifiers at all.
      expect(ready.desktopSessionId).toBeUndefined();
      expect(ready.desktopStreamPath).toBeUndefined();
      // No desktop process was ever launched or probed inside the container.
      const flattened = executor.commands.map((command) => command.args.join(" "));
      expect(
        flattened.some((line) => /tmux|startxfce4|chromium|t3-desktop-webrtc/.test(line)),
      ).toBe(false);
      // ...but the preview sidecar is unaffected by the desktop gate.
      expect(
        executor.commands.some(
          (command) => command.args[0] === "run" && command.args.includes("t3-preview-bridge"),
        ),
      ).toBe(true);
    }),
  );
});

describe("runtime selection", () => {
  it.effect("runs the deployment-default runtime when no thread config names one", () =>
    Effect.gen(function* () {
      process.env.T3_SANDBOX_PREVIEW_PROXY_IMAGE = PREVIEW_IMAGE;
      process.env.T3_SANDBOX_RUNTIME = "podman";
      const executor = new FakeExecutor();
      const manager = makeSandboxRuntimeManager(undefined, "linux", executor);

      // Callers validate the runtime but pass `config` through verbatim, and no
      // client populates `sandboxConfig.runtime` -- so the deployment default has
      // to survive all the way to the executed binary, not just the validation.
      yield* manager.provision(provisionInput());

      expect(executor.commands.length).toBeGreaterThan(0);
      expect([...new Set(executor.commands.map((command) => command.executable))]).toEqual([
        "podman",
      ]);
    }),
  );
});

describe("local repository seeding", () => {
  it.effect("bundles the base commit by a pinned ref instead of a bare SHA", () =>
    Effect.gen(function* () {
      process.env.T3_SANDBOX_PREVIEW_PROXY_IMAGE = PREVIEW_IMAGE;
      const artifactRoot = mkdtempSync(join(tmpdir(), "t3-sandbox-artifacts-"));
      const localRepoPath = "/var/lib/command-center/runtime/sandbox-canary-scratch/repo";
      const baseCommit = "d".repeat(40);
      const executor = new FakeExecutor();
      const manager = makeSandboxRuntimeManager(artifactRoot, "linux", executor);
      try {
        yield* manager.provision(
          provisionInput({
            bootstrap: {
              threadId: "thread-local-seed",
              projectId: "project-1",
              repositoryUrl: localRepoPath,
              baseCommit,
              branchName: "thread/thread-local-seed",
            },
          }),
        );

        const gitCommands = executor.commands.filter((command) => command.executable === "git");
        const pin = gitCommands.find(
          (command) => command.args.includes("update-ref") && !command.args.includes("-d"),
        );
        const created = gitCommands.find(
          (command) => command.args[2] === "bundle" && command.args[3] === "create",
        );
        const verified = gitCommands.find(
          (command) => command.args[2] === "bundle" && command.args[3] === "verify",
        );
        const unpin = gitCommands.find(
          (command) => command.args.includes("update-ref") && command.args.includes("-d"),
        );
        expect(pin).toBeDefined();
        expect(created).toBeDefined();
        expect(verified).toBeDefined();
        expect(unpin).toBeDefined();

        // `git bundle create` refuses a bare commit SHA ("Refusing to create empty
        // bundle") -- it must be given the pinned ref name, never the raw commit.
        const seedRef = pin!.args.at(-2)!;
        expect(seedRef).toMatch(/^refs\/t3-sandbox-seed\//);
        expect(pin!.args.at(-1)).toBe(baseCommit);
        expect(created!.args).toContain(seedRef);
        expect(created!.args).not.toContain(baseCommit);

        // Both bundle subcommands run against the source repository: `create` reads
        // the ref from it, and `verify` resolves the bundle's prerequisites against
        // it. Without `-C`, verify fails wherever the server's cwd happens to be.
        for (const command of [created!, verified!])
          expect(command.args.slice(0, 2)).toEqual(["-C", localRepoPath]);

        // The throwaway ref is deleted once the bundle exists, regardless of outcome.
        expect(unpin!.args.at(-1)).toBe(seedRef);
      } finally {
        rmSync(artifactRoot, { recursive: true, force: true });
      }
    }),
  );
});

describe("restoring a re-provisioned sandbox", () => {
  const BRANCH = "thread/thread-restore";
  const HEAD_COMMIT = "e".repeat(40);
  const ARTIFACT_ID = "f".repeat(64);

  /** Every `git ...` line the backend ran inside the container, in order. */
  const containerGitLines = (executor: FakeExecutor) =>
    executor.commands
      .filter((command) => command.args[0] === "exec" && command.args.includes("git"))
      .map((command) => command.args.slice(command.args.indexOf("git")).join(" "));

  const restoreInput = (bundleSha256: string) =>
    provisionInput({
      bootstrap: {
        threadId: "thread-restore",
        projectId: "project-1",
        repositoryUrl: "https://example.test/repository.git",
        baseCommit: "a".repeat(40),
        branchName: BRANCH,
      },
      restore: {
        artifactId: ARTIFACT_ID,
        bundleSha256,
        headCommit: HEAD_COMMIT,
        branchName: BRANCH,
      },
    });

  /** Artifact root holding one bundle whose real digest is returned alongside it. */
  const seedArtifact = () => {
    const artifactRoot = mkdtempSync(join(tmpdir(), "t3-sandbox-artifacts-"));
    const bundle = join(artifactRoot, `${ARTIFACT_ID}.bundle`);
    const bytes = Buffer.from("not a real bundle, but a real digest\n");
    writeFileSync(bundle, bytes, { mode: 0o600 });
    return {
      artifactRoot,
      bundle,
      sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    };
  };

  it.effect("seeds a re-provision from the branch bundle the last teardown exported", () =>
    Effect.gen(function* () {
      process.env.T3_SANDBOX_PREVIEW_PROXY_IMAGE = PREVIEW_IMAGE;
      const { artifactRoot, bundle, sha256 } = seedArtifact();
      const executor = new FakeExecutor();
      try {
        yield* makeSandboxRuntimeManager(artifactRoot, "linux", executor).provision(
          restoreInput(sha256),
        );

        // The exported bundle is copied in verbatim -- nothing is re-bundled
        // from the project repository, so the thread's own commits survive.
        const copied = executor.commands.find((command) => command.args[0] === "cp")!;
        expect(copied.args[1]).toBe(bundle);
        expect(copied.args[2]).toMatch(/:\/tmp\/t3-repository\.bundle$/);
        expect(
          executor.commands.some(
            (command) => command.args[2] === "bundle" && command.args[3] === "create",
          ),
        ).toBe(false);

        const git = containerGitLines(executor);
        // `exportBundle` writes `git bundle create --all`, so the thread branch
        // is in there under its ordinary heads ref and the fetch must name it:
        // a bundle fetch has no default refspec.
        expect(git).toContain(
          `git -C /workspace/repo fetch --no-tags /tmp/t3-repository.bundle refs/heads/${BRANCH}:refs/heads/${BRANCH}`,
        );
        // Checked out at the exported head, not at the recorded base commit.
        expect(git).toContain(`git -C /workspace/repo checkout --detach ${HEAD_COMMIT}`);
        // ...and `-C`, because that same bundle already carries the branch.
        expect(git).toContain(`git -C /workspace/repo switch -C ${BRANCH}`);
        expect(git.some((line) => line.startsWith("git clone"))).toBe(false);
      } finally {
        rmSync(artifactRoot, { recursive: true, force: true });
      }
    }),
  );

  it.effect("provisions from the project repository when the bundle fails its digest check", () =>
    Effect.gen(function* () {
      process.env.T3_SANDBOX_PREVIEW_PROXY_IMAGE = PREVIEW_IMAGE;
      const { artifactRoot } = seedArtifact();
      const executor = new FakeExecutor();
      try {
        // A tampered or truncated artifact must not fail the provision: losing
        // the previous session's commits is bad, refusing to give the user a
        // sandbox at all is worse.
        yield* makeSandboxRuntimeManager(artifactRoot, "linux", executor).provision(
          restoreInput("b".repeat(64)),
        );

        expect(executor.commands.some((command) => command.args[0] === "cp")).toBe(false);
        const git = containerGitLines(executor);
        expect(git).toContain(
          "git clone --no-checkout https://example.test/repository.git /workspace/repo",
        );
        expect(git).toContain(`git -C /workspace/repo checkout --detach ${"a".repeat(40)}`);
        expect(git).toContain(`git -C /workspace/repo switch -c ${BRANCH}`);
      } finally {
        rmSync(artifactRoot, { recursive: true, force: true });
      }
    }),
  );
});

describe("container run flags", () => {
  it("applies the disk quota by default and omits it when explicitly disabled", async () => {
    const withQuota = new FakeExecutor();
    delete process.env.T3_SANDBOX_CONTAINER_STORAGE_QUOTA;
    await new ContainerSandboxBackend("podman", withQuota).ensureReady(provisionInput());
    const defaultRun = withQuota.commands.find(
      (command) => command.args[0] === "run" && command.args.includes(SANDBOX_IMAGE),
    )!;
    expect(defaultRun.args).toEqual(
      expect.arrayContaining(["--storage-opt", `size=${20 * 1024 ** 3}`]),
    );
    // Both quota-bearing volume creates also carry `--opt o=size=...` by default.
    const defaultVolumeCreates = withQuota.commands.filter(
      (command) => command.args[0] === "volume" && command.args[1] === "create",
    );
    expect(defaultVolumeCreates).toHaveLength(2);
    for (const create of defaultVolumeCreates) expect(create.args).toContain("--opt");

    // `podman --remote` rejects `--storage-opt size=`; the opt-out drops both args.
    // Rootless podman also cannot administer XFS project quotas on volumes it
    // doesn't own the filesystem's namespace for, so the same opt-out must
    // drop `--opt o=size=...` from both volume creates -- otherwise they fail
    // outright ("Filesystem does not support Project Quota") instead of just
    // going unenforced.
    process.env.T3_SANDBOX_CONTAINER_STORAGE_QUOTA = "disabled";
    const withoutQuota = new FakeExecutor();
    await new ContainerSandboxBackend("podman", withoutQuota).ensureReady(provisionInput());
    const gatedRun = withoutQuota.commands.find(
      (command) => command.args[0] === "run" && command.args.includes(SANDBOX_IMAGE),
    )!;
    expect(gatedRun.args).not.toContain("--storage-opt");
    expect(gatedRun.args).toContain("--read-only");
    const gatedVolumeCreates = withoutQuota.commands.filter(
      (command) => command.args[0] === "volume" && command.args[1] === "create",
    );
    expect(gatedVolumeCreates).toHaveLength(2);
    for (const create of gatedVolumeCreates) expect(create.args).not.toContain("--opt");
    // No readback inspect for either volume when there is no quota to verify.
    expect(
      withoutQuota.commands.some(
        (command) => command.args[0] === "volume" && command.args[1] === "inspect",
      ),
    ).toBe(false);
  });

  it("configures a repo-local git identity right after the thread branch is created", async () => {
    process.env.T3_SANDBOX_GIT_USER_NAME = "Sandbox Bot";
    process.env.T3_SANDBOX_GIT_USER_EMAIL = "sandbox@example.test";
    const executor = new FakeExecutor();
    await new ContainerSandboxBackend("podman", executor).ensureReady(provisionInput());
    const gitCommands = executor.commands
      .filter((command) => command.args[0] === "exec" && command.args.includes("git"))
      .map((command) => command.args.slice(command.args.indexOf("git")).join(" "));
    const switchIndex = gitCommands.findIndex((line) => line.includes("switch -c"));
    const nameIndex = gitCommands.findIndex((line) => line.includes("config user.name"));
    const emailIndex = gitCommands.findIndex((line) => line.includes("config user.email"));
    expect(switchIndex).toBeGreaterThanOrEqual(0);
    expect(nameIndex).toBeGreaterThan(switchIndex);
    expect(emailIndex).toBeGreaterThan(switchIndex);
    // `-C /workspace/repo` keeps the identity local to the clone, never global.
    expect(gitCommands[nameIndex]).toBe("git -C /workspace/repo config user.name Sandbox Bot");
    expect(gitCommands[emailIndex]).toBe(
      "git -C /workspace/repo config user.email sandbox@example.test",
    );
  });

  it("leaves git unconfigured unless both identity variables are present", async () => {
    process.env.T3_SANDBOX_GIT_USER_NAME = "Sandbox Bot";
    delete process.env.T3_SANDBOX_GIT_USER_EMAIL;
    const executor = new FakeExecutor();
    await new ContainerSandboxBackend("podman", executor).ensureReady(provisionInput());
    expect(executor.commands.some((command) => command.args.includes("config"))).toBe(false);
  });
});

describe("thread-scoped credential proxy", () => {
  it("keeps the real secret out of every run --env and out of the workspace exec", async () => {
    process.env.T3_SANDBOX_ANTHROPIC_AUTH_TOKEN = SECRET;
    const executor = new FakeExecutor();
    const sidecar = new ThreadCredentialProxySidecar("podman", executor);
    await sidecar.start(target.threadId, "t3-net-abc", CREDENTIAL_IMAGE, true);
    await provisionThreadCredentialProxy(target.threadId);

    // 1. The secret is nowhere in any container launch.
    const runCommands = executor.commands.filter((command) => command.args[0] === "run");
    expect(runCommands.length).toBeGreaterThan(0);
    for (const command of runCommands) expect(command.args.join(" ")).not.toContain(SECRET);

    // 2. It reaches the sidecar only over exec stdin, in the shared document shape.
    const push = executor.commands.find(
      (command) => command.args[0] === "exec" && command.stdin !== undefined,
    )!;
    expect(push.args).toEqual(
      expect.arrayContaining([
        "--interactive",
        "sh",
        "-c",
        "umask 077; cat > /tmp/credential.json",
      ]),
    );
    expect(push.args.join(" ")).not.toContain(SECRET);
    const document = JSON.parse(push.stdin!);
    expect(document.upstreams).toEqual([
      {
        name: "anthropic",
        baseUrl: "https://api.anthropic.com",
        inject: [{ header: "authorization", value: `Bearer ${SECRET}` }],
        stripRequestHeaders: ["x-api-key"],
      },
    ]);
    expect(typeof document.threadToken).toBe("string");
    expect(document.threadToken).not.toContain(SECRET);

    // 3. The workspace exec receives the proxy URL and the opaque thread token only.
    // Both credential shapes are offered here, including the bearer key the
    // proxy itself injects, to prove the host copies are dropped rather than
    // passed through under a name the injection happens to share.
    const invocation = sandboxProviderInvocation(target, "claude", [], undefined, {
      ANTHROPIC_API_KEY: SECRET,
      ANTHROPIC_AUTH_TOKEN: SECRET,
    });
    expect(JSON.stringify(invocation)).not.toContain(SECRET);
    expect(invocation.env.ANTHROPIC_BASE_URL).toBe(`${CREDENTIAL_PROXY_BASE_URL}/anthropic`);
    expect(invocation.env.ANTHROPIC_AUTH_TOKEN).toBe(document.threadToken);
    expect(invocation.env.ANTHROPIC_API_KEY).toBeUndefined();
    // Values still travel by name only; podman reads them from our own env.
    expect(invocation.args).toEqual(
      expect.arrayContaining(["--env", "ANTHROPIC_BASE_URL", "--env", "ANTHROPIC_AUTH_TOKEN"]),
    );
    expect(invocation.args.join(" ")).not.toContain(document.threadToken);
  });

  it("keeps the secret out of the workspace exec when no proxy is bound", () => {
    // The unbound path has no deletion step, so containment rests entirely on
    // the fail-closed throw. Nothing is returned to leak.
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) {
      let leaked: string | undefined;
      try {
        leaked = JSON.stringify(
          sandboxProviderInvocation(target, "claude", [], undefined, { [key]: SECRET }),
        );
      } catch (error) {
        expect(String(error)).not.toContain(SECRET);
      }
      expect(leaked).toBeUndefined();
    }
  });

  it("drops a host Anthropic token even when only an openai upstream is bound", async () => {
    // An openai-only binding injects nothing for Anthropic, so a host token
    // would survive unless persistent keys are dropped unconditionally.
    delete process.env.T3_SANDBOX_ANTHROPIC_AUTH_TOKEN;
    delete process.env.T3_SANDBOX_ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.T3_SANDBOX_OPENAI_API_KEY = SECRET;
    const sidecar = new ThreadCredentialProxySidecar("podman", new FakeExecutor());
    await sidecar.start(target.threadId, "t3-net-abc", CREDENTIAL_IMAGE, true);
    await provisionThreadCredentialProxy(target.threadId);
    expect(threadCredentialProxyBinding(target.threadId)!.upstreamNames).toEqual(["openai"]);

    const invocation = sandboxProviderInvocation(target, "claude", [], undefined, {
      ANTHROPIC_AUTH_TOKEN: SECRET,
      ANTHROPIC_API_KEY: SECRET,
    });
    expect(JSON.stringify(invocation)).not.toContain(SECRET);
    expect(invocation.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(invocation.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(invocation.env.OPENAI_BASE_URL).toBe(`${CREDENTIAL_PROXY_BASE_URL}/openai`);
  });

  it("refuses to start without the egress sidecar it must chain through", async () => {
    const executor = new FakeExecutor();
    await expect(
      new ThreadCredentialProxySidecar("podman", executor).start(
        target.threadId,
        "t3-net-abc",
        CREDENTIAL_IMAGE,
        false,
      ),
    ).rejects.toThrow("requires the egress sidecar");
    expect(executor.commands).toHaveLength(0);
  });

  it("fails provisioning with an actionable error when no credential is configured", async () => {
    for (const key of MUTATED_ENV)
      if (key.includes("TOKEN") || key.includes("KEY")) delete process.env[key];
    const sidecar = new ThreadCredentialProxySidecar("podman", new FakeExecutor());
    await sidecar.start(target.threadId, "t3-net-abc", CREDENTIAL_IMAGE, true);
    await expect(provisionThreadCredentialProxy(target.threadId)).rejects.toThrow(
      "claude setup-token",
    );
    expect(threadCredentialProxyBinding(target.threadId)).toBeUndefined();
  });

  it("prefers a bearer setup-token but accepts a plain api key", () => {
    process.env.T3_SANDBOX_ANTHROPIC_AUTH_TOKEN = SECRET;
    process.env.T3_SANDBOX_ANTHROPIC_API_KEY = "api-key-value";
    expect(resolveSandboxCredentialUpstreams()).toEqual([
      expect.objectContaining({ inject: [{ header: "authorization", value: `Bearer ${SECRET}` }] }),
    ]);
    delete process.env.T3_SANDBOX_ANTHROPIC_AUTH_TOKEN;
    expect(resolveSandboxCredentialUpstreams()).toEqual([
      expect.objectContaining({ inject: [{ header: "x-api-key", value: "api-key-value" }] }),
    ]);
  });
});

describe("provider spawn boundary", () => {
  it("fails closed on every persistent credential when no proxy is bound", () => {
    // `ANTHROPIC_AUTH_TOKEN` is what `claude setup-token` mints, so a host copy
    // of it is a real long-lived credential and must not reach the sandbox
    // merely because the proxy path happens to set the same key name.
    for (const key of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
      "CODEX_TOKEN",
    ]) {
      expect(() =>
        sandboxProviderInvocation(target, "claude", [], undefined, { [key]: SECRET }),
      ).toThrow("thread-scoped credential proxy");
    }
  });

  it("forwards non-credential proxy env keys without a binding", () => {
    // Base URLs carry no secret, so they are not part of the fail-closed set.
    const anthropicUrl = `${CREDENTIAL_PROXY_BASE_URL}/anthropic`;
    const openaiUrl = `${CREDENTIAL_PROXY_BASE_URL}/openai`;
    const invocation = sandboxProviderInvocation(target, "claude", [], undefined, {
      ANTHROPIC_BASE_URL: anthropicUrl,
      OPENAI_BASE_URL: openaiUrl,
    });
    expect(invocation.env.ANTHROPIC_BASE_URL).toBe(anthropicUrl);
    expect(invocation.env.OPENAI_BASE_URL).toBe(openaiUrl);
  });

  it("injects the thread token only on a real binding, not from host env", async () => {
    process.env.T3_SANDBOX_ANTHROPIC_AUTH_TOKEN = SECRET;
    const sidecar = new ThreadCredentialProxySidecar("podman", new FakeExecutor());
    await sidecar.start(target.threadId, "t3-net-abc", CREDENTIAL_IMAGE, true);
    await provisionThreadCredentialProxy(target.threadId);
    const binding = threadCredentialProxyBinding(target.threadId)!;

    const invocation = sandboxProviderInvocation(target, "claude", [], undefined, {});
    expect(invocation.env.ANTHROPIC_BASE_URL).toBe(`${CREDENTIAL_PROXY_BASE_URL}/anthropic`);
    // The injected value is the opaque per-thread token, never the real secret.
    expect(invocation.env.ANTHROPIC_AUTH_TOKEN).toBe(binding.threadToken);
    expect(invocation.env.ANTHROPIC_AUTH_TOKEN).not.toBe(SECRET);
  });

  it("substitutes the in-image command name for a host binary path", () => {
    // Host paths do not exist inside the image, so a sandbox exec uses the bare name.
    expect(inImageProviderCommand("/usr/local/bin/claude")).toBe("claude");
    expect(inImageProviderCommand("/opt/nvm/versions/node/v22/bin/codex")).toBe("codex");
    expect(inImageProviderCommand("claude")).toBe("claude");
    // Anything unrecognized is passed through so a wrong exec fails loudly.
    expect(inImageProviderCommand("/usr/local/bin/opencode")).toBe("/usr/local/bin/opencode");
    const invocation = sandboxProviderInvocation(
      target,
      "/usr/local/bin/claude",
      ["--print"],
      undefined,
      {},
    );
    expect(invocation.args).toEqual(
      expect.arrayContaining(["--", target.runtimeRef, "claude", "--print"]),
    );
    expect(invocation.args).not.toContain("/usr/local/bin/claude");
  });
});

describe("deployment runtime default", () => {
  it("defaults to docker, honors T3_SANDBOX_RUNTIME, and passes typos through to validation", () => {
    delete process.env.T3_SANDBOX_RUNTIME;
    expect(resolveSandboxRuntime()).toBe("docker");
    process.env.T3_SANDBOX_RUNTIME = "podman";
    expect(resolveSandboxRuntime()).toBe("podman");
    // An explicit per-thread runtime still wins over the deployment default.
    expect(threadRuntime("docker")).toBe("docker");
    // A typo is returned verbatim so the reactor's docker/podman check rejects it.
    process.env.T3_SANDBOX_RUNTIME = "podmn";
    expect(resolveSandboxRuntime()).toBe("podmn");
    expect(isSupportedRuntime(resolveSandboxRuntime())).toBe(false);
  });
});

/** Mirrors the reactor's precedence: per-thread config, then deployment default. */
const threadRuntime = (configured: string | undefined) => configured ?? resolveSandboxRuntime();
const isSupportedRuntime = (runtime: string) => runtime === "docker" || runtime === "podman";
