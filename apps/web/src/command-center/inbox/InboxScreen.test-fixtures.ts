import { CommandCenterInboxDetail, CommandCenterInboxDraftReceipt } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * An accepted Gmail draft proposal with no Item, evidence or lifecycle
 * blockers, captured from a disposable dev server (synthetic data only) and
 * decoded through the real contract so it cannot drift from it.
 */
export const GMAIL_DRAFT_DETAIL = Schema.decodeUnknownSync(CommandCenterInboxDetail)({
  item: {
    id: "qa-item-gmail",
    spaceId: "qa-space",
    kind: "decision",
    status: "captured",
    priority: "normal",
    title: "QA: synthetic Gmail draft (no-send)",
    artifactIds: [],
    provenance: {
      kind: "user",
      capturedAt: "2026-10-02T05:17:38.404Z",
    },
    metadata: {},
    createdAt: "2026-10-02T05:17:38.404Z",
    updatedAt: "2026-10-02T05:17:38.404Z",
  },
  state: {
    itemId: "qa-item-gmail",
    spaceId: "qa-space",
    subject: {
      kind: "command-center-item",
      id: "qa-item-gmail",
    },
    lifecycle: "open",
    version: 2,
    currentRevisionId: "revision:qa-gmail-candidate-1",
    unresolvedChangeRequestCount: 0,
    candidateCount: 0,
    approval: {
      supported: false,
      eligible: false,
      reason: "phase-a-no-executor",
    },
    createdAt: "2026-10-02T05:17:38.404Z",
    updatedAt: "2026-10-02T05:17:44.513Z",
  },
  currentRevision: {
    sequence: 3,
    id: "revision:qa-gmail-candidate-1",
    itemId: "qa-item-gmail",
    revision: 1,
    status: "current",
    source: "direct",
    payload: {
      kind: "prepared-action",
      actionKind: "gmail.draft.create",
      target: {
        kind: "command-center-item",
        id: "qa-item-gmail",
      },
      parameters: {
        spaceId: "qa-space",
        connectionId: "qa-google-test",
        operation: "gmail.draft.create",
        to: ["qa-recipient@example.com"],
        subject: "QA synthetic draft",
        body: "Synthetic body; must never be sent.",
      },
    },
    preview: {
      summary: "Create one synthetic Gmail draft.",
    },
    evidence: {
      source: "command-center-item",
      subjectId: "qa-item-gmail",
      version: "2026-10-02T05:17:38.404Z",
    },
    actor: {
      kind: "authenticated-user",
      subject: "andrew",
    },
    createdAt: "2026-10-02T05:17:38.483Z",
    acceptedAt: "2026-10-02T05:17:44.513Z",
    acceptedBy: {
      kind: "authenticated-user",
      subject: "andrew",
    },
  },
  discussion: [],
  revisions: [],
});

export const gmailDraftReceipt = (
  status: CommandCenterInboxDraftReceipt["status"],
): CommandCenterInboxDraftReceipt =>
  Schema.decodeUnknownSync(CommandCenterInboxDraftReceipt)({
    mutationId: "web:qa-approve",
    itemId: GMAIL_DRAFT_DETAIL.item.id,
    spaceId: GMAIL_DRAFT_DETAIL.state.spaceId,
    expectedVersion: GMAIL_DRAFT_DETAIL.state.version,
    revisionId: GMAIL_DRAFT_DETAIL.currentRevision!.id,
    payloadDigest: "sha256:qa",
    connectionId: "qa-google-test",
    accountAlias: "approved@example.com",
    status,
    ...(status === "created" ? { draftId: "draft-qa" } : {}),
  });
