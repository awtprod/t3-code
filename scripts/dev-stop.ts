#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Standalone launcher-lifecycle CLI; runs before/without an Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import {
  devRunnerLockPath,
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
 * are not covered by a lock — pre-lock launches, or watchers whose lock was
 * removed but that outlived their parent. Matches `dev-runner` and the
 * `node --watch src/bin.ts` server watcher whose cwd is under this repo.
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
    const isDevProcess =
      cmdline.includes("dev-runner") ||
      (cmdline.includes("--watch") && cmdline.includes("src/bin.ts"));
    if (!isDevProcess) {
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
    },
    allowPositionals: false,
  });

  const homeDir = resolveHomeDir(values["home-dir"] as string | undefined);
  let reaped = 0;

  const lockPath = devRunnerLockPath(homeDir);
  const lock = readLock(lockPath);
  if (lock !== undefined) {
    const stale = staleRunnerFromLock(lock);
    if (stale !== undefined) {
      process.stdout.write(
        `[dev-stop] reaping dev tree pgid=${stale.pgid} pid=${stale.pid} for ${homeDir}\n`,
      );
      if (await reapProcessGroup(stale.pgid)) {
        reaped += 1;
      }
    }
    try {
      NodeFS.rmSync(lockPath);
    } catch {
      // Lock already gone.
    }
  }

  if (!(values["no-sweep"] as boolean)) {
    for (const pgid of sweepRepoDevGroups()) {
      process.stdout.write(`[dev-stop] sweeping stray dev group pgid=${pgid} under ${REPO_ROOT}\n`);
      if (await reapProcessGroup(pgid)) {
        reaped += 1;
      }
    }
  }

  process.stdout.write(
    reaped === 0
      ? `[dev-stop] no running dev trees found for ${homeDir}\n`
      : `[dev-stop] reaped ${reaped} dev group(s)\n`,
  );
}

void main();
