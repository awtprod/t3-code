import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Installs a database-enforced, atomic head for the append-only Command Center
 * audit chain. SQLite serializes the event INSERT and head advance as one
 * statement, while the unique predecessor index makes forks impossible even
 * if a future writer bypasses the application helper.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Refuse to bless a pre-existing fork or broken link. The temporary CHECK is
  // used so an invalid legacy chain aborts the migration transaction.
  yield* sql`
    CREATE TEMP TABLE command_center_audit_chain_validation (
      valid INTEGER NOT NULL CHECK (valid = 1)
    )
  `;
  yield* sql`
    INSERT INTO command_center_audit_chain_validation (valid)
    SELECT CASE
      WHEN EXISTS (
        SELECT 1
        FROM (
          SELECT
            sequence,
            previous_hash,
            LAG(event_hash) OVER (ORDER BY sequence) AS expected_previous_hash
          FROM command_center_audit_events
        ) ordered_events
        WHERE previous_hash IS NOT expected_previous_hash
      ) THEN 0
      ELSE 1
    END
  `;
  yield* sql`DROP TABLE command_center_audit_chain_validation`;

  yield* sql`
    CREATE TABLE command_center_audit_chain_head (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      event_sequence INTEGER,
      event_hash TEXT,
      advanced_at TEXT,
      CHECK (
        (event_sequence IS NULL AND event_hash IS NULL AND advanced_at IS NULL)
        OR
        (event_sequence IS NOT NULL AND event_hash IS NOT NULL AND advanced_at IS NOT NULL)
      ),
      FOREIGN KEY (event_sequence) REFERENCES command_center_audit_events(sequence)
    )
  `;

  yield* sql`
    INSERT INTO command_center_audit_chain_head (
      singleton_id, event_sequence, event_hash, advanced_at
    )
    SELECT 1, sequence, event_hash, occurred_at
    FROM command_center_audit_events
    ORDER BY sequence DESC
    LIMIT 1
  `;
  yield* sql`
    INSERT OR IGNORE INTO command_center_audit_chain_head (singleton_id)
    VALUES (1)
  `;

  // A hash can be the predecessor of at most one event. Prefixing the value
  // also gives the single genesis NULL a unique index key.
  yield* sql`
    CREATE UNIQUE INDEX idx_command_center_audit_events_one_successor
    ON command_center_audit_events(
      CASE
        WHEN previous_hash IS NULL THEN 'genesis:'
        ELSE 'hash:' || previous_hash
      END
    )
  `;

  yield* sql`
    CREATE TRIGGER command_center_audit_events_require_current_head
    BEFORE INSERT ON command_center_audit_events
    BEGIN
      SELECT CASE
        WHEN NEW.previous_hash IS NOT (
          SELECT event_hash
          FROM command_center_audit_chain_head
          WHERE singleton_id = 1
        )
        THEN RAISE(ABORT, 'command_center_audit_events predecessor is not the current chain head')
      END;
    END
  `;

  yield* sql`
    CREATE TRIGGER command_center_audit_events_advance_head
    AFTER INSERT ON command_center_audit_events
    BEGIN
      UPDATE command_center_audit_chain_head
      SET event_sequence = NEW.sequence,
          event_hash = NEW.event_hash,
          advanced_at = NEW.occurred_at
      WHERE singleton_id = 1;
    END
  `;

  // The head may only describe the actual final audit event. This trigger also
  // protects the singleton from accidental application updates while allowing
  // the event INSERT trigger above to advance it atomically.
  yield* sql`
    CREATE TRIGGER command_center_audit_chain_head_validate_update
    BEFORE UPDATE ON command_center_audit_chain_head
    BEGIN
      SELECT CASE
        WHEN NEW.singleton_id != 1
          OR NEW.event_sequence IS NOT (
            SELECT sequence FROM command_center_audit_events ORDER BY sequence DESC LIMIT 1
          )
          OR NEW.event_hash IS NOT (
            SELECT event_hash FROM command_center_audit_events ORDER BY sequence DESC LIMIT 1
          )
          OR NEW.advanced_at IS NOT (
            SELECT occurred_at FROM command_center_audit_events ORDER BY sequence DESC LIMIT 1
          )
        THEN RAISE(ABORT, 'command_center_audit_chain_head must match the final audit event')
      END;
    END
  `;

  yield* sql`
    CREATE TRIGGER command_center_audit_chain_head_no_delete
    BEFORE DELETE ON command_center_audit_chain_head
    BEGIN
      SELECT RAISE(ABORT, 'command_center_audit_chain_head cannot be deleted');
    END
  `;
});
