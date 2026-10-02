import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { SpaceId, TrimmedNonEmptyString } from "./domain.ts";

export const OBSERVATION_METADATA_MAX_BYTES = 4_096;
export const OBSERVATION_METADATA_MAX_ENTRIES = 32;
export const OBSERVATION_METADATA_MAX_ARRAY_LENGTH = 16;
export const OBSERVATION_METADATA_MAX_STRING_LENGTH = 512;

const shortString = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const longString = TrimmedNonEmptyString.check(Schema.isMaxLength(2_048));
const safeNonNegativeInt = Schema.Int.check(
  Schema.makeFilter(
    (value) => Number.isSafeInteger(value) || "Expected a non-negative safe integer.",
  ),
  Schema.isGreaterThanOrEqualTo(0),
);

const isIsoInstant = (value: string): true | string =>
  (/T/u.test(value) &&
    /(Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    Option.isSome(DateTime.make(value))) ||
  "Expected an ISO-8601 instant with an explicit offset.";

const isCalendarDate = (value: string): true | string => {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return "Expected a calendar date in YYYY-MM-DD form.";
  }
  const parsed = DateTime.make(`${value}T00:00:00.000Z`);
  return (
    (Option.isSome(parsed) && DateTime.formatIsoDateUtc(parsed.value) === value) ||
    "Expected a valid calendar date."
  );
};

export const ObservationIsoInstant = TrimmedNonEmptyString.check(Schema.makeFilter(isIsoInstant));
export type ObservationIsoInstant = typeof ObservationIsoInstant.Type;

export const ObservationCalendarDate = TrimmedNonEmptyString.check(
  Schema.makeFilter(isCalendarDate),
);
export type ObservationCalendarDate = typeof ObservationCalendarDate.Type;

export const ObservationTimeZone = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.makeFilter(
    (value) =>
      Option.isSome(DateTime.zoneMakeNamed(value)) || "Expected a valid named IANA time zone.",
  ),
);
export type ObservationTimeZone = typeof ObservationTimeZone.Type;

const makeId = <Brand extends string>(brand: Brand) => shortString.pipe(Schema.brand(brand));

export const ObservationId = makeId("CommandCenterObservationId");
export type ObservationId = typeof ObservationId.Type;
export const ObservationRevisionId = makeId("CommandCenterObservationRevisionId");
export type ObservationRevisionId = typeof ObservationRevisionId.Type;
export const ObservationMutationId = makeId("CommandCenterObservationMutationId");
export type ObservationMutationId = typeof ObservationMutationId.Type;

export const ObservationContentKind = Schema.Literals([
  "short-form",
  "long-form",
  "channel",
  "app",
]);
export type ObservationContentKind = typeof ObservationContentKind.Type;

export const ObservationMetricKind = Schema.Literals([
  "channel-subscribers",
  "content-subscribers",
  "best-short-views",
  "thumbnail-impressions-ctr",
  "average-view-percentage",
  "average-view-duration",
  "app-follows",
]);
export type ObservationMetricKind = typeof ObservationMetricKind.Type;

export const ObservationMetricUnit = Schema.Literals(["count", "percent", "milliseconds"]);
export type ObservationMetricUnit = typeof ObservationMetricUnit.Type;

export const ObservationCollectionMethod = Schema.Literals(["manual", "imported", "connected"]);
export type ObservationCollectionMethod = typeof ObservationCollectionMethod.Type;

export const ObservationDenominatorKind = Schema.Literals([
  "impressions",
  "views",
  "content-items",
  "accounts",
  "not-applicable",
]);
export type ObservationDenominatorKind = typeof ObservationDenominatorKind.Type;

export const ObservationSource = Schema.Struct({
  identity: shortString,
  revision: shortString,
});
export type ObservationSource = typeof ObservationSource.Type;

export const ObservationMetric = Schema.Struct({
  kind: ObservationMetricKind,
  unit: ObservationMetricUnit,
  definition: longString,
});
export type ObservationMetric = typeof ObservationMetric.Type;

export const ObservationPeriod = Schema.Struct({
  start: ObservationCalendarDate,
  end: ObservationCalendarDate,
  timeZone: ObservationTimeZone,
}).check(
  Schema.makeFilter(
    ({ start, end }) => start <= end || "Observation period start must not follow its end.",
  ),
);
export type ObservationPeriod = typeof ObservationPeriod.Type;

export const ObservationCompleteness = Schema.Struct({
  status: Schema.Literals(["complete", "partial", "missing"]),
  reason: Schema.optional(longString),
}).check(
  Schema.makeFilter((value) => {
    if (value.status === "complete") {
      return value.reason === undefined || "Complete observations must not carry a missing reason.";
    }
    return value.reason !== undefined || "Partial and missing observations require a reason.";
  }),
);
export type ObservationCompleteness = typeof ObservationCompleteness.Type;

const metadataScalar = Schema.Union([
  Schema.Null,
  Schema.Boolean,
  Schema.Number.check(Schema.isFinite()),
  Schema.String.check(Schema.isMaxLength(OBSERVATION_METADATA_MAX_STRING_LENGTH)),
]);
const metadataValue = Schema.Union([
  metadataScalar,
  Schema.Array(metadataScalar).check(Schema.isMaxLength(OBSERVATION_METADATA_MAX_ARRAY_LENGTH)),
]);

export const ObservationMetadata = Schema.Record(
  Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  metadataValue,
).check(
  Schema.makeFilter((value) => {
    if (Object.keys(value).length > OBSERVATION_METADATA_MAX_ENTRIES) {
      return `Observation metadata may contain at most ${OBSERVATION_METADATA_MAX_ENTRIES} entries.`;
    }
    return (
      new TextEncoder().encode(JSON.stringify(value)).byteLength <=
        OBSERVATION_METADATA_MAX_BYTES ||
      `Observation metadata may contain at most ${OBSERVATION_METADATA_MAX_BYTES} UTF-8 bytes.`
    );
  }),
);
export type ObservationMetadata = typeof ObservationMetadata.Type;

export const ObservationData = Schema.Struct({
  value: Schema.NullOr(Schema.Number.check(Schema.isFinite())),
  missingReason: Schema.optional(longString),
  observedAt: ObservationIsoInstant,
  collectedAt: ObservationIsoInstant,
  period: ObservationPeriod,
  publishedAt: Schema.optional(ObservationIsoInstant),
  sampleCount: Schema.NullOr(safeNonNegativeInt),
  denominator: Schema.Struct({
    kind: ObservationDenominatorKind,
    value: Schema.NullOr(safeNonNegativeInt),
  }),
  completeness: ObservationCompleteness,
  reportingLagMs: Schema.NullOr(safeNonNegativeInt),
  freshThrough: Schema.NullOr(ObservationIsoInstant),
  metadata: ObservationMetadata,
}).check(
  Schema.makeFilter((data) => {
    if (data.value === null && data.missingReason === undefined) {
      return "A missing metric value requires a missing reason.";
    }
    if (data.value !== null && data.missingReason !== undefined) {
      return "A present metric value must not carry a missing reason.";
    }
    if (
      DateTime.toEpochMillis(DateTime.makeUnsafe(data.observedAt)) >
      DateTime.toEpochMillis(DateTime.makeUnsafe(data.collectedAt))
    ) {
      return "Observation time must not follow collection time.";
    }
    return true;
  }),
);
export type ObservationData = typeof ObservationData.Type;

const expectedMetricShape: Record<
  ObservationMetricKind,
  {
    readonly unit: ObservationMetricUnit;
    readonly contentKinds: ReadonlyArray<ObservationContentKind>;
    readonly denominatorKind: ObservationDenominatorKind;
  }
> = {
  "channel-subscribers": {
    unit: "count",
    contentKinds: ["channel"],
    denominatorKind: "not-applicable",
  },
  "content-subscribers": {
    unit: "count",
    contentKinds: ["short-form", "long-form"],
    denominatorKind: "views",
  },
  "best-short-views": {
    unit: "count",
    contentKinds: ["short-form"],
    denominatorKind: "content-items",
  },
  "thumbnail-impressions-ctr": {
    unit: "percent",
    contentKinds: ["short-form", "long-form"],
    denominatorKind: "impressions",
  },
  "average-view-percentage": {
    unit: "percent",
    contentKinds: ["short-form", "long-form"],
    denominatorKind: "views",
  },
  "average-view-duration": {
    unit: "milliseconds",
    contentKinds: ["short-form", "long-form"],
    denominatorKind: "views",
  },
  "app-follows": {
    unit: "count",
    contentKinds: ["app"],
    denominatorKind: "accounts",
  },
};

export const ObservationDraft = Schema.Struct({
  id: ObservationId,
  spaceId: SpaceId,
  responsibilityId: Schema.optional(shortString),
  planId: Schema.optional(shortString),
  subjectId: shortString,
  contentId: Schema.optional(shortString),
  channelId: Schema.optional(shortString),
  cohortId: Schema.optional(shortString),
  contentKind: ObservationContentKind,
  source: ObservationSource,
  metric: ObservationMetric,
  collectionMethod: ObservationCollectionMethod,
  data: ObservationData,
}).check(
  Schema.makeFilter((observation) => {
    const expected = expectedMetricShape[observation.metric.kind];
    if (observation.metric.unit !== expected.unit) {
      return `${observation.metric.kind} must use ${expected.unit}.`;
    }
    if (!expected.contentKinds.includes(observation.contentKind)) {
      return `${observation.metric.kind} is incompatible with ${observation.contentKind}.`;
    }
    if (observation.data.denominator.kind !== expected.denominatorKind) {
      return `${observation.metric.kind} must use a ${expected.denominatorKind} denominator.`;
    }
    if (
      expected.denominatorKind === "not-applicable" &&
      observation.data.denominator.value !== null
    ) {
      return "A not-applicable denominator must have a null value.";
    }
    if (observation.contentKind === "channel" && observation.channelId === undefined) {
      return "Channel observations require a durable channel identity.";
    }
    if (
      (observation.contentKind === "short-form" || observation.contentKind === "long-form") &&
      (observation.contentId === undefined || observation.cohortId === undefined)
    ) {
      return "Content observations require durable content and cohort identities.";
    }
    if (observation.contentKind === "app" && observation.cohortId === undefined) {
      return "App observations require a durable cohort identity.";
    }
    if (
      (observation.contentKind === "short-form" || observation.contentKind === "long-form") &&
      observation.data.publishedAt === undefined
    ) {
      return "Content observations require a publication time for maturity checks.";
    }
    const value = observation.data.value;
    if (value === null) {
      return true;
    }
    if (expected.unit === "count" && (!Number.isSafeInteger(value) || value < 0)) {
      return "Count metrics require a non-negative safe integer value.";
    }
    if (observation.metric.kind === "thumbnail-impressions-ctr") {
      return (value >= 0 && value <= 100) || "CTR must be between 0 and 100.";
    }
    if (observation.metric.kind === "average-view-percentage") {
      return value >= 0 || "Average view percentage must be non-negative.";
    }
    if (expected.unit === "milliseconds") {
      return Number.isSafeInteger(value) && value >= 0
        ? true
        : "Duration metrics require non-negative safe integer milliseconds.";
    }
    return value >= 0 || "Metric value must be non-negative.";
  }),
);
export type ObservationDraft = typeof ObservationDraft.Type;

export const ObservationActor = Schema.Struct({
  kind: Schema.Literals(["user", "system", "connector"]),
  id: shortString,
});
export type ObservationActor = typeof ObservationActor.Type;

export const ObservationRevisionKind = Schema.Literals(["created", "corrected", "retired"]);
export type ObservationRevisionKind = typeof ObservationRevisionKind.Type;

export const ObservationSnapshot = Schema.Struct({
  observation: ObservationDraft,
  revisionId: ObservationRevisionId,
  version: safeNonNegativeInt.check(Schema.isGreaterThanOrEqualTo(1)),
  revisionDigest: shortString,
  revisionKind: ObservationRevisionKind,
  revisionReason: Schema.NullOr(longString),
  actor: ObservationActor,
  revisedAt: ObservationIsoInstant,
  retired: Schema.Boolean,
  hasCollectionConflict: Schema.Boolean,
});
export type ObservationSnapshot = typeof ObservationSnapshot.Type;

export const ObservationEligibilityPolicy = Schema.Struct({
  id: shortString,
  version: safeNonNegativeInt.check(Schema.isGreaterThanOrEqualTo(1)),
  metricKind: ObservationMetricKind,
  contentKind: ObservationContentKind,
  cohortId: Schema.NullOr(shortString),
  minimumMaturityMs: safeNonNegativeInt,
  minimumSampleCount: Schema.NullOr(safeNonNegativeInt.check(Schema.isGreaterThanOrEqualTo(1))),
  minimumDenominator: Schema.NullOr(
    Schema.Struct({
      kind: ObservationDenominatorKind,
      value: safeNonNegativeInt.check(Schema.isGreaterThanOrEqualTo(1)),
    }),
  ),
  maximumAgeMs: safeNonNegativeInt,
  maximumReportingLagMs: safeNonNegativeInt,
  requiredCompleteness: Schema.Literals(["complete", "complete-or-partial"]),
});
export type ObservationEligibilityPolicy = typeof ObservationEligibilityPolicy.Type;

export const ObservationEligibilityReason = Schema.Literals([
  "policy-not-configured",
  "evidence-absent",
  "evidence-retired",
  "value-missing",
  "metric-mismatch",
  "content-format-mismatch",
  "cohort-mismatch",
  "publication-time-missing",
  "evidence-immature",
  "sample-count-missing",
  "sample-count-too-small",
  "denominator-kind-mismatch",
  "denominator-missing",
  "denominator-too-small",
  "evidence-stale",
  "evidence-not-yet-available",
  "reporting-lag-missing",
  "reporting-lag-too-high",
  "evidence-incomplete",
]);
export type ObservationEligibilityReason = typeof ObservationEligibilityReason.Type;

export interface ObservationEligibilityResult {
  readonly status: "eligible" | "insufficient" | "not-configured";
  readonly reasons: ReadonlyArray<ObservationEligibilityReason>;
  readonly nextAction: "collect-data" | "review-without-causality-claim";
  readonly policyDigest: string | null;
  readonly evidenceRevisionId: ObservationRevisionId | null;
  readonly evidenceRevisionDigest: string | null;
}

export const digestObservationEligibilityPolicy = (policy: ObservationEligibilityPolicy): string =>
  `policy-v1:${JSON.stringify({
    id: policy.id,
    version: policy.version,
    metricKind: policy.metricKind,
    contentKind: policy.contentKind,
    cohortId: policy.cohortId,
    minimumMaturityMs: policy.minimumMaturityMs,
    minimumSampleCount: policy.minimumSampleCount,
    minimumDenominator: policy.minimumDenominator,
    maximumAgeMs: policy.maximumAgeMs,
    maximumReportingLagMs: policy.maximumReportingLagMs,
    requiredCompleteness: policy.requiredCompleteness,
  })}`;

export const evaluateObservationEligibility = (input: {
  readonly policy: ObservationEligibilityPolicy | null;
  readonly evidence: ObservationSnapshot | null;
  readonly asOf: ObservationIsoInstant;
}): ObservationEligibilityResult => {
  if (input.policy === null) {
    return {
      status: "not-configured",
      reasons: ["policy-not-configured"],
      nextAction: "collect-data",
      policyDigest: null,
      evidenceRevisionId: input.evidence?.revisionId ?? null,
      evidenceRevisionDigest: input.evidence?.revisionDigest ?? null,
    };
  }

  const policyDigest = digestObservationEligibilityPolicy(input.policy);
  if (input.evidence === null) {
    return {
      status: "insufficient",
      reasons: ["evidence-absent"],
      nextAction: "collect-data",
      policyDigest,
      evidenceRevisionId: null,
      evidenceRevisionDigest: null,
    };
  }

  const reasons: Array<ObservationEligibilityReason> = [];
  const evidence = input.evidence;
  const observation = evidence.observation;
  const data = observation.data;
  if (evidence.retired) reasons.push("evidence-retired");
  if (data.value === null) reasons.push("value-missing");
  if (observation.metric.kind !== input.policy.metricKind) reasons.push("metric-mismatch");
  if (observation.contentKind !== input.policy.contentKind) {
    reasons.push("content-format-mismatch");
  }
  if (observation.cohortId !== (input.policy.cohortId ?? undefined)) {
    reasons.push("cohort-mismatch");
  }

  const asOfMs = DateTime.toEpochMillis(DateTime.makeUnsafe(input.asOf));
  if (data.publishedAt === undefined) {
    if (input.policy.minimumMaturityMs > 0) reasons.push("publication-time-missing");
  } else if (
    // Maturity is a property of the measurement: how old the content was when
    // it was observed. Waiting longer does not make an early measurement mature.
    DateTime.toEpochMillis(DateTime.makeUnsafe(data.observedAt)) -
      DateTime.toEpochMillis(DateTime.makeUnsafe(data.publishedAt)) <
    input.policy.minimumMaturityMs
  ) {
    reasons.push("evidence-immature");
  }

  if (input.policy.minimumSampleCount !== null) {
    if (data.sampleCount === null) reasons.push("sample-count-missing");
    else if (data.sampleCount < input.policy.minimumSampleCount) {
      reasons.push("sample-count-too-small");
    }
  }

  if (input.policy.minimumDenominator !== null) {
    if (data.denominator.kind !== input.policy.minimumDenominator.kind) {
      reasons.push("denominator-kind-mismatch");
    } else if (data.denominator.value === null) {
      reasons.push("denominator-missing");
    } else if (data.denominator.value < input.policy.minimumDenominator.value) {
      reasons.push("denominator-too-small");
    }
  }

  const collectedAtMs = DateTime.toEpochMillis(DateTime.makeUnsafe(data.collectedAt));
  // Evidence collected after the evaluation time did not exist yet; a negative
  // age must not pass the maximum-age check.
  if (collectedAtMs > asOfMs) reasons.push("evidence-not-yet-available");
  else if (asOfMs - collectedAtMs > input.policy.maximumAgeMs) reasons.push("evidence-stale");
  if (data.reportingLagMs === null) reasons.push("reporting-lag-missing");
  else if (data.reportingLagMs > input.policy.maximumReportingLagMs) {
    reasons.push("reporting-lag-too-high");
  }

  if (
    data.completeness.status === "missing" ||
    (input.policy.requiredCompleteness === "complete" && data.completeness.status !== "complete")
  ) {
    reasons.push("evidence-incomplete");
  }

  return {
    status: reasons.length === 0 ? "eligible" : "insufficient",
    reasons,
    nextAction: reasons.length === 0 ? "review-without-causality-claim" : "collect-data",
    policyDigest,
    evidenceRevisionId: evidence.revisionId,
    evidenceRevisionDigest: evidence.revisionDigest,
  };
};
