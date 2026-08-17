import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  clearThreadAlert,
  isThreadAlertExpired,
  markThreadAlert,
  markThreadAlertsFocused,
  pruneExpiredThreadAlerts,
  readThreadAlerts,
  THREAD_ALERT_FOCUSED_TTL_MS,
  THREAD_ALERT_MAX_TTL_MS,
} from "./threadAlertStore.ts";

const threadA = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-a"),
};
const threadB = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-b"),
};

afterEach(() => {
  clearThreadAlert(threadA);
  clearThreadAlert(threadB);
});

describe("threadAlertStore", () => {
  it("marks and reads back an alert", () => {
    markThreadAlert(threadA, "completed", { nowMs: 1_000, windowFocused: false });
    const alerts = readThreadAlerts();
    expect(alerts[Object.keys(alerts)[0]!]).toMatchObject({ kind: "completed" });
  });

  it("a failure outranks a completion for the same thread", () => {
    markThreadAlert(threadA, "failed", { nowMs: 1_000, windowFocused: false });
    markThreadAlert(threadA, "completed", { nowMs: 1_100, windowFocused: false });
    const alerts = readThreadAlerts();
    const key = Object.keys(alerts).find((k) => alerts[k] !== undefined)!;
    expect(alerts[key]?.kind).toBe("failed");
  });

  it("a completion does not overwrite an existing failure, but does overwrite another completion", () => {
    markThreadAlert(threadA, "completed", { nowMs: 1_000, windowFocused: false });
    markThreadAlert(threadA, "completed", { nowMs: 1_100, windowFocused: false });
    const alerts = readThreadAlerts();
    const key = Object.keys(alerts).find((k) => alerts[k] !== undefined)!;
    expect(alerts[key]?.markedAtMs).toBe(1_100);
  });

  it("starts the focused countdown immediately when raised while focused", () => {
    markThreadAlert(threadA, "completed", { nowMs: 1_000, windowFocused: true });
    const alerts = readThreadAlerts();
    const key = Object.keys(alerts).find((k) => alerts[k] !== undefined)!;
    expect(alerts[key]?.focusedAtMs).toBe(1_000);
  });

  it("does not start the focused countdown when raised unfocused", () => {
    markThreadAlert(threadA, "completed", { nowMs: 1_000, windowFocused: false });
    const alerts = readThreadAlerts();
    const key = Object.keys(alerts).find((k) => alerts[k] !== undefined)!;
    expect(alerts[key]?.focusedAtMs).toBeNull();
  });

  it("clears an alert", () => {
    markThreadAlert(threadA, "completed", { nowMs: 1_000, windowFocused: false });
    clearThreadAlert(threadA);
    expect(Object.keys(readThreadAlerts())).toHaveLength(0);
  });

  it("marks every live alert focused, without moving an already-focused deadline", () => {
    markThreadAlert(threadA, "completed", { nowMs: 1_000, windowFocused: false });
    markThreadAlert(threadB, "failed", { nowMs: 1_000, windowFocused: true });
    markThreadAlertsFocused(2_000);
    const alerts = readThreadAlerts();
    const values = Object.values(alerts);
    const nowFocused = values.find((a) => a.kind === "completed");
    const alreadyFocused = values.find((a) => a.kind === "failed");
    expect(nowFocused?.focusedAtMs).toBe(2_000);
    expect(alreadyFocused?.focusedAtMs).toBe(1_000);
  });

  it("prunes alerts that outlived the focused TTL or the hard ceiling", () => {
    markThreadAlert(threadA, "completed", { nowMs: 0, windowFocused: true });
    pruneExpiredThreadAlerts(THREAD_ALERT_FOCUSED_TTL_MS);
    expect(Object.keys(readThreadAlerts())).toHaveLength(0);
  });

  it("isThreadAlertExpired respects both bounds", () => {
    const raisedUnfocused = { kind: "completed" as const, markedAtMs: 0, focusedAtMs: null };
    expect(isThreadAlertExpired(raisedUnfocused, THREAD_ALERT_MAX_TTL_MS - 1)).toBe(false);
    expect(isThreadAlertExpired(raisedUnfocused, THREAD_ALERT_MAX_TTL_MS)).toBe(true);

    const focusedAt500 = { kind: "completed" as const, markedAtMs: 0, focusedAtMs: 500 };
    expect(isThreadAlertExpired(focusedAt500, 500 + THREAD_ALERT_FOCUSED_TTL_MS - 1)).toBe(false);
    expect(isThreadAlertExpired(focusedAt500, 500 + THREAD_ALERT_FOCUSED_TTL_MS)).toBe(true);
  });
});
