import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandCenterSalesDraftDecisionInput,
  CommandCenterSalesDraftCreateInput,
  CommandCenterSalesDraftRequestInput,
  CommandCenterSalesProspectProposeInput,
  CommandCenterSalesProspectUpdateInput,
  CommandCenterSalesProspectsQueryInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { SalesPipeline, layer as salesPipelineLayer } from "./SalesPipeline.ts";

const testLayer = salesPipelineLayer.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const decodeProposal = Schema.decodeUnknownSync(CommandCenterSalesProspectProposeInput);
const decodeQuery = Schema.decodeUnknownSync(CommandCenterSalesProspectsQueryInput);
const decodeUpdate = Schema.decodeUnknownSync(CommandCenterSalesProspectUpdateInput);
const decodeDraftRequest = Schema.decodeUnknownSync(CommandCenterSalesDraftRequestInput);
const decodeDraftDecision = Schema.decodeUnknownSync(CommandCenterSalesDraftDecisionInput);
const decodeDraftCreate = Schema.decodeUnknownSync(CommandCenterSalesDraftCreateInput);

const insertSpace = (
  sql: SqlClient.SqlClient,
  id: string,
  enabled = true,
  capabilities: ReadonlyArray<string> = [
    "cc.sales.read",
    "cc.sales.propose",
    "cc.sales.write",
    "cc.connections.google.gmail.drafts.create",
  ],
) =>
  sql`
    INSERT INTO command_center_spaces (
      id, slug, name, kind, instructions, policy_json, model_defaults_json, features_json,
      connections_json, repositories_json, aliases_json, lifecycle, created_at, updated_at
    ) VALUES (
      ${id}, ${id}, ${id}, 'business', '',
      ${JSON.stringify({ allowedCapabilities: capabilities, autoRunRiskLevels: [] })}, '{}',
      ${JSON.stringify(enabled ? { salesPipeline: true } : {})}, '[]', '[]', '[]', 'active',
      '2026-08-01T12:00:00.000Z', '2026-08-01T12:00:00.000Z'
    )
  `;

const proposal = (spaceId = "sales-space", requestId = "research-1") =>
  decodeProposal({
    requestId,
    spaceId,
    channelId: "UC-sales-space-test",
    channelName: "Founder Weekly",
    channelUrl: "https://youtube.com/@founderweekly",
    contactName: "Jordan",
    contactEmail: "business@example.com",
    contactProvenance: {
      sourceUrl: "https://youtube.com/@founderweekly/about",
      sourceLabel: "YouTube business contact",
      isPublicBusinessContact: true,
      capturedAt: "2026-08-01T12:00:00.000Z",
    },
    subscriberCount: 58_000,
    language: "English",
    niche: "Business education",
    fit: {
      score: 82,
      reasons: ["Weekly long-form publishing", "Paid founder community"],
      thumbnailAudit: "the visual hierarchy shifts between recent weekly uploads.",
      monetizationEvidence: "The channel links a paid founder community.",
      publishingEvidence: "Eight long-form videos were published in the last eight weeks.",
    },
    nextAction: "Review fit and public contact provenance",
    provenanceKind: "automation",
    provenanceRef: "weekday-research",
  });

it.effect("keeps the module invisible when a Space has not opted in", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sales = yield* SalesPipeline;
    yield* insertSpace(sql, "ordinary-space", false);

    const failure = yield* Effect.flip(sales.query(decodeQuery({ spaceId: "ordinary-space" })));

    expect(failure.reason).toBe("not_found");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("deduplicates proposals and keeps automation at Researched", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sales = yield* SalesPipeline;
    yield* insertSpace(sql, "sales-space");

    const first = yield* sales.propose(proposal());
    const duplicate = yield* sales.propose(proposal("sales-space", "research-2"));
    const listed = yield* sales.query(decodeQuery({ spaceId: "sales-space" }));

    expect(first.duplicate).toBe(false);
    expect(first.prospect.stage).toBe("researched");
    expect(first.prospect.opportunityCents).toBe(30_000);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.prospect.id).toBe(first.prospect.id);
    expect(listed.prospects).toHaveLength(1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("enforces human stage transitions, optimistic conflicts, and Space boundaries", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sales = yield* SalesPipeline;
    yield* insertSpace(sql, "sales-space");
    yield* insertSpace(sql, "another-space");
    const created = (yield* sales.propose(proposal())).prospect;

    const invalid = yield* Effect.flip(
      sales.update(
        decodeUpdate({
          prospectId: created.id,
          spaceId: "sales-space",
          expectedUpdatedAt: created.updatedAt,
          stage: "won",
        }),
      ),
    );
    expect(invalid.reason).toBe("validation");

    const qualified = yield* sales.update(
      decodeUpdate({
        prospectId: created.id,
        spaceId: "sales-space",
        expectedUpdatedAt: created.updatedAt,
        stage: "qualified",
      }),
    );
    expect(qualified.prospect.stage).toBe("qualified");
    expect(qualified.activities[0]?.kind).toBe("stage_changed");

    const stale = yield* Effect.flip(
      sales.update(
        decodeUpdate({
          prospectId: created.id,
          spaceId: "sales-space",
          expectedUpdatedAt: created.updatedAt,
          nextAction: "This update is stale",
        }),
      ),
    );
    expect(stale.reason).toBe("conflict");

    const crossSpace = yield* Effect.flip(
      sales.update(
        decodeUpdate({
          prospectId: created.id,
          spaceId: "another-space",
          expectedUpdatedAt: qualified.prospect.updatedAt,
          nextAction: "Should not cross Spaces",
        }),
      ),
    );
    expect(crossSpace.reason).toBe("not_found");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("shows the complete $300 outreach before digest-bound approval", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sales = yield* SalesPipeline;
    yield* insertSpace(sql, "sales-space");
    const created = (yield* sales.propose(proposal())).prospect;
    const qualified = yield* sales.update(
      decodeUpdate({
        prospectId: created.id,
        spaceId: "sales-space",
        expectedUpdatedAt: created.updatedAt,
        stage: "qualified",
      }),
    );

    const preview = yield* sales.requestDraft(
      decodeDraftRequest({
        requestId: "draft-request-1",
        prospectId: created.id,
        spaceId: "sales-space",
        connectionId: "sales-google",
        expectedUpdatedAt: qualified.prospect.updatedAt,
      }),
    );
    expect(preview.request.recipient).toBe("business@example.com");
    expect(preview.request.subject).toContain("Founder Weekly");
    expect(preview.request.body).toContain("$300 thumbnail sprint");
    expect(preview.request.body).toContain("not a promise of a specific CTR result");
    expect(preview.request.status).toBe("requested");

    const mismatched = yield* Effect.flip(
      sales.decideDraft(
        decodeDraftDecision({
          requestId: preview.request.id,
          spaceId: "sales-space",
          payloadDigest: "not-the-preview-digest",
          decision: "approved",
        }),
      ),
    );
    expect(mismatched.reason).toBe("conflict");

    const approved = yield* sales.decideDraft(
      decodeDraftDecision({
        requestId: preview.request.id,
        spaceId: "sales-space",
        payloadDigest: preview.request.payloadDigest,
        decision: "approved",
      }),
    );
    expect(approved.request.status).toBe("approved");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("reconciles manual sends and replies and prepares fresh 3-day and 7-day approvals", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sales = yield* SalesPipeline;
    yield* insertSpace(sql, "sales-space");
    const researched = (yield* sales.propose(proposal())).prospect;
    const qualified = (yield* sales.update(
      decodeUpdate({
        prospectId: researched.id,
        spaceId: "sales-space",
        expectedUpdatedAt: researched.updatedAt,
        stage: "qualified",
      }),
    )).prospect;
    const requested = yield* sales.requestDraft(
      decodeDraftRequest({
        requestId: "draft-reconcile-1",
        prospectId: qualified.id,
        spaceId: "sales-space",
        connectionId: "sales-google",
        expectedUpdatedAt: qualified.updatedAt,
      }),
    );
    yield* sales.decideDraft(
      decodeDraftDecision({
        requestId: requested.request.id,
        spaceId: "sales-space",
        payloadDigest: requested.request.payloadDigest,
        decision: "approved",
      }),
    );
    yield* sales.claimDraftCreate(
      decodeDraftCreate({
        requestId: requested.request.id,
        spaceId: "sales-space",
        payloadDigest: requested.request.payloadDigest,
      }),
    );
    yield* sales.failDraftCreate({
      requestId: requested.request.id,
      spaceId: "sales-space",
      payloadDigest: requested.request.payloadDigest,
      message: "Simulated restart after durable claim",
    });
    const recoveredClaim = yield* sales.claimDraftCreate(
      decodeDraftCreate({
        requestId: requested.request.id,
        spaceId: "sales-space",
        payloadDigest: requested.request.payloadDigest,
      }),
    );
    expect(recoveredClaim.request.status).toBe("creating");
    const drafted = yield* sales.completeDraftCreate({
      requestId: requested.request.id,
      spaceId: "sales-space",
      payloadDigest: requested.request.payloadDigest,
      draftId: "gmail-draft-1",
      reconciled: true,
    });
    expect(drafted.prospect.stage).toBe("drafted");
    const duplicateCompletion = yield* sales.completeDraftCreate({
      requestId: requested.request.id,
      spaceId: "sales-space",
      payloadDigest: requested.request.payloadDigest,
      draftId: "gmail-draft-1",
      reconciled: true,
    });
    expect(duplicateCompletion.request.gmailDraftId).toBe("gmail-draft-1");

    const contacted = yield* sales.reconcileGmailEvidence({
      prospectId: drafted.prospect.id,
      spaceId: "sales-space",
      sent: true,
      replied: false,
      messageId: "sent-message-1",
      threadId: "thread-1",
      observedAt: "2026-08-02T12:00:00.000Z",
    });
    expect(contacted.prospect.stage).toBe("contacted");
    expect(contacted.prospect.nextActionAt).toBe("2026-08-05T12:00:00.000Z");

    yield* sales.reconcileGmailEvidence({
      prospectId: drafted.prospect.id,
      spaceId: "sales-space",
      sent: true,
      replied: false,
      observedAt: "2026-08-05T12:00:00.000Z",
    });
    yield* sales.reconcileGmailEvidence({
      prospectId: drafted.prospect.id,
      spaceId: "sales-space",
      sent: true,
      replied: false,
      observedAt: "2026-08-09T12:00:00.000Z",
    });
    const previews = yield* sales.query(decodeQuery({ spaceId: "sales-space" }));
    const followUps = previews.draftRequests.filter((draft) =>
      draft.subject.startsWith("Following up:"),
    );
    expect(followUps).toHaveLength(2);
    expect(followUps.every((draft) => draft.status === "requested")).toBe(true);
    expect(followUps.every((draft) => draft.payloadDigest.length > 20)).toBe(true);

    const replied = yield* sales.reconcileGmailEvidence({
      prospectId: drafted.prospect.id,
      spaceId: "sales-space",
      sent: true,
      replied: true,
      messageId: "reply-message-1",
      threadId: "thread-1",
      observedAt: "2026-08-10T12:00:00.000Z",
    });
    expect(replied.prospect.stage).toBe("replied");
    expect(replied.prospect.nextAction).toBe("Review the reply and propose a call");
  }).pipe(Effect.provide(testLayer)),
);
