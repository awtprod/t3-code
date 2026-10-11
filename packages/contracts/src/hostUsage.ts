import * as Schema from "effect/Schema";

import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { HostResourcesSnapshot } from "./resourceTelemetry.ts";

/**
 * Whole-host usage for the Resources pane: disks the server writes to, host-wide
 * processes that hold an outsized share of CPU, memory, or disk writes, and the
 * last on-demand disk scan. Unlike resource telemetry this is not limited to the
 * server's own process tree.
 */

export const HostDiskPressureLevel = Schema.Literals(["ok", "warning", "critical"]);
export type HostDiskPressureLevel = typeof HostDiskPressureLevel.Type;

/** What the server keeps on a filesystem. */
export const HostFilesystemRole = Schema.Literals([
  "state",
  "runtime",
  "worktrees",
  "workspaces",
  "temp",
]);
export type HostFilesystemRole = typeof HostFilesystemRole.Type;

export const HostFilesystemUsage = Schema.Struct({
  mountPoint: Schema.String,
  device: Schema.String,
  fsType: Schema.String,
  roles: Schema.Array(HostFilesystemRole),
  totalBytes: NonNegativeInt,
  usedBytes: NonNegativeInt,
  availableBytes: NonNegativeInt,
  level: HostDiskPressureLevel,
  /** Positive while the disk fills. Null until enough samples exist. */
  fillBytesPerHour: Schema.NullOr(Schema.Number),
  /** Null unless the disk is filling. */
  hoursUntilFull: Schema.NullOr(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type HostFilesystemUsage = typeof HostFilesystemUsage.Type;

export const HostProcessHoardingReason = Schema.Literals([
  "memory",
  "cpu",
  "disk-write",
  "long-running",
]);
export type HostProcessHoardingReason = typeof HostProcessHoardingReason.Type;

/** The Command Center thread or project whose directory a process or path is in. */
export const HostUsageOwner = Schema.Struct({
  projectId: ProjectId,
  projectTitle: Schema.String,
  threadId: Schema.NullOr(ThreadId),
  threadTitle: Schema.NullOr(Schema.String),
});
export type HostUsageOwner = typeof HostUsageOwner.Type;

export const HostUsageProcess = Schema.Struct({
  pid: NonNegativeInt,
  ppid: NonNegativeInt,
  user: Schema.String,
  name: Schema.String,
  /** Secrets are redacted and long command lines truncated. */
  command: Schema.String,
  /** Average over the interval since the previous sample; 100 = one full core. */
  cpuPercent: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  residentBytes: NonNegativeInt,
  /** Null when the kernel hides another user's I/O counters. */
  ioWriteBytes: Schema.NullOr(NonNegativeInt),
  ioWriteBytesPerSecond: Schema.NullOr(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
  startedAt: NonNegativeInt,
  /** Null when the kernel hides another user's working directory. */
  cwd: Schema.NullOr(Schema.String),
  owner: Schema.NullOr(HostUsageOwner),
  reasons: Schema.Array(HostProcessHoardingReason),
});
export type HostUsageProcess = typeof HostUsageProcess.Type;

export const HostDiskReclaimBlocker = Schema.Literals([
  "no-artifacts",
  "live-process",
  "active-thread",
  "process-check-unavailable",
]);
export type HostDiskReclaimBlocker = typeof HostDiskReclaimBlocker.Type;

/** One directory directly under a scan root. */
export const HostDiskConsumer = Schema.Struct({
  path: Schema.String,
  root: Schema.String,
  bytes: NonNegativeInt,
  /** Contains a `.git` entry: a repository checkout or linked worktree. */
  isCheckout: Schema.Boolean,
  /** Bytes in regenerable build output (node_modules, target, ...) directly inside. */
  artifactBytes: NonNegativeInt,
  /** Largest immediate children, for drilling into non-checkout directories. */
  largestChildren: Schema.Array(Schema.Struct({ name: Schema.String, bytes: NonNegativeInt })),
  /** Newest git or directory modification time; null when unknown. */
  lastActivityAt: Schema.NullOr(NonNegativeInt),
  owner: Schema.NullOr(HostUsageOwner),
  reclaimBlocker: Schema.NullOr(HostDiskReclaimBlocker),
});
export type HostDiskConsumer = typeof HostDiskConsumer.Type;

export const HostDiskScanStatus = Schema.Literals(["never", "running", "complete", "failed"]);
export type HostDiskScanStatus = typeof HostDiskScanStatus.Type;

export const HostDiskScan = Schema.Struct({
  status: HostDiskScanStatus,
  startedAt: Schema.NullOr(NonNegativeInt),
  finishedAt: Schema.NullOr(NonNegativeInt),
  /** Roots that could not be measured, with the reason. */
  errors: Schema.Array(Schema.Struct({ root: Schema.String, message: Schema.String })),
  roots: Schema.Array(Schema.Struct({ path: Schema.String, bytes: NonNegativeInt })),
  consumers: Schema.Array(HostDiskConsumer),
});
export type HostDiskScan = typeof HostDiskScan.Type;

/** The most recent reclaim run from the Resources pane. */
export const HostDiskReclaimRun = Schema.Struct({
  at: NonNegativeInt,
  paths: Schema.Array(Schema.String),
  freedBytes: NonNegativeInt,
});
export type HostDiskReclaimRun = typeof HostDiskReclaimRun.Type;

export const HostUsageSnapshot = Schema.Struct({
  sampledAt: NonNegativeInt,
  host: HostResourcesSnapshot,
  /** False where the server cannot read per-process data (non-Linux hosts). */
  processesSupported: Schema.Boolean,
  filesystems: Schema.Array(HostFilesystemUsage),
  processes: Schema.Array(HostUsageProcess),
  scan: HostDiskScan,
  /**
   * The worktree cleanup setting: build output in thread worktrees inactive this
   * many days is pruned by the daily sweep. Null when the sweep is disabled.
   */
  reclaimIdleAfterDays: Schema.NullOr(NonNegativeInt),
  lastReclaim: Schema.NullOr(HostDiskReclaimRun),
});
export type HostUsageSnapshot = typeof HostUsageSnapshot.Type;

export const HostDiskReclaimInput = Schema.Struct({
  path: TrimmedNonEmptyString,
});
export type HostDiskReclaimInput = typeof HostDiskReclaimInput.Type;

export const HostDiskReclaimResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("reclaimed"),
    removed: Schema.Array(Schema.String),
    freedBytes: NonNegativeInt,
  }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: Schema.Literals([
      "outside-scan-roots",
      "not-a-checkout",
      "no-artifacts",
      "live-process",
      "active-thread",
      "process-check-unavailable",
    ]),
    message: Schema.String,
  }),
]);
export type HostDiskReclaimResult = typeof HostDiskReclaimResult.Type;
