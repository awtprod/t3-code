import * as Schema from "effect/Schema";

// Git stderr can echo remote URLs and credentials. Only these diagnostic tags
// may cross the source control result boundary.
export const GitCommandFailureReason = Schema.Literals([
  "authentication_failed",
  "branch_already_exists",
  "branch_checked_out_in_worktree",
  "host_key_unverified",
  "not_a_repository",
  "path_already_exists",
  "remote_unreachable",
  "tag_would_be_clobbered",
]);
export type GitCommandFailureReason = typeof GitCommandFailureReason.Type;
