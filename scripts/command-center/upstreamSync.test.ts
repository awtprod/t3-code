// @effect-diagnostics nodeBuiltinImport:off - Isolated Git fixtures.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  PUBLIC_BASELINE_FILE,
  advancePublicBaseline,
  planUpstreamSync,
  syncBranchName,
  validateUpstreamRef,
} from "./upstreamSync.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("planUpstreamSync", () => {
  it("keeps the publishing workflow on a schedule or manual dispatch, never on pushes or PRs", () => {
    const workflow = NodeFS.readFileSync(
      NodePath.resolve(import.meta.dirname, "../../.github/workflows/upstream-sync.yml"),
      "utf8",
    );
    const triggerStart = workflow.indexOf("\non:\n");
    const triggerEnd = workflow.indexOf("\nconcurrency:", triggerStart);
    expect(triggerStart).toBeGreaterThan(-1);
    expect(triggerEnd).toBeGreaterThan(triggerStart);
    const triggers = workflow.slice(triggerStart, triggerEnd);
    expect(triggers).toContain("schedule:");
    expect(triggers).toContain("workflow_dispatch:");
    expect(triggers).not.toMatch(/\n\s+(?:push|pull_request|pull_request_target|workflow_call):/);
  });

  it("plans an exact descendant ref without changing the repository", () => {
    const fixture = makeRepository();

    const plan = planUpstreamSync({
      repositoryPath: fixture.repositoryPath,
      upstreamRef: "refs/tags/v1.1.0",
      expectedCommit: fixture.target,
      initialBaseline: fixture.baseline,
    });

    expect(plan).toMatchObject({
      currentBaseline: fixture.baseline,
      baseCommit: fixture.custom,
      targetCommit: fixture.target,
      mergeBase: fixture.baseline,
      status: "needs-sync",
      branchName: "upstream-sync/v1.1.0",
    });
    expect(NodeFS.readFileSync(fixture.baselinePath, "utf8")).toBe(`${fixture.baseline}\n`);
    expect(git(fixture.repositoryPath, ["branch", "--show-current"])).toBe("main");
  });

  it("plans a tracked branch without an expected commit and names one branch per ref", () => {
    const fixture = makeRepository();
    git(fixture.repositoryPath, ["update-ref", "refs/remotes/upstream/main", fixture.target]);

    const plan = planUpstreamSync({
      repositoryPath: fixture.repositoryPath,
      upstreamRef: "refs/remotes/upstream/main",
      initialBaseline: fixture.baseline,
    });

    expect(plan).toMatchObject({
      targetCommit: fixture.target,
      mergeBase: fixture.baseline,
      status: "needs-sync",
      branchName: "upstream-sync/main",
    });
    expect(syncBranchName("refs/tags/v0.0.39")).toBe("upstream-sync/v0.0.39");
    expect(() => syncBranchName("main")).toThrow("exact refs/tags");
  });

  it("accepts a pinned baseline that is a fork merge commit rather than an upstream commit", () => {
    // After a sync the baseline pins the merge commit on main, which upstream never contains. The
    // next target must still be accepted as long as it descends from the original T3 Code baseline.
    const fixture = makeRepository();
    git(fixture.repositoryPath, ["merge", "--no-ff", "--no-edit", fixture.target]);
    const syncMerge = git(fixture.repositoryPath, ["rev-parse", "HEAD"]);
    advancePublicBaseline(fixture.repositoryPath, syncMerge, { initialBaseline: fixture.baseline });
    git(fixture.repositoryPath, ["commit", "-am", "advance baseline"]);

    git(fixture.repositoryPath, ["checkout", "upstream"]);
    NodeFS.writeFileSync(NodePath.join(fixture.repositoryPath, "upstream2.txt"), "next\n");
    git(fixture.repositoryPath, ["add", "upstream2.txt"]);
    git(fixture.repositoryPath, ["commit", "-m", "upstream next"]);
    const next = git(fixture.repositoryPath, ["rev-parse", "HEAD"]);
    git(fixture.repositoryPath, ["tag", "v1.2.0", next]);
    git(fixture.repositoryPath, ["checkout", "main"]);

    const plan = planUpstreamSync({
      repositoryPath: fixture.repositoryPath,
      upstreamRef: "refs/tags/v1.2.0",
      initialBaseline: fixture.baseline,
    });
    expect(plan).toMatchObject({
      currentBaseline: syncMerge,
      targetCommit: next,
      mergeBase: fixture.target,
      status: "needs-sync",
      branchName: "upstream-sync/v1.2.0",
    });
  });

  it("reports a no-op when the exact upstream target is already contained", () => {
    const fixture = makeRepository();
    git(fixture.repositoryPath, ["merge", "--no-ff", "--no-edit", fixture.target]);

    const plan = planUpstreamSync({
      repositoryPath: fixture.repositoryPath,
      upstreamRef: "refs/tags/v1.1.0",
      expectedCommit: fixture.target,
      initialBaseline: fixture.baseline,
    });

    expect(plan.status).toBe("already-contained");
    expect(plan.branchName).toBeNull();
  });

  it("rejects a moved ref and a target that diverges before the baseline", () => {
    const fixture = makeRepository();

    expect(() =>
      planUpstreamSync({
        repositoryPath: fixture.repositoryPath,
        upstreamRef: "refs/tags/v1.1.0",
        expectedCommit: fixture.custom,
        initialBaseline: fixture.baseline,
      }),
    ).toThrow("not the explicitly expected");

    git(fixture.repositoryPath, ["checkout", "--orphan", "divergent"]);
    NodeFS.writeFileSync(NodePath.join(fixture.repositoryPath, "divergent.txt"), "different\n");
    git(fixture.repositoryPath, ["add", "divergent.txt"]);
    git(fixture.repositoryPath, ["commit", "-m", "divergent"]);
    const divergent = git(fixture.repositoryPath, ["rev-parse", "HEAD"]);
    git(fixture.repositoryPath, ["tag", "v2.0.0", divergent]);
    git(fixture.repositoryPath, ["checkout", "main"]);

    expect(() =>
      planUpstreamSync({
        repositoryPath: fixture.repositoryPath,
        upstreamRef: "refs/tags/v2.0.0",
        expectedCommit: divergent,
        initialBaseline: fixture.baseline,
      }),
    ).toThrow("does not descend from the original T3 Code baseline");
  });

  it("requires safe exact upstream namespaces and a clean worktree", () => {
    const fixture = makeRepository();
    expect(() => validateUpstreamRef("main")).toThrow("exact refs/tags");
    expect(() => validateUpstreamRef("refs/tags/v1.0.0^{tree}")).toThrow("exact refs/tags");

    NodeFS.writeFileSync(NodePath.join(fixture.repositoryPath, "untracked.txt"), "keep\n");
    expect(() =>
      planUpstreamSync({
        repositoryPath: fixture.repositoryPath,
        upstreamRef: "refs/tags/v1.1.0",
        expectedCommit: fixture.target,
        initialBaseline: fixture.baseline,
      }),
    ).toThrow("clean worktree");
  });
});

describe("advancePublicBaseline", () => {
  it("advances atomically only after the target is merged into HEAD", () => {
    const fixture = makeRepository();
    expect(() =>
      advancePublicBaseline(fixture.repositoryPath, fixture.target, {
        initialBaseline: fixture.baseline,
      }),
    ).toThrow("not contained in HEAD");

    git(fixture.repositoryPath, ["merge", "--no-ff", "--no-edit", fixture.target]);
    advancePublicBaseline(fixture.repositoryPath, fixture.target, {
      initialBaseline: fixture.baseline,
    });
    expect(NodeFS.readFileSync(fixture.baselinePath, "utf8")).toBe(`${fixture.target}\n`);
    expect(NodeFS.existsSync(`${fixture.baselinePath}.tmp`)).toBe(false);
  });
});

function makeRepository() {
  const repositoryPath = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cc-upstream-sync-"));
  temporaryDirectories.push(repositoryPath);
  git(repositoryPath, ["init", "--initial-branch=main"]);
  git(repositoryPath, ["config", "user.email", "fixture@example.test"]);
  git(repositoryPath, ["config", "user.name", "Fixture"]);

  NodeFS.writeFileSync(NodePath.join(repositoryPath, "base.txt"), "base\n");
  git(repositoryPath, ["add", "base.txt"]);
  git(repositoryPath, ["commit", "-m", "baseline"]);
  const baseline = git(repositoryPath, ["rev-parse", "HEAD"]);
  const baselinePath = NodePath.join(repositoryPath, PUBLIC_BASELINE_FILE);
  NodeFS.writeFileSync(baselinePath, `${baseline}\n`);
  git(repositoryPath, ["add", PUBLIC_BASELINE_FILE]);
  git(repositoryPath, ["commit", "-m", "pin baseline"]);

  git(repositoryPath, ["checkout", "-b", "upstream", baseline]);
  NodeFS.writeFileSync(NodePath.join(repositoryPath, "upstream.txt"), "release\n");
  git(repositoryPath, ["add", "upstream.txt"]);
  git(repositoryPath, ["commit", "-m", "upstream release"]);
  const target = git(repositoryPath, ["rev-parse", "HEAD"]);
  git(repositoryPath, ["tag", "v1.1.0", target]);

  git(repositoryPath, ["checkout", "main"]);
  NodeFS.writeFileSync(NodePath.join(repositoryPath, "custom.txt"), "custom\n");
  git(repositoryPath, ["add", "custom.txt"]);
  git(repositoryPath, ["commit", "-m", "custom change"]);
  const custom = git(repositoryPath, ["rev-parse", "HEAD"]);
  return { repositoryPath, baselinePath, baseline, target, custom };
}

function git(repositoryPath: string, args: readonly string[]): string {
  const result = NodeChildProcess.spawnSync("git", ["-C", repositoryPath, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr || "Git fixture command failed.");
  return result.stdout.trim();
}
