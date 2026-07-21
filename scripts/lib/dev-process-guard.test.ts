// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Exercises the non-Effect launcher-boundary guard with real OS processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import {
  currentProcessGroupId,
  devRunnerLockPath,
  isProcessAlive,
  readLock,
  reapProcessGroup,
  removeLock,
  staleRunnerFromLock,
  writeLock,
  type DevRunnerLock,
} from "./dev-process-guard.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitForDeath = async (pid: number, timeoutMs = 3000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await sleep(50);
  }
  return !isProcessAlive(pid);
};

describe("dev-process-guard lock file", () => {
  it("round-trips a lock and reports missing/garbage as undefined", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "dev-guard-"));
    try {
      const lockPath = devRunnerLockPath(dir);
      assert.strictEqual(readLock(lockPath), undefined);

      const lock: DevRunnerLock = {
        pid: 4242,
        pgid: 4242,
        homeDir: dir,
        startedAt: "2026-07-21T00:00:00.000Z",
      };
      writeLock(lockPath, lock);
      assert.deepStrictEqual(readLock(lockPath), lock);

      NodeFS.writeFileSync(lockPath, "{ not json");
      assert.strictEqual(readLock(lockPath), undefined);

      removeLock(lockPath);
      assert.strictEqual(readLock(lockPath), undefined);
      // removeLock on an already-absent file must not throw.
      removeLock(lockPath);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("dev-process-guard staleness", () => {
  it("rejects a dead pid and a live non-dev-runner pid", () => {
    // A pid that is (almost certainly) not alive.
    const deadLock: DevRunnerLock = { pid: 2 ** 22, pgid: 2 ** 22, homeDir: "", startedAt: "" };
    assert.strictEqual(staleRunnerFromLock(deadLock), undefined);

    // Our own test process is alive but its cmdline is not a dev-runner, so on
    // Linux (where cmdline is readable) it must be rejected to avoid pid-reuse
    // mis-kills. Off-Linux the cmdline is unreadable and liveness is trusted.
    const selfLock: DevRunnerLock = {
      pid: process.pid,
      pgid: currentProcessGroupId(),
      homeDir: "",
      startedAt: "",
    };
    const result = staleRunnerFromLock(selfLock);
    if (process.platform === "linux") {
      assert.strictEqual(result, undefined);
    } else {
      assert.deepStrictEqual(result, selfLock);
    }
  });
});

describe("dev-process-guard reaper", () => {
  it("refuses to signal init or our own group", async () => {
    assert.strictEqual(await reapProcessGroup(0), false);
    assert.strictEqual(await reapProcessGroup(1), false);
    assert.strictEqual(await reapProcessGroup(currentProcessGroupId()), false);
    // Proof it did not signal us: this line runs.
    assert.ok(isProcessAlive(process.pid));
  });

  it("reaps an entire process group, not just the leader", async () => {
    // Spawn a detached leader (new session => pgid === child.pid) that forks a
    // grandchild sharing the group. The grandchild is only reachable through a
    // group-directed signal, so its death proves group semantics.
    const child = NodeChildProcess.spawn(
      "sh",
      ["-c", "sleep 300 & grandchild=$!; echo $grandchild; wait"],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    child.unref();

    const leaderPid = child.pid;
    assert.ok(leaderPid !== undefined && leaderPid > 1);

    const grandchildPid = await new Promise<number>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error("no grandchild pid")), 3000);
      child.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const line = buffer.split("\n")[0]?.trim();
        if (line && /^\d+$/.test(line)) {
          clearTimeout(timer);
          resolve(Number(line));
        }
      });
    });

    try {
      assert.ok(isProcessAlive(leaderPid as number), "leader should be alive before reap");
      assert.ok(isProcessAlive(grandchildPid), "grandchild should be alive before reap");

      // pgid === leader pid for a detached session leader.
      const signalled = await reapProcessGroup(leaderPid as number, { graceMs: 1500 });
      assert.strictEqual(signalled, true);

      assert.ok(await waitForDeath(leaderPid as number), "leader must be reaped");
      assert.ok(await waitForDeath(grandchildPid), "grandchild must be reaped via the group");
    } finally {
      // Belt-and-suspenders: ensure nothing survives a failed assertion.
      try {
        process.kill(-(leaderPid as number), "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });
});
