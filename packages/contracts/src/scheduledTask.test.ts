import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  ScheduledTask,
  scheduledTaskLastRunError,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertSchedule,
} from "./scheduledTask.ts";

const decodeSchedule = Schema.decodeUnknownSync(ScheduledTaskSchedule);
const decodeUpsertSchedule = Schema.decodeUnknownSync(ScheduledTaskUpsertSchedule);
const decodeTask = Schema.decodeSync(ScheduledTask);

describe("ScheduledTaskSchedule", () => {
  it("keeps legacy sub-minute persisted schedules readable", () => {
    expect(
      decodeSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
      }),
    ).toEqual({
      type: "interval",
      everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
    });
  });
});

describe("ScheduledTask", () => {
  it("decodes a task from a server that does not send the run outcome", () => {
    const task = decodeTask({
      id: "task-1",
      title: "Weekly report",
      prompt: "Write the report",
      enabled: true,
      schedule: { type: "interval", everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS },
      projectId: "project-1",
      threadId: null,
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "user",
      creationSource: "web",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nextRunAt: null,
      lastRunAt: "2026-01-01T00:00:00.000Z",
      lastRunStatus: "succeeded",
      lastRunError: null,
      runCount: 1,
    });
    expect(task.lastRunOutcome).toBeNull();
    expect(task.lastRunOutcomeError).toBeNull();
  });

  it("reports the started run's failure when the dispatch itself succeeded", () => {
    const base = { lastRunError: null, lastRunOutcomeError: null } as const;
    expect(
      scheduledTaskLastRunError({
        ...base,
        lastRunStatus: "succeeded",
        lastRunOutcome: "failed",
        lastRunOutcomeError: "usage_limit (api_error_429)",
      }),
    ).toBe("usage_limit (api_error_429)");
    expect(
      scheduledTaskLastRunError({ ...base, lastRunStatus: "succeeded", lastRunOutcome: null }),
    ).toBeNull();
    expect(
      scheduledTaskLastRunError({
        ...base,
        lastRunStatus: "failed",
        lastRunOutcome: null,
        lastRunError: "Thread not found",
      }),
    ).toBe("Thread not found");
  });
});

it.each(["literal", " ", "\t\n", "{{body.bad", "{{unknown.field}}"])(
  "rejects invalid dedupe template %s",
  (replayKey) => {
    expect(() => decodeUpsertSchedule({ type: "webhook", dedupe: { replayKey } })).toThrow();
    expect(() =>
      decodeUpsertSchedule({ type: "webhook", dedupe: { coalesceKey: replayKey } }),
    ).toThrow();
  },
);
describe("webhook filters", () => {
  const accepts = (filters: unknown) => {
    try {
      decodeUpsertSchedule({ type: "webhook", filters });
      return true;
    } catch {
      return false;
    }
  };

  it("rejects empty or unknown paths, unknown ops, and values that do not fit the op", () => {
    expect(accepts([{ path: "", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "  ", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "request", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "header.x-github-event", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "in", value: "opened" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "in", value: [] }])).toBe(false);
    for (const value of ["", " opened", "opened ", "a,b"]) {
      expect(accepts([{ path: "body.action", op: "in", value: [value] }])).toBe(false);
    }
    expect(accepts([{ path: "body.label.name", op: "in", value: ["needs review"] }])).toBe(true);
    expect(accepts([{ path: "body.action", op: "equals" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "matches", value: "^opened$" }])).toBe(false);
  });
});
