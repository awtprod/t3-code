import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as GitWorkflowService from "../git/GitWorkflowService.ts";

/**
 * The workspace holds no Git history a sandbox could be seeded from. Distinct
 * from a Git command failure: no retry and no other base resolves this, the
 * workspace itself has to change.
 */
export class SandboxGitBaseUnavailableError extends Schema.TaggedErrorClass<SandboxGitBaseUnavailableError>()(
  "SandboxGitBaseUnavailableError",
  {
    message: Schema.String,
  },
) {}

export type SandboxGitBase = {
  /** The commit the sandbox's initial bundle is cut at. */
  readonly commitSha: string;
  readonly remoteRefName?: string;
  readonly remoteName?: string;
  readonly remoteUrl?: string;
  readonly remotePushUrl?: string;
};

/**
 * Resolves the commit an isolated thread's sandbox is seeded from, preferring
 * the upstream tracking commit so a pushed branch keeps its remote identity.
 *
 * Provisioning bundles this commit out of the local checkout rather than
 * cloning a remote (see `SandboxRuntimeManager.provision`), so any local commit
 * is a valid base: a detached HEAD, a repository with no `origin`, and a branch
 * that was never pushed all fall back to the checkout's own HEAD. Only a
 * workspace with no readable Git history at all fails.
 */
export const resolveSandboxGitBase = Effect.fn("resolveSandboxGitBase")(function* (input: {
  readonly gitWorkflow: GitWorkflowService.GitWorkflowService["Service"];
  readonly cwd: string;
}) {
  const { cwd, gitWorkflow } = input;
  const local = yield* gitWorkflow.localStatus({ cwd });
  if (!local.isRepo)
    return yield* new SandboxGitBaseUnavailableError({
      message: `Isolated threads need Git history in '${cwd}', which is not a readable Git repository. Run 'git init' and make a first commit, or point the project at a repository.`,
    });
  if (local.refName !== null) {
    const tracked = Option.getOrUndefined(
      yield* gitWorkflow
        .resolveRemoteTrackingCommit({
          cwd,
          refName: local.refName,
          fallbackRemoteName: "origin",
        })
        .pipe(Effect.option),
    );
    if (tracked !== undefined) {
      const base: SandboxGitBase = tracked;
      return base;
    }
  }
  // No upstream to pin against: an unpushed branch, a repository without a
  // remote, or a detached HEAD. The checkout's own HEAD is still a commit the
  // seed bundle can name, and the sandbox simply gets no push remote.
  const head = yield* gitWorkflow.resolveCommit({ cwd, revision: "HEAD" }).pipe(
    Effect.mapError(
      () =>
        new SandboxGitBaseUnavailableError({
          message: `Isolated threads need a commit to start from, and the repository at '${cwd}' has none yet. Make a first commit and try again.`,
        }),
    ),
  );
  const base: SandboxGitBase = { commitSha: head.commitSha };
  return base;
});
