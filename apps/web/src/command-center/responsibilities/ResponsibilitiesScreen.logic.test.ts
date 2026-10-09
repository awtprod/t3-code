import { describe, expect, it } from "@effect/vitest";
import type {
  CommandCenterResponsibilityDetail,
  CommandCenterResponsibilityStatus,
} from "@t3tools/contracts";

import {
  withResponsibilityDetailReceipt,
  withResponsibilityReceipt,
} from "./ResponsibilitiesScreen.logic";

const status = {
  spaceId: "space-a",
  automationId: "automation-a",
  pauseVersion: 1,
  paused: false,
} as CommandCenterResponsibilityStatus;

const detail = {
  ...status,
  history: [
    {
      executionId: "execution-a",
      workIdentity: "responsibility:v1:space-a:automation-a",
      state: "succeeded",
      startedAt: "2026-09-28T12:00:00.000Z",
      finishedAt: "2026-09-28T12:00:01.000Z",
      error: null,
      usefulResultRef: null,
      preparationResult: null,
    },
  ],
} as CommandCenterResponsibilityDetail;

describe("Responsibility control receipt display", () => {
  it("shows the new pause revision until the refreshed query catches up", () => {
    const receipt = { ...status, paused: true, pauseVersion: 2 };
    expect(withResponsibilityReceipt([status], receipt)[0]?.paused).toBe(true);
    expect(withResponsibilityDetailReceipt(detail, receipt)).toMatchObject({
      paused: true,
      pauseVersion: 2,
      history: [{ executionId: "execution-a" }],
    });
  });

  it("does not apply a receipt to another Space, Automation, or newer revision", () => {
    const receipt = { ...status, paused: true, pauseVersion: 2 };
    expect(withResponsibilityReceipt([{ ...status, spaceId: "space-b" }], receipt)[0]?.paused).toBe(
      false,
    );
    expect(
      withResponsibilityReceipt([{ ...status, automationId: "automation-b" }], receipt)[0]?.paused,
    ).toBe(false);
    expect(withResponsibilityDetailReceipt({ ...detail, pauseVersion: 3 }, receipt)?.paused).toBe(
      false,
    );
    expect(withResponsibilityDetailReceipt({ ...detail, pauseVersion: 2 }, receipt)?.paused).toBe(
      false,
    );
  });
});
