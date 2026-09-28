import { describe, expect, it } from "@effect/vitest";
import { GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { resolveSandboxGitBase, SandboxGitBaseUnavailableError } from "./sandboxGitBase.ts";

const CWD = "/workspace/project";

const gitCommandError = (operation: string) =>
  new GitCommandError({ operation, command: "git", cwd: CWD, detail: "no such ref" });

const localStatus = (input: { isRepo: boolean; refName: string | null }) => ({
  isRepo: input.isRepo,
  hasPrimaryRemote: false,
  isDefaultRef: false,
  refName: input.refName,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
});

const upstream = {
  commitSha: "a".repeat(40),
  remoteRefName: "origin/main",
  remoteName: "origin",
  remoteUrl: "https://github.com/T3Tools/t3code.git",
  remotePushUrl: "https://github.com/T3Tools/t3code.git",
};

const stubGitWorkflow = (overrides: {
  status?: { isRepo: boolean; refName: string | null };
  tracking?: "found" | "missing";
  head?: string | "unborn";
}) =>
  ({
    localStatus: () =>
      Effect.succeed(localStatus(overrides.status ?? { isRepo: true, refName: "main" })),
    resolveRemoteTrackingCommit: () =>
      overrides.tracking === "found"
        ? Effect.succeed(upstream)
        : Effect.fail(gitCommandError("resolveRemoteTrackingCommit")),
    resolveCommit: () =>
      overrides.head === undefined || overrides.head === "unborn"
        ? Effect.fail(gitCommandError("resolveCommit"))
        : Effect.succeed({ commitSha: overrides.head }),
  }) as unknown as GitWorkflowService.GitWorkflowService["Service"];

const resolve = (gitWorkflow: GitWorkflowService.GitWorkflowService["Service"]) =>
  resolveSandboxGitBase({ gitWorkflow, cwd: CWD });

const resolveFailure = (gitWorkflow: GitWorkflowService.GitWorkflowService["Service"]) =>
  Effect.flip(resolve(gitWorkflow));

describe("resolveSandboxGitBase", () => {
  it.effect("prefers the upstream tracking commit and its remote identity", () =>
    Effect.gen(function* () {
      expect(yield* resolve(stubGitWorkflow({ tracking: "found" }))).toEqual(upstream);
    }),
  );

  it.effect("falls back to the local HEAD when the branch has no tracking ref", () =>
    Effect.gen(function* () {
      expect(
        yield* resolve(stubGitWorkflow({ tracking: "missing", head: "b".repeat(40) })),
      ).toEqual({ commitSha: "b".repeat(40) });
    }),
  );

  it.effect("falls back to the local HEAD on a detached checkout", () =>
    Effect.gen(function* () {
      expect(
        yield* resolve(
          stubGitWorkflow({ status: { isRepo: true, refName: null }, head: "c".repeat(40) }),
        ),
      ).toEqual({ commitSha: "c".repeat(40) });
    }),
  );

  it.effect("fails with the workspace path when the directory is not a repository", () =>
    Effect.gen(function* () {
      const error = yield* resolveFailure(
        stubGitWorkflow({ status: { isRepo: false, refName: null } }),
      );
      expect(error).toBeInstanceOf(SandboxGitBaseUnavailableError);
      expect(error.message).toContain(CWD);
      expect(error.message).toContain("git init");
    }),
  );

  it.effect("fails when the repository has no commits yet", () =>
    Effect.gen(function* () {
      const error = yield* resolveFailure(stubGitWorkflow({ tracking: "missing", head: "unborn" }));
      expect(error).toBeInstanceOf(SandboxGitBaseUnavailableError);
      expect(error.message).toContain("has none yet");
    }),
  );
});
