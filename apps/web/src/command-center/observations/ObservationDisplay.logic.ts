import type { ObservationSnapshot } from "@command-center/core";

import { randomUUID } from "../../lib/utils";

export function starterDraft(spaceId: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  const day = now.slice(0, 10);
  return JSON.stringify(
    {
      id: `observation:${id}`,
      spaceId,
      subjectId: "channel-id",
      channelId: "channel-id",
      contentKind: "channel",
      source: { identity: `manual:${id}`, revision: "1" },
      metric: {
        kind: "channel-subscribers",
        unit: "count",
        definition: "Subscribers at observation time",
      },
      collectionMethod: "manual",
      data: {
        value: null,
        missingReason: "Data not yet available",
        observedAt: now,
        collectedAt: now,
        period: { start: day, end: day, timeZone: "UTC" },
        sampleCount: null,
        denominator: { kind: "not-applicable", value: null },
        completeness: { status: "missing", reason: "Data not yet available" },
        reportingLagMs: null,
        freshThrough: null,
        metadata: {},
      },
    },
    null,
    2,
  );
}

export function metricValue(snapshot: ObservationSnapshot): string {
  const { value, missingReason } = snapshot.observation.data;
  return value === null
    ? `Missing — ${missingReason ?? "reason unavailable"}`
    : `${value.toLocaleString()} ${snapshot.observation.metric.unit}`;
}
