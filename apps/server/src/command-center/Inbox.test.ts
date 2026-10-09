import * as NodeServices from "@effect/platform-node/NodeServices";
import { ItemId, SpaceId } from "@command-center/core";
import {
  COMMAND_CENTER_INBOX_MAX_COMMENT_CHARS,
  CommandCenterInboxCandidateCreateInput,
  CommandCenterInboxQueryInput,
  type CommandCenterInboxProposalPayload,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { make } from "./Inbox.ts";

const testLayer = Layer.mergeAll(SqlitePersistenceMemory, NodeServices.layer);
const spaceA = SpaceId.make("space-a");
const spaceB = SpaceId.make("space-b");
const itemA = ItemId.make("item-a");
const itemB = ItemId.make("item-b");
const authenticatedActor = { subject: "authenticated-andrew" };
const decodeCandidateInputExit = Schema.decodeUnknownExit(CommandCenterInboxCandidateCreateInput);
const decodeQueryInputExit = Schema.decodeUnknownExit(CommandCenterInboxQueryInput);

const preparedAction = (version: string): CommandCenterInboxProposalPayload => ({
  kind: "prepared-action",
  actionKind: "prepare.fixture",
  target: { kind: "fixture", id: "subject-a" },
  parameters: { version },
});

const candidateInput = (mutationId: string, expectedVersion: number, source: "direct" = "direct") =>
  ({
    spaceId: spaceA,
    itemId: itemA,
    mutationId,
    expectedVersion,
    source,
    payload: preparedAction(mutationId),
    preview: {
      summary: `Proposal ${mutationId}`,
      before: "Before",
      after: "After",
    },
    evidence: {
      source: "fixture-source",
      subjectId: "subject-a",
      version: mutationId,
    },
  }) as const;

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = "2026-09-28T00:00:00.000Z";
  yield* sql`
    INSERT INTO command_center_spaces (
      id, slug, name, kind, lifecycle, created_at, updated_at
    ) VALUES
      (${spaceA}, 'a', 'Space A', 'business', 'active', ${now}, ${now}),
      (${spaceB}, 'b', 'Space B', 'business', 'active', ${now}, ${now}),
      ('space-archived', 'archived', 'Archived', 'business', 'archived', ${now}, ${now})
  `;
  yield* sql`
    INSERT INTO command_center_items (
      id, space_id, kind, status, title, body, priority,
      source_json, links_json, metadata_json, created_at, updated_at
    ) VALUES
      (${itemA}, ${spaceA}, 'decision', 'review', 'Review proposal', 'Existing body', 'high',
        '{"kind":"user","capturedAt":"2026-09-28T00:00:00.000Z"}', '[]', '{}', ${now}, ${now}),
      (${itemB}, ${spaceA}, 'task', 'captured', 'Second item', NULL, 'normal',
        '{"kind":"user","capturedAt":"2026-09-28T00:00:00.000Z"}', '[]', '{}', ${now}, ${now}),
      ('item-space-b', ${spaceB}, 'decision', 'review', 'Other Space', NULL, 'normal',
        '{"kind":"user","capturedAt":"2026-09-28T00:00:00.000Z"}', '[]', '{}', ${now}, ${now}),
      ('item-archived', 'space-archived', 'decision', 'review', 'Archived', NULL, 'normal',
        '{"kind":"user","capturedAt":"2026-09-28T00:00:00.000Z"}', '[]', '{}', ${now}, ${now})
  `;
});

it.effect("persists exact authenticated comments across a reconstructed service", () =>
  Effect.gen(function* () {
    yield* seed;
    const first = yield* make;
    const exactText = "  Keep these leading and trailing spaces.  ";
    const commented = yield* first.comment(
      {
        spaceId: spaceA,
        itemId: itemA,
        mutationId: "comment-persist",
        expectedVersion: 0,
        text: exactText,
      },
      authenticatedActor,
    );

    const reconstructed = yield* make;
    const detail = yield* reconstructed.detail({ spaceId: spaceA, itemId: itemA });
    expect(commented.detail.state.version).toBe(1);
    expect(detail.discussion).toHaveLength(1);
    expect(detail.discussion[0]?.text).toBe(exactText);
    expect(detail.discussion[0]?.actor).toEqual({
      kind: "authenticated-user",
      subject: authenticatedActor.subject,
    });
    expect(detail.item.status).toBe("review");

    expect(
      Exit.isFailure(
        yield* Effect.exit(
          reconstructed.comment(
            {
              spaceId: spaceA,
              itemId: itemA,
              mutationId: "blank-comment",
              expectedVersion: 1,
              text: "   \n\t",
            },
            authenticatedActor,
          ),
        ),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          reconstructed.comment(
            {
              spaceId: spaceA,
              itemId: itemA,
              mutationId: "large-comment",
              expectedVersion: 1,
              text: "x".repeat(COMMAND_CENTER_INBOX_MAX_COMMENT_CHARS + 1),
            },
            authenticatedActor,
          ),
        ),
      ),
    ).toBe(true);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rejects cross-Space access and stale writers while replaying one mutation once", () =>
  Effect.gen(function* () {
    yield* seed;
    const inbox = yield* make;
    const wrongSpace = yield* Effect.flip(inbox.detail({ spaceId: spaceB, itemId: itemA }));
    expect(wrongSpace.reason).toBe("not_found");
    const wrongSpaceMutation = yield* Effect.flip(
      inbox.comment(
        {
          spaceId: spaceB,
          itemId: itemA,
          mutationId: "cross-space-comment",
          expectedVersion: 0,
          text: "Must not cross the Space boundary.",
        },
        authenticatedActor,
      ),
    );
    expect(wrongSpaceMutation.reason).toBe("not_found");

    const input = {
      spaceId: spaceA,
      itemId: itemA,
      mutationId: "two-client-comment",
      expectedVersion: 0,
      text: "First client wins.",
    } as const;
    const first = yield* inbox.comment(input, authenticatedActor);
    const stale = yield* Effect.flip(
      inbox.comment(
        {
          ...input,
          mutationId: "stale-second-client",
          text: "Second stale client.",
        },
        authenticatedActor,
      ),
    );
    yield* inbox.comment(
      {
        ...input,
        mutationId: "later-comment",
        expectedVersion: 1,
        text: "A later authoritative comment.",
      },
      authenticatedActor,
    );
    const replay = yield* inbox.comment(input, authenticatedActor);
    const current = yield* inbox.detail({ spaceId: spaceA, itemId: itemA });

    expect(first.duplicate).toBe(false);
    expect(stale.reason).toBe("conflict");
    expect(replay.duplicate).toBe(true);
    expect(replay.detail.state.version).toBe(2);
    expect(replay.detail.discussion).toEqual(current.discussion);
    expect(current.state.version).toBe(2);
    expect(current.discussion).toHaveLength(2);

    const sql = yield* SqlClient.SqlClient;
    const receipts = yield* sql<{ readonly receiptJson: string }>`
      SELECT receipt_json AS "receiptJson"
      FROM command_center_inbox_mutation_receipts
      WHERE mutation_id = ${input.mutationId}
    `;
    const decodedReceipt = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
      receipts[0]?.receiptJson ?? "{}",
    );
    expect(decodedReceipt).toEqual({
      resultVersion: 1,
      createdDiscussionId: "comment:two-client-comment",
    });
    expect(receipts[0]?.receiptJson).not.toContain("First client wins.");

    const conflictingReplay = yield* Effect.exit(
      inbox.comment({ ...input, text: "Changed replay." }, authenticatedActor),
    );
    expect(Exit.isFailure(conflictingReplay)).toBe(true);
    const conflictingActorReplay = yield* Effect.exit(
      inbox.comment(input, { subject: "different-authenticated-user" }),
    );
    expect(Exit.isFailure(conflictingActorReplay)).toBe(true);
  }).pipe(Effect.provide(testLayer)),
);

it("rejects agent provenance at the user candidate input boundary", () => {
  const decoded = decodeCandidateInputExit({
    ...candidateInput("forged-agent-source", 0),
    source: "agent",
  });
  expect(Exit.isFailure(decoded)).toBe(true);
});

it("validates the optional Inbox view", () => {
  expect(Exit.isSuccess(decodeQueryInputExit({ view: "actionable" }))).toBe(true);
  expect(Exit.isSuccess(decodeQueryInputExit({ view: "recent" }))).toBe(true);
  expect(Exit.isSuccess(decodeQueryInputExit({ view: "snoozed" }))).toBe(true);
  expect(Exit.isFailure(decodeQueryInputExit({ view: "everything" }))).toBe(true);
});

it.effect("keeps comments invariant and preserves request, accepted, and discarded history", () =>
  Effect.gen(function* () {
    yield* seed;
    const inbox = yield* make;

    const firstCandidate = yield* inbox.createCandidate(
      candidateInput("candidate-one", 0),
      authenticatedActor,
    );
    const acceptedFirst = yield* inbox.acceptCandidate(
      {
        spaceId: spaceA,
        itemId: itemA,
        mutationId: "accept-one",
        expectedVersion: 1,
        candidateRevisionId: "revision:candidate-one",
      },
      authenticatedActor,
    );
    const proposalBeforeComment = acceptedFirst.detail.currentRevision;
    const approvalBeforeComment = acceptedFirst.detail.state.approval;
    const commented = yield* inbox.comment(
      {
        spaceId: spaceA,
        itemId: itemA,
        mutationId: "comment-on-current",
        expectedVersion: 2,
        text: "This comment must not change the proposal.",
      },
      authenticatedActor,
    );
    expect(commented.detail.currentRevision).toEqual(proposalBeforeComment);
    expect(commented.detail.state.approval).toEqual(approvalBeforeComment);

    const requested = yield* inbox.requestChanges(
      {
        spaceId: spaceA,
        itemId: itemA,
        mutationId: "request-one",
        expectedVersion: 3,
        text: "Please make the evidence-specific correction.",
      },
      authenticatedActor,
    );
    expect(requested.detail.state.approval.reason).toBe("changes-requested");
    expect(requested.detail.currentRevision?.id).toBe("revision:candidate-one");

    yield* inbox.createCandidate(
      candidateInput("candidate-discard", 4, "direct"),
      authenticatedActor,
    );
    const discarded = yield* inbox.discardCandidate(
      {
        spaceId: spaceA,
        itemId: itemA,
        mutationId: "discard-two",
        expectedVersion: 5,
        candidateRevisionId: "revision:candidate-discard",
      },
      authenticatedActor,
    );
    expect(discarded.detail.currentRevision?.id).toBe("revision:candidate-one");
    expect(discarded.detail.state.unresolvedChangeRequestCount).toBe(1);
    expect(
      discarded.detail.revisions.find((revision) => revision.id === "revision:candidate-discard")
        ?.status,
    ).toBe("discarded");

    yield* inbox.createCandidate(
      candidateInput("candidate-three", 6, "direct"),
      authenticatedActor,
    );
    const acceptedThird = yield* inbox.acceptCandidate(
      {
        spaceId: spaceA,
        itemId: itemA,
        mutationId: "accept-three",
        expectedVersion: 7,
        candidateRevisionId: "revision:candidate-three",
      },
      authenticatedActor,
    );
    expect(acceptedThird.detail.currentRevision?.id).toBe("revision:candidate-three");
    expect(acceptedThird.detail.state.approval.reason).toBe("changes-requested");

    const resolved = yield* inbox.resolveChangeRequest(
      {
        spaceId: spaceA,
        itemId: itemA,
        mutationId: "resolve-request",
        expectedVersion: 8,
        changeRequestId: "change-request:request-one",
      },
      authenticatedActor,
    );
    expect(resolved.detail.state.unresolvedChangeRequestCount).toBe(0);
    expect(resolved.detail.state.approval).toEqual({
      supported: false,
      eligible: false,
      reason: "phase-a-no-executor",
    });
    expect(
      resolved.detail.revisions.find((revision) => revision.id === "revision:candidate-one")
        ?.status,
    ).toBe("superseded");
    expect(firstCandidate.detail.state.candidateCount).toBe(1);

    const sql = yield* SqlClient.SqlClient;
    const sideEffects = yield* sql<{ readonly runs: number; readonly approvals: number }>`
      SELECT
        (SELECT COUNT(*) FROM command_center_runs) AS runs,
        (SELECT COUNT(*) FROM command_center_approvals) AS approvals
    `;
    expect(sideEffects).toEqual([{ runs: 0, approvals: 0 }]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("snoozes, unsnoozes, dismisses, and reopens without executing work", () =>
  Effect.gen(function* () {
    yield* seed;
    const inbox = yield* make;
    const wakeAt = DateTime.formatIso(DateTime.add(yield* DateTime.now, { days: 7 }));
    const snoozed = yield* inbox.snooze(
      {
        spaceId: spaceA,
        itemId: itemA,
        mutationId: "snooze-one",
        expectedVersion: 0,
        wakeAt,
      },
      authenticatedActor,
    );
    expect(snoozed.detail.state.lifecycle).toBe("snoozed");
    expect(snoozed.detail.state.snoozedUntil).toBe(wakeAt);

    const openWhileSnoozed = yield* inbox.query({
      spaceId: spaceA,
      lifecycles: ["open"],
      limit: 10,
    });
    expect(openWhileSnoozed.items.map((entry) => entry.item.id)).not.toContain(itemA);

    const unsnoozed = yield* inbox.unsnooze(
      {
        spaceId: spaceA,
        itemId: itemA,
        mutationId: "unsnooze-one",
        expectedVersion: 1,
      },
      authenticatedActor,
    );
    expect(unsnoozed.detail.state.lifecycle).toBe("open");

    const dismissed = yield* inbox.dismiss(
      {
        spaceId: spaceA,
        itemId: itemA,
        mutationId: "dismiss-one",
        expectedVersion: 2,
      },
      authenticatedActor,
    );
    expect(dismissed.detail.state.lifecycle).toBe("dismissed");

    const reopened = yield* inbox.reopen(
      {
        spaceId: spaceA,
        itemId: itemA,
        mutationId: "reopen-one",
        expectedVersion: 3,
      },
      authenticatedActor,
    );
    expect(reopened.detail.state.lifecycle).toBe("open");
    expect(reopened.detail.item.status).toBe("review");

    const sql = yield* SqlClient.SqlClient;
    const runCount = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM command_center_runs
    `;
    expect(runCount).toEqual([{ count: 0 }]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("bounds list and history pages with stable continuation keys", () =>
  Effect.gen(function* () {
    yield* seed;
    const inbox = yield* make;
    const firstPage = yield* inbox.query({ spaceId: spaceA, limit: 1 });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).toBeDefined();
    const secondPage = yield* inbox.query({
      spaceId: spaceA,
      limit: 1,
      cursor: firstPage.nextCursor,
    });
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]?.item.id).not.toBe(firstPage.items[0]?.item.id);

    const allSpacesFirstPage = yield* inbox.query({ limit: 2 });
    expect(allSpacesFirstPage.nextCursor).toBeDefined();
    const allSpacesSecondPage = yield* inbox.query({
      limit: 2,
      cursor: allSpacesFirstPage.nextCursor,
    });
    const allSpacesItems = [...allSpacesFirstPage.items, ...allSpacesSecondPage.items];
    expect(allSpacesItems.map((entry) => entry.item.id).toSorted()).toEqual(
      [itemA, itemB, "item-space-b"].toSorted(),
    );
    expect(allSpacesItems.some((entry) => entry.item.id === "item-archived")).toBe(false);

    yield* inbox.comment(
      {
        spaceId: spaceA,
        itemId: itemA,
        mutationId: "page-comment-one",
        expectedVersion: 0,
        text: "One",
      },
      authenticatedActor,
    );
    yield* inbox.comment(
      {
        spaceId: spaceA,
        itemId: itemA,
        mutationId: "page-comment-two",
        expectedVersion: 1,
        text: "Two",
      },
      authenticatedActor,
    );
    const historyOne = yield* inbox.detail({
      spaceId: spaceA,
      itemId: itemA,
      historyLimit: 1,
    });
    expect(historyOne.discussion).toHaveLength(1);
    expect(historyOne.nextDiscussionBeforeSequence).toBeDefined();
    const historyTwo = yield* inbox.detail({
      spaceId: spaceA,
      itemId: itemA,
      historyLimit: 1,
      discussionBeforeSequence: historyOne.nextDiscussionBeforeSequence,
    });
    expect(historyTwo.discussion).toHaveLength(1);
    expect(historyTwo.discussion[0]?.id).not.toBe(historyOne.discussion[0]?.id);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("filters actionable, recent, and snoozed views before stable pagination", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    const future = DateTime.formatIso(DateTime.add(yield* DateTime.now, { days: 7 }));
    const past = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { days: 7 }));
    yield* sql`
      INSERT INTO command_center_items (
        id, space_id, kind, status, title, body, priority,
        source_json, links_json, metadata_json, created_at, updated_at
      ) VALUES
        ('view-actionable', ${spaceB}, 'decision', 'review', 'Actionable', NULL, 'normal',
          '{"kind":"user","capturedAt":"2026-09-28T00:00:00.000Z"}', '[]', '{}',
          '2026-09-28T00:00:00.000Z', '2026-09-28T00:00:00.000Z'),
        ('view-completed', ${spaceB}, 'task', 'done', 'Completed', NULL, 'normal',
          '{"kind":"user","capturedAt":"2026-09-28T00:00:00.000Z"}', '[]', '{}',
          '2026-09-28T00:00:00.000Z', '2026-09-28T00:00:00.000Z'),
        ('view-dismissed', ${spaceB}, 'decision', 'review', 'Dismissed', NULL, 'normal',
          '{"kind":"user","capturedAt":"2026-09-28T00:00:00.000Z"}', '[]', '{}',
          '2026-09-28T00:00:00.000Z', '2026-09-28T00:00:00.000Z'),
        ('view-snoozed', ${spaceB}, 'task', 'done', 'Actively snoozed', NULL, 'normal',
          '{"kind":"user","capturedAt":"2026-09-28T00:00:00.000Z"}', '[]', '{}',
          '2026-09-28T00:00:00.000Z', '2026-09-28T00:00:00.000Z'),
        ('view-woken', ${spaceB}, 'task', 'captured', 'Elapsed snooze', NULL, 'normal',
          '{"kind":"user","capturedAt":"2026-09-28T00:00:00.000Z"}', '[]', '{}',
          '2026-09-28T00:00:00.000Z', '2026-09-28T00:00:00.000Z')
    `;
    yield* sql`
      UPDATE command_center_items SET status = 'canceled' WHERE id = 'item-space-b'
    `;
    yield* sql`
      UPDATE command_center_inbox_state
      SET lifecycle = CASE item_id
            WHEN 'view-dismissed' THEN 'dismissed'
            WHEN 'view-snoozed' THEN 'snoozed'
            WHEN 'view-woken' THEN 'snoozed'
            ELSE 'open'
          END,
          snoozed_until = CASE item_id
            WHEN 'view-snoozed' THEN ${future}
            WHEN 'view-woken' THEN ${past}
            ELSE NULL
          END,
          updated_at = CASE item_id
            WHEN 'view-snoozed' THEN '2026-09-28T07:00:00.000Z'
            WHEN 'view-completed' THEN '2026-09-28T06:00:00.000Z'
            WHEN 'item-space-b' THEN '2026-09-28T05:00:00.000Z'
            WHEN 'view-dismissed' THEN '2026-09-28T04:00:00.000Z'
            WHEN 'view-woken' THEN '2026-09-28T03:00:00.000Z'
            ELSE '2026-09-28T02:00:00.000Z'
          END
      WHERE space_id = ${spaceB}
    `;

    const actionableFirst = yield* (yield* make).query({
      spaceId: spaceB,
      view: "actionable",
      limit: 1,
    });
    expect(actionableFirst.items.map((entry) => entry.item.id)).toEqual(["view-woken"]);
    expect(actionableFirst.nextCursor).toBeDefined();
    const actionableSecond = yield* (yield* make).query({
      spaceId: spaceB,
      view: "actionable",
      limit: 1,
      cursor: actionableFirst.nextCursor,
    });
    expect(actionableSecond.items.map((entry) => entry.item.id)).toEqual(["view-actionable"]);
    expect(actionableSecond.nextCursor).toBeUndefined();

    const inbox = yield* make;
    const recent = yield* inbox.query({ spaceId: spaceB, view: "recent", limit: 10 });
    expect(recent.items.map((entry) => entry.item.id)).toEqual([
      "view-completed",
      "item-space-b",
      "view-dismissed",
    ]);
    const snoozed = yield* inbox.query({ spaceId: spaceB, view: "snoozed", limit: 10 });
    expect(snoozed.items.map((entry) => entry.item.id)).toEqual(["view-snoozed"]);
  }).pipe(Effect.provide(testLayer)),
);
