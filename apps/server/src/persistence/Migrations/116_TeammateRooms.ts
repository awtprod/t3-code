import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE teammate_agents (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES command_center_spaces(id),
    name TEXT NOT NULL, job TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
    role TEXT NOT NULL CHECK(role IN ('main','specialist')), thread_id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL, model_json TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE teammate_rooms (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES command_center_spaces(id),
    title TEXT NOT NULL, sequence INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE INDEX teammate_rooms_space ON teammate_rooms(space_id,id)`;
  yield* sql`CREATE TABLE teammate_members (
    room_id TEXT NOT NULL REFERENCES teammate_rooms(id), agent_id TEXT NOT NULL REFERENCES teammate_agents(id),
    PRIMARY KEY(room_id,agent_id)
  )`;
  yield* sql`CREATE TABLE teammate_events (
    room_id TEXT NOT NULL REFERENCES teammate_rooms(id), sequence INTEGER NOT NULL,
    author TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, recipients_json TEXT NOT NULL,
    cause_sequence INTEGER, root_sequence INTEGER NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(room_id,sequence)
  )`;
  yield* sql`CREATE TABLE teammate_work (
    room_id TEXT NOT NULL REFERENCES teammate_rooms(id), task_id TEXT NOT NULL,
    linked_sequence INTEGER NOT NULL, completed_sequence INTEGER,
    PRIMARY KEY(room_id,task_id)
  )`;
  yield* sql`CREATE TABLE teammate_requests (
    actor TEXT NOT NULL, request_id TEXT NOT NULL, payload TEXT NOT NULL, result_json TEXT NOT NULL,
    PRIMARY KEY(actor,request_id)
  )`;
  yield* sql`CREATE TABLE teammate_deliveries (
    room_id TEXT NOT NULL, sequence INTEGER NOT NULL, agent_id TEXT NOT NULL REFERENCES teammate_agents(id),
    runtime_mode TEXT NOT NULL, interaction_mode TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued','accepted','failed')), attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL, deadline TEXT NOT NULL, run_id TEXT, delivery TEXT, error TEXT,
    PRIMARY KEY(room_id,sequence,agent_id),
    FOREIGN KEY(room_id,sequence) REFERENCES teammate_events(room_id,sequence)
  )`;
  yield* sql`CREATE INDEX teammate_delivery_pending ON teammate_deliveries(state,next_attempt_at)`;
});
