import { Automation, Run, Space } from "@command-center/core";
import { ScheduledTask } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeAutomation = Schema.decodeUnknownSync(Automation);
const decodeRun = Schema.decodeUnknownSync(Run);
const decodeSpace = Schema.decodeUnknownSync(Space);
const decodeScheduledTask = Schema.decodeUnknownSync(ScheduledTask);

export const SAMPLE_AUTOMATION = decodeAutomation({
  id: "sample-weekly-brief",
  spaceId: "sample-space",
  name: "Sample weekly brief",
  version: 1,
  enabled: false,
  trigger: { type: "schedule", expression: "0 9 * * 1", timezone: "Etc/UTC" },
  nodes: [
    {
      id: "collect",
      kind: "connector.read",
      config: { source: "sample", options: { limit: 5 } },
      position: { x: 80, y: 120 },
    },
    {
      id: "draft",
      kind: "transform",
      config: { template: "sample-brief" },
      position: { x: 380, y: 120 },
    },
  ],
  edges: [{ sourceNodeId: "collect", targetNodeId: "draft" }],
  definitionDigest: `sha256:${"1".repeat(64)}`,
  configCommit: "sample-commit",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

export const SAMPLE_SPACE = decodeSpace({
  id: "sample-space",
  slug: "sample-space",
  displayName: "Sample Space",
  kind: "business",
  instructions: "",
  policy: {
    allowedCapabilities: ["cc.automations.read"],
    autoRunRiskLevels: ["low"],
  },
  connectionIds: [],
  repositories: [],
  aliases: [],
  lifecycle: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

/** The latest run of SAMPLE_AUTOMATION; its status decides the automation's health. */
export const SAMPLE_FAILED_RUN = decodeRun({
  id: "run-weekly-brief-2",
  spaceId: "sample-space",
  kind: "automation",
  status: "failed",
  automationId: "sample-weekly-brief",
  artifactIds: [],
  createdAt: "2026-10-24T09:00:00.000Z",
  startedAt: "2026-10-24T09:00:01.000Z",
  finishedAt: "2026-10-24T09:00:05.000Z",
});

export const SAMPLE_OLDER_SUCCEEDED_RUN = decodeRun({
  id: "run-weekly-brief-1",
  spaceId: "sample-space",
  kind: "automation",
  status: "succeeded",
  automationId: "sample-weekly-brief",
  artifactIds: [],
  createdAt: "2026-10-17T09:00:00.000Z",
  finishedAt: "2026-10-17T09:02:00.000Z",
});

const SAMPLE_SCHEDULED_TASK_SOURCE = {
  id: "task-editing-watch",
  title: "Editing opportunity watch",
  prompt: "Read the brief, run the screening script once, reply with one line if nothing fits.",
  enabled: true,
  schedule: { type: "fixed_time", timeOfDay: "17:00" },
  projectId: "project-system",
  threadId: "thread-editing-watch",
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: "claude", model: "claude-haiku-5-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "agent",
  creationSource: "mcp",
  createdAt: "2026-10-24T18:00:00.000Z",
  updatedAt: "2026-10-24T18:30:00.000Z",
  nextRunAt: "2026-10-25T17:00:00.000Z",
  lastRunAt: "2026-10-24T18:29:00.000Z",
  lastRunStatus: "succeeded",
  lastRunError: null,
  runCount: 1,
};

export const SAMPLE_SCHEDULED_TASK = decodeScheduledTask(SAMPLE_SCHEDULED_TASK_SOURCE);

export const SAMPLE_FAILED_SCHEDULED_TASK = decodeScheduledTask({
  ...SAMPLE_SCHEDULED_TASK_SOURCE,
  id: "task-weekday-digest",
  title: "Weekday prospect digest",
  threadId: null,
  workspaceStrategy: { type: "worktree", baseRef: "main" },
  schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
  lastRunStatus: "failed",
  lastRunError: "Workspace preparation failed during provision worktree.",
  runCount: 7,
});

export const SAMPLE_PAUSED_SCHEDULED_TASK = decodeScheduledTask({
  ...SAMPLE_SCHEDULED_TASK_SOURCE,
  id: "task-paused-sync",
  title: "Paused inbox sync",
  enabled: false,
  schedule: { type: "interval", everyMs: 900_000 },
  nextRunAt: null,
});
