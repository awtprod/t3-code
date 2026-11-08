import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE command_center_knowledge_sources (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES command_center_spaces(id),
    repository_id TEXT, identity TEXT NOT NULL UNIQUE, current_revision_id TEXT,
    retired_at TEXT
  )`;
  yield* sql`CREATE INDEX command_center_knowledge_scope ON command_center_knowledge_sources(space_id, repository_id, retired_at)`;
  yield* sql`CREATE TABLE command_center_knowledge_revisions (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES command_center_knowledge_sources(id),
    document_json TEXT NOT NULL, captured_at TEXT NOT NULL, actor_id TEXT NOT NULL,
    acquisition TEXT NOT NULL CHECK(acquisition IN ('imported','connected')),
    connected_operation TEXT, connected_account TEXT
  )`;
  yield* sql`CREATE INDEX command_center_knowledge_revision_source ON command_center_knowledge_revisions(source_id)`;
  yield* sql`CREATE TRIGGER command_center_knowledge_source_identity BEFORE UPDATE OF id,space_id,repository_id,identity ON command_center_knowledge_sources BEGIN SELECT RAISE(ABORT,'knowledge source identity is immutable'); END`;
  yield* sql`CREATE TABLE command_center_knowledge_chunks (
    id INTEGER PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES command_center_knowledge_revisions(id),
    chunk INTEGER NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, text TEXT NOT NULL,
    UNIQUE(revision_id,chunk)
  )`;
  yield* sql`CREATE TABLE command_center_knowledge_current (
    id INTEGER PRIMARY KEY REFERENCES command_center_knowledge_chunks(id),
    space_id TEXT NOT NULL, repository_id TEXT, scope_key TEXT NOT NULL, text TEXT NOT NULL
  )`;
  yield* sql`CREATE VIRTUAL TABLE command_center_knowledge_fts USING fts5(text, scope_key, content='command_center_knowledge_current', content_rowid='id')`;
  yield* sql`CREATE TRIGGER command_center_knowledge_fts_insert AFTER INSERT ON command_center_knowledge_current BEGIN
    INSERT INTO command_center_knowledge_fts(rowid,text,scope_key) VALUES(new.id,new.text,new.scope_key);
  END`;
  yield* sql`CREATE TRIGGER command_center_knowledge_fts_delete AFTER DELETE ON command_center_knowledge_current BEGIN
    INSERT INTO command_center_knowledge_fts(command_center_knowledge_fts,rowid,text,scope_key) VALUES('delete',old.id,old.text,old.scope_key);
  END`;
  yield* sql`CREATE TABLE command_center_knowledge_mutations (
    space_id TEXT NOT NULL, mutation_id TEXT NOT NULL, digest TEXT NOT NULL, receipt_json TEXT NOT NULL,
    PRIMARY KEY(space_id,mutation_id)
  )`;
  for (const table of [
    "command_center_knowledge_revisions",
    "command_center_knowledge_chunks",
    "command_center_knowledge_mutations",
  ]) {
    yield* sql.unsafe(
      `CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'knowledge evidence is immutable'); END`,
    );
    yield* sql.unsafe(
      `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'knowledge evidence is immutable'); END`,
    );
  }
});
