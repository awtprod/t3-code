import { assert, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  ApprovalStatus,
  CommandSubmission,
  ItemStatus,
  MemoryStatus,
  RunStatus,
  Space,
  SpaceContextFeed,
} from "./domain.ts";
import { classifyActionRisk } from "./risk.ts";

it("accepts every public workflow status and rejects unknown statuses", () => {
  const decodeItemStatus = Schema.decodeUnknownSync(ItemStatus);
  const decodeRunStatus = Schema.decodeUnknownSync(RunStatus);
  const decodeApprovalStatus = Schema.decodeUnknownSync(ApprovalStatus);
  const decodeMemoryStatus = Schema.decodeUnknownSync(MemoryStatus);

  for (const status of [
    "captured",
    "ready",
    "in_progress",
    "waiting",
    "review",
    "done",
    "canceled",
  ] as const) {
    assert.strictEqual(decodeItemStatus(status), status);
  }
  for (const status of [
    "queued",
    "running",
    "waiting_approval",
    "waiting",
    "succeeded",
    "failed",
    "canceled",
  ] as const) {
    assert.strictEqual(decodeRunStatus(status), status);
  }
  for (const status of ["requested", "approved", "declined", "expired", "canceled"] as const) {
    assert.strictEqual(decodeApprovalStatus(status), status);
  }
  for (const status of ["candidate", "approved", "rejected", "expired", "archive"] as const) {
    assert.strictEqual(decodeMemoryStatus(status), status);
  }

  assert.throws(() => decodeItemStatus("paused"));
  assert.throws(() => decodeRunStatus("complete"));
  assert.throws(() => decodeApprovalStatus("accepted"));
  assert.throws(() => decodeMemoryStatus("trusted"));
});

it("trims command fields at the public boundary", () => {
  const decodeCommand = Schema.decodeUnknownSync(CommandSubmission);
  const command = decodeCommand({
    commandId: " command-1 ",
    text: " Summarize the sample project ",
    spaceId: " example-space ",
    providerId: " provider-a ",
    modelId: " model-a ",
  });

  assert.strictEqual(command.commandId, "command-1");
  assert.strictEqual(command.text, "Summarize the sample project");
  assert.strictEqual(command.spaceId, "example-space");
  assert.strictEqual(command.providerId, "provider-a");
  assert.strictEqual(command.modelId, "model-a");
});

it("classifies low-risk, reversible, approval-gated, and blocked actions", () => {
  assert.deepStrictEqual(classifyActionRisk("read"), {
    actionKind: "read",
    level: "low",
    approvalRequired: false,
    reversible: false,
  });
  assert.deepStrictEqual(classifyActionRisk("worktree.edit"), {
    actionKind: "worktree.edit",
    level: "reversible",
    approvalRequired: false,
    reversible: true,
  });
  assert.deepStrictEqual(classifyActionRisk("git.push"), {
    actionKind: "git.push",
    level: "approval-required",
    approvalRequired: true,
    reversible: false,
  });
  assert.deepStrictEqual(classifyActionRisk("google.write"), {
    actionKind: "google.write",
    level: "blocked",
    approvalRequired: false,
    reversible: false,
  });
});

it("accepts a bounded context feed with exactly one source and rejects the rest", () => {
  const decodeFeed = Schema.decodeUnknownSync(SpaceContextFeed);
  const decodeFeedOption = Schema.decodeUnknownOption(SpaceContextFeed);
  const feed = {
    id: "outreach-pipeline",
    title: " Outreach pipeline ",
    argv: ["python3", "feeds/example.py"],
    maxChars: 1_200,
    refreshMinutes: 30,
    timeoutSeconds: 20,
  };
  assert.deepStrictEqual(decodeFeed(feed), { ...feed, title: "Outreach pipeline" });
  const { argv: _argv, ...withoutArgv } = feed;
  assert.deepStrictEqual(decodeFeed({ ...withoutArgv, path: "/config/feeds/summary.txt" }), {
    ...withoutArgv,
    title: "Outreach pipeline",
    path: "/config/feeds/summary.txt",
  });

  for (const invalid of [
    { ...feed, path: "/config/feeds/summary.txt" },
    withoutArgv,
    { ...feed, argv: [] },
    { ...feed, argv: [""] },
    { ...feed, argv: Array.from({ length: 17 }, () => "x") },
    { ...feed, argv: ["x".repeat(513)] },
    { ...feed, id: "Outreach" },
    { ...feed, id: "" },
    { ...feed, id: "x".repeat(41) },
    { ...feed, title: "" },
    { ...feed, title: "x".repeat(81) },
    { ...feed, maxChars: 199 },
    { ...feed, maxChars: 3_001 },
    { ...feed, refreshMinutes: 4 },
    { ...feed, refreshMinutes: 1_441 },
    { ...feed, timeoutSeconds: 4 },
    { ...feed, timeoutSeconds: 61 },
    { ...feed, timeoutSeconds: 7.5 },
  ]) {
    assert.isTrue(Option.isNone(decodeFeedOption(invalid)), JSON.stringify(invalid));
  }

  const decodeSpace = Schema.decodeUnknownSync(Space);
  const space = (contextFeeds: ReadonlyArray<unknown>) => ({
    id: "space-a",
    slug: "space-a",
    displayName: "Space A",
    kind: "business",
    instructions: "",
    policy: { allowedCapabilities: [], autoRunRiskLevels: [] },
    contextFeeds,
    connectionIds: [],
    repositories: [],
    aliases: [],
    lifecycle: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const feeds = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ ...feed, id: `feed-${index}` }));
  assert.strictEqual(decodeSpace(space(feeds(6))).contextFeeds?.length, 6);
  assert.throws(() => decodeSpace(space(feeds(7))));
  assert.throws(() => decodeSpace(space([feed, feed])));
});
