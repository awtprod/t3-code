import type {
  HostDiskConsumer,
  HostDiskPressureLevel,
  HostDiskReclaimBlocker,
  HostDiskReclaimRun,
  HostDiskScan,
  HostFilesystemRole,
  HostFilesystemUsage,
  HostProcessHoardingReason,
} from "@t3tools/contracts";

/**
 * Presentation rules for the Resources pane. The pane re-reads the whole-host snapshot every few
 * seconds, so everything here is a function of that snapshot and the current time.
 */

/** How often the pane re-reads host usage while it is open and visible. */
export const RESOURCES_POLL_INTERVAL_MS = 5_000;

const BYTE_UNITS = ["KB", "MB", "GB", "TB", "PB"] as const;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * The host's clock now, from its last sample plus how long ago that sample arrived here. Every
 * timestamp in the snapshot is the host's, so measuring ages against the browser clock would
 * fold any skew between the two machines into every "… ago" label.
 */
export function estimateHostNow(input: {
  readonly sampledAt: number;
  readonly receivedAt: number | null;
  readonly localNow: number;
}): number {
  if (input.receivedAt === null) return input.sampledAt;
  return input.sampledAt + Math.max(0, input.localNow - input.receivedAt);
}

export type UtilizationTone = "default" | "warning" | "danger";

/** Shared thresholds for CPU and memory tiles, as a 0..1 fraction. */
export function utilizationTone(fraction: number | null): UtilizationTone {
  if (fraction === null) return "default";
  if (fraction >= 0.9) return "danger";
  if (fraction >= 0.75) return "warning";
  return "default";
}

/** Binary units with one decimal below 100, the way `df -h` reads. */
export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value < 1_024) return `${Math.round(value)} B`;
  let next = value;
  let unitIndex = -1;
  do {
    next /= 1_024;
    unitIndex += 1;
  } while (next >= 1_024 && unitIndex < BYTE_UNITS.length - 1);
  return `${next.toFixed(next >= 100 ? 0 : 1)} ${BYTE_UNITS[unitIndex]}`;
}

export function formatByteRate(bytesPerSecond: number | null): string {
  return bytesPerSecond === null ? "—" : `${formatBytes(bytesPerSecond)}/s`;
}

/** 100 is one full core, so a busy multi-threaded process reads above 100%. */
export function formatCpuPercent(percent: number): string {
  return `${percent.toFixed(percent >= 100 ? 0 : 1)}%`;
}

export function formatHostCpu(cpuUtilization: number | null): string {
  return cpuUtilization === null ? "—" : `${Math.round(cpuUtilization * 100)}%`;
}

/** Disk ETAs are estimates from a fill rate, so they never claim more precision than that. */
export function formatHoursUntilFull(hours: number): string {
  if (hours < 1) return `~${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `~${Math.round(hours)} h`;
  return `~${Math.round(hours / 24)} d`;
}

/** Single-unit age for "… ago" labels. Clock skew between host and browser reads as "just now". */
export function formatRelativeAge(at: number, now: number): string {
  const elapsed = now - at;
  if (elapsed < MINUTE_MS) return "just now";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)} min ago`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)} h ago`;
  return `${Math.floor(elapsed / DAY_MS)} d ago`;
}

/** Two-unit duration for how long a process has run: "12 min", "3 h 5 min", "2 d 4 h". */
export function formatRunningFor(startedAt: number, now: number): string {
  const elapsed = Math.max(0, now - startedAt);
  if (elapsed < MINUTE_MS) return `${Math.floor(elapsed / 1_000)} s`;
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)} min`;
  if (elapsed < DAY_MS) {
    const hours = Math.floor(elapsed / HOUR_MS);
    const minutes = Math.floor((elapsed % HOUR_MS) / MINUTE_MS);
    return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
  }
  const days = Math.floor(elapsed / DAY_MS);
  const hours = Math.floor((elapsed % DAY_MS) / HOUR_MS);
  return hours === 0 ? `${days} d` : `${days} d ${hours} h`;
}

export function filesystemRoleLabel(role: HostFilesystemRole): string {
  switch (role) {
    case "state":
      return "Server state";
    case "runtime":
      return "Runtime";
    case "worktrees":
      return "Worktrees";
    case "workspaces":
      return "Project workspaces";
    case "temp":
      return "Temp";
  }
}

export function diskLevelLabel(level: HostDiskPressureLevel): string {
  switch (level) {
    case "ok":
      return "OK";
    case "warning":
      return "Warning";
    case "critical":
      return "Critical";
  }
}

export function hoardingReasonLabel(reason: HostProcessHoardingReason): string {
  switch (reason) {
    case "memory":
      return "High memory";
    case "cpu":
      return "High CPU";
    case "disk-write":
      return "Heavy disk writes";
    case "long-running":
      return "Long-running";
  }
}

export function reclaimBlockerLabel(blocker: HostDiskReclaimBlocker): string {
  switch (blocker) {
    case "live-process":
      return "In use by a running process";
    case "active-thread":
      return "Thread is running";
    case "no-artifacts":
      return "No build output";
  }
}

/**
 * Share of the space a user can actually write that is taken. Root-reserved blocks count toward
 * the total but are never available, so this matches `df`'s Use% rather than used / total.
 */
export function diskUsedFraction(
  filesystem: Pick<HostFilesystemUsage, "usedBytes" | "availableBytes">,
): number {
  const usable = filesystem.usedBytes + filesystem.availableBytes;
  if (usable <= 0) return 0;
  return Math.min(1, Math.max(0, filesystem.usedBytes / usable));
}

/** Null unless the disk is filling; a shrinking or flat disk has nothing worth saying. */
export function diskFillSummary(
  filesystem: Pick<HostFilesystemUsage, "fillBytesPerHour" | "hoursUntilFull">,
): string | null {
  const rate = filesystem.fillBytesPerHour;
  if (rate === null || rate <= 0) return null;
  const filling = `Filling at ${formatBytes(rate)}/h`;
  return filesystem.hoursUntilFull === null
    ? filling
    : `${filling} · full in ${formatHoursUntilFull(filesystem.hoursUntilFull)}`;
}

/** Biggest first; equal sizes fall back to path so the order holds still between polls. */
export function sortConsumersBySize(
  consumers: ReadonlyArray<HostDiskConsumer>,
): ReadonlyArray<HostDiskConsumer> {
  return consumers.toSorted(
    (left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path),
  );
}

function trimTrailingSeparator(path: string): string {
  return path.length > 1 ? path.replace(/[\\/]+$/, "") : path;
}

/** Splits a consumer path into its scan root (shown muted) and the part under it. */
export function consumerPathParts(consumer: Pick<HostDiskConsumer, "path" | "root">): {
  readonly prefix: string;
  readonly relative: string;
} {
  const root = trimTrailingSeparator(consumer.root);
  const path = consumer.path;
  if (root.length > 0 && path.length > root.length && path.startsWith(root)) {
    const separator = path[root.length];
    if (separator === "/" || separator === "\\") {
      return { prefix: path.slice(0, root.length + 1), relative: path.slice(root.length + 1) };
    }
    if (root === "/") return { prefix: "/", relative: path.slice(1) };
  }
  return { prefix: "", relative: path };
}

export function consumerName(path: string): string {
  const trimmed = trimTrailingSeparator(path);
  return trimmed.split(/[\\/]/).findLast((segment) => segment.length > 0) ?? trimmed;
}

export type ConsumerReclaimState =
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready" }
  | { readonly kind: "blocked"; readonly reason: string };

/**
 * Only checkouts can be reclaimed: their build output is regenerable from the repository.
 * Anything else has no Reclaim action at all rather than a permanently disabled one.
 */
export function consumerReclaimState(
  consumer: Pick<HostDiskConsumer, "isCheckout" | "reclaimBlocker" | "artifactBytes">,
): ConsumerReclaimState {
  if (!consumer.isCheckout) return { kind: "unavailable" };
  if (consumer.reclaimBlocker !== null) {
    return { kind: "blocked", reason: reclaimBlockerLabel(consumer.reclaimBlocker) };
  }
  if (consumer.artifactBytes <= 0) {
    return { kind: "blocked", reason: reclaimBlockerLabel("no-artifacts") };
  }
  return { kind: "ready" };
}

export function scanStatusLabel(
  scan: Pick<HostDiskScan, "status" | "startedAt" | "finishedAt">,
  now: number,
): string {
  switch (scan.status) {
    case "never":
      return "Never scanned";
    case "running":
      return scan.startedAt === null
        ? "Scanning…"
        : `Scanning… started ${formatRelativeAge(scan.startedAt, now)}`;
    case "complete":
      return scan.finishedAt === null
        ? "Last scan complete"
        : `Last scanned ${formatRelativeAge(scan.finishedAt, now)}`;
    case "failed": {
      const at = scan.finishedAt ?? scan.startedAt;
      return at === null ? "Last scan failed" : `Last scan failed ${formatRelativeAge(at, now)}`;
    }
  }
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * The pane's footer: what the daily worktree-cleanup sweep prunes on its own, and the last
 * reclaim run from this pane.
 */
export function reclaimPolicySummary(
  input: {
    readonly reclaimIdleAfterDays: number | null;
    readonly lastReclaim: HostDiskReclaimRun | null;
  },
  now: number,
): { readonly policy: string; readonly lastRun: string | null } {
  const days = input.reclaimIdleAfterDays;
  const policy =
    days === null
      ? "Worktree cleanup is off in Settings — build output is only removed when you reclaim it here."
      : `Worktree cleanup prunes build output in thread worktrees inactive for ${days}+ ${
          days === 1 ? "day" : "days"
        }, once a day.`;
  const run = input.lastReclaim;
  const lastRun =
    run === null
      ? null
      : `Last reclaim: freed ${formatBytes(run.freedBytes)} from ${plural(
          run.paths.length,
          "checkout",
        )}, ${formatRelativeAge(run.at, now)}.`;
  return { policy, lastRun };
}
