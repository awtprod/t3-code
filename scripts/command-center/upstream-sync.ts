// @effect-diagnostics nodeBuiltinImport:off - Explicit, non-shell upstream-sync planner.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { advancePublicBaseline, planUpstreamSync } from "./upstreamSync.ts";

interface ParsedArguments {
  readonly command: "plan" | "advance-baseline";
  readonly repositoryPath: string;
  readonly upstreamRef?: string | undefined;
  readonly expectedCommit?: string | undefined;
  readonly githubOutput?: string | undefined;
}

function usage(): never {
  throw new Error(`Usage:
  node scripts/command-center/upstream-sync.ts plan \\
    --upstream-ref refs/tags/<tag> [--expected-commit <40-char-sha>] [--repository /path]
  node scripts/command-center/upstream-sync.ts advance-baseline \\
    --expected-commit <40-char-sha> [--repository /path]

The planner never fetches, merges, pushes, or opens a pull request. The scheduled upstream-sync
workflow owns those GitHub writes; every change still lands through a reviewed pull request.`);
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const [commandValue, ...rest] = argv;
  if (commandValue !== "plan" && commandValue !== "advance-baseline") usage();
  let repositoryPath = process.cwd();
  let upstreamRef: string | undefined;
  let expectedCommit: string | undefined;
  let githubOutput: string | undefined;

  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag || !value) usage();
    if (flag === "--repository") repositoryPath = NodePath.resolve(value);
    else if (flag === "--upstream-ref") upstreamRef = value;
    else if (flag === "--expected-commit") expectedCommit = value;
    else if (flag === "--github-output") githubOutput = NodePath.resolve(value);
    else usage();
  }

  if (commandValue === "plan" ? !upstreamRef : !expectedCommit) usage();
  return { command: commandValue, repositoryPath, upstreamRef, expectedCommit, githubOutput };
}

function appendGitHubOutput(path: string, values: Readonly<Record<string, string>>): void {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  NodeFS.appendFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

function main(): void {
  const args = parseArguments(process.argv.slice(2));
  if (args.command === "advance-baseline") {
    const target = args.expectedCommit ?? "";
    advancePublicBaseline(args.repositoryPath, target);
    process.stdout.write(`${target}\n`);
    return;
  }

  const plan = planUpstreamSync({
    repositoryPath: args.repositoryPath,
    upstreamRef: args.upstreamRef ?? "",
    expectedCommit: args.expectedCommit,
  });
  if (args.githubOutput) {
    appendGitHubOutput(args.githubOutput, {
      status: plan.status,
      target_commit: plan.targetCommit,
      merge_base: plan.mergeBase,
      branch_name: plan.branchName ?? "",
    });
  }
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
