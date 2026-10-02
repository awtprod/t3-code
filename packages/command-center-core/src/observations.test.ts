import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ObservationDraft,
  ObservationEligibilityPolicy,
  ObservationSnapshot,
  evaluateObservationEligibility,
} from "./observations.ts";

const decodeDraft = Schema.decodeUnknownSync(ObservationDraft);
const decodeSnapshot = Schema.decodeUnknownSync(ObservationSnapshot);
const decodePolicy = Schema.decodeUnknownSync(ObservationEligibilityPolicy);

const base = {
  id: "observation-1",
  spaceId: "space-a",
  responsibilityId: "responsibility-a",
  planId: "plan-a",
  subjectId: "video-1",
  contentId: "video-1",
  channelId: "channel-1",
  cohortId: "shorts-30-45-seconds",
  contentKind: "short-form",
  source: { identity: "manual-entry-1", revision: "1" },
  metric: {
    kind: "thumbnail-impressions-ctr",
    unit: "percent",
    definition: "Impression click-through rate reported for this content.",
  },
  collectionMethod: "manual",
  data: {
    value: 4.5,
    observedAt: "2026-09-20T12:00:00.000Z",
    collectedAt: "2026-09-21T12:00:00.000Z",
    period: {
      start: "2026-09-13",
      end: "2026-09-20",
      timeZone: "America/New_York",
    },
    publishedAt: "2026-09-13T12:00:00.000Z",
    sampleCount: 1,
    denominator: { kind: "impressions", value: 2_000 },
    completeness: { status: "complete" },
    reportingLagMs: 86_400_000,
    freshThrough: "2026-09-20T23:59:59.000Z",
    metadata: { label: "synthetic fixture", tags: ["test", "short"] },
  },
} as const;

const snapshot = (draft: unknown = base) =>
  decodeSnapshot({
    observation: draft,
    revisionId: "revision-1",
    version: 1,
    revisionDigest: "sha256:fixture",
    revisionKind: "created",
    revisionReason: null,
    actor: { kind: "user", id: "server-user" },
    revisedAt: "2026-09-21T12:00:00.000Z",
    retired: false,
    hasCollectionConflict: false,
  });

const policy = decodePolicy({
  id: "short-ctr-policy",
  version: 1,
  metricKind: "thumbnail-impressions-ctr",
  contentKind: "short-form",
  cohortId: "shorts-30-45-seconds",
  minimumMaturityMs: 7 * 86_400_000,
  minimumSampleCount: 1,
  minimumDenominator: { kind: "impressions", value: 1_000 },
  maximumAgeMs: 14 * 86_400_000,
  maximumReportingLagMs: 2 * 86_400_000,
  requiredCompleteness: "complete",
});

describe("ObservationDraft", () => {
  it("keeps a missing value distinct from a measured zero", () => {
    const missing = decodeDraft({
      ...base,
      data: { ...base.data, value: null, missingReason: "Not reported yet." },
    });
    const zero = decodeDraft({ ...base, data: { ...base.data, value: 0 } });

    assert.strictEqual(missing.data.value, null);
    assert.strictEqual(zero.data.value, 0);
    assert.throws(() => decodeDraft({ ...base, data: { ...base.data, value: null } }));
  });

  it("enforces metric units, formats, identities, and denominator kinds", () => {
    assert.throws(() => decodeDraft({ ...base, metric: { ...base.metric, unit: "count" } }));
    assert.throws(() => decodeDraft({ ...base, contentKind: "channel" }));
    assert.throws(() => decodeDraft({ ...base, contentId: undefined }));
    assert.throws(() =>
      decodeDraft({
        ...base,
        data: { ...base.data, denominator: { kind: "views", value: 2_000 } },
      }),
    );
  });

  it("accepts APV over 100 but rejects CTR over 100", () => {
    assert.doesNotThrow(() =>
      decodeDraft({
        ...base,
        metric: {
          kind: "average-view-percentage",
          unit: "percent",
          definition: "Average percentage viewed including repeat viewing.",
        },
        data: {
          ...base.data,
          value: 125.5,
          denominator: { kind: "views", value: 2_000 },
        },
      }),
    );
    assert.throws(() => decodeDraft({ ...base, data: { ...base.data, value: 100.01 } }));
  });

  it("rejects invalid dates, unsafe counts, negative durations, and oversized metadata", () => {
    assert.throws(() =>
      decodeDraft({
        ...base,
        data: { ...base.data, period: { ...base.data.period, start: "2026-02-30" } },
      }),
    );
    assert.throws(() =>
      decodeDraft({ ...base, data: { ...base.data, sampleCount: Number.MAX_SAFE_INTEGER + 1 } }),
    );
    assert.throws(() => decodeDraft({ ...base, data: { ...base.data, reportingLagMs: -1 } }));
    assert.throws(() =>
      decodeDraft({ ...base, data: { ...base.data, metadata: { text: "x".repeat(5_000) } } }),
    );
  });
});

describe("evaluateObservationEligibility", () => {
  it("returns not-configured and collect-data without inventing defaults", () => {
    assert.deepStrictEqual(
      evaluateObservationEligibility({
        policy: null,
        evidence: snapshot(),
        asOf: "2026-09-22T12:00:00.000Z" as never,
      }),
      {
        status: "not-configured",
        reasons: ["policy-not-configured"],
        nextAction: "collect-data",
        policyDigest: null,
        evidenceRevisionId: "revision-1" as never,
        evidenceRevisionDigest: "sha256:fixture",
      },
    );
  });

  it("rejects evidence collected after the evaluation time", () => {
    const future = evaluateObservationEligibility({
      policy,
      evidence: snapshot({
        ...base,
        data: {
          ...base.data,
          observedAt: "2026-09-23T12:00:00.000Z",
          collectedAt: "2026-09-23T12:00:00.000Z",
        },
      }),
      asOf: "2026-09-22T12:00:00.000Z" as never,
    });
    assert.strictEqual(future.status, "insufficient");
    assert.include(future.reasons, "evidence-not-yet-available");
    assert.notInclude(future.reasons, "evidence-stale");
  });

  it("judges maturity when the evidence was observed, not when it is reviewed", () => {
    const publishedAt = "2026-09-13T12:00:00.000Z";
    const reviewedLate = "2026-09-22T12:00:00.000Z" as never;
    // Measured one day after publication: still immature eight days later.
    const early = evaluateObservationEligibility({
      policy,
      evidence: snapshot({
        ...base,
        data: { ...base.data, publishedAt, observedAt: "2026-09-14T12:00:00.000Z" },
      }),
      asOf: reviewedLate,
    });
    assert.include(early.reasons, "evidence-immature");
    // Measured seven days after publication: mature.
    const mature = evaluateObservationEligibility({
      policy,
      evidence: snapshot({
        ...base,
        data: { ...base.data, publishedAt, observedAt: "2026-09-20T12:00:00.000Z" },
      }),
      asOf: reviewedLate,
    });
    assert.notInclude(mature.reasons, "evidence-immature");
  });

  it("rejects immature, unknown-denominator, and short/long mismatched evidence", () => {
    const immature = evaluateObservationEligibility({
      policy,
      evidence: snapshot({
        ...base,
        data: { ...base.data, publishedAt: "2026-09-21T12:00:00.000Z" },
      }),
      asOf: "2026-09-22T12:00:00.000Z" as never,
    });
    assert.include(immature.reasons, "evidence-immature");

    const missingDenominator = evaluateObservationEligibility({
      policy,
      evidence: snapshot({
        ...base,
        data: { ...base.data, denominator: { kind: "impressions", value: null } },
      }),
      asOf: "2026-09-22T12:00:00.000Z" as never,
    });
    assert.include(missingDenominator.reasons, "denominator-missing");

    const longFormPolicy = decodePolicy({ ...policy, contentKind: "long-form" });
    const mismatched = evaluateObservationEligibility({
      policy: longFormPolicy,
      evidence: snapshot(),
      asOf: "2026-09-22T12:00:00.000Z" as never,
    });
    assert.include(mismatched.reasons, "content-format-mismatch");
  });

  it("includes policy and immutable evidence identities without significance claims", () => {
    const result = evaluateObservationEligibility({
      policy,
      evidence: snapshot(),
      asOf: "2026-09-22T12:00:00.000Z" as never,
    });

    assert.strictEqual(result.status, "eligible");
    assert.match(result.policyDigest ?? "", /^policy-v1:/u);
    assert.strictEqual(result.evidenceRevisionId, "revision-1");
    assert.strictEqual(result.evidenceRevisionDigest, "sha256:fixture");
    assert.strictEqual(result.nextAction, "review-without-causality-claim");
  });
});
