import { describe, expect, it } from "vite-plus/test";

import { notificationBody } from "./notificationCopy.ts";

describe("notificationBody", () => {
  it("joins the headline and project title", () => {
    expect(notificationBody({ headline: "Approval needed", projectTitle: "My Project" })).toBe(
      "Approval needed: My Project",
    );
  });
});
