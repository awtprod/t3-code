import type {
  CommandCenterEventEnvelope,
  CommandCenterEventSubscribeInput,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import type { CommandCenterEventStreamShape } from "./EventStream.ts";
import { streamSpaceAgentQuestions } from "./SpaceAgentQuestions.ts";

const AT = "2026-01-01T00:00:00.000Z";

const insertItem = (input: {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly metadataJson: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO command_center_items (
        id, space_id, kind, status, title, metadata_json, created_at, updated_at
      ) VALUES (
        ${input.id}, 'acme', ${input.kind}, ${input.status}, ${`Title of ${input.id}`},
        ${input.metadataJson}, ${AT}, ${AT}
      )
    `;
  });

// The audit chain is hash-linked: each row must name the previous row's hash.
const insertAuditEvent = (input: { readonly n: number; readonly previousHash: string | null }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO command_center_audit_events (
        event_id, previous_hash, event_hash, actor_kind, action, space_id, payload_json, occurred_at
      ) VALUES (
        ${`audit-${input.n}`}, ${input.previousHash}, ${`hash-${input.n}`}, 'agent',
        'item.created', 'acme', '{}', ${AT}
      )
    `;
  });

const itemEvent = (
  itemId: string,
  sequence: number,
  actorKind: "agent" | "user" = "agent",
): CommandCenterEventEnvelope =>
  ({
    _tag: "ItemChanged",
    sequence,
    eventId: `event-${sequence}`,
    previousHash: null,
    eventHash: `hash-${sequence}`,
    actorKind,
    spaceId: "acme",
    runId: null,
    occurredAt: AT,
    payload: { itemId, change: "created", kind: "decision", status: "captured" },
  }) as unknown as CommandCenterEventEnvelope;

const fakeEvents = (envelopes: ReadonlyArray<CommandCenterEventEnvelope>) => {
  const calls: Array<CommandCenterEventSubscribeInput> = [];
  const events: CommandCenterEventStreamShape = {
    replay: () => Effect.die("unused"),
    timeline: () => Effect.die("unused"),
    changes: (input) => {
      calls.push(input);
      return Stream.fromIterable(envelopes);
    },
  };
  return { events, calls };
};

it.effect("streams only the agent's new decisions that need the user", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO command_center_spaces (id, slug, name, kind, created_at, updated_at)
      VALUES ('acme', 'acme', 'Acme', 'business', ${AT}, ${AT})
    `;
    yield* insertItem({
      id: "task",
      kind: "task",
      status: "captured",
      metadataJson: `{"spaceAgent":true}`,
    });
    yield* insertItem({
      id: "unmarked",
      kind: "decision",
      status: "captured",
      metadataJson: "{}",
    });
    yield* insertItem({
      id: "by-user",
      kind: "decision",
      status: "captured",
      metadataJson: `{"spaceAgent":true}`,
    });
    yield* insertItem({
      id: "question",
      kind: "decision",
      status: "captured",
      metadataJson: `{"spaceAgent":true}`,
    });
    const { events } = fakeEvents([
      itemEvent("by-user", 1, "user"),
      itemEvent("unmarked", 2),
      itemEvent("task", 3),
      itemEvent("missing", 4),
      itemEvent("question", 5),
    ]);

    const questions = yield* Stream.runCollect(
      streamSpaceAgentQuestions({ events, pollIntervalMs: 5_000 }),
    );

    assert.deepStrictEqual(questions, [
      {
        spaceId: "acme",
        itemId: "question",
        threadId: "cc-space-agent-acme",
        title: "Title of question",
        occurredAt: AT,
      },
    ]);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("follows from the audit head, so earlier questions never replay", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO command_center_spaces (id, slug, name, kind, created_at, updated_at)
      VALUES ('acme', 'acme', 'Acme', 'business', ${AT}, ${AT})
    `;
    yield* insertAuditEvent({ n: 1, previousHash: null });
    yield* insertAuditEvent({ n: 2, previousHash: "hash-1" });
    const { events, calls } = fakeEvents([]);

    const questions = yield* Stream.runCollect(
      streamSpaceAgentQuestions({ events, pollIntervalMs: 1_234 }),
    );

    assert.deepStrictEqual(questions, []);
    assert.deepStrictEqual(calls, [{ afterSequence: 2, pollIntervalMs: 1_234 }]);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
