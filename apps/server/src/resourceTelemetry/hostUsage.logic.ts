import type {
  HostDiskPressureLevel,
  HostProcessHoardingReason,
  HostUsageOwner,
} from "@t3tools/contracts";

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;
const HOUR_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Filesystems

export interface MountInfoEntry {
  readonly majorMinor: string;
  /** Directory of the source filesystem that is mounted here (bind mounts). */
  readonly root: string;
  readonly mountPoint: string;
  readonly fsType: string;
  readonly source: string;
}

// mountinfo escapes space, tab, newline, and backslash as three-digit octal (\x5c is the backslash).
const decodeMountField = (value: string) =>
  value.replace(/\x5c([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );

/** Parses `/proc/self/mountinfo` (proc(5)). Malformed lines are skipped. */
export function parseMountInfo(text: string): ReadonlyArray<MountInfoEntry> {
  const entries: MountInfoEntry[] = [];
  for (const line of text.split("\n")) {
    const separator = line.indexOf(" - ");
    if (separator < 0) continue;
    const before = line.slice(0, separator).split(" ");
    const after = line.slice(separator + 3).split(" ");
    const [, , majorMinor, root, mountPoint] = before;
    const [fsType, source] = after;
    if (!majorMinor || !root || !mountPoint || !fsType || source === undefined) continue;
    entries.push({
      majorMinor,
      root: decodeMountField(root),
      mountPoint: decodeMountField(mountPoint),
      fsType,
      source: decodeMountField(source),
    });
  }
  return entries;
}

export function isPathWithin(parent: string, candidate: string): boolean {
  if (parent === "/") return candidate.startsWith("/");
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

/** The mount that contains `path`: the longest matching mount point wins. */
export function mountForPath(
  mounts: ReadonlyArray<MountInfoEntry>,
  path: string,
): MountInfoEntry | null {
  let best: MountInfoEntry | null = null;
  for (const mount of mounts) {
    if (!isPathWithin(mount.mountPoint, path)) continue;
    // Later entries shadow earlier ones mounted at the same point.
    if (!best || mount.mountPoint.length >= best.mountPoint.length) best = mount;
  }
  return best;
}

/**
 * Pressure is relative for large disks and absolute for small ones, so a
 * 2 TB disk warns before 200 GB are gone and a 50 GB disk is not always red.
 */
export function diskPressureLevel(
  totalBytes: number,
  availableBytes: number,
): HostDiskPressureLevel {
  if (totalBytes <= 0) return "ok";
  const share = availableBytes / totalBytes;
  if (share < 0.05 || availableBytes < 5 * GIB) return "critical";
  if (share < 0.1 || availableBytes < 15 * GIB) return "warning";
  return "ok";
}

export interface DiskSample {
  readonly at: number;
  readonly availableBytes: number;
}

const FILL_RATE_WINDOW_MS = HOUR_MS;
const FILL_RATE_MIN_SPAN_MS = 10 * 60 * 1000;
const FILL_RATE_MIN_SAMPLES = 3;

/**
 * Least-squares slope of available bytes over the last hour, as bytes consumed
 * per hour. Null until samples span at least ten minutes.
 */
export function fillBytesPerHour(samples: ReadonlyArray<DiskSample>, nowMs: number): number | null {
  const recent = samples.filter((sample) => nowMs - sample.at <= FILL_RATE_WINDOW_MS);
  if (recent.length < FILL_RATE_MIN_SAMPLES) return null;
  const first = recent[0]!;
  const last = recent.at(-1)!;
  if (last.at - first.at < FILL_RATE_MIN_SPAN_MS) return null;
  const meanX = recent.reduce((sum, sample) => sum + (sample.at - first.at), 0) / recent.length;
  const meanY = recent.reduce((sum, sample) => sum + sample.availableBytes, 0) / recent.length;
  let numerator = 0;
  let denominator = 0;
  for (const sample of recent) {
    const x = sample.at - first.at - meanX;
    numerator += x * (sample.availableBytes - meanY);
    denominator += x * x;
  }
  if (denominator === 0) return null;
  return -(numerator / denominator) * HOUR_MS;
}

export function hoursUntilFull(availableBytes: number, fillRate: number | null): number | null {
  if (fillRate === null || fillRate <= 0) return null;
  return availableBytes / fillRate;
}

// ---------------------------------------------------------------------------
// Processes

export interface ProcStat {
  readonly pid: number;
  readonly name: string;
  readonly ppid: number;
  /** utime + stime, in clock ticks. */
  readonly cpuTicks: number;
  /** Start time after boot, in clock ticks. */
  readonly startTicks: number;
}

/** Parses `/proc/<pid>/stat`. The command name may contain spaces and parentheses. */
export function parseProcStat(text: string): ProcStat | null {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const pid = Number(text.slice(0, open).trim());
  const fields = text
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  // Fields after the name start at proc(5) field 3 (state).
  const ppid = Number(fields[1]);
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  const startTicks = Number(fields[19]);
  if (![pid, ppid, utime, stime, startTicks].every(Number.isFinite)) return null;
  return {
    pid,
    name: text.slice(open + 1, close),
    ppid,
    cpuTicks: utime + stime,
    startTicks,
  };
}

export interface ProcStatus {
  readonly uid: number;
  /** Null for kernel threads, which have no address space. */
  readonly residentBytes: number | null;
}

export function parseProcStatus(text: string): ProcStatus | null {
  const uid = /^Uid:\s+(\d+)/m.exec(text)?.[1];
  if (uid === undefined) return null;
  const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(text)?.[1];
  return { uid: Number(uid), residentBytes: rss === undefined ? null : Number(rss) * KIB };
}

export function parseProcIoWriteBytes(text: string): number | null {
  const value = /^write_bytes:\s+(\d+)$/m.exec(text)?.[1];
  return value === undefined ? null : Number(value);
}

export function parseBootTimeMs(procStat: string): number | null {
  const value = /^btime\s+(\d+)$/m.exec(procStat)?.[1];
  return value === undefined ? null : Number(value) * 1000;
}

/** `/etc/passwd` uid → name. */
export function parsePasswd(text: string): ReadonlyMap<number, string> {
  const users = new Map<number, string>();
  for (const line of text.split("\n")) {
    const [name, , uid] = line.split(":");
    if (name && uid && /^\d+$/.test(uid)) users.set(Number(uid), name);
  }
  return users;
}

const HOARDING_THRESHOLDS = {
  /** A process holding this much memory is flagged; capped at a share of RAM on small hosts. */
  memoryBytes: 8 * GIB,
  memoryShareOfHost: 0.15,
  /** 100 = one full core, averaged over the sample interval. */
  cpuPercent: 300,
  diskWriteBytesPerSecond: 50 * MIB,
  /** Work left running inside a project for a day while still consuming resources. */
  longRunningMs: 24 * HOUR_MS,
  longRunningCpuPercent: 50,
  longRunningMemoryBytes: 2 * GIB,
} as const;

export interface HoardingInput {
  readonly cpuPercent: number;
  readonly residentBytes: number;
  readonly ioWriteBytesPerSecond: number | null;
  readonly runTimeMs: number;
  /** Long-running is only flagged for processes working inside a known project. */
  readonly hasOwner: boolean;
}

export function hoardingReasons(
  process: HoardingInput,
  totalMemoryBytes: number,
): ReadonlyArray<HostProcessHoardingReason> {
  const reasons: HostProcessHoardingReason[] = [];
  const memoryLimit = Math.min(
    HOARDING_THRESHOLDS.memoryBytes,
    totalMemoryBytes * HOARDING_THRESHOLDS.memoryShareOfHost,
  );
  if (totalMemoryBytes > 0 && process.residentBytes >= memoryLimit) reasons.push("memory");
  if (process.cpuPercent >= HOARDING_THRESHOLDS.cpuPercent) reasons.push("cpu");
  if (
    process.ioWriteBytesPerSecond !== null &&
    process.ioWriteBytesPerSecond >= HOARDING_THRESHOLDS.diskWriteBytesPerSecond
  ) {
    reasons.push("disk-write");
  }
  if (
    process.hasOwner &&
    process.runTimeMs >= HOARDING_THRESHOLDS.longRunningMs &&
    (process.cpuPercent >= HOARDING_THRESHOLDS.longRunningCpuPercent ||
      process.residentBytes >= HOARDING_THRESHOLDS.longRunningMemoryBytes)
  ) {
    reasons.push("long-running");
  }
  return reasons;
}

/** Could become long-running once its owner is known; worth reading its cwd. */
export function mayBeLongRunning(process: Omit<HoardingInput, "hasOwner">): boolean {
  return hoardingReasons({ ...process, hasOwner: true }, 0).includes("long-running");
}

export interface ProcessReading {
  readonly pid: number;
  readonly ppid: number;
  readonly name: string;
  readonly uid: number;
  readonly cpuTicks: number;
  readonly startTicks: number;
  readonly residentBytes: number;
  readonly ioWriteBytes: number | null;
}

export interface ProcessSample {
  readonly at: number;
  readonly processes: ReadonlyMap<number, ProcessReading>;
}

export interface ProcessMetrics extends ProcessReading {
  readonly cpuPercent: number;
  readonly ioWriteBytesPerSecond: number | null;
  readonly startedAt: number;
  readonly runTimeMs: number;
}

/** Linux reports process times in USER_HZ, which is 100 on every supported architecture. */
const CLOCK_TICKS_PER_SECOND = 100;

/** Rates between two samples. A pid reused between samples counts as a new process. */
export function processMetrics(
  previous: ProcessSample,
  current: ProcessSample,
  bootTimeMs: number,
): ReadonlyArray<ProcessMetrics> {
  const elapsedSeconds = (current.at - previous.at) / 1000;
  const metrics: ProcessMetrics[] = [];
  for (const process of current.processes.values()) {
    const before = previous.processes.get(process.pid);
    const sameProcess = before !== undefined && before.startTicks === process.startTicks;
    const cpuPercent =
      sameProcess && elapsedSeconds > 0
        ? Math.max(
            0,
            ((process.cpuTicks - before.cpuTicks) / CLOCK_TICKS_PER_SECOND / elapsedSeconds) * 100,
          )
        : 0;
    const ioWriteBytesPerSecond =
      sameProcess &&
      elapsedSeconds > 0 &&
      process.ioWriteBytes !== null &&
      before.ioWriteBytes !== null
        ? Math.max(0, (process.ioWriteBytes - before.ioWriteBytes) / elapsedSeconds)
        : null;
    const startedAt = bootTimeMs + (process.startTicks / CLOCK_TICKS_PER_SECOND) * 1000;
    metrics.push({
      ...process,
      cpuPercent,
      ioWriteBytesPerSecond,
      startedAt: Math.round(startedAt),
      runTimeMs: Math.max(0, current.at - startedAt),
    });
  }
  return metrics;
}

const TOP_PROCESSES_PER_METRIC = 8;

/**
 * Processes worth a closer look (command line, working directory): anything
 * already over a threshold, anything that may be long-running once its owner
 * is known, and the heaviest few by CPU and by memory for context.
 */
export function processCandidates(
  metrics: ReadonlyArray<ProcessMetrics>,
  totalMemoryBytes: number,
): ReadonlyArray<ProcessMetrics> {
  const selected = new Map<number, ProcessMetrics>();
  for (const process of metrics) {
    const input = {
      cpuPercent: process.cpuPercent,
      residentBytes: process.residentBytes,
      ioWriteBytesPerSecond: process.ioWriteBytesPerSecond,
      runTimeMs: process.runTimeMs,
    };
    if (
      hoardingReasons({ ...input, hasOwner: false }, totalMemoryBytes).length > 0 ||
      mayBeLongRunning(input)
    ) {
      selected.set(process.pid, process);
    }
  }
  for (const key of ["cpuPercent", "residentBytes"] as const) {
    for (const process of metrics
      .toSorted((left, right) => right[key] - left[key])
      .slice(0, TOP_PROCESSES_PER_METRIC)) {
      selected.set(process.pid, process);
    }
  }
  return [...selected.values()];
}

export const MAX_COMMAND_LENGTH = 400;

const SECRET_WORD = String.raw`(?:token|secret|password|passwd|api[-_]?key|apikey|auth|authorization|credentials?|cookie|session[-_]?key|private[-_]?key)`;
const JSON_SECRET_PATTERN = new RegExp(
  String.raw`("[\w.-]*${SECRET_WORD}[\w.-]*"\s*:\s*)"(?:[^"\\]|\\.)*"`,
  "gi",
);
// The value after a secret flag in a JSON argv array: `"args":["--api-key","…"]`.
const JSON_ARG_SECRET_PATTERN = new RegExp(
  String.raw`("--?(?:[A-Za-z0-9]+[-_])*${SECRET_WORD}"\s*,\s*)"(?:[^"\\]|\\.)*"`,
  "gi",
);
// A header given as its own argument (`-H "X-Api-Key: …"`, `--header=Cookie: …`):
// everything after the colon is the value.
const HEADER_SECRET_PATTERN = new RegExp(
  String.raw`^((?:--?[\w-]+=)?[\w-]*${SECRET_WORD}[\w-]*:)\s*\S.*$`,
  "is",
);
const BEARER_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const FLAG_SECRET_PATTERN = new RegExp(
  String.raw`(--?(?:[A-Za-z0-9]+[-_])*${SECRET_WORD})(=|\s+)(?!-)(?:"[^"]*"|'[^']*'|\S+)`,
  "gi",
);
const ENV_SECRET_PATTERN =
  /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|AUTH|CREDENTIALS?|PRIVATE_KEY)[A-Z0-9_]*)=\S+/g;
const QUERY_SECRET_PATTERN = new RegExp(
  String.raw`([?&][\w.-]*(?:${SECRET_WORD}|key|sig|signature)[\w.-]*=)[^&\s"']+`,
  "gi",
);
const URL_CREDENTIALS_PATTERN = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const KNOWN_TOKEN_PATTERN =
  /\b(?:sk-[A-Za-z0-9][A-Za-z0-9_-]{7,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[a-zA-Z]-[A-Za-z0-9-]+|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})\b/g;

/**
 * Command lines are visible to every client with read access, and agent CLIs
 * receive credentials as arguments (MCP headers, API keys). Redact before
 * truncating so a cut can never expose part of a secret.
 */
export function redactCommandLine(argv: ReadonlyArray<string>): string {
  const redacted = argv
    .map((arg) => arg.replace(HEADER_SECRET_PATTERN, "$1 [redacted]"))
    .join(" ")
    .replace(JSON_SECRET_PATTERN, '$1"[redacted]"')
    .replace(JSON_ARG_SECRET_PATTERN, '$1"[redacted]"')
    .replace(BEARER_PATTERN, "$1 [redacted]")
    .replace(FLAG_SECRET_PATTERN, "$1$2[redacted]")
    .replace(ENV_SECRET_PATTERN, "$1=[redacted]")
    .replace(QUERY_SECRET_PATTERN, "$1[redacted]")
    .replace(URL_CREDENTIALS_PATTERN, "$1[redacted]@")
    .replace(KNOWN_TOKEN_PATTERN, "[redacted]");
  return redacted.length <= MAX_COMMAND_LENGTH
    ? redacted
    : `${redacted.slice(0, MAX_COMMAND_LENGTH - 1)}…`;
}

export function parseCmdline(text: string): ReadonlyArray<string> {
  return text.split("\0").filter((part) => part.length > 0);
}

// ---------------------------------------------------------------------------
// Ownership

export interface OwnedPath {
  readonly path: string;
  readonly owner: HostUsageOwner;
}

/** Most specific owner of `path`: a thread worktree beats its project root. */
export function ownerForPath(owned: ReadonlyArray<OwnedPath>, path: string): HostUsageOwner | null {
  let best: OwnedPath | null = null;
  for (const entry of owned) {
    if (!isPathWithin(entry.path, path)) continue;
    if (!best || entry.path.length > best.path.length) best = entry;
  }
  return best?.owner ?? null;
}

// ---------------------------------------------------------------------------
// Disk scan

/** Parses `du -k` output into absolute path → bytes. */
export function parseDuOutput(text: string): ReadonlyMap<string, number> {
  const sizes = new Map<string, number>();
  for (const line of text.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const kib = Number(line.slice(0, tab));
    const path = line.slice(tab + 1);
    if (!Number.isFinite(kib) || kib < 0 || path.length === 0) continue;
    sizes.set(path.length > 1 ? path.replace(/\/+$/, "") : path, kib * KIB);
  }
  return sizes;
}

export interface DuConsumer {
  readonly path: string;
  readonly bytes: number;
  readonly children: ReadonlyArray<{ readonly name: string; readonly bytes: number }>;
}

/** Groups a depth-2 `du` of `root` into its immediate children, largest first. */
export function duConsumers(
  root: string,
  sizes: ReadonlyMap<string, number>,
): {
  readonly rootBytes: number | null;
  readonly consumers: ReadonlyArray<DuConsumer>;
} {
  const prefix = root === "/" ? "/" : `${root}/`;
  const children = new Map<string, Array<{ name: string; bytes: number }>>();
  const direct = new Map<string, number>();
  for (const [path, bytes] of sizes) {
    if (!path.startsWith(prefix)) continue;
    const parts = path.slice(prefix.length).split("/");
    const [first, second] = parts;
    if (!first) continue;
    const consumerPath = `${prefix}${first}`;
    if (parts.length === 1) {
      direct.set(consumerPath, bytes);
    } else if (parts.length === 2 && second) {
      const list = children.get(consumerPath) ?? [];
      list.push({ name: second, bytes });
      children.set(consumerPath, list);
    }
  }
  const consumers = [...direct].map(([path, bytes]) => ({
    path,
    bytes,
    children: (children.get(path) ?? []).toSorted((left, right) => right.bytes - left.bytes),
  }));
  return {
    rootBytes: sizes.get(root) ?? null,
    consumers: consumers.toSorted((left, right) => right.bytes - left.bytes),
  };
}

/** `.git` file contents of a linked worktree: `gitdir: <path>`. */
export function parseGitDirPointer(text: string): string | null {
  const value = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim();
  return value && value.length > 0 ? value : null;
}
