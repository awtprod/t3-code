import { describe, expect, it } from "vite-plus/test";

import { agentNotificationKind } from "./agentNotificationKind.ts";

describe("agentNotificationKind", () => {
  it("does not fire on first observation of a thread", () => {
    expect(agentNotificationKind(null, "completed")).toBeNull();
    expect(agentNotificationKind(null, "waiting_for_approval")).toBeNull();
  });

  it("does not fire when the phase is unchanged", () => {
    expect(agentNotificationKind("running", "running")).toBeNull();
    expect(agentNotificationKind("waiting_for_input", "waiting_for_input")).toBeNull();
  });

  it("fires 'completed' from any active phase", () => {
    expect(agentNotificationKind("running", "completed")).toBe("completed");
    expect(agentNotificationKind("starting", "completed")).toBe("completed");
    expect(agentNotificationKind("waiting_for_approval", "completed")).toBe("completed");
    expect(agentNotificationKind("waiting_for_input", "completed")).toBe("completed");
  });

  it("does not fire 'completed' from a terminal phase (replay guard)", () => {
    expect(agentNotificationKind("failed", "completed")).toBeNull();
    expect(agentNotificationKind("stale", "completed")).toBeNull();
  });

  it("fires 'failed' from any active phase", () => {
    expect(agentNotificationKind("running", "failed")).toBe("failed");
    expect(agentNotificationKind("waiting_for_input", "failed")).toBe("failed");
  });

  it("fires 'approval-needed' entering waiting_for_approval from a non-approval phase", () => {
    expect(agentNotificationKind("running", "waiting_for_approval")).toBe("approval-needed");
    expect(agentNotificationKind("starting", "waiting_for_approval")).toBe("approval-needed");
  });

  it("fires 'input-needed' entering waiting_for_input from a non-input phase", () => {
    expect(agentNotificationKind("running", "waiting_for_input")).toBe("input-needed");
  });

  it("does not fire for transitions into running/starting", () => {
    expect(agentNotificationKind("waiting_for_approval", "running")).toBeNull();
    expect(agentNotificationKind("completed", "running")).toBeNull();
  });
});
