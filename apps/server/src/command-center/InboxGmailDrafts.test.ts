import * as NodeServices from "@effect/platform-node/NodeServices";
import { ItemId, SpaceId } from "@command-center/core";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CommandCenterConfig } from "./Config.ts";
import { InboxGmailDrafts, layer as draftsLayer } from "./InboxGmailDrafts.ts";
import { CommandCenterService, type CommandCenterServiceShape } from "./Service.ts";

const now = "2026-09-28T00:00:00.000Z";
const spaceId = SpaceId.make("space-a");
const itemId = ItemId.make("item-a");
let accountAlias = "original@example.com";
let capability = true;
const service = CommandCenterService.of({
  queryConnections: () =>
    Effect.succeed({
      connections: capability
        ? [
            {
              id: "google-a",
              spaceId,
              kind: "google",
              capabilities: ["cc.connections.google.gmail.drafts.create"],
            },
          ]
        : [],
    }),
} as unknown as CommandCenterServiceShape);
const config = CommandCenterConfig.of({
  configDirectory: "test",
  load: Effect.die("not used"),
  resolveGoogleAccount: () => Effect.succeed({ accountAlias, label: accountAlias }),
});
const testLayer = draftsLayer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.succeed(CommandCenterService, service),
      Layer.succeed(CommandCenterConfig, config),
    ),
  ),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO command_center_spaces (id, slug, name, kind, lifecycle, created_at, updated_at)
    VALUES (${spaceId}, 'space-a', 'Space A', 'business', 'active', ${now}, ${now})
  `;
  yield* sql`
    INSERT INTO command_center_items (
      id, space_id, kind, status, title, body, priority,
      source_json, links_json, metadata_json, created_at, updated_at
    ) VALUES (
      ${itemId}, ${spaceId}, 'decision', 'review', 'Review response', 'Source text', 'high',
      '{"kind":"user","capturedAt":"2026-09-28T00:00:00.000Z"}', '[]', '{}', ${now}, ${now}
    )
  `;
  const payload = JSON.stringify({
    kind: "prepared-action",
    actionKind: "gmail.draft.create",
    target: { kind: "command-center-item", id: itemId },
    parameters: {
      spaceId,
      connectionId: "google-a",
      operation: "gmail.draft.create",
      to: ["recipient@example.com"],
      subject: "Exact draft",
      body: "Exact body",
    },
  });
  const evidence = JSON.stringify({
    source: "command-center-item",
    subjectId: itemId,
    version: now,
  });
  yield* sql`
    INSERT INTO command_center_inbox_revisions (
      id, item_id, revision, status, source, payload_json, preview_json, evidence_json,
      actor_subject, created_at, accepted_at, accepted_by_subject
    ) VALUES ('revision-a', ${itemId}, 1, 'current', 'direct', ${payload},
      '{"summary":"Exact draft","before":"No draft","after":"A Gmail draft"}',
      ${evidence}, 'andrew', ${now}, ${now}, 'andrew')
  `;
  yield* sql`
    UPDATE command_center_inbox_state
    SET current_revision_id = 'revision-a', version = 1
    WHERE item_id = ${itemId}
  `;
});

const input = {
  spaceId,
  itemId,
  mutationId: "approve-a",
  revisionId: "revision-a",
  expectedVersion: 1,
} as const;

it.effect("pins the exact accepted draft, account and capability across execution", () =>
  Effect.gen(function* () {
    accountAlias = "original@example.com";
    capability = true;
    yield* seed;
    const drafts = yield* InboxGmailDrafts;
    const approved = yield* drafts.approve(input, "andrew");
    expect(approved.status).toBe("approved");
    expect((yield* drafts.approve(input, "andrew")).payloadDigest).toBe(approved.payloadDigest);
    expect(
      (yield* drafts.loadForExecution({
        mutationId: input.mutationId,
        spaceId,
        payloadDigest: approved.payloadDigest,
      })).request.to,
    ).toEqual(["recipient@example.com"]);

    accountAlias = "other@example.com";
    expect(
      (yield* Effect.flip(
        drafts.loadForExecution({
          mutationId: input.mutationId,
          spaceId,
          payloadDigest: approved.payloadDigest,
        }),
      )).reason,
    ).toBe("conflict");
    accountAlias = "original@example.com";
    capability = false;
    expect(
      (yield* Effect.flip(
        drafts.loadForExecution({
          mutationId: input.mutationId,
          spaceId,
          payloadDigest: approved.payloadDigest,
        }),
      )).reason,
    ).toBe("conflict");
    capability = true;

    yield* drafts.claim(input.mutationId);
    expect((yield* Effect.flip(drafts.claim(input.mutationId))).reason).toBe("conflict");
    const sql = yield* SqlClient.SqlClient;
    expect(
      Exit.isFailure(
        yield* Effect.exit(sql`
      UPDATE command_center_items SET body = 'Changed during Gmail creation' WHERE id = ${itemId}
    `),
      ),
    ).toBe(true);
    yield* drafts.uncertain(input.mutationId, "unverified response");
    expect(
      (yield* Effect.flip(
        drafts.loadForExecution({
          mutationId: input.mutationId,
          spaceId,
          payloadDigest: approved.payloadDigest,
        }),
      )).reason,
    ).toBe("conflict");
    expect((yield* drafts.receipt({ spaceId, itemId }))?.status).toBe("uncertain");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rejects a stale accepted version before approval", () =>
  Effect.gen(function* () {
    accountAlias = "original@example.com";
    capability = true;
    yield* seed;
    const drafts = yield* InboxGmailDrafts;
    expect(
      (yield* Effect.flip(drafts.approve({ ...input, expectedVersion: 0 }, "andrew"))).reason,
    ).toBe("conflict");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rejects changed recipient and a version race before the draft claim", () =>
  Effect.gen(function* () {
    accountAlias = "original@example.com";
    capability = true;
    yield* seed;
    const drafts = yield* InboxGmailDrafts;
    const sql = yield* SqlClient.SqlClient;
    const approved = yield* drafts.approve(input, "andrew");
    yield* sql`
      UPDATE command_center_inbox_revisions
      SET payload_json = replace(payload_json, 'recipient@example.com', 'other@example.com')
      WHERE id = 'revision-a'
    `;
    expect(
      (yield* Effect.flip(
        drafts.loadForExecution({
          mutationId: input.mutationId,
          spaceId,
          payloadDigest: approved.payloadDigest,
        }),
      )).reason,
    ).toBe("conflict");
    yield* sql`
      UPDATE command_center_inbox_revisions
      SET payload_json = replace(payload_json, 'other@example.com', 'recipient@example.com')
      WHERE id = 'revision-a'
    `;
    yield* sql`UPDATE command_center_inbox_state SET version = 2 WHERE item_id = ${itemId}`;
    expect((yield* Effect.flip(drafts.claim(input.mutationId))).reason).toBe("conflict");
  }).pipe(Effect.provide(testLayer)),
);
