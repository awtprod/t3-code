// @effect-diagnostics nodeBuiltinImport:off - the round trip is only meaningful against real git and a real artifact directory.
import { describe, expect, it } from "@effect/vitest";
import { afterEach } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

import { makeSandboxRuntimeManager } from "./SandboxRuntimeManager.ts";
import type { SandboxCommand, SandboxCommandExecutor, SandboxCommandResult } from "./types.ts";

const PREVIEW_IMAGE = `preview@sha256:${"a".repeat(64)}`;
const SANDBOX_IMAGE = `sandbox@sha256:${"b".repeat(64)}`;
const THREAD_ID = "thread-roundtrip";

const scratch: string[] = [];
const makeDirectory = (prefix: string) => {
  const path = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  scratch.push(path);
  return path;
};

const MUTATED_ENV = ["T3_SANDBOX_DESKTOP", "T3_SANDBOX_PREVIEW_PROXY_IMAGE"] as const;
const originalEnv = new Map(MUTATED_ENV.map((key) => [key, process.env[key]] as const));

afterEach(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  while (scratch.length > 0) NodeFS.rmSync(scratch.pop()!, { recursive: true, force: true });
});

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Sandbox",
  GIT_AUTHOR_EMAIL: "sandbox@example.test",
  GIT_COMMITTER_NAME: "Sandbox",
  GIT_COMMITTER_EMAIL: "sandbox@example.test",
} as const;

const git = (cwd: string, ...args: string[]) => {
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...GIT_IDENTITY },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
};

/**
 * A container the fake runtime "runs": a directory standing in for the
 * container's filesystem, with real git executing inside it.
 *
 * The export/restore round trip is a sequence of git plumbing commands whose
 * whole point is which bytes survive. A responder that returns canned output
 * would assert the argv and prove nothing about the files, so this executor
 * runs the commands for real against mapped paths.
 */
class GitBackedExecutor implements SandboxCommandExecutor {
  readonly commands: SandboxCommand[] = [];
  readonly root: string;
  constructor() {
    this.root = makeDirectory("t3-sandbox-fs-");
    for (const directory of ["workspace", "thread-data", "tmp"])
      NodeFS.mkdirSync(NodePath.join(this.root, directory), { recursive: true });
  }
  /** Container absolute paths resolve inside this fake container's root. */
  #map(value: string): string {
    return /^\/(?:workspace|thread-data|tmp)(?:\/|$)/.test(value)
      ? NodePath.join(this.root, value)
      : value;
  }
  get repository(): string {
    return NodePath.join(this.root, "workspace/repo");
  }
  async run(command: SandboxCommand): Promise<SandboxCommandResult> {
    this.commands.push(command);
    const args = [...command.args];
    const [verb] = args;
    if (verb === "info") return { exitCode: 0, stdout: '["name=rootless"]', stderr: "" };
    if (verb === "inspect" && args.length === 2)
      return { exitCode: 1, stdout: "", stderr: "no such container" };
    if (verb === "volume" && args[1] === "inspect") {
      const name = args.at(-1) ?? "";
      if (name.startsWith("t3-cache-")) return { exitCode: 1, stdout: "", stderr: "missing" };
      const bytes = name.startsWith("t3-desktop-")
        ? Math.max(256 * 1024 ** 2, Math.floor(20 * 1024 ** 3 * 0.1))
        : Math.floor(20 * 1024 ** 3 * 0.9);
      return { exitCode: 0, stdout: `size=${bytes}\n`, stderr: "" };
    }
    if (verb === "cp") {
      const [source, destination] = [args[1] ?? "", args[2] ?? ""];
      // Only the `container:/path` side is mapped into the fake container
      // root; the other side is a real host path (the artifact directory,
      // which also lives under /tmp).
      const strip = (value: string) =>
        value.includes(":") ? this.#map(value.slice(value.indexOf(":") + 1)) : value;
      const to = strip(destination);
      NodeFS.mkdirSync(NodePath.dirname(to), { recursive: true });
      NodeFS.copyFileSync(strip(source), to);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (verb === "exec") return this.#exec(command, args);
    // Seed-bundle creation runs git on the host, outside the container.
    if (command.executable === "git") return this.#spawn("git", args, {}, command.stdin);
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  #exec(command: SandboxCommand, args: string[]): SandboxCommandResult {
    const separator = args.indexOf("--");
    const environment: Record<string, string> = {};
    for (let index = 0; index < separator; index += 1) {
      if (args[index] !== "--env") continue;
      const [key, ...rest] = (args[index + 1] ?? "").split("=");
      if (key) environment[key] = this.#map(rest.join("="));
    }
    const workdirAt = args.indexOf("--workdir");
    // args[separator + 1] is the container name.
    const [executable, ...rest] = args.slice(separator + 2);
    return this.#spawn(
      executable ?? "",
      rest.map((value) => this.#map(value)),
      environment,
      command.stdin,
      workdirAt === -1 ? undefined : this.#map(args[workdirAt + 1] ?? ""),
    );
  }
  #spawn(
    executable: string,
    args: ReadonlyArray<string>,
    environment: Record<string, string>,
    stdin?: string,
    cwd?: string,
  ): SandboxCommandResult {
    const result = NodeChildProcess.spawnSync(executable, args, {
      encoding: "utf8",
      ...(cwd === undefined ? {} : { cwd }),
      ...(stdin === undefined ? {} : { input: stdin }),
      env: { ...process.env, ...GIT_IDENTITY, ...environment },
    });
    return {
      exitCode: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? String(result.error ?? ""),
    };
  }
}

const headless = () => {
  process.env.T3_SANDBOX_DESKTOP = "disabled";
  process.env.T3_SANDBOX_PREVIEW_PROXY_IMAGE = PREVIEW_IMAGE;
};

/** A source repository with one commit, standing in for the project checkout. */
const sourceRepository = () => {
  const path = makeDirectory("t3-sandbox-src-");
  git(path, "init", "--quiet", "--initial-branch=main", ".");
  git(path, "config", "user.name", "Source");
  git(path, "config", "user.email", "source@example.test");
  NodeFS.writeFileSync(NodePath.join(path, "tracked.txt"), "first line\n", "utf8");
  git(path, "add", "-A");
  git(path, "commit", "--quiet", "-m", "base");
  return { path, baseCommit: git(path, "rev-parse", "HEAD").trim() };
};

const provisionInput = (repositoryUrl: string, baseCommit: string) => ({
  bootstrap: {
    threadId: THREAD_ID,
    projectId: "project-1",
    repositoryUrl,
    baseCommit,
    branchName: `thread/${THREAD_ID}`,
  },
  image: SANDBOX_IMAGE,
});

describe("sandbox export round trip", () => {
  it.effect("carries dirty and untracked work across a settle and restore", () =>
    Effect.gen(function* () {
      // The failure this covers destroyed user work silently: an automatic
      // settle exported only the branch bundle, and everything the user had
      // edited or newly created without committing was gone when the thread
      // came back.
      headless();
      const artifacts = makeDirectory("t3-sandbox-artifacts-");
      const source = sourceRepository();

      const first = new GitBackedExecutor();
      const manager = makeSandboxRuntimeManager(artifacts, "linux", first);
      yield* manager.provision(provisionInput(source.path, source.baseCommit));

      // A commit the user made, plus work they had not committed.
      NodeFS.writeFileSync(
        NodePath.join(first.repository, "tracked.txt"),
        "first line\ncommitted line\n",
        "utf8",
      );
      git(first.repository, "add", "-A");
      git(first.repository, "commit", "--quiet", "-m", "committed work");
      NodeFS.appendFileSync(NodePath.join(first.repository, "tracked.txt"), "dirty line\n", "utf8");
      NodeFS.mkdirSync(NodePath.join(first.repository, "notes"), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(first.repository, "notes/scratch.md"),
        "untracked note\n",
        "utf8",
      );

      const exported = yield* manager.exportBranch("docker", THREAD_ID);
      expect(exported.snapshotCommit).toMatch(/^[0-9a-f]{40,64}$/);

      // A fresh manager and container: the thread was torn down and comes back
      // on the next turn, seeded from the artifact set alone.
      const second = new GitBackedExecutor();
      yield* makeSandboxRuntimeManager(artifacts, "linux", second).provision({
        ...provisionInput(source.path, source.baseCommit),
        restore: {
          artifactId: exported.artifactId,
          bundleSha256: exported.bundleSha256,
          headCommit: exported.commit,
          branchName: `thread/${THREAD_ID}`,
          // What the decider records on `lastExport`; restore refuses to unpack
          // any snapshot that is not this exact commit.
          ...(exported.snapshotCommit === undefined
            ? {}
            : { snapshotCommit: exported.snapshotCommit }),
        },
      });

      expect(NodeFS.readFileSync(NodePath.join(second.repository, "tracked.txt"), "utf8")).toBe(
        "first line\ncommitted line\ndirty line\n",
      );
      expect(
        NodeFS.readFileSync(NodePath.join(second.repository, "notes/scratch.md"), "utf8"),
      ).toBe("untracked note\n");
      // The branch still points at the exported head, and the carried work is
      // uncommitted exactly as the user left it -- not silently staged, and not
      // committed on their behalf.
      expect(git(second.repository, "rev-parse", "HEAD").trim()).toBe(exported.commit);
      expect(git(second.repository, "status", "--porcelain")).toBe(" M tracked.txt\n?? notes/\n");
      // The transport ref does not survive into the user's repository.
      expect(
        NodeChildProcess.spawnSync("git", ["rev-parse", "--verify", "refs/t3/export-snapshot"], {
          cwd: second.repository,
          encoding: "utf8",
        }).status,
      ).not.toBe(0);
    }),
  );

  it.effect("restores a clean sandbox without a snapshot", () =>
    Effect.gen(function* () {
      // Nothing uncommitted means no snapshot commit and nothing to unpack;
      // the restore must still land on the exported head rather than fail
      // looking for a ref the bundle never named.
      headless();
      const artifacts = makeDirectory("t3-sandbox-artifacts-");
      const source = sourceRepository();

      const first = new GitBackedExecutor();
      const manager = makeSandboxRuntimeManager(artifacts, "linux", first);
      yield* manager.provision(provisionInput(source.path, source.baseCommit));
      NodeFS.writeFileSync(
        NodePath.join(first.repository, "tracked.txt"),
        "first line\ncommitted only\n",
        "utf8",
      );
      git(first.repository, "add", "-A");
      git(first.repository, "commit", "--quiet", "-m", "committed work");

      const exported = yield* manager.exportBranch("docker", THREAD_ID);
      expect(exported.snapshotCommit).toBeUndefined();

      const second = new GitBackedExecutor();
      yield* makeSandboxRuntimeManager(artifacts, "linux", second).provision({
        ...provisionInput(source.path, source.baseCommit),
        restore: {
          artifactId: exported.artifactId,
          bundleSha256: exported.bundleSha256,
          headCommit: exported.commit,
          branchName: `thread/${THREAD_ID}`,
          // What the decider records on `lastExport`; restore refuses to unpack
          // any snapshot that is not this exact commit.
          ...(exported.snapshotCommit === undefined
            ? {}
            : { snapshotCommit: exported.snapshotCommit }),
        },
      });

      expect(git(second.repository, "rev-parse", "HEAD").trim()).toBe(exported.commit);
      expect(git(second.repository, "status", "--porcelain")).toBe("");
    }),
  );

  it.effect("a later clean export does not resurrect an earlier snapshot", () =>
    Effect.gen(function* () {
      // Threads export more than once. If the ref from an export with dirty
      // work survived into a later, clean export's bundle, restore would put
      // files back that the user had since deleted.
      headless();
      const artifacts = makeDirectory("t3-sandbox-artifacts-");
      const source = sourceRepository();

      const first = new GitBackedExecutor();
      const manager = makeSandboxRuntimeManager(artifacts, "linux", first);
      yield* manager.provision(provisionInput(source.path, source.baseCommit));
      NodeFS.writeFileSync(NodePath.join(first.repository, "notes.md"), "temporary note\n", "utf8");
      expect((yield* manager.exportBranch("docker", THREAD_ID)).snapshotCommit).toBeDefined();

      NodeFS.rmSync(NodePath.join(first.repository, "notes.md"));
      const exported = yield* manager.exportBranch("docker", THREAD_ID);
      expect(exported.snapshotCommit).toBeUndefined();

      const second = new GitBackedExecutor();
      yield* makeSandboxRuntimeManager(artifacts, "linux", second).provision({
        ...provisionInput(source.path, source.baseCommit),
        restore: {
          artifactId: exported.artifactId,
          bundleSha256: exported.bundleSha256,
          headCommit: exported.commit,
          branchName: `thread/${THREAD_ID}`,
          // What the decider records on `lastExport`; restore refuses to unpack
          // any snapshot that is not this exact commit.
          ...(exported.snapshotCommit === undefined
            ? {}
            : { snapshotCommit: exported.snapshotCommit }),
        },
      });

      expect(NodeFS.existsSync(NodePath.join(second.repository, "notes.md"))).toBe(false);
    }),
  );

  it.effect("refuses a snapshot ref that is not the one the export recorded", () =>
    Effect.gen(function* () {
      // The ref deletion an export performs can fail, and the snapshot used to
      // live under one fixed name -- so a stale ref rode out in the next
      // bundle and restore unpacked an OLD working tree over the user's newer
      // state, silently. Restore now takes the commit from the event log and
      // unpacks nothing else.
      headless();
      const artifacts = makeDirectory("t3-sandbox-artifacts-");
      const source = sourceRepository();

      const first = new GitBackedExecutor();
      const manager = makeSandboxRuntimeManager(artifacts, "linux", first);
      yield* manager.provision(provisionInput(source.path, source.baseCommit));
      NodeFS.writeFileSync(
        NodePath.join(first.repository, "stale.md"),
        "work the user later deleted\n",
        "utf8",
      );
      const stale = yield* manager.exportBranch("docker", THREAD_ID);
      expect(stale.snapshotCommit).toBeDefined();

      // The user deletes that file and exports again. This bundle still
      // carries the earlier snapshot ref -- as it would after a failed ref
      // deletion -- but the export recorded no snapshot of its own.
      NodeFS.rmSync(NodePath.join(first.repository, "stale.md"));
      git(
        first.repository,
        "update-ref",
        `refs/t3/export-snapshot/${stale.snapshotCommit!}`,
        stale.snapshotCommit!,
      );
      const exported = yield* manager.exportBranch("docker", THREAD_ID);
      expect(exported.snapshotCommit).toBeUndefined();

      const second = new GitBackedExecutor();
      yield* makeSandboxRuntimeManager(artifacts, "linux", second).provision({
        ...provisionInput(source.path, source.baseCommit),
        restore: {
          artifactId: exported.artifactId,
          bundleSha256: exported.bundleSha256,
          headCommit: exported.commit,
          branchName: `thread/${THREAD_ID}`,
        },
      });

      // The deleted file stays deleted, and the working tree is exactly what
      // the export actually captured.
      expect(NodeFS.existsSync(NodePath.join(second.repository, "stale.md"))).toBe(false);
      expect(git(second.repository, "status", "--porcelain")).toBe("");
      // The stale ref does not survive into the user's repository either.
      expect(
        NodeChildProcess.spawnSync("git", ["for-each-ref", "refs/t3/export-snapshot"], {
          cwd: second.repository,
          encoding: "utf8",
        }).stdout,
      ).toBe("");
    }),
  );

  it.effect("fails the restore when the recorded snapshot is not in the bundle", () =>
    Effect.gen(function* () {
      // The mirror of the export-side failure, and it was silent: a restore
      // whose event log records a snapshot commit, against a bundle that no
      // longer carries it (a truncated or rewritten artifact, a fetch that
      // dropped the ref), resolved to `undefined` -- indistinguishable from a
      // clean export -- and provisioned the branch head alone. The dirty and
      // untracked work the log says exists was gone, with nothing said.
      headless();
      const artifacts = makeDirectory("t3-sandbox-artifacts-");
      const source = sourceRepository();

      const first = new GitBackedExecutor();
      const manager = makeSandboxRuntimeManager(artifacts, "linux", first);
      yield* manager.provision(provisionInput(source.path, source.baseCommit));
      NodeFS.appendFileSync(
        NodePath.join(first.repository, "tracked.txt"),
        "work the log says exists\n",
        "utf8",
      );
      const exported = yield* manager.exportBranch("docker", THREAD_ID);
      expect(exported.snapshotCommit).toBeDefined();

      // Rewrite the published artifact as a branch-only bundle, exactly what a
      // truncated or re-written one looks like from the restore side, and hand
      // over its real digest so the restore gets past the integrity check and
      // reaches the snapshot resolution this covers.
      const bundle = NodePath.join(artifacts, `${exported.artifactId}.bundle`);
      const rebuild = makeDirectory("t3-sandbox-rebundle-");
      git(rebuild, "init", "--quiet", "--bare", ".");
      git(
        rebuild,
        "fetch",
        bundle,
        `refs/heads/thread/${THREAD_ID}:refs/heads/thread/${THREAD_ID}`,
      );
      git(rebuild, "bundle", "create", bundle, `refs/heads/thread/${THREAD_ID}`);
      const rewrittenSha256 = NodeCrypto.createHash("sha256")
        .update(NodeFS.readFileSync(bundle))
        .digest("hex");

      const second = new GitBackedExecutor();
      const failure = yield* makeSandboxRuntimeManager(artifacts, "linux", second)
        .provision({
          ...provisionInput(source.path, source.baseCommit),
          restore: {
            artifactId: exported.artifactId,
            bundleSha256: rewrittenSha256,
            headCommit: exported.commit,
            branchName: `thread/${THREAD_ID}`,
            snapshotCommit: exported.snapshotCommit!,
          },
        })
        .pipe(Effect.flip);

      // Named, so the operator can find the commit in the artifact themselves
      // rather than being told only that something went wrong.
      expect(failure.message).toContain(exported.snapshotCommit!);
      expect(failure.message).toContain("working-tree snapshot");
    }),
  );

  it.effect("fails the restore when the snapshot refs cannot be listed", () =>
    Effect.gen(function* () {
      // The same silent degradation by the other route: the ref listing itself
      // failing returned `undefined` too, so a broken container was
      // indistinguishable from an export that had nothing uncommitted, and the
      // provision continued from the branch head.
      headless();
      const artifacts = makeDirectory("t3-sandbox-artifacts-");
      const source = sourceRepository();

      const first = new GitBackedExecutor();
      const manager = makeSandboxRuntimeManager(artifacts, "linux", first);
      yield* manager.provision(provisionInput(source.path, source.baseCommit));
      NodeFS.writeFileSync(
        NodePath.join(first.repository, "scratch.md"),
        "untracked work the log says exists\n",
        "utf8",
      );
      const exported = yield* manager.exportBranch("docker", THREAD_ID);
      expect(exported.snapshotCommit).toBeDefined();

      // Only the resolution listing, which is the one asking for object names;
      // the plain `%(refname)` listing the deletion helper runs is untouched.
      class BrokenRefListingExecutor extends GitBackedExecutor {
        override async run(command: SandboxCommand): Promise<SandboxCommandResult> {
          return command.args.includes("for-each-ref") &&
            command.args.some((value) => value.includes("%(objectname)"))
            ? { exitCode: 128, stdout: "", stderr: "fatal: not a git repository" }
            : super.run(command);
        }
      }
      const second = new BrokenRefListingExecutor();
      const failure = yield* makeSandboxRuntimeManager(artifacts, "linux", second)
        .provision({
          ...provisionInput(source.path, source.baseCommit),
          restore: {
            artifactId: exported.artifactId,
            bundleSha256: exported.bundleSha256,
            headCommit: exported.commit,
            branchName: `thread/${THREAD_ID}`,
            snapshotCommit: exported.snapshotCommit!,
          },
        })
        .pipe(Effect.flip);

      expect(failure.message).toContain(exported.snapshotCommit!);
      expect(failure.message).toContain("working-tree snapshot");
    }),
  );

  it.effect("does not carry a file deleted after an earlier export into a later bundle", () =>
    Effect.gen(function* () {
      // A data-retention bug, not just wasted bytes. Every export pins its
      // working tree under a ref named by its own commit, and the bundle was
      // written with `--all` -- so every snapshot an earlier export left behind
      // rode out in every LATER bundle. A secret the user wrote, exported, and
      // then deleted was still sitting in the newest artifact, which is
      // supposed to represent current state and is what the retention sweep
      // ages out.
      //
      // Read against the bundle bytes, not against a restored checkout: the
      // restore-side commit check already refuses to UNPACK a stale snapshot,
      // so a checkout assertion passes while the deleted content is still on
      // disk in the artifact.
      headless();
      const artifacts = makeDirectory("t3-sandbox-artifacts-");
      const source = sourceRepository();

      const executor = new GitBackedExecutor();
      const manager = makeSandboxRuntimeManager(artifacts, "linux", executor);
      yield* manager.provision(provisionInput(source.path, source.baseCommit));
      NodeFS.writeFileSync(
        NodePath.join(executor.repository, "secret.txt"),
        "credential the user deleted\n",
        "utf8",
      );
      const first = yield* manager.exportBranch("docker", THREAD_ID);
      expect(first.snapshotCommit).toBeDefined();

      NodeFS.rmSync(NodePath.join(executor.repository, "secret.txt"));
      NodeFS.appendFileSync(
        NodePath.join(executor.repository, "tracked.txt"),
        "second line\n",
        "utf8",
      );
      const second = yield* manager.exportBranch("docker", THREAD_ID);
      expect(second.snapshotCommit).toBeDefined();
      expect(second.snapshotCommit).not.toBe(first.snapshotCommit);

      // Unbundle the newest artifact into a scratch repository and look for the
      // deleted content anywhere in its object graph.
      const inspect = makeDirectory("t3-sandbox-bundle-");
      git(inspect, "init", "--quiet", "--bare", ".");
      git(
        inspect,
        "fetch",
        NodePath.join(artifacts, `${second.artifactId}.bundle`),
        "refs/*:refs/bundled/*",
      );
      // Exactly what a restore reads back, and nothing else. `--all` swept in
      // every ref the repository happened to hold -- the seeding ref, and any
      // snapshot ref a failed prune left behind -- each one a way for content
      // this export never captured to reach the artifact.
      expect(git(inspect, "for-each-ref", "--format=%(refname)").trim().split("\n")).toEqual([
        `refs/bundled/heads/thread/${THREAD_ID}`,
        `refs/bundled/t3/export-snapshot/${second.snapshotCommit!}`,
      ]);
      const reachable = git(inspect, "rev-list", "--objects", "--all");
      expect(reachable).not.toContain("secret.txt");
      expect(reachable).toContain("tracked.txt");
      // The export this bundle IS still has to be in it -- pruning must not cost
      // the current snapshot, or the fix trades a retention bug for data loss.
      expect(git(inspect, "cat-file", "-t", second.snapshotCommit!).trim()).toBe("commit");
      // ...and the earlier export's snapshot is gone from it entirely.
      expect(
        NodeChildProcess.spawnSync("git", ["cat-file", "-e", first.snapshotCommit!], {
          cwd: inspect,
          encoding: "utf8",
        }).status,
      ).not.toBe(0);
    }),
  );

  it.effect("fails the export when a dirty tree cannot be snapshotted", () =>
    Effect.gen(function* () {
      // The snapshot used to be best-effort: a failure returned `undefined`
      // and the export shipped a bundle that looked complete while silently
      // dropping everything the user had not committed -- which the settle
      // that triggered the export then destroyed. Failing leaves the container
      // and the work intact for a retry.
      headless();
      const artifacts = makeDirectory("t3-sandbox-artifacts-");
      const source = sourceRepository();

      class BrokenCommitTreeExecutor extends GitBackedExecutor {
        override async run(command: SandboxCommand): Promise<SandboxCommandResult> {
          const result = await super.run(command);
          return command.args.includes("commit-tree")
            ? { exitCode: 1, stdout: "", stderr: "fatal: unable to write commit object" }
            : result;
        }
      }
      const executor = new BrokenCommitTreeExecutor();
      const manager = makeSandboxRuntimeManager(artifacts, "linux", executor);
      yield* manager.provision(provisionInput(source.path, source.baseCommit));
      NodeFS.appendFileSync(
        NodePath.join(executor.repository, "tracked.txt"),
        "work that must not be silently dropped\n",
        "utf8",
      );

      const failure = yield* manager.exportBranch("docker", THREAD_ID).pipe(Effect.flip);
      expect(failure.message).toContain("working-tree snapshot");
      // Nothing was published: a bundle that drops the user's work must not
      // become the artifact a re-provision restores from.
      expect(NodeFS.readdirSync(artifacts).filter((entry) => entry.endsWith(".bundle"))).toEqual(
        [],
      );
    }),
  );
});
