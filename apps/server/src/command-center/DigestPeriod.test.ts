import { describe, expect, it } from "@effect/vitest";

import { digestPeriod, isDigestQuietHour } from "./DigestPeriod.ts";

describe("local digest period", () => {
  it("uses exact local day bounds across daylight-saving transitions", () => {
    const spring = digestPeriod("2026-03-08T16:00:00.000Z", "America/New_York");
    expect(spring).toMatchObject({
      localDate: "2026-03-08",
      startAt: "2026-03-08T05:00:00.000Z",
      endAt: "2026-03-09T04:00:00.000Z",
    });
    const fall = digestPeriod("2026-11-01T16:00:00.000Z", "America/New_York");
    expect(Date.parse(fall.endAt) - Date.parse(fall.startAt)).toBe(25 * 60 * 60 * 1_000);
  });

  it("suppresses fresh notification during configured overnight quiet hours", () => {
    expect(isDigestQuietHour("2026-09-28T02:00:00.000Z", "UTC", "22:00", "07:00")).toBe(true);
    expect(isDigestQuietHour("2026-09-28T12:00:00.000Z", "UTC", "22:00", "07:00")).toBe(false);
    expect(isDigestQuietHour("2026-09-28T02:00:00.000Z", "UTC", null, null)).toBe(false);
  });
});
