import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE command_center_conversations (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES command_center_spaces(id),
    repository_id TEXT,
    title TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    request_id TEXT NOT NULL UNIQUE,
    request_digest TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX command_center_conversations_scope ON command_center_conversations(space_id, repository_id, id)`;
  yield* sql`ALTER TABLE command_center_runs ADD COLUMN conversation_id TEXT REFERENCES command_center_conversations(id)`;
  yield* sql`ALTER TABLE command_center_runs ADD COLUMN conversation_turn INTEGER`;
  yield* sql`CREATE UNIQUE INDEX command_center_conversation_turn ON command_center_runs(conversation_id, conversation_turn) WHERE conversation_id IS NOT NULL`;
  yield* sql`CREATE UNIQUE INDEX command_center_conversation_active ON command_center_runs(conversation_id)
    WHERE conversation_id IS NOT NULL AND state IN ('queued', 'running', 'waiting', 'waiting_approval')`;
});
