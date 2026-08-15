// @effect-diagnostics nodeBuiltinImport:off - Repository safety runs before the application runtime.
// @effect-diagnostics globalConsole:off - Standalone CI/commit scanner output.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  extractPublicBinaryMetadata,
  isReviewablePublicBinary,
  makePublicBlobFinding,
  parsePrivateDenylist,
  scanPublicAddedText,
  scanPublicPath,
  scanPrivateDenylistText,
  scanPublicText,
  type PublicLeakFinding,
} from "./lib/public-leak-scan.ts";

const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024;
const BASELINE_FILE = ".command-center-public-baseline";
const DEFAULT_DENYLIST_FILE = ".command-center-private-denylist";
const GENERATED_LOCKFILES = new Set([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);
const VENDORED_PUBLIC_REFERENCE_PREFIX = ".repos/";

const args = new Set(process.argv.slice(2));
const repoRoot = NodeChildProcess.execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: process.cwd(),
  encoding: "utf8",
}).trim();
const stagedOnly = args.has("--staged");
const baseline = loadBaseline();
const paths = stagedOnly ? stagedPaths() : publicChangePaths();
const denylist = loadDenylist();
const findings: PublicLeakFinding[] = [];

for (const relativePath of paths) {
  const isVendoredPublicReference = relativePath.startsWith(VENDORED_PUBLIC_REFERENCE_PREFIX);
  const pathFindings = scanPublicPath(relativePath, denylist);
  findings.push(
    ...(isVendoredPublicReference
      ? pathFindings.filter((finding) => finding.rule === "private-denylist")
      : pathFindings),
  );
  const candidate = readCandidate(relativePath);
  if (candidate._tag === "Missing") continue;
  // `.repos/` contains immutable public upstream repositories used as integration fixtures. Their
  // own examples intentionally include private-network and credential-shaped test values, so the
  // generic heuristics are not meaningful there. Keep scanning their paths and printable content
  // against Command Center's operator-provided denylist so private identity boundaries still hold.
  if (isVendoredPublicReference) {
    if (candidate._tag === "Oversized") continue;
    const text = candidate.bytes.includes(0)
      ? extractPublicBinaryMetadata(candidate.bytes)
      : candidate.bytes.toString("utf8");
    findings.push(...scanPrivateDenylistText({ path: relativePath, text, denylist }));
    continue;
  }
  if (candidate._tag === "Oversized") {
    findings.push(
      makePublicBlobFinding({
        path: relativePath,
        rule: "oversized-file",
        message: "Files larger than the public-review limit require an explicit audited exception.",
      }),
    );
    continue;
  }
  const bytes = candidate.bytes;
  if (bytes.includes(0)) {
    if (!isReviewablePublicBinary(relativePath)) {
      findings.push(
        makePublicBlobFinding({
          path: relativePath,
          rule: "unreviewed-binary",
          message:
            "Binary files outside the public asset allowlist require an explicit audited exception.",
        }),
      );
      continue;
    }
    findings.push(
      ...scanPublicText({
        path: relativePath,
        text: extractPublicBinaryMetadata(bytes),
        denylist,
      }),
    );
    continue;
  }
  findings.push(
    ...scanPublicAddedText({
      path: relativePath,
      text: bytes.toString("utf8"),
      patch: candidatePatch(relativePath, bytes),
      denylist,
      denylistOnly: GENERATED_LOCKFILES.has(relativePath),
    }),
  );
}

const history = scanHistoricalRevisions();
findings.push(...history.findings);
const uniqueFindings = deduplicateFindings(findings);

if (uniqueFindings.length > 0) {
  console.error(`Public repository safety check failed with ${uniqueFindings.length} finding(s):`);
  for (const finding of uniqueFindings) {
    const revision = finding.revision === undefined ? "" : ` (revision ${finding.revision})`;
    console.error(
      `- ${finding.path}:${finding.line}:${finding.column}${revision} [${finding.rule}] ${finding.message}`,
    );
  }
  console.error(
    "Matched values are intentionally omitted. Move private data outside the public tree.",
  );
  process.exitCode = 1;
} else {
  console.log(
    `Public repository safety check passed (${paths.length} current file(s), ${history.revisionCount} historical revision(s) scanned).`,
  );
}

function publicChangePaths() {
  return splitNull(
    [
      git(["diff", "--name-only", "--diff-filter=ACMR", "-z", baseline, "--"]),
      git(["ls-files", "--others", "--exclude-standard", "-z", "--"]),
    ].join("\0"),
  );
}

function stagedPaths() {
  return splitNull(git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z", "--"]));
}

function candidatePatch(relativePath: string, bytes: Buffer) {
  const isUntracked =
    git(["ls-files", "--others", "--exclude-standard", "--", relativePath]).trim().length > 0;
  if (isUntracked) {
    const lineCount = bytes.toString("utf8").split("\n").length;
    return [`@@ -0,0 +1,${lineCount} @@`, ...Array.from({ length: lineCount }, () => "+")].join(
      "\n",
    );
  }

  return stagedOnly
    ? git(["diff", "--cached", "--unified=0", "--no-ext-diff", "--", relativePath])
    : git(["diff", "--unified=0", "--no-ext-diff", baseline, "--", relativePath]);
}

type Candidate =
  | { readonly _tag: "Bytes"; readonly bytes: Buffer }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Oversized" };

function readCandidate(relativePath: string): Candidate {
  if (stagedOnly) {
    const object = `:${relativePath}`;
    if (git(["cat-file", "-t", object]).trim() !== "blob") return { _tag: "Missing" };
    const size = Number(git(["cat-file", "-s", object]).trim());
    return size > MAX_TEXT_FILE_BYTES
      ? { _tag: "Oversized" }
      : { _tag: "Bytes", bytes: gitBytes(["cat-file", "blob", object]) };
  }

  const absolutePath = NodePath.join(repoRoot, relativePath);
  if (!NodeFS.existsSync(absolutePath)) return { _tag: "Missing" };
  const stat = NodeFS.lstatSync(absolutePath);
  if (stat.isSymbolicLink()) {
    return { _tag: "Bytes", bytes: Buffer.from(NodeFS.readlinkSync(absolutePath), "utf8") };
  }
  if (!stat.isFile()) return { _tag: "Missing" };
  if (stat.size > MAX_TEXT_FILE_BYTES) return { _tag: "Oversized" };
  return { _tag: "Bytes", bytes: NodeFS.readFileSync(absolutePath) };
}

function scanHistoricalRevisions() {
  // Audit Command Center's release lineage and each integration merge as a complete delta from its
  // first parent. Preserved upstream ancestry may contain hundreds of intermediate public commits;
  // scanning those separately creates findings for transient fixtures that are absent from the
  // pinned merge result. The merge commit itself remains fully scanned below against the release
  // parent, so every byte entering Command Center is still covered.
  const commits = git(["rev-list", "--first-parent", "--reverse", `${baseline}..HEAD`])
    .trim()
    .split("\n")
    .filter(Boolean);
  const historicalFindings: PublicLeakFinding[] = [];

  for (const commit of commits) {
    const comparisonParent = historicalComparisonParent(commit);
    if (comparisonParent === undefined) continue;
    const revision = commit.slice(0, 12);
    const changedPaths = splitNull(
      git([
        "diff",
        "--name-only",
        "--diff-filter=ACMR",
        "--no-renames",
        "-z",
        comparisonParent,
        commit,
        "--",
      ]),
    );

    for (const relativePath of changedPaths) {
      const isVendoredPublicReference = relativePath.startsWith(VENDORED_PUBLIC_REFERENCE_PREFIX);
      const pathFindings = scanPublicPath(relativePath, denylist);
      historicalFindings.push(
        ...(isVendoredPublicReference
          ? pathFindings.filter((finding) => finding.rule === "private-denylist")
          : pathFindings
        ).map((finding) => ({ ...finding, revision })),
      );

      const object = `${commit}:${relativePath}`;
      if (git(["cat-file", "-t", object]).trim() !== "blob") continue;
      const size = Number(git(["cat-file", "-s", object]).trim());
      if (!Number.isFinite(size) || size > MAX_TEXT_FILE_BYTES) {
        historicalFindings.push(
          makePublicBlobFinding({
            path: relativePath,
            revision,
            rule: "oversized-file",
            message:
              "Files larger than the public-review limit require an explicit audited exception.",
          }),
        );
        continue;
      }
      const bytes = gitBytes(["cat-file", "blob", object]);
      if (isVendoredPublicReference) {
        const text = bytes.includes(0)
          ? extractPublicBinaryMetadata(bytes)
          : bytes.toString("utf8");
        historicalFindings.push(
          ...scanPrivateDenylistText({ path: relativePath, text, denylist }).map((finding) => ({
            ...finding,
            revision,
          })),
        );
        continue;
      }
      if (bytes.includes(0)) {
        if (!isReviewablePublicBinary(relativePath)) {
          historicalFindings.push(
            makePublicBlobFinding({
              path: relativePath,
              revision,
              rule: "unreviewed-binary",
              message:
                "Binary files outside the public asset allowlist require an explicit audited exception.",
            }),
          );
          continue;
        }
        historicalFindings.push(
          ...scanPublicText({
            path: relativePath,
            text: extractPublicBinaryMetadata(bytes),
            denylist,
          }).map((finding) => ({ ...finding, revision })),
        );
        continue;
      }

      const patch = git([
        "diff",
        "--unified=0",
        "--no-ext-diff",
        "--no-renames",
        comparisonParent,
        commit,
        "--",
        relativePath,
      ]);
      historicalFindings.push(
        ...scanPublicAddedText({
          path: relativePath,
          text: bytes.toString("utf8"),
          patch,
          denylist,
          revision,
          denylistOnly: GENERATED_LOCKFILES.has(relativePath),
        }),
      );
    }
  }

  return { findings: historicalFindings, revisionCount: commits.length } as const;
}

function historicalComparisonParent(commit: string) {
  const parents = git(["show", "-s", "--format=%P", commit]).trim().split(/\s+/u).filter(Boolean);
  if (parents.length === 0) return undefined;
  return parents.find((parent) => isAncestor(baseline, parent)) ?? parents[0];
}

function deduplicateFindings(values: readonly PublicLeakFinding[]) {
  const byLocation = new Map<string, PublicLeakFinding>();
  for (const finding of values) {
    const key = [finding.path, finding.line, finding.column, finding.rule].join("\0");
    const existing = byLocation.get(key);
    if (
      existing === undefined ||
      (existing.revision === undefined && finding.revision !== undefined)
    ) {
      byLocation.set(key, finding);
    }
  }
  return [...byLocation.values()];
}

function loadBaseline() {
  const value = NodeFS.readFileSync(NodePath.join(repoRoot, BASELINE_FILE), "utf8").trim();
  if (!/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error(`${BASELINE_FILE} must contain exactly one full Git commit hash.`);
  }
  git(["cat-file", "-e", `${value}^{commit}`]);
  return value;
}

function loadDenylist() {
  const values = [process.env.COMMAND_CENTER_PUBLIC_DENYLIST];
  const configuredPath = process.env.COMMAND_CENTER_PUBLIC_DENYLIST_FILE;
  const denylistPath = configuredPath
    ? NodePath.resolve(configuredPath)
    : NodePath.join(repoRoot, DEFAULT_DENYLIST_FILE);
  if (NodeFS.existsSync(denylistPath)) values.push(NodeFS.readFileSync(denylistPath, "utf8"));
  return parsePrivateDenylist(values.filter(Boolean).join("\n"));
}

function git(commandArgs: readonly string[]) {
  return NodeChildProcess.execFileSync("git", commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

function gitBytes(commandArgs: readonly string[]) {
  return NodeChildProcess.execFileSync("git", commandArgs, {
    cwd: repoRoot,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function isAncestor(ancestor: string, descendant: string) {
  return (
    NodeChildProcess.spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: repoRoot,
      stdio: "ignore",
    }).status === 0
  );
}

function splitNull(value: string) {
  return [...new Set(value.split("\0").filter(Boolean))];
}
