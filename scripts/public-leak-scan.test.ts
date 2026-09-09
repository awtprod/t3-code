// @effect-diagnostics nodeBuiltinImport:off - Isolated Git fixtures execute the scanner CLI.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

const SCANNER_PATH = NodePath.resolve(import.meta.dirname, "public-leak-scan.ts");
const SOURCE_REPOSITORY = NodePath.resolve(import.meta.dirname, "..");
const PUBLIC_UPSTREAM_COMMITS = [
  "c0995d2eaf8ec787b3318ed1169ae266ed1529f8",
  "27732293373fbb081a966b437ae022afe77db16b",
] as const;
const PUBLIC_FIXTURE_PATH = "apps/desktop/src/app/DesktopEarlyElectronStartup.test.ts";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("public leak scanner CLI upstream provenance", () => {
  it("scans an untrusted pre-baseline side merge", () => {
    const fixture = makeRepository();
    git(fixture.path, ["checkout", "-b", "private-side", fixture.root]);
    commitFile(fixture.path, "private.txt", `${privateHomePath()}\n`, "private side");
    git(fixture.path, ["checkout", "main"]);
    git(fixture.path, ["merge", "--no-ff", "--no-edit", "private-side"]);

    const result = scan(fixture.path);

    expect(result.status).toBe(1);
    expect(result.output).toContain("private.txt:");
    expect(result.output).toContain("[posix-home-path]");
  });

  it("scans an unverified MERGE_HEAD in staged mode", () => {
    const fixture = makeRepository();
    git(fixture.path, ["checkout", "-b", "unverified-merge"]);
    commitFile(fixture.path, "staged.txt", `${privateHomePath()}\n`, "unverified content");
    const unverifiedHead = git(fixture.path, ["rev-parse", "HEAD"]);
    git(fixture.path, ["checkout", "main"]);
    git(fixture.path, ["merge", "--no-ff", "--no-commit", "unverified-merge"]);
    expect(git(fixture.path, ["rev-parse", "MERGE_HEAD"])).toBe(unverifiedHead);

    const result = scan(fixture.path, ["--staged"]);

    expect(result.status).toBe(1);
    expect(result.output).toContain("staged.txt:");
    expect(result.output).toContain("[posix-home-path]");
  });

  it("finds a historical private blob removed after an untrusted merge", () => {
    const fixture = makeRepository();
    git(fixture.path, ["checkout", "-b", "private-history", fixture.root]);
    commitFile(fixture.path, "historical.txt", `${privateHomePath()}\n`, "private history");
    git(fixture.path, ["checkout", "main"]);
    git(fixture.path, ["merge", "--no-ff", "--no-edit", "private-history"]);
    const mergeCommit = git(fixture.path, ["rev-parse", "HEAD"]);
    git(fixture.path, ["rm", "historical.txt"]);
    git(fixture.path, ["commit", "-m", "remove private history"]);

    const result = scan(fixture.path);

    expect(result.status).toBe(1);
    expect(result.output).toContain("historical.txt:");
    expect(result.output).toContain(`(revision ${mergeCommit.slice(0, 12)})`);
    expect(result.output).toContain("[posix-home-path]");
  });

  it("keeps scanning private lines mixed into reviewed upstream content", () => {
    const fixture = makeRepository({ sharePublicObjects: true });
    const pinnedText = gitRaw(fixture.path, [
      "show",
      `${PUBLIC_UPSTREAM_COMMITS[0]}:${PUBLIC_FIXTURE_PATH}`,
    ]);
    commitFile(
      fixture.path,
      PUBLIC_FIXTURE_PATH,
      `${pinnedText}${pinnedText.endsWith("\n") ? "" : "\n"}${privateHomePath()}\n`,
      "mixed public and private content",
    );

    const result = scan(fixture.path);

    expect(result.status).toBe(1);
    expect(result.output).toContain("Public repository safety check failed with 1 finding(s)");
    expect(result.output).toContain(`${PUBLIC_FIXTURE_PATH}:`);
    expect(result.output).toContain("[posix-home-path]");
  });

  it("scans untracked private content when reviewed upstream objects are available", () => {
    const fixture = makeRepository({ sharePublicObjects: true });
    NodeFS.writeFileSync(
      NodePath.join(fixture.path, "notes.txt"),
      `${["https", "://synthetic-leak.internal/"].join("")}\n`,
    );

    const result = scan(fixture.path);

    expect(result.status).toBe(1);
    expect(result.output).toContain("notes.txt:");
    expect(result.output).toContain("[private-url]");
  });

  it.each(PUBLIC_UPSTREAM_COMMITS)("accepts reviewed public content from %s", (commit) => {
    const fixture = makeRepository({ sharePublicObjects: true });
    commitFile(
      fixture.path,
      PUBLIC_FIXTURE_PATH,
      gitRaw(fixture.path, ["show", `${commit}:${PUBLIC_FIXTURE_PATH}`]),
      "reviewed public content",
    );

    const result = scan(fixture.path);

    expect(result.status).toBe(0);
    expect(result.output).toContain(
      "Public repository safety check passed (2 current file(s), 2 historical revision(s) scanned)",
    );
  });

  it("fails closed when a reviewed public commit object is absent", () => {
    const fixture = makeRepository();
    commitFile(
      fixture.path,
      PUBLIC_FIXTURE_PATH,
      gitRaw(SOURCE_REPOSITORY, ["show", `${PUBLIC_UPSTREAM_COMMITS[0]}:${PUBLIC_FIXTURE_PATH}`]),
      "unproven copied content",
    );

    const result = scan(fixture.path);

    expect(result.status).toBe(1);
    expect(result.output).toContain(`${PUBLIC_FIXTURE_PATH}:`);
    expect(result.output).toContain("[posix-home-path]");
  });

  it("applies the private denylist to reviewed upstream content", () => {
    const privateIdentifier = ["T3CODE", "HOME"].join("_");
    const fixture = makeRepository({ denylist: privateIdentifier, sharePublicObjects: true });
    commitFile(
      fixture.path,
      PUBLIC_FIXTURE_PATH,
      gitRaw(fixture.path, ["show", `${PUBLIC_UPSTREAM_COMMITS[0]}:${PUBLIC_FIXTURE_PATH}`]),
      "reviewed content with denylisted identifier",
    );

    const result = scan(fixture.path);

    expect(result.status).toBe(1);
    expect(result.output).toContain(`${PUBLIC_FIXTURE_PATH}:`);
    expect(result.output).toContain("[private-denylist]");
  });
});

function makeRepository(options?: {
  readonly denylist?: string;
  readonly sharePublicObjects?: boolean;
}) {
  const repositoryPath = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "public-leak-scan-"));
  temporaryDirectories.push(repositoryPath);
  git(repositoryPath, ["init", "--initial-branch=main"]);
  git(repositoryPath, ["config", "user.email", "fixture@example.test"]);
  git(repositoryPath, ["config", "user.name", "Fixture"]);

  if (options?.sharePublicObjects === true) {
    const commonDirectory = git(SOURCE_REPOSITORY, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    const alternatesPath = NodePath.join(repositoryPath, ".git/objects/info/alternates");
    NodeFS.mkdirSync(NodePath.dirname(alternatesPath), { recursive: true });
    NodeFS.writeFileSync(alternatesPath, `${NodePath.join(commonDirectory, "objects")}\n`);
    for (const commit of PUBLIC_UPSTREAM_COMMITS) {
      git(repositoryPath, ["cat-file", "-e", `${commit}^{commit}`]);
    }
  }

  commitFile(repositoryPath, "root.txt", "root\n", "root");
  NodeFS.writeFileSync(NodePath.join(repositoryPath, "baseline.txt"), "baseline\n");
  if (options?.denylist !== undefined) {
    NodeFS.writeFileSync(
      NodePath.join(repositoryPath, ".command-center-private-denylist"),
      `${options.denylist}\n`,
    );
  }
  git(repositoryPath, ["add", "."]);
  git(repositoryPath, ["commit", "-m", "public baseline"]);
  const baseline = git(repositoryPath, ["rev-parse", "HEAD"]);
  NodeFS.writeFileSync(
    NodePath.join(repositoryPath, ".command-center-public-baseline"),
    `${baseline}\n`,
  );
  git(repositoryPath, ["add", ".command-center-public-baseline"]);
  git(repositoryPath, ["commit", "-m", "pin public baseline"]);

  return {
    path: repositoryPath,
    root: git(repositoryPath, ["rev-parse", `${baseline}^`]),
  } as const;
}

function commitFile(
  repositoryPath: string,
  relativePath: string,
  content: string,
  message: string,
) {
  const absolutePath = NodePath.join(repositoryPath, relativePath);
  NodeFS.mkdirSync(NodePath.dirname(absolutePath), { recursive: true });
  NodeFS.writeFileSync(absolutePath, content);
  git(repositoryPath, ["add", "--", relativePath]);
  git(repositoryPath, ["commit", "-m", message]);
}

function privateHomePath() {
  return ["", "home", "private-user", "project"].join("/");
}

function scan(repositoryPath: string, args: readonly string[] = []) {
  const env = { ...process.env };
  delete env.COMMAND_CENTER_PUBLIC_DENYLIST;
  delete env.COMMAND_CENTER_PUBLIC_DENYLIST_FILE;
  const outputPath = NodePath.join(repositoryPath, ".git/public-leak-scan-output");
  const output = NodeFS.openSync(outputPath, "w");
  const result = (() => {
    try {
      return NodeChildProcess.spawnSync(process.execPath, [SCANNER_PATH, ...args], {
        cwd: repositoryPath,
        env,
        stdio: ["ignore", output, output],
        timeout: 10_000,
      });
    } finally {
      NodeFS.closeSync(output);
    }
  })();
  if (result.status === null) throw result.error ?? new Error("Scanner subprocess did not exit.");
  return {
    output: NodeFS.readFileSync(outputPath, "utf8"),
    status: result.status,
  } as const;
}

function git(repositoryPath: string, args: readonly string[]): string {
  return gitRaw(repositoryPath, args).trim();
}

function gitRaw(repositoryPath: string, args: readonly string[]): string {
  const result = NodeChildProcess.spawnSync("git", ["-C", repositoryPath, ...args], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
  if (result.status === null) throw result.error ?? new Error("Git fixture command did not exit.");
  if (result.status !== 0) throw new Error(result.stderr || "Git fixture command failed.");
  return result.stdout;
}
