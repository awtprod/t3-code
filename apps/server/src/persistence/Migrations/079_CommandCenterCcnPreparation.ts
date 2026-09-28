import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE command_center_ccn_recording_bindings (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL REFERENCES command_center_spaces(id),
      plan_id TEXT NOT NULL REFERENCES command_center_sprint_plans(id),
      task_id TEXT NOT NULL,
      candidate_kind TEXT NOT NULL CHECK (candidate_kind IN ('clip', 'title', 'thumbnail')),
      plan_version INTEGER NOT NULL CHECK (plan_version >= 1),
      version INTEGER NOT NULL CHECK (version >= 1),
      performer_id TEXT NOT NULL,
      performer_name TEXT NOT NULL,
      recording_id TEXT NOT NULL,
      recording_version TEXT NOT NULL,
      root_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(space_id, plan_id, task_id, candidate_kind)
    )
  `;
  yield* sql`
    CREATE INDEX idx_command_center_ccn_bindings_plan
    ON command_center_ccn_recording_bindings(space_id, plan_id, plan_version)
  `;
  yield* sql`
    CREATE TABLE command_center_ccn_exports (
      request_id TEXT PRIMARY KEY,
      request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
      space_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      binding_id TEXT NOT NULL REFERENCES command_center_ccn_recording_bindings(id),
      binding_version INTEGER NOT NULL,
      plan_version INTEGER NOT NULL,
      run_id TEXT NOT NULL REFERENCES command_center_runs(id),
      artifact_id TEXT NOT NULL UNIQUE REFERENCES command_center_artifacts(id),
      content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
      size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
      provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json) AND length(provenance_json) <= 65536),
      created_at TEXT NOT NULL
    )
  `;
});
