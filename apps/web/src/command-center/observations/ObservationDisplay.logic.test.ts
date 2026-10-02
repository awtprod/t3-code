import { ObservationDraft, type ObservationSnapshot } from "@command-center/core";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { metricValue, starterDraft } from "./ObservationDisplay.logic";

const decode = Schema.decodeUnknownSync(ObservationDraft);

describe("Observation display", () => {
  it("offers a valid manual draft with an explicit reason for missing data", () => {
    const first = decode(JSON.parse(starterDraft("space-a")));
    const second = decode(JSON.parse(starterDraft("space-a")));
    expect(first.spaceId).toBe("space-a");
    expect(first.collectionMethod).toBe("manual");
    expect(first.data.value).toBeNull();
    expect(first.data.missingReason).toBeTruthy();
    expect(first.source.identity).not.toBe(second.source.identity);
  });

  it("labels absent values without treating them as zero", () => {
    const observation = decode(JSON.parse(starterDraft("space-a")));
    const snapshot = { observation } as ObservationSnapshot;
    expect(metricValue(snapshot)).toContain("Missing");
    expect(
      metricValue({
        ...snapshot,
        observation: {
          ...observation,
          data: { ...observation.data, value: 0, missingReason: undefined },
        },
      }),
    ).toBe("0 count");
  });
});
