#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Standalone launcher-lifecycle CLI; runs before/without an Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import {
  devRunnerLockPath,
  isDevServerCmdline,
  readLock,
  readProcessCmdline,
  readProcessCwd,
  reapProcessGroup,
  staleRunnerFromLock,
} from "./lib/dev-process-guard.ts";

const REPO_ROOT = NodePath.dirname(NodePath.dirname(NodeFS.realpathSync(process.argv[1] ?? ".")));

function resolveHomeDir(explicit: string | undefined): string {
  if (explicit !== undefined && explicit.length > 0) {
    return NodePath.resolve(explicit);
  }
  const fromEnv = process.env.T3CODE_HOME;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return NodePath.resolve(fromEnv);
  }
  return NodePath.join(NodeOS.homedir(), ".command-center");
}

/**
 * Sweep the process table (Linux `/proc`) for dev trees rooted in this repo that
 * are not covered by a lock — pre-lock launches, or servers whose lock was
 * removed but that outlived their parent. Matches the dev-runner launcher, the
 * `node --watch src/bin.ts` server watcher, and Vite web dev servers (see
 * isDevServerCmdline) whose cwd is under this repo.
 */
function sweepRepoDevGroups(): number[] {
  const pgids = new Set<number>();
  let entries: string[];
  try {
    entries = NodeFS.readdirSync("/proc");
  } catch {
    return []; // off-Linux: lock-based reap only
  }
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isInteger(pid)) {
      continue;
    }
    const cmdline = readProcessCmdline(pid);
    if (cmdline === undefined) {
      continue;
    }
    if (!isDevServerCmdline(cmdline)) {
      continue;
    }
    const cwd = readProcessCwd(pid);
    if (cwd === undefined || !cwd.startsWith(REPO_ROOT)) {
      continue;
    }
    // /proc/<pid>/stat field 5 (pgrp), parsed after the final ')' of comm.
    try {
      const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
      const pgrp = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
      if (Number.isFinite(pgrp)) {
        pgids.add(pgrp);
      }
    } catch {
      // Process exited between readdir and stat — skip.
    }
  }
  return [...pgids];
}

async function main(): Promise<void> {
  const { values } = NodeUtil.parseArgs({
    options: {
      "home-dir": { type: "string" },
      "no-sweep": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  const homeDir = resolveHomeDir(values["home-dir"] as string | undefined);
  const dryRun = values["dry-run"] as boolean;
  const verb = dryRun ? "would reap" : "reaping";
  let reaped = 0;

  const lockPath = devRunnerLockPath(homeDir);
  const lock = readLock(lockPath);
  if (lock !== undefined) {
    const stale = staleRunnerFromLock(lock);
    if (stale !== undefined) {
      process.stdout.write(
        `[dev-stop] ${verb} dev tree pgid=${stale.pgid} pid=${stale.pid} for ${homeDir}\n`,
      );
      if (dryRun) {
        reaped += 1;
      } else if (await reapProcessGroup(stale.pgid)) {
        reaped += 1;
      }
    }
    if (!dryRun) {
      try {
        NodeFS.rmSync(lockPath);
      } catch {
        // Lock already gone.
      }
    }
  }

  if (!(values["no-sweep"] as boolean)) {
    for (const pgid of sweepRepoDevGroups()) {
      process.stdout.write(
        `[dev-stop] ${dryRun ? "would sweep" : "sweeping"} stray dev group pgid=${pgid} under ${REPO_ROOT}\n`,
      );
      if (dryRun) {
        reaped += 1;
      } else if (await reapProcessGroup(pgid)) {
        reaped += 1;
      }
    }
  }

  if (reaped === 0) {
    process.stdout.write(`[dev-stop] no running dev trees found for ${homeDir}\n`);
  } else if (dryRun) {
    process.stdout.write(
      `[dev-stop] would reap ${reaped} dev group(s) (dry run — nothing killed)\n`,
    );
  } else {
    process.stdout.write(`[dev-stop] reaped ${reaped} dev group(s)\n`);
  }
}

void main();
