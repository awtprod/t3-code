import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  COMMAND_CENTER_OBSERVATION_BATCH_MAX_BYTES,
  COMMAND_CENTER_OBSERVATION_BATCH_MAX_COUNT,
  CommandCenterObservationCorrectionRequest,
  CommandCenterObservationImportRequest,
  CommandCenterObservationManualCreateRequest,
} from "./commandCenterObservations.ts";

const decodeCorrection = Schema.decodeUnknownSync(CommandCenterObservationCorrectionRequest);

const observation = {
  id: "observation-1",
  spaceId: "space-a",
  subjectId: "channel-a",
  channelId: "channel-a",
  contentKind: "channel",
  source: { identity: "manual-entry-a", revision: "1" },
  metric: {
    kind: "channel-subscribers",
    unit: "count",
    definition: "Current channel subscriber count.",
  },
  collectionMethod: "manual",
  data: {
    value: 10,
    observedAt: "2026-09-20T12:00:00.000Z",
    collectedAt: "2026-09-20T12:01:00.000Z",
    period: { start: "2026-09-20", end: "2026-09-20", timeZone: "UTC" },
    sampleCount: 1,
    denominator: { kind: "not-applicable", value: null },
    completeness: { status: "complete" },
    reportingLagMs: 60_000,
    freshThrough: "2026-09-20T12:00:00.000Z",
    metadata: {},
  },
} as const;

describe("Command Center observation public contracts", () => {
  it("allows manual creation but rejects connected and simulated input", () => {
    const decode = Schema.decodeUnknownSync(CommandCenterObservationManualCreateRequest);
    assert.doesNotThrow(() =>
      decode({ mutationId: "mutation-1", expectedVersion: 0, observation }),
    );
    assert.throws(() =>
      decode({
        mutationId: "mutation-1",
        expectedVersion: 0,
        observation: { ...observation, collectionMethod: "connected" },
      }),
    );
    assert.throws(() =>
      decode({
        mutationId: "mutation-1",
        expectedVersion: 0,
        observation: { ...observation, collectionMethod: "simulated" },
      }),
    );
  });

  it("accepts imported rows only and bounds batch count", () => {
    const decode = Schema.decodeUnknownSync(CommandCenterObservationImportRequest);
    const imported = { ...observation, collectionMethod: "imported" };
    assert.doesNotThrow(() => decode({ mutationId: "mutation-1", observations: [imported] }));
    assert.throws(() => decode({ mutationId: "mutation-1", observations: [observation] }));
    assert.throws(() =>
      decode({
        mutationId: "mutation-1",
        observations: Array.from(
          { length: COMMAND_CENTER_OBSERVATION_BATCH_MAX_COUNT + 1 },
          (_, index) => ({
            ...imported,
            id: `observation-${index}`,
            source: { identity: `source-${index}`, revision: "1" },
          }),
        ),
      }),
    );
  });

  it("bounds encoded import bytes", () => {
    const decode = Schema.decodeUnknownSync(CommandCenterObservationImportRequest);
    assert.throws(() =>
      decode({
        mutationId: "mutation-1",
        observations: [
          {
            ...observation,
            collectionMethod: "imported",
            metric: {
              ...observation.metric,
              definition: "x".repeat(COMMAND_CENTER_OBSERVATION_BATCH_MAX_BYTES),
            },
          },
        ],
      }),
    );
  });

  it("drops caller-supplied actor fields from correction input", () => {
    const decoded = decodeCorrection({
      mutationId: "mutation-2",
      spaceId: "space-a",
      observationId: "observation-1",
      expectedVersion: 1,
      reason: "Correct a transcription error.",
      data: observation.data,
      actor: { kind: "system", id: "forged" },
    });

    assert.notProperty(decoded, "actor");
  });
});
