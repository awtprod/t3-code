// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Dev process supervision runs at the launcher boundary before an Effect runtime exists.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * Records the process group of a running dev-runner so a later launch (or the
 * `dev:stop` script) can reap the whole tree — the `vp` toolchain, the
 * `node --watch src/bin.ts` watcher, and the server it spawns.
 *
 * The watcher is the reason orphans accumulate: killing only the dev-runner pid
 * leaves the watcher reparented to init, where it keeps respawning the server
 * against the same data directory. dev-runner spawns its children with
 * `detached: false`, so they inherit its process group and a single
 * group-directed signal cleans the entire tree.
 */
export interface DevRunnerLock {
  readonly pid: number;
  readonly pgid: number;
  readonly homeDir: string;
  readonly startedAt: string;
}

const LOCK_BASENAME = "dev-runner.lock";

export function devRunnerLockPath(baseDir: string): string {
  return NodePath.join(baseDir, "userdata", LOCK_BASENAME);
}

/** Best-effort read of a process' argv (Linux `/proc`); undefined off-Linux. */
export function readProcessCmdline(pid: number): string | undefined {
  try {
    return NodeFS.readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim();
  } catch {
    return undefined;
  }
}

/** Working directory of a process (Linux `/proc`); undefined off-Linux. */
export function readProcessCwd(pid: number): string | undefined {
  try {
    return NodeFS.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return undefined;
  }
}

/**
 * True when a process command line looks like a dev server belonging to this
 * repo's stack: the dev-runner launcher, the `node --watch src/bin.ts` server
 * watcher (or the server it spawns), or a Vite web dev server. The match is
 * repo-agnostic — always pair it with a cwd-under-repo check before acting so a
 * dev server from a *different* checkout is left alone.
 */
export function isDevServerCmdline(cmdline: string): boolean {
  if (cmdline.includes("dev-runner")) {
    return true;
  }
  if (cmdline.includes("--watch") && cmdline.includes("src/bin.ts")) {
    return true;
  }
  // Vite web dev server: the vite-plus toolchain entrypoint (`.../vite-plus-core/
  // .../vite/node/cli.js dev`) or a plain `node_modules/.bin/vite` invocation.
  return (
    cmdline.includes("vite-plus-core") ||
    cmdline.includes("/vite/node/cli.js") ||
    /[\\/]\.bin[\\/]vite\b/.test(cmdline)
  );
}

/**
 * Our own process group id. On Linux this is `/proc/self/stat` field 5 (pgrp),
 * parsed after the final `)` of `comm` so a program name containing spaces or
 * parentheses cannot shift the field offsets. Falls back to our pid.
 */
export function currentProcessGroupId(): number {
  try {
    const stat = NodeFS.readFileSync("/proc/self/stat", "utf8");
    const afterComm = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // afterComm: [state, ppid, pgrp, ...]
    const pgrp = Number(afterComm[2]);
    return Number.isFinite(pgrp) ? pgrp : process.pid;
  } catch {
    return process.pid;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readLock(lockPath: string): DevRunnerLock | undefined {
  try {
    const parsed = JSON.parse(NodeFS.readFileSync(lockPath, "utf8")) as Partial<DevRunnerLock>;
    if (typeof parsed.pid !== "number" || typeof parsed.pgid !== "number") {
      return undefined;
    }
    return {
      pid: parsed.pid,
      pgid: parsed.pgid,
      homeDir: typeof parsed.homeDir === "string" ? parsed.homeDir : "",
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
    };
  } catch {
    return undefined;
  }
}

export function writeLock(lockPath: string, lock: DevRunnerLock): void {
  NodeFS.mkdirSync(NodePath.dirname(lockPath), { recursive: true });
  NodeFS.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

/** Current time as an ISO-8601 string, isolated here behind the boundary suppression. */
export function nowIso(): string {
  return new Date().toISOString();
}

export function removeLock(lockPath: string): void {
  try {
    NodeFS.rmSync(lockPath);
  } catch {
    // Already gone (never written, or another launch cleaned it) — nothing to do.
  }
}

/**
 * Returns the lock only if its recorded leader is still a live dev-runner. This
 * guards against pid reuse: a recycled pid that is now some unrelated process
 * must not get its process group killed. Off-Linux (no `/proc/<pid>/cmdline`)
 * we can only prove liveness, so a live pid is accepted on trust.
 */
export function staleRunnerFromLock(lock: DevRunnerLock): DevRunnerLock | undefined {
  if (!isProcessAlive(lock.pid)) {
    return undefined;
  }
  const cmdline = readProcessCmdline(lock.pid);
  if (cmdline !== undefined && !cmdline.includes("dev-runner")) {
    return undefined;
  }
  return lock;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * SIGTERM a whole process group, poll for it to drain, then SIGKILL survivors.
 * Refuses to touch pgid <= 1 (init/unknown) or our own group (self-immolation).
 * Returns true if a signal was delivered.
 */
export async function reapProcessGroup(
  pgid: number,
  options: { readonly graceMs?: number } = {},
): Promise<boolean> {
  if (pgid <= 1 || pgid === currentProcessGroupId()) {
    return false;
  }
  const graceMs = options.graceMs ?? 2000;
  try {
    process.kill(-pgid, "SIGTERM");
  } catch {
    // Group already gone.
    return false;
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-pgid, 0);
    } catch {
      return true; // group drained cleanly
    }
    await sleep(100);
  }
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // Drained during the final poll gap.
  }
  return true;
}
