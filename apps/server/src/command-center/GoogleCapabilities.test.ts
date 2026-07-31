import { describe, expect, it } from "@effect/vitest";

import {
  expandLegacyGoogleCapabilities,
  googleCapabilitiesFromConfig,
  googleCapabilityForOperation,
} from "./GoogleCapabilities.ts";

describe("Google capabilities", () => {
  it("maps private config grants independently", () => {
    expect(googleCapabilitiesFromConfig(["gmail.read"])).toEqual([
      "cc.connections.google.gmail.read",
    ]);
    expect(googleCapabilitiesFromConfig(["calendar.read", "drive.read"])).toEqual([
      "cc.connections.google.calendar.read",
      "cc.connections.google.drive.read",
    ]);
  });

  it("maps every connector operation to its least-privilege grant", () => {
    expect(googleCapabilityForOperation("gmail.search")).toBe("cc.connections.google.gmail.read");
    expect(googleCapabilityForOperation("calendar.freebusy")).toBe(
      "cc.connections.google.calendar.read",
    );
    expect(googleCapabilityForOperation("drive.export")).toBe("cc.connections.google.drive.read");
  });

  it("expands the legacy aggregate for policy compatibility without reissuing it", () => {
    expect(expandLegacyGoogleCapabilities(["cc.items.read", "cc.connections.google.read"])).toEqual(
      [
        "cc.items.read",
        "cc.connections.google.gmail.read",
        "cc.connections.google.calendar.read",
        "cc.connections.google.drive.read",
      ],
    );
  });
});
