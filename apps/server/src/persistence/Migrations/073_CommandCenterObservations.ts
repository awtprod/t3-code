import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Durable, Space-scoped observations with immutable revision evidence. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS command_center_observations (
      space_id TEXT NOT NULL REFERENCES command_center_spaces(id),
      id TEXT NOT NULL,
      responsibility_id TEXT,
      plan_id TEXT,
      subject_id TEXT NOT NULL,
      content_id TEXT,
      channel_id TEXT,
      cohort_id TEXT,
      content_kind TEXT NOT NULL CHECK (
        content_kind IN ('short-form', 'long-form', 'channel', 'app')
      ),
      source_identity TEXT NOT NULL,
      source_revision TEXT NOT NULL,
      source_payload_digest TEXT NOT NULL,
      metric_kind TEXT NOT NULL CHECK (
        metric_kind IN (
          'channel-subscribers',
          'content-subscribers',
          'best-short-views',
          'thumbnail-impressions-ctr',
          'average-view-percentage',
          'average-view-duration',
          'app-follows'
        )
      ),
      metric_unit TEXT NOT NULL CHECK (metric_unit IN ('count', 'percent', 'milliseconds')),
      metric_definition TEXT NOT NULL,
      collection_method TEXT NOT NULL CHECK (
        collection_method IN ('manual', 'imported', 'connected')
      ),
      current_revision_id TEXT,
      current_version INTEGER NOT NULL DEFAULT 0 CHECK (current_version >= 0),
      created_at TEXT NOT NULL,
      retired_at TEXT,
      PRIMARY KEY (space_id, id),
      UNIQUE (space_id, source_identity, source_revision)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS command_center_observation_revisions (
      revision_id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      observation_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 1),
      revision_kind TEXT NOT NULL CHECK (revision_kind IN ('created', 'corrected', 'retired')),
      revision_reason TEXT,
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'system', 'connector')),
      actor_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      revision_digest TEXT NOT NULL,
      revised_at TEXT NOT NULL,
      retired INTEGER NOT NULL CHECK (retired IN (0, 1)),
      FOREIGN KEY (space_id, observation_id)
        REFERENCES command_center_observations(space_id, id),
      UNIQUE (space_id, observation_id, version)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS command_center_observation_mutations (
      space_id TEXT NOT NULL REFERENCES command_center_spaces(id),
      mutation_id TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (space_id, mutation_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_command_center_observations_space_keyset
    ON command_center_observations(space_id, created_at DESC, id DESC)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_command_center_observations_evidence_conflicts
    ON command_center_observations(
      space_id, subject_id, metric_kind, content_kind, cohort_id, collection_method
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_command_center_observation_revisions_history
    ON command_center_observation_revisions(space_id, observation_id, version DESC)
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS command_center_observation_revisions_no_update
    BEFORE UPDATE ON command_center_observation_revisions
    BEGIN
      SELECT RAISE(ABORT, 'command_center_observation_revisions is append-only');
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS command_center_observation_revisions_no_delete
    BEFORE DELETE ON command_center_observation_revisions
    BEGIN
      SELECT RAISE(ABORT, 'command_center_observation_revisions is append-only');
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS command_center_observations_immutable_provenance
    BEFORE UPDATE OF
      space_id, id, responsibility_id, plan_id, subject_id, content_id, channel_id, cohort_id,
      content_kind, source_identity, source_revision, source_payload_digest, metric_kind,
      metric_unit, metric_definition, collection_method, created_at
    ON command_center_observations
    BEGIN
      SELECT RAISE(ABORT, 'command_center_observation provenance is immutable');
    END
  `;
});
