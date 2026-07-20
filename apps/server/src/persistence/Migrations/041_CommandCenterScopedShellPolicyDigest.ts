import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Pin the canonical scoped-shell manifest entry before a command starts. The
 * nullable value preserves existing non-shell checkpoints while the runtime
 * compare-and-set prevents a retry or crash recovery from gaining new policy.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE command_center_automation_node_checkpoints
    ADD COLUMN scoped_shell_policy_digest TEXT
      CHECK (
        scoped_shell_policy_digest IS NULL OR
        (
          length(scoped_shell_policy_digest) = 71 AND
          substr(scoped_shell_policy_digest, 1, 7) = 'sha256:' AND
          substr(scoped_shell_policy_digest, 8) NOT GLOB '*[^0-9a-f]*'
        )
      )
  `;
});
