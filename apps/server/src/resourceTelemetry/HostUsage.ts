// @effect-diagnostics nodeBuiltinImport:off - Effect has no free-space query.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import type {
  HostDiskConsumer,
  HostDiskReclaimBlocker,
  HostDiskReclaimInput,
  HostDiskReclaimResult,
  HostDiskReclaimRun,
  HostDiskScan,
  HostFilesystemRole,
  HostFilesystemUsage,
  HostUsageProcess,
  HostUsageSnapshot,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProcessRunner } from "../processRunner.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import {
  artifactDirectoryNamesForEntries,
  findIgnoredArtifactDirectories,
  threadIsBusy,
} from "../worktreeCleanup.ts";
import { HostResources } from "./HostResources.ts";
import {
  type DiskSample,
  type DuConsumer,
  type MountInfoEntry,
  type OwnedPath,
  type ProcessReading,
  type ProcessSample,
  diskPressureLevel,
  duConsumers,
  fillBytesPerHour,
  hoardingReasons,
  hoursUntilFull,
  isPathWithin,
  mountForPath,
  ownerForPath,
  parseBootTimeMs,
  parseCmdline,
  parseDuOutput,
  parseGitDirPointer,
  parseMountInfo,
  parsePasswd,
  parseProcIoWriteBytes,
  parseProcStat,
  parseProcStatus,
  processCandidates,
  processMetrics,
  redactCommandLine,
} from "./hostUsage.logic.ts";

export class HostUsage extends Context.Service<
  HostUsage,
  {
    readonly read: Effect.Effect<HostUsageSnapshot>;
    /** Starts a background disk scan unless one is running, and returns its state. */
    readonly scan: Effect.Effect<HostDiskScan>;
    /** Removes git-ignored build output from one checkout found by the scan. */
    readonly reclaim: (input: HostDiskReclaimInput) => Effect.Effect<HostDiskReclaimResult>;
    /** Records free space once a minute so the pane can show how fast each disk fills. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@awtprod/command-center/resourceTelemetry/HostUsage") {}

const DISK_SAMPLE_INTERVAL = "60 seconds";
// Covers the one-hour fill-rate window with room for late ticks.
const MAX_DISK_SAMPLES = 90;
const PROCESS_SAMPLE_GAP = "1 second";
const PROCESS_SAMPLE_MAX_AGE_MS = 30_000;
const MAX_PROCESSES = 30;
const MAX_CONSUMERS = 150;
const MAX_CONSUMER_CHILDREN = 5;
const SCAN_TIMEOUT = "20 minutes";
const SCAN_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const NO_RUNNING_TERMINALS: ReadonlySet<string> = new Set();

const EMPTY_SCAN: HostDiskScan = {
  status: "never",
  startedAt: null,
  finishedAt: null,
  errors: [],
  roots: [],
  consumers: [],
};

interface ShellState {
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
}

interface FilesystemReading {
  readonly key: string;
  readonly mountPoint: string;
  readonly device: string;
  readonly fsType: string;
  readonly roles: ReadonlyArray<HostFilesystemRole>;
  readonly totalBytes: number;
  readonly usedBytes: number;
  readonly availableBytes: number;
}

interface ReclaimContext {
  readonly owned: ReadonlyArray<OwnedPath>;
  /** Working directories of every process whose cwd the server may read. */
  readonly liveCwds: ReadonlyArray<string>;
  /** Directories that busy threads work in. */
  readonly busyPaths: ReadonlyArray<string>;
}

const isPid = (entry: string) => /^\d+$/.test(entry);

const statfs = (path: string) =>
  Effect.tryPromise(() => NodeFSP.statfs(path, { bigint: true })).pipe(
    Effect.map((stats) => ({
      totalBytes: Number(stats.blocks * stats.bsize),
      usedBytes: Number((stats.blocks - stats.bfree) * stats.bsize),
      availableBytes: Number(stats.bavail * stats.bsize),
    })),
    Effect.option,
  );

// A home directory as a scan root would measure everything its user owns.
function isUserHomeDirectory(path: string, home: string): boolean {
  return path === home || path === "/root" || /^\/(?:home|Users)\/[^/]+$/.test(path);
}

function reclaimBlocker(
  candidatePaths: ReadonlyArray<string>,
  context: ReclaimContext,
): Exclude<HostDiskReclaimBlocker, "no-artifacts"> | null {
  const touches = (directory: string) =>
    candidatePaths.some((candidate) => isPathWithin(candidate, directory));
  if (context.liveCwds.some(touches)) return "live-process";
  // A busy thread working in the checkout, or in a directory above it.
  if (
    context.busyPaths.some(
      (busy) => touches(busy) || candidatePaths.some((candidate) => isPathWithin(busy, candidate)),
    )
  ) {
    return "active-thread";
  }
  return null;
}

export const make = Effect.fn("makeHostUsage")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const config = yield* ServerConfig.ServerConfig;
  const hostResources = yield* HostResources;
  const projections = yield* ProjectionSnapshotQuery;
  const settings = yield* ServerSettingsService;
  const runner = yield* ProcessRunner;
  const git = yield* GitVcsDriver;

  const workerScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(workerScope, Exit.void));

  const diskSamples = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<DiskSample>>>(new Map());
  const lastProcessSample = yield* Ref.make<ProcessSample | null>(null);
  const scanState = yield* Ref.make<HostDiskScan>(EMPTY_SCAN);
  const scanRunning = yield* Ref.make(false);
  const lastReclaim = yield* Ref.make<HostDiskReclaimRun | null>(null);
  const reclaimLock = yield* Semaphore.make(1);

  const shellState = (options?: { readonly includeArchived?: boolean }) =>
    Effect.gen(function* () {
      const active = yield* projections.getShellSnapshot();
      if (!options?.includeArchived) return active as ShellState;
      const archived = yield* projections.getArchivedShellSnapshot();
      const projects = new Map(
        [...active.projects, ...archived.projects].map((project) => [project.id, project]),
      );
      return {
        projects: [...projects.values()],
        threads: [...active.threads, ...archived.threads],
      } satisfies ShellState;
    }).pipe(Effect.orElseSucceed((): ShellState => ({ projects: [], threads: [] })));

  const ownedPaths = (shell: ShellState): ReadonlyArray<OwnedPath> => {
    const projects = new Map(shell.projects.map((project) => [project.id, project]));
    const owned: OwnedPath[] = shell.projects.map((project) => ({
      path: path.resolve(project.workspaceRoot),
      owner: {
        projectId: project.id,
        projectTitle: project.title,
        threadId: null,
        threadTitle: null,
      },
    }));
    for (const thread of shell.threads) {
      const project = projects.get(thread.projectId);
      if (!thread.worktreePath || !project) continue;
      owned.push({
        path: path.resolve(thread.worktreePath),
        owner: {
          projectId: project.id,
          projectTitle: project.title,
          threadId: thread.id,
          threadTitle: thread.title,
        },
      });
    }
    return owned;
  };

  // ---------------------------------------------------------------------------
  // Filesystems

  const readMounts =
    platform === "linux"
      ? fs.readFileString("/proc/self/mountinfo").pipe(
          Effect.map(parseMountInfo),
          Effect.orElseSucceed((): ReadonlyArray<MountInfoEntry> => []),
        )
      : Effect.succeed<ReadonlyArray<MountInfoEntry>>([]);

  const filesystemOf = Effect.fn("HostUsage.filesystemOf")(function* (
    realPath: string,
    mounts: ReadonlyArray<MountInfoEntry>,
  ) {
    const mount = mountForPath(mounts, realPath);
    if (mount) {
      // Bind mounts share the device's major:minor; name the disk by its own mount when visible.
      const display =
        mounts.find((entry) => entry.majorMinor === mount.majorMinor && entry.root === "/") ??
        mount;
      return {
        key: mount.majorMinor,
        mountPoint: display.mountPoint,
        device: mount.source,
        fsType: mount.fsType,
      };
    }
    const info = yield* fs.stat(realPath).pipe(Effect.option);
    if (Option.isNone(info)) return null;
    return { key: `dev:${info.value.dev}`, mountPoint: realPath, device: "", fsType: "" };
  });

  const readFilesystems = Effect.fn("HostUsage.readFilesystems")(function* (
    projects: ReadonlyArray<OrchestrationProjectShell>,
  ) {
    const watched: ReadonlyArray<readonly [string, HostFilesystemRole]> = [
      [config.stateDir, "state"],
      [config.baseDir, "runtime"],
      [config.worktreesDir, "worktrees"],
      ...projects.map((project) => [project.workspaceRoot, "workspaces"] as const),
      [NodeOS.tmpdir(), "temp"],
    ];
    const mounts = yield* readMounts;
    const groups = new Map<
      string,
      {
        readonly filesystem: NonNullable<Effect.Success<ReturnType<typeof filesystemOf>>>;
        readonly probePath: string;
        readonly roles: Set<HostFilesystemRole>;
      }
    >();
    for (const [watchedPath, role] of watched) {
      const realPath = yield* fs.realPath(watchedPath).pipe(Effect.orElseSucceed(() => null));
      if (!realPath) continue;
      const filesystem = yield* filesystemOf(realPath, mounts);
      if (!filesystem) continue;
      const group = groups.get(filesystem.key) ?? {
        filesystem,
        probePath: realPath,
        roles: new Set<HostFilesystemRole>(),
      };
      group.roles.add(role);
      groups.set(filesystem.key, group);
    }
    const readings = yield* Effect.forEach(
      groups.values(),
      (group) =>
        statfs(group.probePath).pipe(
          Effect.map(
            Option.map((usage): FilesystemReading => ({
              ...group.filesystem,
              roles: [...group.roles],
              ...usage,
            })),
          ),
        ),
      { concurrency: 8 },
    );
    return readings.flatMap((reading) => (Option.isSome(reading) ? [reading.value] : []));
  });

  const recordDiskSample = Effect.gen(function* () {
    // Unsettled-only skips thread bodies; every project is still resolved.
    const shell = yield* projections
      .getShellSnapshot({ unsettledOnly: true })
      .pipe(Effect.orElseSucceed(() => null));
    const readings = yield* readFilesystems(shell?.projects ?? []);
    const now = yield* Clock.currentTimeMillis;
    yield* Ref.update(diskSamples, (current) => {
      const next = new Map<string, ReadonlyArray<DiskSample>>();
      for (const reading of readings) {
        next.set(
          reading.key,
          [
            ...(current.get(reading.key) ?? []),
            { at: now, availableBytes: reading.availableBytes },
          ].slice(-MAX_DISK_SAMPLES),
        );
      }
      return next;
    });
  });

  // ---------------------------------------------------------------------------
  // Processes

  const readProcess = (pid: string) =>
    Effect.gen(function* () {
      const [statText, statusText] = yield* Effect.all([
        fs.readFileString(`/proc/${pid}/stat`),
        fs.readFileString(`/proc/${pid}/status`),
      ]);
      const stat = parseProcStat(statText);
      const status = parseProcStatus(statusText);
      // Kernel threads have no resident memory and descend from kthreadd (pid 2).
      if (!stat || !status || status.residentBytes === null || stat.ppid === 2) return null;
      // Another user's I/O counters are hidden; that read fails and stays null.
      const ioWriteBytes = yield* fs.readFileString(`/proc/${pid}/io`).pipe(
        Effect.map(parseProcIoWriteBytes),
        Effect.orElseSucceed(() => null),
      );
      return {
        pid: stat.pid,
        ppid: stat.ppid,
        name: stat.name,
        uid: status.uid,
        cpuTicks: stat.cpuTicks,
        startTicks: stat.startTicks,
        residentBytes: status.residentBytes,
        ioWriteBytes,
      } satisfies ProcessReading;
    }).pipe(Effect.orElseSucceed(() => null));

  const readProcessSample = Effect.fn("HostUsage.readProcessSample")(function* () {
    const entries = yield* fs
      .readDirectory("/proc")
      .pipe(Effect.orElseSucceed((): Array<string> => []));
    const readings = yield* Effect.forEach(entries.filter(isPid), readProcess, {
      concurrency: 32,
    });
    const processes = new Map<number, ProcessReading>();
    for (const reading of readings) {
      if (reading) processes.set(reading.pid, reading);
    }
    return { at: yield* Clock.currentTimeMillis, processes } satisfies ProcessSample;
  });

  const readProcesses = Effect.fn("HostUsage.readProcesses")(function* (
    owned: ReadonlyArray<OwnedPath>,
    totalMemoryBytes: number,
  ) {
    let previous = yield* Ref.get(lastProcessSample);
    if (
      previous === null ||
      (yield* Clock.currentTimeMillis) - previous.at > PROCESS_SAMPLE_MAX_AGE_MS
    ) {
      // CPU and write rates need two readings; take a short pair when the last one is stale.
      previous = yield* readProcessSample();
      yield* Effect.sleep(PROCESS_SAMPLE_GAP);
    }
    const current = yield* readProcessSample();
    yield* Ref.set(lastProcessSample, current);

    const [procStat, passwd] = yield* Effect.all([
      fs.readFileString("/proc/stat").pipe(Effect.orElseSucceed(() => "")),
      fs.readFileString("/etc/passwd").pipe(Effect.orElseSucceed(() => "")),
    ]);
    const users = parsePasswd(passwd);
    const candidates = processCandidates(
      processMetrics(previous, current, parseBootTimeMs(procStat) ?? 0),
      totalMemoryBytes,
    );
    const processes = yield* Effect.forEach(
      candidates,
      (process) =>
        Effect.gen(function* () {
          const [argv, cwd] = yield* Effect.all([
            fs.readFileString(`/proc/${process.pid}/cmdline`).pipe(
              Effect.map(parseCmdline),
              Effect.orElseSucceed((): ReadonlyArray<string> => []),
            ),
            fs.readLink(`/proc/${process.pid}/cwd`).pipe(Effect.orElseSucceed(() => null)),
          ]);
          const owner = cwd === null ? null : ownerForPath(owned, cwd);
          return {
            pid: process.pid,
            ppid: process.ppid,
            user: users.get(process.uid) ?? String(process.uid),
            name: process.name,
            command: redactCommandLine(argv.length > 0 ? argv : [process.name]),
            cpuPercent: Math.round(process.cpuPercent * 10) / 10,
            residentBytes: process.residentBytes,
            ioWriteBytes: process.ioWriteBytes,
            ioWriteBytesPerSecond: process.ioWriteBytesPerSecond,
            startedAt: Math.max(0, process.startedAt),
            cwd,
            owner,
            reasons: hoardingReasons(
              {
                cpuPercent: process.cpuPercent,
                residentBytes: process.residentBytes,
                ioWriteBytesPerSecond: process.ioWriteBytesPerSecond,
                runTimeMs: process.runTimeMs,
                hasOwner: owner !== null,
              },
              totalMemoryBytes,
            ),
          } satisfies HostUsageProcess;
        }),
      { concurrency: 8 },
    );
    return processes
      .toSorted(
        (left, right) =>
          Number(right.reasons.length > 0) - Number(left.reasons.length > 0) ||
          right.cpuPercent - left.cpuPercent ||
          right.residentBytes - left.residentBytes,
      )
      .slice(0, MAX_PROCESSES);
  });

  // ---------------------------------------------------------------------------
  // Snapshot

  const sample = Effect.fn("HostUsage.sample")(function* () {
    const shell = yield* shellState();
    const [host, filesystems, processes] = yield* Effect.all(
      [
        hostResources.read,
        readFilesystems(shell.projects),
        platform === "linux"
          ? readProcesses(ownedPaths(shell), NodeOS.totalmem())
          : Effect.succeed<ReadonlyArray<HostUsageProcess>>([]),
      ],
      { concurrency: "unbounded" },
    );
    const now = yield* Clock.currentTimeMillis;
    const samples = yield* Ref.get(diskSamples);
    return {
      host,
      processes,
      filesystems: filesystems.map((reading): HostFilesystemUsage => {
        const fillRate = fillBytesPerHour(samples.get(reading.key) ?? [], now);
        return {
          mountPoint: reading.mountPoint,
          device: reading.device,
          fsType: reading.fsType,
          roles: reading.roles,
          totalBytes: reading.totalBytes,
          usedBytes: reading.usedBytes,
          availableBytes: reading.availableBytes,
          level: diskPressureLevel(reading.totalBytes, reading.availableBytes),
          fillBytesPerHour: fillRate === null ? null : Math.round(fillRate),
          hoursUntilFull: hoursUntilFull(reading.availableBytes, fillRate),
        };
      }),
    };
  });

  // One server-lifetime cache deduplicates simultaneous requests from all sockets.
  const sampleCache = yield* Cache.make({
    capacity: 1,
    lookup: (_key: "host") => sample(),
    timeToLive: "5 seconds",
  });

  const read = Effect.gen(function* () {
    const sampled = yield* Cache.get(sampleCache, "host");
    const [scan, reclaimRun, reclaimIdleAfterDays] = yield* Effect.all([
      Ref.get(scanState),
      Ref.get(lastReclaim),
      settings.getSettings.pipe(
        Effect.map((current) => current.worktreeCleanupAfterDays),
        Effect.orElseSucceed(() => null),
      ),
    ]);
    return {
      sampledAt: sampled.host.sampledAt,
      host: sampled.host,
      processesSupported: platform === "linux",
      filesystems: sampled.filesystems,
      processes: sampled.processes,
      scan,
      reclaimIdleAfterDays,
      lastReclaim: reclaimRun,
    } satisfies HostUsageSnapshot;
  });

  // ---------------------------------------------------------------------------
  // Disk scan

  const liveProcessCwds = Effect.gen(function* () {
    if (platform !== "linux") return [];
    const entries = yield* fs
      .readDirectory("/proc")
      .pipe(Effect.orElseSucceed((): Array<string> => []));
    const cwds = yield* Effect.forEach(
      entries.filter(isPid),
      (pid) => fs.readLink(`/proc/${pid}/cwd`).pipe(Effect.orElseSucceed(() => null)),
      { concurrency: 32 },
    );
    return cwds.filter((cwd): cwd is string => cwd !== null);
  });

  const reclaimContext = Effect.fn("HostUsage.reclaimContext")(function* (shell: ShellState) {
    const workspaceRoots = new Map(
      shell.projects.map((project) => [project.id, project.workspaceRoot]),
    );
    const busyPaths = shell.threads.flatMap((thread) => {
      // Running terminals show up as live processes, so only thread state is checked here.
      if (!threadIsBusy(thread, NO_RUNNING_TERMINALS)) return [];
      const directory = thread.worktreePath ?? workspaceRoots.get(thread.projectId);
      return directory ? [path.resolve(directory)] : [];
    });
    return {
      owned: ownedPaths(shell),
      liveCwds: yield* liveProcessCwds,
      busyPaths,
    } satisfies ReclaimContext;
  });

  /** Directories whose immediate children are measured, resolved to real paths. */
  const scanRoots = Effect.fn("HostUsage.scanRoots")(function* (
    projects: ReadonlyArray<OrchestrationProjectShell>,
  ) {
    const candidates: string[] = [];
    const repositories = yield* fs
      .readDirectory(config.worktreesDir)
      .pipe(Effect.orElseSucceed((): Array<string> => []));
    for (const repository of repositories) {
      candidates.push(path.join(config.worktreesDir, repository));
    }
    const home = NodeOS.homedir();
    for (const project of projects) {
      const parent = path.dirname(path.resolve(project.workspaceRoot));
      if (parent === path.parse(parent).root || isUserHomeDirectory(parent, home)) continue;
      candidates.push(parent);
    }
    candidates.push(config.baseDir);

    const roots = new Set<string>();
    for (const candidate of candidates) {
      const realPath = yield* fs.realPath(candidate).pipe(Effect.orElseSucceed(() => null));
      if (!realPath) continue;
      const info = yield* fs.stat(realPath).pipe(Effect.option);
      if (Option.isSome(info) && info.value.type === "Directory") roots.add(realPath);
    }
    return [...roots];
  });

  const measureRoot = Effect.fn("HostUsage.measureRoot")(function* (root: string) {
    const result = yield* runner
      .run({
        command: "nice",
        // -x: stay on the root's filesystem; -k: sizes in KiB on every platform.
        args: ["-n", "19", "du", "-x", "-k", "-d", "2", "--", root],
        timeout: SCAN_TIMEOUT,
        maxOutputBytes: SCAN_MAX_OUTPUT_BYTES,
        outputMode: "truncate",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.result);
    if (result._tag === "Failure") {
      return { ok: false, message: result.failure.message } as const;
    }
    const output = result.success;
    if (output.timedOut) return { ok: false, message: "Timed out after 20 minutes." } as const;
    // A truncated final line would parse as a bogus path.
    const stdout = output.stdoutTruncated
      ? output.stdout.slice(0, output.stdout.lastIndexOf("\n") + 1)
      : output.stdout;
    const sizes = parseDuOutput(stdout);
    // du exits 1 when some directories are unreadable but still reports the rest.
    if (sizes.size === 0) {
      const detail = output.stderr.trim().split("\n")[0];
      return {
        ok: false,
        message: detail && detail.length > 0 ? detail : `du exited with code ${output.code}.`,
      } as const;
    }
    return { ok: true, ...duConsumers(root, sizes) } as const;
  });

  const describeConsumer = Effect.fn("HostUsage.describeConsumer")(function* (
    root: string,
    consumer: DuConsumer,
    context: ReclaimContext,
  ) {
    const gitPath = path.join(consumer.path, ".git");
    const gitInfo = yield* fs.stat(gitPath).pipe(Effect.option);
    const isCheckout = Option.isSome(gitInfo);
    const entries = isCheckout
      ? yield* fs.readDirectory(consumer.path).pipe(Effect.orElseSucceed((): Array<string> => []))
      : [];
    const artifactNames = new Set(artifactDirectoryNamesForEntries(entries));
    const artifactBytes = consumer.children
      .filter((child) => artifactNames.has(child.name))
      .reduce((sum, child) => sum + child.bytes, 0);

    let gitDirectory = gitPath;
    if (Option.isSome(gitInfo) && gitInfo.value.type === "File") {
      const pointer = yield* fs.readFileString(gitPath).pipe(
        Effect.map(parseGitDirPointer),
        Effect.orElseSucceed(() => null),
      );
      if (pointer) gitDirectory = path.resolve(consumer.path, pointer);
    }
    const activityPaths = isCheckout
      ? [
          consumer.path,
          gitPath,
          path.join(gitDirectory, "index"),
          path.join(gitDirectory, "HEAD"),
          path.join(gitDirectory, "logs", "HEAD"),
          ...[...artifactNames].map((name) => path.join(consumer.path, name)),
        ]
      : [consumer.path];
    const modifiedTimes = yield* Effect.forEach(activityPaths, (activityPath) =>
      fs.stat(activityPath).pipe(
        Effect.map((info) => Option.getOrNull(Option.map(info.mtime, (date) => date.getTime()))),
        Effect.orElseSucceed(() => null),
      ),
    );
    const knownTimes = modifiedTimes.filter((time): time is number => time !== null);

    return {
      path: consumer.path,
      root,
      bytes: consumer.bytes,
      isCheckout,
      artifactBytes,
      largestChildren: consumer.children.slice(0, MAX_CONSUMER_CHILDREN),
      lastActivityAt: knownTimes.length > 0 ? Math.max(...knownTimes) : null,
      owner: ownerForPath(context.owned, consumer.path),
      reclaimBlocker: !isCheckout
        ? null
        : artifactBytes === 0
          ? "no-artifacts"
          : reclaimBlocker([consumer.path], context),
    } satisfies HostDiskConsumer;
  });

  const runScan = Effect.fn("HostUsage.runScan")(function* (startedAt: number) {
    const shell = yield* shellState({ includeArchived: true });
    const roots = yield* scanRoots(shell.projects);
    const errors: Array<{ root: string; message: string }> = [];
    const rootSizes: Array<{ path: string; bytes: number }> = [];
    const measured: Array<{ root: string; consumer: DuConsumer }> = [];
    // One root at a time keeps the scan to a single low-priority du process.
    for (const root of roots) {
      const result = yield* measureRoot(root);
      if (!result.ok) {
        errors.push({ root, message: result.message });
        continue;
      }
      rootSizes.push({
        path: root,
        bytes: result.rootBytes ?? result.consumers.reduce((sum, item) => sum + item.bytes, 0),
      });
      for (const consumer of result.consumers) measured.push({ root, consumer });
    }
    // Blockers are read after du finishes so they reflect the moment results appear.
    const context = yield* reclaimContext(shell);
    const consumers = yield* Effect.forEach(
      measured
        .toSorted((left, right) => right.consumer.bytes - left.consumer.bytes)
        .slice(0, MAX_CONSUMERS),
      ({ root, consumer }) => describeConsumer(root, consumer, context),
      { concurrency: 8 },
    );
    yield* Ref.set(scanState, {
      status: "complete",
      startedAt,
      finishedAt: yield* Clock.currentTimeMillis,
      errors,
      roots: rootSizes.toSorted((left, right) => right.bytes - left.bytes),
      consumers,
    });
  });

  const scan = Effect.gen(function* () {
    const shouldStart = yield* Ref.modify(scanRunning, (running) => [!running, true] as const);
    if (shouldStart) {
      const startedAt = yield* Clock.currentTimeMillis;
      // Earlier results stay visible while the new scan runs.
      yield* Ref.update(scanState, (current) => ({
        ...current,
        status: "running" as const,
        startedAt,
        errors: [],
      }));
      yield* (
        platform === "win32"
          ? Ref.update(scanState, (current) => ({
              ...current,
              status: "failed" as const,
              finishedAt: startedAt,
              errors: [
                { root: config.baseDir, message: "Disk scans need du, which Windows lacks." },
              ],
            }))
          : runScan(startedAt)
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("host disk scan failed", { cause }).pipe(
            Effect.andThen(Clock.currentTimeMillis),
            Effect.flatMap((finishedAt) =>
              Ref.update(scanState, (current) => ({
                ...current,
                status: "failed" as const,
                finishedAt,
                errors: [{ root: config.baseDir, message: "The disk scan failed unexpectedly." }],
              })),
            ),
          ),
        ),
        Effect.ensuring(Ref.set(scanRunning, false)),
        Effect.forkIn(workerScope),
      );
    }
    return yield* Ref.get(scanState);
  });

  // ---------------------------------------------------------------------------
  // Reclaim

  const reclaimOnce = Effect.fn("HostUsage.reclaim")(function* (input: HostDiskReclaimInput) {
    const refused = (
      reason: Extract<HostDiskReclaimResult, { status: "refused" }>["reason"],
      message: string,
    ): HostDiskReclaimResult => ({ status: "refused", reason, message });

    const requested = path.resolve(input.path);
    const checkout = yield* fs.realPath(requested).pipe(Effect.orElseSucceed(() => null));
    if (!checkout) return refused("outside-scan-roots", "That directory no longer exists.");
    const shell = yield* shellState({ includeArchived: true });
    const roots = yield* scanRoots(shell.projects);
    if (!roots.includes(path.dirname(checkout))) {
      return refused(
        "outside-scan-roots",
        "Only directories directly inside a scanned location can be reclaimed.",
      );
    }
    const isCheckout = yield* fs
      .exists(path.join(checkout, ".git"))
      .pipe(Effect.orElseSucceed(() => false));
    if (!isCheckout) return refused("not-a-checkout", "Only git checkouts can be reclaimed.");

    const blocker = reclaimBlocker([checkout, requested], yield* reclaimContext(shell));
    if (blocker === "live-process") {
      return refused("live-process", "A process is still running inside this checkout.");
    }
    if (blocker === "active-thread") {
      return refused("active-thread", "A thread working in this checkout is still active.");
    }

    const artifacts = yield* findIgnoredArtifactDirectories(git, checkout).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    );
    if (artifacts.length === 0) {
      return refused("no-artifacts", "No git-ignored build output was found in this checkout.");
    }

    const before = yield* statfs(checkout);
    const removed: string[] = [];
    for (const artifact of artifacts) {
      const ok = yield* fs.remove(artifact, { recursive: true, force: true }).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning("host disk reclaim could not remove build output", {
            artifact,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );
      if (ok) removed.push(artifact);
    }
    const after = yield* statfs(checkout);
    const freedBytes =
      Option.isSome(before) && Option.isSome(after)
        ? Math.max(0, after.value.availableBytes - before.value.availableBytes)
        : 0;
    yield* Effect.logInfo("host disk reclaim removed build output", {
      checkout,
      removed,
      freedBytes,
    });

    yield* Ref.set(lastReclaim, {
      at: yield* Clock.currentTimeMillis,
      paths: [checkout],
      freedBytes,
    });
    yield* Ref.update(scanState, (current) => ({
      ...current,
      consumers: current.consumers.map((consumer) =>
        consumer.path === checkout
          ? {
              ...consumer,
              bytes: Math.max(0, consumer.bytes - consumer.artifactBytes),
              artifactBytes: 0,
              reclaimBlocker: "no-artifacts" as const,
            }
          : consumer,
      ),
    }));
    return { status: "reclaimed", removed, freedBytes } satisfies HostDiskReclaimResult;
  });

  const reclaim: HostUsage["Service"]["reclaim"] = (input) =>
    reclaimLock.withPermits(1)(reclaimOnce(input));

  const start: HostUsage["Service"]["start"] = () =>
    forkParked(recordDiskSample.pipe(Effect.repeat(Schedule.spaced(DISK_SAMPLE_INTERVAL))));

  return HostUsage.of({ read, scan, reclaim, start });
});

export const layer = Layer.effect(HostUsage, make());
