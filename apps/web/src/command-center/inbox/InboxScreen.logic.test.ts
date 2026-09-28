import { describe, expect, it } from "vite-plus/test";

import {
  classifyInboxMutationResult,
  ccnClipReview,
  inboxDraftStorageKey,
  inboxDraftAfterAcknowledgedReply,
  inboxPendingReplyAfterAttempt,
  inboxPendingReplyForSubmit,
  inboxPendingReplyStorageKey,
  mergeHistoryById,
  readInboxDraft,
  readInboxPendingReply,
  resolveInboxDraftScopeId,
  resolveInboxEnvironmentId,
  rebaseInboxPendingReply,
  validateInboxSearch,
  writeInboxDraft,
  writeInboxPendingReply,
} from "./InboxScreen.logic";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

const scope = {
  environmentId: "environment-a",
  draftScopeId: "session-a",
  spaceId: "space-a",
  itemId: "item-a",
};

describe("Inbox route and draft logic", () => {
  it("shows CCN review controls only for a bounded, coherent prepared clip", () => {
    const artifactId = `ccn-clip-${"a".repeat(48)}`;
    const ccn = {
      kind: "clip-review",
      semanticStatus: "unverified",
      planId: "plan-a",
      taskId: "task-a",
      performerId: "performer-a",
      performerName: "Performer A",
      recordingId: "recording-a",
      recordingVersion: "v1",
      startSeconds: 1,
      endSeconds: 3,
      sourceDurationSeconds: 10,
    };
    expect(ccnClipReview({ ccn }, [artifactId])).toMatchObject({ artifactId, taskId: "task-a" });
    expect(ccnClipReview({ ccn: { ...ccn, endSeconds: 11 } }, [artifactId])).toBeNull();
    expect(ccnClipReview({ ccn }, ["../other.mp4"])).toBeNull();
    expect(ccnClipReview({ ccn: { ...ccn, semanticStatus: "verified" } }, [artifactId])).toBeNull();
  });
  it("bounds URL values and defaults unsupported tabs to actionable", () => {
    expect(
      validateInboxSearch({ environment: " env-1 ", space: "space-1", item: 4, tab: "unknown" }),
    ).toEqual({ environment: "env-1", space: "space-1", tab: "actionable" });
    expect(validateInboxSearch({ tab: "snoozed" })).toEqual({ tab: "snoozed" });
  });

  it("preserves an explicit environment deep link instead of falling back", () => {
    expect(
      resolveInboxEnvironmentId({
        requestedEnvironmentId: "offline-environment",
        activeEnvironmentId: "connected-environment",
        primaryEnvironmentId: "connected-environment",
        environmentIds: ["connected-environment", "offline-environment"],
      }),
    ).toBe("offline-environment");
    expect(
      resolveInboxEnvironmentId({
        requestedEnvironmentId: "temporarily-missing-environment",
        activeEnvironmentId: "connected-environment",
        environmentIds: ["connected-environment"],
      }),
    ).toBe("temporarily-missing-environment");
  });

  it("uses a relay account only for a confirmed relay target", () => {
    const serverScopeId = "dpop:stable-proof-scope";
    expect(
      resolveInboxDraftScopeId({
        serverScopeId,
        targetKind: "RelayConnectionTarget",
        relayAccountId: "account-a",
      }),
    ).toBe(JSON.stringify(["relay", serverScopeId, "account-a"]));
    expect(
      resolveInboxDraftScopeId({
        serverScopeId,
        targetKind: "RelayConnectionTarget",
        relayAccountId: "account-b",
      }),
    ).not.toBe(
      resolveInboxDraftScopeId({
        serverScopeId,
        targetKind: "RelayConnectionTarget",
        relayAccountId: "account-a",
      }),
    );
    expect(
      resolveInboxDraftScopeId({ serverScopeId, targetKind: "RelayConnectionTarget" }),
    ).toBeUndefined();
    expect(
      resolveInboxDraftScopeId({ serverScopeId, relayAccountId: "account-a" }),
    ).toBeUndefined();
    expect(
      resolveInboxDraftScopeId({
        serverScopeId,
        targetKind: "BearerConnectionTarget",
        relayAccountId: "account-a",
      }),
    ).toBe(serverScopeId);
  });

  it("isolates exact drafts by environment, identity, Space, and item", () => {
    const storage = memoryStorage();
    writeInboxDraft(storage, scope, { text: " Keep this exactly. ", intent: "request-changes" });

    expect(readInboxDraft(storage, scope)).toEqual({
      text: " Keep this exactly. ",
      intent: "request-changes",
    });
    expect(readInboxDraft(storage, { ...scope, draftScopeId: "session-b" })).toEqual({
      text: "",
      intent: "comment",
    });
    expect(inboxDraftStorageKey(scope)).toContain("environment-a:session-a:space-a:item-a");
  });

  it("retains the exact ambiguous reply request identity across reads", () => {
    const storage = memoryStorage();
    const pending = {
      mutationId: "web:stable-request",
      expectedVersion: 7,
      text: " Keep the exact submitted text. ",
      intent: "request-changes" as const,
    };
    writeInboxPendingReply(storage, scope, pending);

    expect(readInboxPendingReply(storage, scope)).toEqual(pending);
    expect(
      inboxPendingReplyForSubmit({
        pending: readInboxPendingReply(storage, scope),
        draft: { text: "newer text", intent: "comment" },
        expectedVersion: 99,
        mutationId: "web:new-request",
      }),
    ).toEqual(pending);
    expect(readInboxPendingReply(storage, { ...scope, draftScopeId: "session-b" })).toBeNull();
    expect(inboxPendingReplyStorageKey(scope)).toContain("environment-a:session-a:space-a:item-a");

    writeInboxPendingReply(storage, scope, null);
    expect(readInboxPendingReply(storage, scope)).toBeNull();
  });

  it("creates a new reply identity only when no ambiguous request is pending", () => {
    expect(
      inboxPendingReplyForSubmit({
        pending: null,
        draft: { text: "submitted text", intent: "comment" },
        expectedVersion: 4,
        mutationId: "web:new-request",
      }),
    ).toEqual({
      mutationId: "web:new-request",
      expectedVersion: 4,
      text: "submitted text",
      intent: "comment",
    });
  });

  it("clears only the acknowledged submitted text and preserves newer input", () => {
    const submitted = { text: "submitted text", intent: "comment" as const };
    expect(inboxDraftAfterAcknowledgedReply(submitted, submitted)).toEqual({
      text: "",
      intent: "comment",
    });
    expect(
      inboxDraftAfterAcknowledgedReply(
        { text: "newer text", intent: "request-changes" },
        submitted,
      ),
    ).toEqual({ text: "newer text", intent: "request-changes" });
  });

  it("rejects malformed pending requests instead of changing their identity", () => {
    const storage = memoryStorage();
    storage.setItem(
      inboxPendingReplyStorageKey(scope),
      JSON.stringify({
        mutationId: "bad mutation id",
        expectedVersion: -1,
        text: "text",
        intent: "comment",
      }),
    );
    expect(readInboxPendingReply(storage, scope)).toBeNull();
  });

  it("keeps ambiguous replies retryable and rebases only an explicitly rejected conflict", () => {
    const submitted = {
      mutationId: "web:original",
      expectedVersion: 7,
      text: "Original submitted text",
      intent: "request-changes" as const,
    };
    const ambiguous = { _tag: "Failure", cause: { reasons: [{ _tag: "Die" }] } };
    expect(classifyInboxMutationResult(ambiguous)).toBe("ambiguous");
    expect(
      inboxPendingReplyForSubmit({
        pending: inboxPendingReplyAfterAttempt(submitted, "ambiguous"),
        draft: { text: "Newer text", intent: "comment" },
        expectedVersion: 8,
        mutationId: "web:must-not-be-used",
      }),
    ).toEqual(submitted);

    const conflict = {
      _tag: "Failure",
      cause: {
        reasons: [
          {
            _tag: "Fail",
            error: { _tag: "CommandCenterError", reason: "conflict" },
          },
        ],
      },
    };
    expect(classifyInboxMutationResult(conflict)).toBe("conflict");
    expect(inboxPendingReplyAfterAttempt(submitted, "conflict")).toEqual(submitted);
    expect(inboxPendingReplyAfterAttempt(submitted, "rejected")).toBeNull();
    expect(
      classifyInboxMutationResult({
        _tag: "Failure",
        cause: {
          reasons: [{ _tag: "Fail", error: { _tag: "CommandCenterError", reason: "persistence" } }],
        },
      }),
    ).toBe("ambiguous");
    expect(rebaseInboxPendingReply(submitted, 8, "web:explicit-rebase")).toEqual({
      ...submitted,
      expectedVersion: 8,
      mutationId: "web:explicit-rebase",
    });
  });

  it("rejects malformed stored drafts and deduplicates overlapping history pages", () => {
    const storage = memoryStorage();
    storage.setItem(inboxDraftStorageKey(scope), "not json");
    expect(readInboxDraft(storage, scope)).toEqual({ text: "", intent: "comment" });
    expect(
      mergeHistoryById(
        [
          { id: "new", sequence: 3 },
          { id: "shared", sequence: 2 },
        ],
        [
          { id: "shared", sequence: 2 },
          { id: "old", sequence: 1 },
        ],
      ).map((entry) => entry.id),
    ).toEqual(["new", "shared", "old"]);
  });
});
