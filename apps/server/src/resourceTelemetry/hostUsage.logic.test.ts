import { ProjectId, ThreadId, type HostUsageOwner } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  MAX_COMMAND_LENGTH,
  duConsumers,
  diskPressureLevel,
  fillBytesPerHour,
  hoardingReasons,
  hoursUntilFull,
  isPathWithin,
  mayBeLongRunning,
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
  type DiskSample,
  type MountInfoEntry,
  type ProcessMetrics,
  type ProcessReading,
  type ProcessSample,
} from "./hostUsage.logic.ts";

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const TIB = 1024 ** 4;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

describe("parseMountInfo", () => {
  it("parses a plain mount", () => {
    expect(
      parseMountInfo("26 1 259:2 / / rw,relatime - ext4 /dev/nvme0n1p2 rw,errors=remount-ro"),
    ).toEqual([
      { majorMinor: "259:2", root: "/", mountPoint: "/", fsType: "ext4", source: "/dev/nvme0n1p2" },
    ]);
  });

  it("keeps the source subdirectory of a bind mount as root", () => {
    expect(
      parseMountInfo(
        "412 26 259:3 /retained/runtime-worktrees /srv/acme/worktrees rw,relatime - ext4 /dev/nvme0n1p1 rw",
      ),
    ).toEqual([
      {
        majorMinor: "259:3",
        root: "/retained/runtime-worktrees",
        mountPoint: "/srv/acme/worktrees",
        fsType: "ext4",
        source: "/dev/nvme0n1p1",
      },
    ]);
  });

  it("decodes octal escapes in the root, mount point, and source", () => {
    const [entry] = parseMountInfo(
      String.raw`100 26 8:1 /sub\011dir /mnt/with\040space rw - fuse.acme /srv/back\134slash rw`,
    );
    expect(entry).toMatchObject({
      root: "/sub\tdir",
      mountPoint: "/mnt/with space",
      source: "/srv/back\\slash",
    });
  });

  it("ignores optional fields before the separator", () => {
    expect(
      parseMountInfo("77 26 0:41 / /srv/acme rw,nosuid shared:1 master:2 - tmpfs tmpfs rw"),
    ).toEqual([
      { majorMinor: "0:41", root: "/", mountPoint: "/srv/acme", fsType: "tmpfs", source: "tmpfs" },
    ]);
  });

  it("skips malformed lines and keeps the valid ones", () => {
    const text = [
      "",
      "no separator on this line",
      "1 2 - ext4 /dev/sda1",
      "1 2 3:4 / /mnt rw - ",
      "1 2 3:4 / /mnt rw - ext4",
      "26 1 259:2 / / rw - ext4 /dev/nvme0n1p2 rw",
      "",
    ].join("\n");
    expect(parseMountInfo(text).map((entry) => entry.mountPoint)).toEqual(["/"]);
  });
});

describe("isPathWithin / mountForPath", () => {
  const mount = (mountPoint: string, source = mountPoint): MountInfoEntry => ({
    majorMinor: "0:0",
    root: "/",
    mountPoint,
    fsType: "ext4",
    source,
  });

  it.each([
    ["/srv", "/srv", true],
    ["/srv", "/srv/acme/x", true],
    ["/srv", "/srv/", true],
    ["/srv/fo", "/srv/foo", false],
    ["/srv/foo", "/srv", false],
    ["/", "/anything/at/all", true],
    ["/", "/", true],
    ["/", "relative/path", false],
  ])("isPathWithin(%s, %s) is %s", (parent, candidate, expected) => {
    expect(isPathWithin(parent, candidate)).toBe(expected);
  });

  it("picks the longest matching mount point regardless of order", () => {
    const root = mount("/");
    const srv = mount("/srv");
    const acme = mount("/srv/acme");
    for (const mounts of [
      [root, srv, acme],
      [acme, srv, root],
    ]) {
      expect(mountForPath(mounts, "/srv/acme/data/file")).toBe(acme);
      expect(mountForPath(mounts, "/srv/other")).toBe(srv);
      expect(mountForPath(mounts, "/etc/hosts")).toBe(root);
    }
  });

  it("lets a later mount shadow an earlier one at the same mount point", () => {
    const first = mount("/srv", "/dev/first");
    const second = mount("/srv", "/dev/second");
    expect(mountForPath([mount("/"), first, second], "/srv/x")).toBe(second);
  });

  it("does not match a mount point that is only a string prefix", () => {
    const root = mount("/");
    expect(mountForPath([root, mount("/srv/fo")], "/srv/foo")).toBe(root);
    expect(mountForPath([mount("/srv/fo")], "/srv/foo")).toBeNull();
  });

  it("returns null without a containing mount", () => {
    expect(mountForPath([], "/srv")).toBeNull();
  });
});

describe("diskPressureLevel", () => {
  it.each([
    ["2 TiB disk, 300 GiB free", 2 * TIB, 300 * GIB, "ok"],
    ["2 TiB disk, 200 GiB free (<10%)", 2 * TIB, 200 * GIB, "warning"],
    ["2 TiB disk, 110 GiB free (<10%)", 2 * TIB, 110 * GIB, "warning"],
    ["2 TiB disk, 100 GiB free (<5%)", 2 * TIB, 100 * GIB, "critical"],
    ["2 TiB disk, 12 GiB free", 2 * TIB, 12 * GIB, "critical"],
    ["50 GiB disk, 20 GiB free", 50 * GIB, 20 * GIB, "ok"],
    ["50 GiB disk, exactly 15 GiB free", 50 * GIB, 15 * GIB, "ok"],
    ["50 GiB disk, just under 15 GiB free", 50 * GIB, 15 * GIB - 1, "warning"],
    ["50 GiB disk, 12 GiB free (24% but <15 GiB)", 50 * GIB, 12 * GIB, "warning"],
    ["50 GiB disk, exactly 5 GiB free", 50 * GIB, 5 * GIB, "warning"],
    ["50 GiB disk, just under 5 GiB free", 50 * GIB, 5 * GIB - 1, "critical"],
    ["50 GiB disk, 4 GiB free", 50 * GIB, 4 * GIB, "critical"],
    ["unknown size", 0, 0, "ok"],
    ["negative size", -1, 10, "ok"],
  ] as const)("%s is %s", (_label, total, available, expected) => {
    expect(diskPressureLevel(total, available)).toBe(expected);
  });
});

describe("fillBytesPerHour / hoursUntilFull", () => {
  const NOW = 10 * HOUR_MS;
  const declining = (offsetsMinutes: ReadonlyArray<number>, gibPerTenMinutes: number) =>
    offsetsMinutes.map((minutes): DiskSample => ({
      at: NOW - 30 * MINUTE_MS + minutes * MINUTE_MS,
      availableBytes: 100 * GIB - (minutes / 10) * gibPerTenMinutes * GIB,
    }));

  it("is null with fewer than three samples", () => {
    expect(fillBytesPerHour([], NOW)).toBeNull();
    expect(fillBytesPerHour(declining([0, 30], 1), NOW)).toBeNull();
  });

  it("is null when the samples span less than ten minutes", () => {
    expect(fillBytesPerHour(declining([20, 25, 29], 1), NOW)).toBeNull();
    expect(fillBytesPerHour(declining([20, 25, 30], 1), NOW)).not.toBeNull();
  });

  it("measures a linear decline of 1 GiB per 10 minutes as 6 GiB per hour", () => {
    const rate = fillBytesPerHour(declining([0, 10, 20, 30], 1), NOW);
    expect(rate! / GIB).toBeCloseTo(6, 6);
    expect(hoursUntilFull(60 * GIB, rate)).toBeCloseTo(10, 6);
  });

  it("fits a line through uneven samples", () => {
    expect(fillBytesPerHour(declining([0, 3, 12, 30], 2), NOW)! / GIB).toBeCloseTo(12, 6);
  });

  it("ignores samples older than one hour", () => {
    const stale: DiskSample = { at: NOW - 90 * MINUTE_MS, availableBytes: 900 * GIB };
    expect(fillBytesPerHour([stale, ...declining([0, 10, 20, 30], 1)], NOW)! / GIB).toBeCloseTo(
      6,
      6,
    );
    expect(fillBytesPerHour([stale, ...declining([20, 30], 1)], NOW)).toBeNull();
  });

  it("keeps a sample exactly one hour old", () => {
    const edge: DiskSample = { at: NOW - HOUR_MS, availableBytes: 100 * GIB };
    const rest: DiskSample[] = [
      { at: NOW - 30 * MINUTE_MS, availableBytes: 97 * GIB },
      { at: NOW, availableBytes: 94 * GIB },
    ];
    expect(fillBytesPerHour([edge, ...rest], NOW)).not.toBeNull();
  });

  it("reports a negative rate and no time to full while space is being freed", () => {
    const rate = fillBytesPerHour(declining([0, 10, 20, 30], -1), NOW);
    expect(rate! / GIB).toBeCloseTo(-6, 6);
    expect(hoursUntilFull(60 * GIB, rate)).toBeNull();
  });

  it("reports no time to full for a flat disk or an unknown rate", () => {
    const flat = fillBytesPerHour(declining([0, 10, 20, 30], 0), NOW);
    expect(flat).toBeCloseTo(0, 6);
    expect(hoursUntilFull(60 * GIB, flat)).toBeNull();
    expect(hoursUntilFull(60 * GIB, null)).toBeNull();
    expect(hoursUntilFull(60 * GIB, 0)).toBeNull();
  });

  it("divides available bytes by the rate", () => {
    expect(hoursUntilFull(30 * GIB, 2 * GIB)).toBe(15);
  });
});

describe("procfs parsers", () => {
  const statLine = (
    pid: number,
    name: string,
    values: { ppid: number; utime: number; stime: number; startTicks: number },
  ) => {
    // proc(5) fields 3..52; every other field gets a distinct sentinel so an off-by-one index shows.
    const fields = Array.from({ length: 50 }, (_, index) => String(9000 + index + 3));
    fields[0] = "S";
    fields[1] = String(values.ppid);
    fields[11] = String(values.utime);
    fields[12] = String(values.stime);
    fields[19] = String(values.startTicks);
    return `${pid} (${name}) ${fields.join(" ")}\n`;
  };
  const values = { ppid: 1, utime: 120, stime: 35, startTicks: 987_654 };

  describe("parseProcStat", () => {
    it("reads pid, ppid, summed cpu ticks, and start ticks", () => {
      expect(parseProcStat(statLine(4321, "node", values))).toEqual({
        pid: 4321,
        name: "node",
        ppid: 1,
        cpuTicks: 155,
        startTicks: 987_654,
      });
    });

    it("keeps spaces and parentheses in the command name", () => {
      expect(parseProcStat(statLine(1234, "my (weird) proc", values))).toEqual({
        pid: 1234,
        name: "my (weird) proc",
        ppid: 1,
        cpuTicks: 155,
        startTicks: 987_654,
      });
      expect(parseProcStat(statLine(1234, "a) S 99 (b", values))?.name).toBe("a) S 99 (b");
    });

    it.each(["", "garbage", "123 (no-fields)", "abc (x) S 1 2 3", "1 )x("])(
      "returns null for %j",
      (text) => {
        expect(parseProcStat(text)).toBeNull();
      },
    );
  });

  describe("parseProcStatus", () => {
    const header = "Name:\tbash\nUmask:\t0022\nState:\tS (sleeping)\n";

    it("reads the real uid and converts VmRSS from kB to bytes", () => {
      const text = `${header}Uid:\t1000\t1001\t1002\t1003\nVmSize:\t  99999 kB\nVmRSS:\t   12345 kB\nThreads:\t1\n`;
      expect(parseProcStatus(text)).toEqual({ uid: 1000, residentBytes: 12_345 * 1024 });
    });

    it("has no resident size for a kernel thread", () => {
      expect(parseProcStatus(`${header}Uid:\t0\t0\t0\t0\n`)).toEqual({
        uid: 0,
        residentBytes: null,
      });
    });

    it("is null without a Uid line", () => {
      expect(parseProcStatus(`${header}VmRSS:\t 10 kB\n`)).toBeNull();
    });
  });

  describe("parseProcIoWriteBytes", () => {
    it("reads write_bytes, not cancelled_write_bytes", () => {
      const text =
        "rchar: 1\nwchar: 2\nsyscr: 3\nsyscw: 4\nread_bytes: 5\nwrite_bytes: 4096\ncancelled_write_bytes: 77\n";
      expect(parseProcIoWriteBytes(text)).toBe(4096);
      expect(parseProcIoWriteBytes("cancelled_write_bytes: 77\n")).toBeNull();
      expect(parseProcIoWriteBytes("")).toBeNull();
    });
  });

  describe("parseBootTimeMs", () => {
    it("converts btime seconds to milliseconds", () => {
      expect(parseBootTimeMs("cpu  1 2 3 4\nbtime 1700000000\nprocesses 5\n")).toBe(
        1_700_000_000_000,
      );
      expect(parseBootTimeMs("cpu  1 2 3 4\nprocesses 5\n")).toBeNull();
    });
  });

  describe("parsePasswd", () => {
    it("maps uid to name and skips junk lines", () => {
      const text = [
        "root:x:0:0:root:/root:/bin/bash",
        "# comment",
        "junk line",
        "acme:x:1000:1000::/home/acme:/bin/sh",
        "bad:x:notanumber:5::/:/bin/false",
        ":x:42:42::/:/bin/false",
        "",
      ].join("\n");
      expect([...parsePasswd(text)]).toEqual([
        [0, "root"],
        [1000, "acme"],
      ]);
    });
  });

  describe("parseCmdline", () => {
    it("splits on NUL and drops empty parts", () => {
      expect(
        parseCmdline(["node", "/srv/acme/server.js", "--port", "3000", ""].join("\0")),
      ).toEqual(["node", "/srv/acme/server.js", "--port", "3000"]);
      expect(parseCmdline(["a", "", "b"].join("\0"))).toEqual(["a", "b"]);
      expect(parseCmdline("")).toEqual([]);
    });
  });
});

describe("hoardingReasons", () => {
  const idle = {
    cpuPercent: 0,
    residentBytes: 0,
    ioWriteBytesPerSecond: null,
    runTimeMs: 0,
    hasOwner: false,
  };

  it("flags memory at 15% of RAM on a small host", () => {
    const total = 16 * GIB;
    expect(hoardingReasons({ ...idle, residentBytes: 2.5 * GIB }, total)).toEqual(["memory"]);
    expect(hoardingReasons({ ...idle, residentBytes: 2.3 * GIB }, total)).toEqual([]);
  });

  it("caps the memory limit at 8 GiB on a big host", () => {
    const total = 64 * GIB;
    expect(hoardingReasons({ ...idle, residentBytes: 8 * GIB }, total)).toEqual(["memory"]);
    expect(hoardingReasons({ ...idle, residentBytes: 8 * GIB - 1 }, total)).toEqual([]);
    expect(hoardingReasons({ ...idle, residentBytes: 2.5 * GIB }, total)).toEqual([]);
  });

  it("never flags memory when the host size is unknown", () => {
    expect(hoardingReasons({ ...idle, residentBytes: 100 * GIB }, 0)).toEqual([]);
  });

  it("flags cpu at 300%", () => {
    expect(hoardingReasons({ ...idle, cpuPercent: 300 }, 0)).toEqual(["cpu"]);
    expect(hoardingReasons({ ...idle, cpuPercent: 299.9 }, 0)).toEqual([]);
  });

  it("flags disk writes at 50 MiB/s and never when io is unreadable", () => {
    expect(hoardingReasons({ ...idle, ioWriteBytesPerSecond: 50 * MIB }, 0)).toEqual([
      "disk-write",
    ]);
    expect(hoardingReasons({ ...idle, ioWriteBytesPerSecond: 50 * MIB - 1 }, 0)).toEqual([]);
    expect(hoardingReasons({ ...idle, ioWriteBytesPerSecond: null }, 0)).toEqual([]);
  });

  describe("long-running", () => {
    const owned = { ...idle, hasOwner: true, runTimeMs: 24 * HOUR_MS };

    it.each([
      ["cpu at 50%", { cpuPercent: 50 }, ["long-running"]],
      ["rss at 2 GiB", { residentBytes: 2 * GIB }, ["long-running"]],
      [
        "cpu just under 50% and rss just under 2 GiB",
        { cpuPercent: 49, residentBytes: 2 * GIB - 1 },
        [],
      ],
      ["no owner", { cpuPercent: 80, hasOwner: false }, []],
      ["under 24 hours", { cpuPercent: 80, runTimeMs: 24 * HOUR_MS - 1 }, []],
    ] as const)("%s", (_label, overrides, expected) => {
      expect(hoardingReasons({ ...owned, ...overrides }, 64 * GIB)).toEqual(expected);
    });
  });

  it("lists every reason in a stable order", () => {
    expect(
      hoardingReasons(
        {
          cpuPercent: 400,
          residentBytes: 9 * GIB,
          ioWriteBytesPerSecond: 60 * MIB,
          runTimeMs: 48 * HOUR_MS,
          hasOwner: true,
        },
        64 * GIB,
      ),
    ).toEqual(["memory", "cpu", "disk-write", "long-running"]);
  });

  describe("mayBeLongRunning", () => {
    it("is true for an ownerless process that would qualify once owned", () => {
      expect(
        mayBeLongRunning({
          cpuPercent: 0,
          residentBytes: 3 * GIB,
          ioWriteBytesPerSecond: null,
          runTimeMs: 25 * HOUR_MS,
        }),
      ).toBe(true);
    });

    it("is false for a short-lived or light process", () => {
      const process = {
        cpuPercent: 0,
        residentBytes: 3 * GIB,
        ioWriteBytesPerSecond: null,
        runTimeMs: 25 * HOUR_MS,
      };
      expect(mayBeLongRunning({ ...process, runTimeMs: HOUR_MS })).toBe(false);
      expect(mayBeLongRunning({ ...process, residentBytes: GIB })).toBe(false);
    });
  });
});

describe("processMetrics", () => {
  const BOOT_MS = 1_700_000_000_000;
  const reading = (overrides: Partial<ProcessReading> = {}): ProcessReading => ({
    pid: 10,
    ppid: 1,
    name: "worker",
    uid: 1000,
    cpuTicks: 1000,
    startTicks: 500,
    residentBytes: 64 * MIB,
    ioWriteBytes: 10_000,
    ...overrides,
  });
  const sample = (at: number, ...readings: ProcessReading[]): ProcessSample => ({
    at,
    processes: new Map(readings.map((entry) => [entry.pid, entry])),
  });
  const only = (previous: ProcessSample, current: ProcessSample) => {
    const [metric] = processMetrics(previous, current, BOOT_MS);
    return metric!;
  };

  it("derives cpu percent from the tick delta over the elapsed time", () => {
    const fast = only(sample(10_000, reading()), sample(11_000, reading({ cpuTicks: 1150 })));
    expect(fast.cpuPercent).toBe(150);
    const slow = only(sample(10_000, reading()), sample(12_000, reading({ cpuTicks: 1100 })));
    expect(slow.cpuPercent).toBe(50);
  });

  it("derives the write rate from the byte delta over the elapsed time", () => {
    const metric = only(
      sample(10_000, reading()),
      sample(12_000, reading({ ioWriteBytes: 10_000 + 4 * MIB })),
    );
    expect(metric.ioWriteBytesPerSecond).toBe(2 * MIB);
  });

  it("treats a reused pid as a new process", () => {
    const metric = only(
      sample(10_000, reading({ startTicks: 500, cpuTicks: 100 })),
      sample(11_000, reading({ startTicks: 900, cpuTicks: 5000 })),
    );
    expect(metric.cpuPercent).toBe(0);
    expect(metric.ioWriteBytesPerSecond).toBeNull();
  });

  it("has no rates for a process missing from the previous sample or without elapsed time", () => {
    const fresh = only(sample(10_000), sample(11_000, reading({ cpuTicks: 9999 })));
    expect(fresh).toMatchObject({ cpuPercent: 0, ioWriteBytesPerSecond: null });
    const instant = only(sample(10_000, reading()), sample(10_000, reading({ cpuTicks: 2000 })));
    expect(instant).toMatchObject({ cpuPercent: 0, ioWriteBytesPerSecond: null });
  });

  it("has no write rate when either io reading is null", () => {
    expect(
      only(sample(10_000, reading({ ioWriteBytes: null })), sample(11_000, reading())),
    ).toMatchObject({ ioWriteBytesPerSecond: null });
    expect(
      only(sample(10_000, reading()), sample(11_000, reading({ ioWriteBytes: null }))),
    ).toMatchObject({ ioWriteBytesPerSecond: null });
  });

  it("clamps counters that went backwards to zero", () => {
    const metric = only(
      sample(10_000, reading({ cpuTicks: 2000, ioWriteBytes: 50_000 })),
      sample(11_000, reading({ cpuTicks: 1000, ioWriteBytes: 10_000 })),
    );
    expect(metric).toMatchObject({ cpuPercent: 0, ioWriteBytesPerSecond: 0 });
  });

  it("computes start time and run time from boot time and start ticks", () => {
    const startedAt = 1_700_000_123_450;
    const now = startedAt + 90_000;
    const metric = only(
      sample(now - 1000, reading({ startTicks: 12_345 })),
      sample(now, reading({ startTicks: 12_345 })),
    );
    expect(metric.startedAt).toBe(startedAt);
    expect(metric.runTimeMs).toBeCloseTo(90_000, 3);
    expect(metric).toMatchObject({ pid: 10, name: "worker", uid: 1000, residentBytes: 64 * MIB });
  });

  it("never reports a negative run time", () => {
    const metric = only(
      sample(BOOT_MS, reading({ startTicks: 12_345 })),
      sample(BOOT_MS + 1000, reading({ startTicks: 12_345 })),
    );
    expect(metric.runTimeMs).toBe(0);
  });
});

describe("processCandidates", () => {
  const TOTAL_MEMORY = 64 * GIB;
  const metric = (pid: number, overrides: Partial<ProcessMetrics> = {}): ProcessMetrics => ({
    pid,
    ppid: 1,
    name: `proc-${pid}`,
    uid: 1000,
    cpuTicks: 0,
    startTicks: 0,
    ioWriteBytes: null,
    cpuPercent: 0,
    residentBytes: MIB,
    ioWriteBytesPerSecond: null,
    startedAt: 0,
    runTimeMs: 1000,
    ...overrides,
  });
  // pids 1..30: cpu rises with pid, rss falls with pid.
  const idle = Array.from({ length: 30 }, (_, index) =>
    metric(index + 1, { cpuPercent: (index + 1) / 10, residentBytes: (30 - index) * MIB }),
  );
  const pids = (selected: ReadonlyArray<ProcessMetrics>) =>
    selected.map((entry) => entry.pid).toSorted((left, right) => left - right);
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, index) => from + index);
  const topCpu = range(23, 30);
  const topRss = range(1, 8);

  it("keeps the eight heaviest by cpu and by memory and drops the rest", () => {
    expect(pids(processCandidates(idle, TOTAL_MEMORY))).toEqual([...topRss, ...topCpu]);
  });

  it("keeps a process over a threshold even outside both top lists", () => {
    const writer = metric(900, {
      cpuPercent: 0,
      residentBytes: 0,
      ioWriteBytesPerSecond: 60 * MIB,
    });
    expect(pids(processCandidates([...idle, writer], TOTAL_MEMORY))).toEqual([
      ...topRss,
      ...topCpu,
      900,
    ]);
  });

  it("keeps a possible long-runner even outside both top lists", () => {
    const heavy = range(101, 108).map((pid) => metric(pid, { residentBytes: 4 * GIB }));
    const runner = metric(900, { residentBytes: 2.5 * GIB, runTimeMs: 25 * HOUR_MS });
    expect(pids(processCandidates([...idle, ...heavy, runner], TOTAL_MEMORY))).toEqual([
      ...topCpu,
      ...range(101, 108),
      900,
    ]);
  });
});

describe("redactCommandLine", () => {
  const REDACTED = "[redacted]";
  const SECRET = "hunter2-placeholder"; // gitleaks:allow placeholder fixture
  const redact = (...argv: string[]) => redactCommandLine(argv);
  // Assembled at runtime so the public-repo scan does not read the fixture as a credential URL.
  const userInfoUrl = (userInfo: string) => "https://" + userInfo + "@example.com/repo.git";

  const secretCases: ReadonlyArray<
    readonly [label: string, argv: ReadonlyArray<string>, secret: string]
  > = [
    [
      "MCP config JSON in argv",
      [
        "claude",
        "--mcp-config",
        '{"mcpServers":{"acme":{"headers":{"Authorization":"Bearer abc.def-ghi"}}}}',
      ],
      "abc.def-ghi",
    ],
    ["JSON apiKey", ['{"apiKey":"' + SECRET + '"}'], SECRET],
    ["JSON x-api-key", ['{"x-api-key": "' + SECRET + '"}'], SECRET],
    ["JSON access_token", ['{"access_token":"' + SECRET + '"}'], SECRET],
    ["JSON client_secret", ['{"client_secret":"' + SECRET + '"}'], SECRET],
    ["JSON value with escaped quote", ['{"password":"abc\\"' + SECRET + '"}'], SECRET],
    ["--api-key VALUE", ["tool", "--api-key", SECRET], SECRET],
    ["--api-key=VALUE", ["tool", `--api-key=${SECRET}`], SECRET],
    ["--token VALUE", ["tool", "--token", SECRET], SECRET],
    ["--github-token=VALUE", ["tool", `--github-token=${SECRET}`], SECRET],
    ["-token VALUE", ["tool", "-token", SECRET], SECRET],
    ["quoted flag value", ["sh", "-c", `tool --password "${SECRET} with space"`], "with space"],
    ["OPENAI_API_KEY=VALUE", ["env", `OPENAI_API_KEY=${SECRET}`, "tool"], SECRET],
    ["GH_TOKEN=VALUE", ["env", `GH_TOKEN=${SECRET}`, "tool"], SECRET],
    ["DB_PASSWORD=VALUE", ["env", `DB_PASSWORD=${SECRET}`, "tool"], SECRET],
    ["Authorization: Bearer", ["curl", "-H", `Authorization: Bearer ${SECRET}`], SECRET],
    ["Authorization: Basic", ["curl", "-H", `Authorization: Basic ${SECRET}`], SECRET],
    ["X-Api-Key header", ["curl", "-H", `X-Api-Key: ${SECRET}`], SECRET],
    ["Cookie header", ["curl", "-H", `Cookie: session=${SECRET}`], SECRET],
    ["--header=NAME: VALUE", ["claude", `--header=x-api-key:${SECRET}`], SECRET],
    [
      "secret flag in a JSON args array",
      ['{"mcpServers":{"acme":{"args":["-y","acme-mcp","--api-key", "' + SECRET + '"]}}}'],
      SECRET,
    ],
    ["URL credentials", ["git", "clone", userInfoUrl(`acme:${SECRET}`)], SECRET],
    ["query ?token=", ["curl", `https://example.com/api?token=${SECRET}&x=1`], SECRET],
    ["query &sig=", ["curl", `https://example.com/file?x=1&sig=${SECRET}`], SECRET],
    ["sk- key", ["tool", "sk-" + "x".repeat(24)], "x".repeat(24)],
    ["ghp_ token", ["tool", "ghp_" + "a".repeat(36)], "a".repeat(36)],
    ["github_pat_ token", ["tool", "github_pat_" + "a".repeat(30)], "a".repeat(30)],
    ["xoxb- token", ["tool", "xoxb-" + "1".repeat(12) + "-" + "a".repeat(12)], "1".repeat(12)],
    ["AKIA key id", ["tool", "AKIA" + "A".repeat(16)], "A".repeat(16)],
    ["AIza key", ["tool", "AIza" + "b".repeat(35)], "b".repeat(35)],
  ];

  it.each(secretCases)("redacts %s", (_label, argv, secret) => {
    const output = redactCommandLine(argv);
    expect(output).toContain(REDACTED);
    expect(output).not.toContain(secret);
  });

  it("keeps the surrounding structure when redacting", () => {
    expect(
      redact(
        "claude",
        "--mcp-config",
        '{"mcpServers":{"acme":{"headers":{"Authorization":"Bearer abc.def-ghi"}}}}',
      ),
    ).toBe(
      'claude --mcp-config {"mcpServers":{"acme":{"headers":{"Authorization":"[redacted]"}}}}',
    );
    expect(redact("tool", "--api-key", SECRET, "--verbose")).toBe(
      "tool --api-key [redacted] --verbose",
    );
    expect(redact("tool", `--api-key=${SECRET}`)).toBe("tool --api-key=[redacted]");
    expect(redact("tool", `--github-token=${SECRET}`)).toBe("tool --github-token=[redacted]");
    expect(redact("env", `OPENAI_API_KEY=${SECRET}`, `GH_TOKEN=${SECRET}`, "tool")).toBe(
      "env OPENAI_API_KEY=[redacted] GH_TOKEN=[redacted] tool",
    );
    expect(redact("curl", "-H", `Authorization: Bearer ${SECRET}`)).toBe(
      "curl -H Authorization: [redacted]",
    );
    expect(redact("curl", "-H", `X-Api-Key: ${SECRET}`, "https://example.com")).toBe(
      "curl -H X-Api-Key: [redacted] https://example.com",
    );
    expect(redact('{"args":["--api-key","' + SECRET + '","--verbose"]}')).toBe(
      '{"args":["--api-key","[redacted]","--verbose"]}',
    );
    expect(redact("git", "clone", userInfoUrl(`acme:${SECRET}`))).toBe(
      `git clone ${userInfoUrl("[redacted]")}`,
    );
    expect(redact(`https://example.com/api?token=${SECRET}&x=1`)).toBe(
      "https://example.com/api?token=[redacted]&x=1",
    );
    expect(redact(`https://example.com/file?x=1&sig=${SECRET}`)).toBe(
      "https://example.com/file?x=1&sig=[redacted]",
    );
    expect(redact("tool", "ghp_" + "a".repeat(36), "--verbose")).toBe("tool [redacted] --verbose");
  });

  it("does not let a secret flag swallow the next flag", () => {
    expect(redact("tool", "--token", "--verbose")).toBe("tool --token --verbose");
    expect(redact("tool", "--password", "--verbose", "-x")).toBe("tool --password --verbose -x");
    expect(redact("tool", "--token", SECRET, "--verbose")).toBe(
      "tool --token [redacted] --verbose",
    );
  });

  it.each([
    "node /srv/acme/server.js --port 3000",
    "cargo build --release",
    "git log --author=someone --max-count=5",
    "node --max-old-space-size=4096 dist/main.js",
    "",
  ])("passes %j through unchanged", (commandLine) => {
    expect(redactCommandLine(commandLine.split(" "))).toBe(commandLine);
  });

  describe("truncation", () => {
    it("leaves a command at the limit untouched", () => {
      const exact = "a".repeat(MAX_COMMAND_LENGTH);
      expect(redact(exact)).toBe(exact);
    });

    it("cuts longer commands to the limit with an ellipsis", () => {
      const output = redact("a".repeat(MAX_COMMAND_LENGTH * 2));
      expect(output).toHaveLength(MAX_COMMAND_LENGTH);
      expect(output.endsWith("…")).toBe(true);
    });

    it("redacts a secret that straddles the cut before truncating", () => {
      const prefix = "a".repeat(MAX_COMMAND_LENGTH - 20);
      const output = redact(prefix, "--token", SECRET, "b".repeat(100));
      expect(output).toHaveLength(MAX_COMMAND_LENGTH);
      expect(output.endsWith("…")).toBe(true);
      expect(output).toContain(REDACTED);
      expect(output).not.toContain("hunter2");
    });
  });
});

describe("ownerForPath", () => {
  const owner = (projectId: string, threadId: string | null): HostUsageOwner => ({
    projectId: ProjectId.make(projectId),
    projectTitle: `Project ${projectId}`,
    threadId: threadId === null ? null : ThreadId.make(threadId),
    threadTitle: threadId === null ? null : `Thread ${threadId}`,
  });
  const project = owner("acme", null);
  const thread = owner("acme", "thread-1");
  const owned = [
    { path: "/srv/acme", owner: project },
    { path: "/srv/acme/.worktrees/thread-1", owner: thread },
  ];

  it("prefers the thread worktree over its project root, in either order", () => {
    expect(ownerForPath(owned, "/srv/acme/.worktrees/thread-1/src/index.ts")).toBe(thread);
    expect(ownerForPath(owned.toReversed(), "/srv/acme/.worktrees/thread-1")).toBe(thread);
    expect(ownerForPath(owned, "/srv/acme/src")).toBe(project);
  });

  it("returns null outside every owned path, including prefix-only matches", () => {
    expect(ownerForPath(owned, "/srv/elsewhere")).toBeNull();
    expect(ownerForPath(owned, "/srv/acme-2")).toBeNull();
    expect(ownerForPath(owned, "/srv/acme-2/src")).toBeNull();
    expect(ownerForPath([], "/srv/acme")).toBeNull();
  });
});

describe("du parsing", () => {
  describe("parseDuOutput", () => {
    it("converts tab-separated KiB to bytes and strips trailing slashes", () => {
      const text = ["4096\t/data/a/", "12\t/data/b", "1000\t/", "0\t/data/empty", ""].join("\n");
      expect([...parseDuOutput(text)]).toEqual([
        ["/data/a", 4096 * 1024],
        ["/data/b", 12 * 1024],
        ["/", 1000 * 1024],
        ["/data/empty", 0],
      ]);
    });

    it("skips malformed lines", () => {
      const text = [
        "not a du line",
        "\t/no/size",
        "abc\t/nan",
        "-5\t/negative",
        "7\t",
        "9\t/ok",
      ].join("\n");
      expect([...parseDuOutput(text)]).toEqual([["/ok", 9 * 1024]]);
    });
  });

  describe("duConsumers", () => {
    const kib = (value: number) => value * 1024;

    it("groups depth-2 output into direct children with their own children, largest first", () => {
      const sizes = parseDuOutput(
        [
          "50\t/data/c",
          "300\t/data/b",
          "250\t/data/b/z",
          "600\t/data/a",
          "100\t/data/a/x",
          "400\t/data/a/y",
          "10\t/data/a/y/deep",
          "5\t/database",
          "99\t/other/q",
          "1000\t/data",
        ].join("\n"),
      );
      expect(duConsumers("/data", sizes)).toEqual({
        rootBytes: kib(1000),
        consumers: [
          {
            path: "/data/a",
            bytes: kib(600),
            children: [
              { name: "y", bytes: kib(400) },
              { name: "x", bytes: kib(100) },
            ],
          },
          { path: "/data/b", bytes: kib(300), children: [{ name: "z", bytes: kib(250) }] },
          { path: "/data/c", bytes: kib(50), children: [] },
        ],
      });
    });

    it("has no root size when the root line is absent", () => {
      expect(duConsumers("/data", parseDuOutput("10\t/data/a"))).toEqual({
        rootBytes: null,
        consumers: [{ path: "/data/a", bytes: kib(10), children: [] }],
      });
    });

    it("works for the filesystem root", () => {
      const sizes = parseDuOutput(
        [
          "200\t/var",
          "120\t/var/log",
          "1000\t/",
          "700\t/usr",
          "150\t/usr/bin",
          "500\t/usr/lib",
        ].join("\n"),
      );
      expect(duConsumers("/", sizes)).toEqual({
        rootBytes: kib(1000),
        consumers: [
          {
            path: "/usr",
            bytes: kib(700),
            children: [
              { name: "lib", bytes: kib(500) },
              { name: "bin", bytes: kib(150) },
            ],
          },
          { path: "/var", bytes: kib(200), children: [{ name: "log", bytes: kib(120) }] },
        ],
      });
    });
  });
});

describe("parseGitDirPointer", () => {
  it("reads the path of a linked worktree .git file", () => {
    expect(parseGitDirPointer("gitdir: /x/.git/worktrees/y\n")).toBe("/x/.git/worktrees/y");
  });

  it.each(["", "garbage", "gitdir: \n", "ref: refs/heads/main\n"])(
    "returns null for %j",
    (text) => {
      expect(parseGitDirPointer(text)).toBeNull();
    },
  );
});
