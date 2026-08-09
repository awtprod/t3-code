import { describe, expect, it } from "vite-plus/test";

import {
  automationScheduleMatches,
  automationSchedulePresetExpression,
  describeAutomationSchedule,
  isValidAutomationTimeZone,
  nextAutomationScheduleOccurrences,
  parseAutomationCronExpression,
} from "./automationSchedule.js";

describe("automation schedules", () => {
  it("parses and matches the supported five-field grammar in a timezone", () => {
    expect(parseAutomationCronExpression("*/20 8-17 * * 1-5")).toBeDefined();
    expect(parseAutomationCronExpression("* * * *")).toBeUndefined();
    expect(isValidAutomationTimeZone("America/New_York")).toBe(true);
    expect(isValidAutomationTimeZone("Not/AZone")).toBe(false);
    expect(
      automationScheduleMatches("0 8 * * 1-5", "America/New_York", "2026-07-20T12:00:00Z"),
    ).toBe(true);
  });

  it("creates and describes friendly preset schedules", () => {
    expect(automationSchedulePresetExpression({ frequency: "weekdays", hour: 8, minute: 30 })).toBe(
      "30 8 * * 1-5",
    );
    expect(describeAutomationSchedule("30 8 * * 1-5")).toBe("Weekdays at 8:30 AM");
    expect(describeAutomationSchedule("0 9 15 * *")).toBe("Monthly on day 15 at 9:00 AM");
    expect(describeAutomationSchedule("0 9 * 1 *")).toBe("Custom recurring schedule");
  });

  it("previews future occurrences without exposing cron semantics to callers", () => {
    expect(
      nextAutomationScheduleOccurrences("0 9 * * *", "UTC", {
        // @effect-diagnostics-next-line globalDate:off -- fixed native date is the API input.
        from: new Date("2026-07-20T08:00:00Z"),
        count: 3,
      }),
    ).toEqual(["2026-07-20T09:00:00.000Z", "2026-07-21T09:00:00.000Z", "2026-07-22T09:00:00.000Z"]);
  });
});
