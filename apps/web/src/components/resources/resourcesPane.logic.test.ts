import { describe, expect, it } from "vite-plus/test";

import type { HostDiskConsumer } from "@t3tools/contracts";

import {
  consumerName,
  consumerPathParts,
  consumerReclaimState,
  diskFillSummary,
  diskUsedFraction,
  estimateHostNow,
  filesystemRoleLabel,
  formatByteRate,
  formatBytes,
  formatCpuPercent,
  formatHostCpu,
  formatHoursUntilFull,
  formatRelativeAge,
  formatRunningFor,
  hoardingReasonLabel,
  reclaimBlockerLabel,
  reclaimPolicySummary,
  scanStatusLabel,
  sortConsumersBySize,
  utilizationTone,
} from "./resourcesPane.logic";

const GB = 1_024 ** 3;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = 1_800_000_000_000;

const consumer = (overrides: Partial<HostDiskConsumer> = {}): HostDiskConsumer => ({
  path: "/srv/acme/workspaces/acme-app",
  root: "/srv/acme/workspaces",
  bytes: 4 * GB,
  isCheckout: true,
  artifactBytes: 2 * GB,
  largestChildren: [],
  lastActivityAt: NOW - 3 * HOUR,
  owner: null,
  reclaimBlocker: null,
  ...overrides,
});

describe("estimateHostNow", () => {
  it("advances the host's sample time by the local time since it arrived", () => {
    expect(estimateHostNow({ sampledAt: NOW, receivedAt: 5_000, localNow: 9_000 })).toBe(
      NOW + 4_000,
    );
    expect(estimateHostNow({ sampledAt: NOW, receivedAt: 9_000, localNow: 5_000 })).toBe(NOW);
    expect(estimateHostNow({ sampledAt: NOW, receivedAt: null, localNow: 5_000 })).toBe(NOW);
  });
});

describe("utilizationTone", () => {
  it("warns from three quarters and alarms from nine tenths", () => {
    expect(utilizationTone(null)).toBe("default");
    expect(utilizationTone(0.5)).toBe("default");
    expect(utilizationTone(0.75)).toBe("warning");
    expect(utilizationTone(0.93)).toBe("danger");
  });
});

describe("formatBytes", () => {
  it("uses binary units with one decimal below 100", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1_536)).toBe("1.5 KB");
    expect(formatBytes(12.3 * GB)).toBe("12.3 GB");
    expect(formatBytes(250 * GB)).toBe("250 GB");
    expect(formatBytes(3 * 1_024 * GB)).toBe("3.0 TB");
  });

  it("treats negative and non-finite input as empty", () => {
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });
});

describe("rates and percentages", () => {
  it("formats per-second rates and hides unknown ones", () => {
    expect(formatByteRate(2 * 1_024 * 1_024)).toBe("2.0 MB/s");
    expect(formatByteRate(null)).toBe("—");
  });

  it("formats process CPU where 100 is one core", () => {
    expect(formatCpuPercent(3.25)).toBe("3.3%");
    expect(formatCpuPercent(412.4)).toBe("412%");
  });

  it("formats host CPU utilization as a whole percentage", () => {
    expect(formatHostCpu(0.426)).toBe("43%");
    expect(formatHostCpu(null)).toBe("—");
  });
});

describe("time formatting", () => {
  it("rounds disk ETAs to a single coarse unit", () => {
    expect(formatHoursUntilFull(0.25)).toBe("~15 min");
    expect(formatHoursUntilFull(0.001)).toBe("~1 min");
    expect(formatHoursUntilFull(13.6)).toBe("~14 h");
    expect(formatHoursUntilFull(80)).toBe("~3 d");
  });

  it("formats relative ages and absorbs clock skew", () => {
    expect(formatRelativeAge(NOW - 20_000, NOW)).toBe("just now");
    expect(formatRelativeAge(NOW + 30_000, NOW)).toBe("just now");
    expect(formatRelativeAge(NOW - 2 * MINUTE, NOW)).toBe("2 min ago");
    expect(formatRelativeAge(NOW - 3 * HOUR - 5 * MINUTE, NOW)).toBe("3 h ago");
    expect(formatRelativeAge(NOW - 50 * HOUR, NOW)).toBe("2 d ago");
  });

  it("formats running time with up to two units", () => {
    expect(formatRunningFor(NOW - 45_000, NOW)).toBe("45 s");
    expect(formatRunningFor(NOW - 12 * MINUTE, NOW)).toBe("12 min");
    expect(formatRunningFor(NOW - 3 * HOUR, NOW)).toBe("3 h");
    expect(formatRunningFor(NOW - 3 * HOUR - 5 * MINUTE, NOW)).toBe("3 h 5 min");
    expect(formatRunningFor(NOW - 52 * HOUR, NOW)).toBe("2 d 4 h");
    expect(formatRunningFor(NOW + MINUTE, NOW)).toBe("0 s");
  });
});

describe("labels", () => {
  it("names filesystem roles, hoarding reasons, and reclaim blockers", () => {
    expect(filesystemRoleLabel("workspaces")).toBe("Project workspaces");
    expect(filesystemRoleLabel("state")).toBe("Server state");
    expect(hoardingReasonLabel("disk-write")).toBe("Heavy disk writes");
    expect(hoardingReasonLabel("long-running")).toBe("Long-running");
    expect(reclaimBlockerLabel("live-process")).toBe("In use by a running process");
    expect(reclaimBlockerLabel("active-thread")).toBe("Thread is running");
    expect(reclaimBlockerLabel("process-check-unavailable")).toBe("Can't check running processes");
  });
});

describe("disk usage", () => {
  it("measures use against writable space like df", () => {
    expect(diskUsedFraction({ usedBytes: 75 * GB, availableBytes: 25 * GB })).toBe(0.75);
    expect(diskUsedFraction({ usedBytes: 0, availableBytes: 0 })).toBe(0);
  });

  it("describes a filling disk and stays quiet otherwise", () => {
    expect(diskFillSummary({ fillBytesPerHour: 3.2 * GB, hoursUntilFull: 14.2 })).toBe(
      "Filling at 3.2 GB/h · full in ~14 h",
    );
    expect(diskFillSummary({ fillBytesPerHour: 3.2 * GB, hoursUntilFull: null })).toBe(
      "Filling at 3.2 GB/h",
    );
    expect(diskFillSummary({ fillBytesPerHour: -GB, hoursUntilFull: null })).toBeNull();
    expect(diskFillSummary({ fillBytesPerHour: null, hoursUntilFull: null })).toBeNull();
  });
});

describe("disk consumers", () => {
  it("sorts by size with a stable path tiebreak and leaves the input alone", () => {
    const input = [
      consumer({ path: "/srv/acme/workspaces/b", bytes: GB }),
      consumer({ path: "/srv/acme/workspaces/c", bytes: 5 * GB }),
      consumer({ path: "/srv/acme/workspaces/a", bytes: GB }),
    ];
    expect(sortConsumersBySize(input).map((entry) => entry.path)).toEqual([
      "/srv/acme/workspaces/c",
      "/srv/acme/workspaces/a",
      "/srv/acme/workspaces/b",
    ]);
    expect(input[0]?.path).toBe("/srv/acme/workspaces/b");
  });

  it("splits a path into its scan root and the part under it", () => {
    expect(consumerPathParts(consumer())).toEqual({
      prefix: "/srv/acme/workspaces/",
      relative: "acme-app",
    });
    expect(
      consumerPathParts({ path: "/srv/acme/workspaces/acme-app", root: "/srv/acme/workspaces/" }),
    ).toEqual({ prefix: "/srv/acme/workspaces/", relative: "acme-app" });
    expect(consumerPathParts({ path: "/tmp/acme-build", root: "/" })).toEqual({
      prefix: "/",
      relative: "tmp/acme-build",
    });
  });

  it("does not split on a root that is only a string prefix", () => {
    expect(consumerPathParts({ path: "/srv/acme-other/app", root: "/srv/acme" })).toEqual({
      prefix: "",
      relative: "/srv/acme-other/app",
    });
  });

  it("names a consumer by its last path segment", () => {
    expect(consumerName("/srv/acme/workspaces/acme-app/")).toBe("acme-app");
    expect(consumerName("C:\\acme\\acme-app")).toBe("acme-app");
  });

  it("only offers reclaim for unblocked checkouts with build output", () => {
    expect(consumerReclaimState(consumer())).toEqual({ kind: "ready" });
    expect(consumerReclaimState(consumer({ isCheckout: false }))).toEqual({
      kind: "unavailable",
    });
    expect(consumerReclaimState(consumer({ reclaimBlocker: "live-process" }))).toEqual({
      kind: "blocked",
      reason: "In use by a running process",
    });
    expect(consumerReclaimState(consumer({ reclaimBlocker: "active-thread" }))).toEqual({
      kind: "blocked",
      reason: "Thread is running",
    });
    expect(consumerReclaimState(consumer({ artifactBytes: 0 }))).toEqual({
      kind: "blocked",
      reason: "No build output",
    });
  });
});

describe("scanStatusLabel", () => {
  it("describes each scan state", () => {
    expect(scanStatusLabel({ status: "never", startedAt: null, finishedAt: null }, NOW)).toBe(
      "Never scanned",
    );
    expect(
      scanStatusLabel({ status: "running", startedAt: NOW - 2 * MINUTE, finishedAt: null }, NOW),
    ).toBe("Scanning… started 2 min ago");
    expect(
      scanStatusLabel(
        { status: "complete", startedAt: NOW - 14 * MINUTE, finishedAt: NOW - 12 * MINUTE },
        NOW,
      ),
    ).toBe("Last scanned 12 min ago");
    expect(
      scanStatusLabel({ status: "failed", startedAt: NOW - 5 * MINUTE, finishedAt: null }, NOW),
    ).toBe("Last scan failed 5 min ago");
  });
});

describe("reclaimPolicySummary", () => {
  it("explains the cleanup threshold and the last reclaim", () => {
    expect(
      reclaimPolicySummary(
        {
          reclaimIdleAfterDays: 7,
          lastReclaim: {
            at: NOW - 3 * HOUR,
            paths: ["/srv/acme/workspaces/a", "/srv/acme/workspaces/b"],
            freedBytes: 12.3 * GB,
          },
        },
        NOW,
      ),
    ).toEqual({
      policy:
        "Worktree cleanup prunes build output in thread worktrees inactive for 7+ days, once a day.",
      lastRun: "Last reclaim: freed 12.3 GB from 2 checkouts, 3 h ago.",
    });
  });

  it("reports disabled cleanup, a single-checkout reclaim, and no reclaim yet", () => {
    expect(
      reclaimPolicySummary(
        {
          reclaimIdleAfterDays: null,
          lastReclaim: { at: NOW - 10 * MINUTE, paths: ["/srv/acme/workspaces/a"], freedBytes: GB },
        },
        NOW,
      ),
    ).toEqual({
      policy:
        "Worktree cleanup is off in Settings — build output is only removed when you reclaim it here.",
      lastRun: "Last reclaim: freed 1.0 GB from 1 checkout, 10 min ago.",
    });
    expect(reclaimPolicySummary({ reclaimIdleAfterDays: 1, lastReclaim: null }, NOW)).toEqual({
      policy:
        "Worktree cleanup prunes build output in thread worktrees inactive for 1+ day, once a day.",
      lastRun: null,
    });
  });
});
