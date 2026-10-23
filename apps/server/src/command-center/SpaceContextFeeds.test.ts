import * as NodeServices from "@effect/platform-node/NodeServices";
import { Space } from "@command-center/core";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import {
  ProcessRunner,
  ProcessSpawnError,
  type ProcessRunError,
  type ProcessRunInput,
  type ProcessRunOutput,
} from "../processRunner.ts";
import { CommandCenterConfig } from "./Config.ts";
import { layer as spaceContextFeedsLayer, SpaceContextFeeds } from "./SpaceContextFeeds.ts";

const decodeSpace = Schema.decodeUnknownSync(Space);
const CONFIG_DIRECTORY = "config-example";
const NOW_MS = Date.parse("2026-10-23T11:30:00.000Z");

const commandFeed = (overrides: Record<string, unknown> = {}) => ({
  id: "outreach",
  title: "Outreach pipeline",
  argv: ["python3", "feeds/example.py", "--summary"],
  maxChars: 1_200,
  refreshMinutes: 30,
  timeoutSeconds: 20,
  ...overrides,
});

const spaceWith = (contextFeeds?: ReadonlyArray<unknown>) =>
  decodeSpace({
    id: "space-a",
    slug: "space-a",
    displayName: "Space A",
    kind: "business",
    instructions: "",
    policy: { allowedCapabilities: [], autoRunRiskLevels: [] },
    ...(contextFeeds === undefined ? {} : { contextFeeds }),
    connectionIds: [],
    repositories: [],
    aliases: [],
    lifecycle: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

const output = (overrides: Partial<ProcessRunOutput> = {}): ProcessRunOutput => ({
  stdout: "",
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
  ...overrides,
});

const harness = (
  run: (input: ProcessRunInput) => Effect.Effect<ProcessRunOutput, ProcessRunError>,
) => {
  const runs: Array<ProcessRunInput> = [];
  const layer = spaceContextFeedsLayer.pipe(
    Layer.provide(
      Layer.succeed(
        ProcessRunner,
        ProcessRunner.of({
          run: (input) =>
            Effect.suspend(() => {
              runs.push(input);
              return run(input);
            }),
        }),
      ),
    ),
    Layer.provide(
      Layer.succeed(
        CommandCenterConfig,
        CommandCenterConfig.of({
          configDirectory: CONFIG_DIRECTORY,
          load: Effect.die("unused"),
          resolveGoogleAccount: () => Effect.die("unused"),
        }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return { layer, runs };
};

describe("Space context feeds", () => {
  it.effect("returns nothing for a Space without feeds", () => {
    const test = harness(() => Effect.die("must not run"));
    return Effect.gen(function* () {
      const feeds = yield* SpaceContextFeeds;
      expect(yield* feeds.section(spaceWith())).toBeUndefined();
      expect(test.runs).toEqual([]);
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("runs a command without a shell, in the config directory, with four env vars", () => {
    const test = harness(() =>
      Effect.succeed(output({ stdout: "Drafts: 4\nSent: 12\n", stderr: "warming up" })),
    );
    const planted = "CC_CONTEXT_FEED_TEST_SECRET";
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      process.env[planted] = "must-not-leak";
      yield* Effect.addFinalizer(() => Effect.sync(() => delete process.env[planted]));
      const feeds = yield* SpaceContextFeeds;
      const section = yield* feeds.section(spaceWith([commandFeed()]));

      expect(section).toEqual([
        {
          title: "Outreach pipeline",
          status: "ok",
          text: "Drafts: 4\nSent: 12",
          refreshedAtMs: NOW_MS,
        },
      ]);
      const [input] = test.runs;
      expect(input).toMatchObject({
        command: "python3",
        args: ["feeds/example.py", "--summary"],
        cwd: CONFIG_DIRECTORY,
        extendEnv: false,
        timeoutBehavior: "timedOutResult",
        outputMode: "truncate",
      });
      const env = input?.env ?? {};
      expect(Object.keys(env).every((key) => ["PATH", "HOME", "LANG", "TZ"].includes(key))).toBe(
        true,
      );
      expect(env[planted]).toBeUndefined();
      expect(env.PATH).toBe(process.env.PATH);
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("cuts long output on a line boundary and marks it truncated", () => {
    const lines = Array.from(
      { length: 40 },
      (_, index) => `row ${String(index).padStart(2, "0")} ok`,
    );
    const test = harness(() => Effect.succeed(output({ stdout: lines.join("\n") })));
    return Effect.gen(function* () {
      const feeds = yield* SpaceContextFeeds;
      const [feed] = (yield* feeds.section(spaceWith([commandFeed({ maxChars: 200 })]))) ?? [];
      if (feed?.status !== "ok") throw new Error("Expected an ok feed.");

      expect(feed.text.length).toBeLessThanOrEqual(200);
      const shown = feed.text.split("\n");
      expect(shown.at(-1)).toBe("[truncated]");
      expect(shown.slice(0, -1)).toEqual(lines.slice(0, shown.length - 1));
      // The runner reads only a bounded prefix of stdout.
      expect(test.runs[0]?.maxOutputBytes).toBe(603);
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("reports a command that times out or exits non-zero, never its stderr", () => {
    const test = harness((input) =>
      input.args[0] === "slow.py"
        ? Effect.never
        : input.args[0] === "killed.py"
          ? Effect.succeed(output({ code: null, timedOut: true }))
          : input.args[0] === "missing.py"
            ? Effect.fail(
                new ProcessSpawnError({ command: "missing", argumentCount: 0, cause: "ENOENT" }),
              )
            : Effect.succeed(
                output({
                  code: ChildProcessSpawner.ExitCode(2),
                  stderr: "token for owner@example.com expired",
                }),
              ),
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const feeds = yield* SpaceContextFeeds;
      const fiber = yield* Effect.forkChild(
        feeds.section(
          spaceWith([
            commandFeed({ id: "slow", title: "Slow", argv: ["python3", "slow.py"] }),
            commandFeed({ id: "failing", title: "Failing", argv: ["python3", "failing.py"] }),
            commandFeed({
              id: "killed",
              title: "Killed",
              argv: ["python3", "killed.py"],
              timeoutSeconds: 5,
            }),
            commandFeed({ id: "missing", title: "Missing", argv: ["python3", "missing.py"] }),
          ]),
        ),
      );
      yield* TestClock.adjust("20 seconds");
      expect(yield* Fiber.join(fiber)).toEqual([
        { title: "Slow", status: "unavailable", reason: "timed out after 20 s" },
        { title: "Failing", status: "unavailable", reason: "exit 2" },
        { title: "Killed", status: "unavailable", reason: "timed out after 5 s" },
        { title: "Missing", status: "unavailable", reason: "the command could not be started" },
      ]);
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("reads a file feed up to its cap, and says when the file is missing", () => {
    const test = harness(() => Effect.die("must not run"));
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "space-context-feeds-" });
      const summary = path.join(directory, "summary.txt");
      yield* fs.writeFileString(summary, "Due this week: 3 invoices\nOverdue: none\n");
      const long = path.join(directory, "long.txt");
      yield* fs.writeFileString(
        long,
        `${"a".repeat(150)}\n${"b".repeat(150)}\n${"c".repeat(5_000)}`,
      );
      const fileFeed = (id: string, filePath: string, maxChars = 1_200) => {
        const { argv: _argv, ...rest } = commandFeed({ id, title: id, maxChars });
        return { ...rest, path: filePath };
      };
      const feeds = yield* SpaceContextFeeds;
      const section = yield* feeds.section(
        spaceWith([
          fileFeed("summary", summary),
          fileFeed("long", long, 200),
          fileFeed("later", path.join(directory, "later.txt")),
        ]),
      );

      expect(section).toEqual([
        {
          title: "summary",
          status: "ok",
          text: "Due this week: 3 invoices\nOverdue: none",
          refreshedAtMs: NOW_MS,
        },
        {
          title: "long",
          status: "ok",
          text: `${"a".repeat(150)}\n[truncated]`,
          refreshedAtMs: NOW_MS,
        },
        { title: "later", status: "unavailable", reason: "file not found" },
      ]);
      expect(test.runs).toEqual([]);
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("serves a good feed for refreshMinutes and retries a failed one after a minute", () => {
    let failing = true;
    const test = harness((input) =>
      Effect.succeed(
        input.args[0] === "flaky.py" && failing
          ? output({ code: ChildProcessSpawner.ExitCode(1) })
          : output({ stdout: `run at ${input.args[0]}` }),
      ),
    );
    const space = spaceWith([
      commandFeed({ id: "steady", argv: ["python3", "steady.py"], refreshMinutes: 30 }),
      commandFeed({ id: "flaky", argv: ["python3", "flaky.py"], refreshMinutes: 30 }),
    ]);
    const runsOf = (script: string) => test.runs.filter((run) => run.args[0] === script).length;
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const feeds = yield* SpaceContextFeeds;
      const first = yield* feeds.section(space);
      expect(first?.map((feed) => feed.status)).toEqual(["ok", "unavailable"]);

      yield* TestClock.adjust("59 seconds");
      yield* feeds.section(space);
      expect([runsOf("steady.py"), runsOf("flaky.py")]).toEqual([1, 1]);

      failing = false;
      yield* TestClock.adjust("2 seconds");
      const retried = yield* feeds.section(space);
      expect([runsOf("steady.py"), runsOf("flaky.py")]).toEqual([1, 2]);
      expect(retried?.[0]).toMatchObject({ status: "ok", refreshedAtMs: NOW_MS });
      expect(retried?.[1]).toMatchObject({ status: "ok", refreshedAtMs: NOW_MS + 61_000 });

      yield* TestClock.adjust("28 minutes");
      yield* feeds.section(space);
      expect([runsOf("steady.py"), runsOf("flaky.py")]).toEqual([1, 2]);
      yield* TestClock.adjust("1 minute");
      const refreshed = yield* feeds.section(space);
      expect([runsOf("steady.py"), runsOf("flaky.py")]).toEqual([2, 2]);
      expect(refreshed?.[0]).toMatchObject({ refreshedAtMs: NOW_MS + 30 * 60_000 + 1_000 });

      // A changed definition is a different feed, not a cache hit.
      yield* feeds.section(
        spaceWith([commandFeed({ id: "steady", argv: ["python3", "steady.py", "--week"] })]),
      );
      expect(runsOf("steady.py")).toBe(3);
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("runs at most three feeds of a Space at once", () => {
    const state = { active: 0, peak: 0 };
    const gate: { started?: Deferred.Deferred<void>; release?: Deferred.Deferred<void> } = {};
    const test = harness(() =>
      Effect.gen(function* () {
        state.active += 1;
        state.peak = Math.max(state.peak, state.active);
        if (state.active === 3 && gate.started !== undefined) {
          yield* Deferred.succeed(gate.started, undefined);
        }
        if (gate.release !== undefined) yield* Deferred.await(gate.release);
        state.active -= 1;
        return output({ stdout: "ok" });
      }),
    );
    return Effect.gen(function* () {
      gate.started = yield* Deferred.make<void>();
      gate.release = yield* Deferred.make<void>();
      const feeds = yield* SpaceContextFeeds;
      const space = spaceWith(
        Array.from({ length: 6 }, (_, index) =>
          commandFeed({ id: `feed-${index}`, argv: ["python3", `feed-${index}.py`] }),
        ),
      );
      const fiber = yield* Effect.forkChild(feeds.section(space));
      yield* Deferred.await(gate.started);
      expect(test.runs).toHaveLength(3);
      yield* Deferred.succeed(gate.release, undefined);
      expect(yield* Fiber.join(fiber)).toHaveLength(6);
      expect(state.peak).toBe(3);
      expect(test.runs).toHaveLength(6);
    }).pipe(Effect.provide(test.layer));
  });
});
