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

it.effect("deduplicates proposals and refreshes newer external evidence", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sales = yield* SalesPipeline;
    yield* insertSpace(sql, "sales-space");

    const first = yield* sales.propose({
      ...proposal(),
      sourceRecordId: "UC-sales-space-test",
      sourceVersion: "2026-08-01T12:00:00.000Z",
      evaluatedAt: "2026-08-01T12:00:00.000Z",
    });
    const duplicate = yield* sales.propose(proposal("sales-space", "research-2"));
    const refreshed = yield* sales.propose({
      ...proposal("sales-space", "research-3"),
      contactEmail: "new-contact@example.com",
      fit: { ...proposal().fit, score: 91 },
      initialStage: "qualified",
      scoreVersion: "weighted-v2",
      sourceRecordId: "UC-sales-space-test",
      sourceVersion: "2026-08-02T12:00:00.000Z",
      evaluatedAt: "2026-08-02T12:00:00.000Z",
    });
    const listed = yield* sales.query(decodeQuery({ spaceId: "sales-space" }));

    expect(first.duplicate).toBe(false);
    expect(first.prospect.stage).toBe("researched");
    expect(first.prospect.opportunityCents).toBe(30_000);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.prospect.id).toBe(first.prospect.id);
    expect(refreshed.duplicate).toBe(true);
    expect(refreshed.prospect).toMatchObject({
      id: first.prospect.id,
      stage: "qualified",
      contactEmail: "new-contact@example.com",
      score: 91,
      sourceVersion: "2026-08-02T12:00:00.000Z",
    });
    expect(listed.prospects).toHaveLength(1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "atomically prepares an eligible draft from the stored recipient and idempotency key",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const sales = yield* SalesPipeline;
      yield* insertSpace(sql, "sales-space");
      const qualified = yield* sales.propose({
        ...proposal(),
        initialStage: "qualified",
        scoreVersion: "sales-weighted-v1",
        sourceRecordId: "UC-sales-space-test",
        sourceVersion: "2026-08-01T12:00:00.000Z",
      });
      const body = [
        "Hi Jordan,",
        "",
        "I looked through Founder Weekly and noticed the visual hierarchy shifts between recent weekly uploads. The ideas are clear, but the packaging does not always make the main promise equally easy to scan.",
        "",
        "We offer a paid $300 trial sprint for an upcoming long-form video. We would turn one real release into finished thumbnail options and a clearer direction you can reuse. This is not free speculative work or a promise about CTR.",
        "",
        "Would a short conversation about the next video be useful?",
        "",
        "Best,",
        "Andrew",
      ].join("\n");
      const input = {
        spaceId: qualified.prospect.spaceId,
        prospectId: qualified.prospect.id,
        connectionId: "sales-google",
        subject: "Founder Weekly thumbnail direction",
        body,
        evidenceReferences: [qualified.prospect.fit.thumbnailAudit],
        campaignStep: 0,
        campaignVersion: "sales-initial-v1",
        idempotencyKey: "initial:prospect-1:sales-initial-v1",
      } as const;
      const prepared = yield* sales.prepareAutomatedDraft(input);
      const retried = yield* sales.prepareAutomatedDraft(input);

      expect(prepared.request.recipient).toBe("business@example.com");
      expect(prepared.request.status).toBe("creating");
      expect(prepared.request.draftKind).toBe("initial");
      expect(retried.request.id).toBe(prepared.request.id);
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

    const duplicateActive = yield* Effect.flip(
      sales.requestDraft(
        decodeDraftRequest({
          requestId: "draft-request-2",
          prospectId: created.id,
          spaceId: "sales-space",
          connectionId: "sales-google",
          expectedUpdatedAt: qualified.prospect.updatedAt,
        }),
      ),
    );
    expect(duplicateActive.reason).toBe("conflict");

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
      sent: false,
      replied: false,
      observedAt: "2026-08-05T12:00:00.000Z",
    });
    const day3Snapshot = yield* sales.query(decodeQuery({ spaceId: "sales-space" }));
    const day3 = day3Snapshot.draftRequests.find((draft) => draft.campaignStep === 1)!;
    yield* sales.reconcileGmailEvidence({
      prospectId: drafted.prospect.id,
      spaceId: "sales-space",
      sent: true,
      replied: false,
      draftRequestId: day3.id,
      campaignStep: 1,
      observedAt: "2026-08-06T12:00:00.000Z",
    });
    const repeatedSent = yield* sales.reconcileGmailEvidence({
      prospectId: drafted.prospect.id,
      spaceId: "sales-space",
      sent: true,
      replied: false,
      draftRequestId: day3.id,
      campaignStep: 1,
      observedAt: "2026-08-09T12:00:00.000Z",
    });
    expect(repeatedSent.prospect.nextActionAt).toBe("2026-08-10T12:00:00.000Z");
    yield* sales.reconcileGmailEvidence({
      prospectId: drafted.prospect.id,
      spaceId: "sales-space",
      sent: false,
      replied: false,
      observedAt: "2026-08-10T12:00:00.000Z",
    });
    const previews = yield* sales.query(decodeQuery({ spaceId: "sales-space" }));
    const followUps = previews.draftRequests.filter((draft) =>
      draft.subject.startsWith("Following up:"),
    );
    expect(followUps).toHaveLength(2);
    expect(followUps.some((draft) => draft.campaignStep === 1 && draft.sentAt !== undefined)).toBe(
      true,
    );
    expect(followUps.some((draft) => draft.campaignStep === 2 && draft.status === "creating")).toBe(
      true,
    );
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

it.effect("defers due follow-ups when the daily draft allowance is exhausted", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sales = yield* SalesPipeline;
    yield* insertSpace(sql, "sales-space");
    const target = (yield* sales.propose(proposal())).prospect;
    const capProspect = (yield* sales.propose(
      decodeProposal({
        ...proposal("sales-space", "cap-research"),
        channelId: "UC-cap-prospect",
        channelName: "Cap Prospect",
        channelUrl: "https://youtube.com/@capprospect",
      }),
    )).prospect;
    const qualified = (yield* sales.update(
      decodeUpdate({
        prospectId: target.id,
        spaceId: "sales-space",
        expectedUpdatedAt: target.updatedAt,
        stage: "qualified",
      }),
    )).prospect;
    const requested = yield* sales.requestDraft(
      decodeDraftRequest({
        requestId: "cap-target-initial",
        prospectId: target.id,
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
    const drafted = yield* sales.completeDraftCreate({
      requestId: requested.request.id,
      spaceId: "sales-space",
      payloadDigest: requested.request.payloadDigest,
      draftId: "cap-target-draft",
      reconciled: false,
    });
    yield* sales.reconcileGmailEvidence({
      prospectId: drafted.prospect.id,
      spaceId: "sales-space",
      sent: true,
      replied: false,
      draftRequestId: requested.request.id,
      campaignStep: 0,
      observedAt: "2026-08-02T12:00:00.000Z",
    });
    for (let index = 0; index < 15; index += 1) {
      yield* sql`
        INSERT INTO command_center_sales_draft_requests (
          id, prospect_id, space_id, connection_id, recipient, subject, body,
          payload_digest, status, campaign_step, requested_at, sent_at, daily_bucket
        ) VALUES (
          ${`cap-draft-${index}`}, ${capProspect.id}, 'sales-space', 'sales-google',
          'cap@example.com', ${`Cap ${index}`}, 'Cap body', ${`cap-digest-${index}`},
          'created', 1, '2026-08-05T11:00:00.000Z', '2026-08-05T11:30:00.000Z',
          '2026-08-05'
        )
      `;
    }

    const deferred = yield* sales.reconcileGmailEvidence({
      prospectId: drafted.prospect.id,
      spaceId: "sales-space",
      sent: false,
      replied: false,
      observedAt: "2026-08-05T12:00:00.000Z",
    });
    const snapshot = yield* sales.query(decodeQuery({ spaceId: "sales-space" }));

    expect(deferred.prospect.nextActionAt).toBe("2026-08-05T12:00:00.000Z");
    expect(
      snapshot.draftRequests.filter(
        (draft) => draft.prospectId === target.id && draft.campaignStep > 0,
      ),
    ).toHaveLength(0);
  }).pipe(Effect.provide(testLayer)),
);
