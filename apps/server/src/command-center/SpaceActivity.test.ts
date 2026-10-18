import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProjectId as CoreProjectId, RepositoryId } from "@command-center/core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import {
  findPullRequestUrl,
  layer as spaceActivityLayer,
  resolveSpaceIdsForProject,
  SPACE_ACTIVITY_EXTERNAL_EVENT_SEQUENCE,
  SPACE_ACTIVITY_RETENTION,
  SpaceActivity,
} from "./SpaceActivity.ts";
import { isSpaceAgentThreadId } from "./SpaceAgentIds.ts";

const NOW = "2026-10-09T12:00:00.000Z";
const secondsAfterNow = (seconds: number) =>
  DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(NOW), { seconds }));

const project = (id: string, remoteKeys: ReadonlyArray<string> = []) => ({ id, remoteKeys });

const binding = (input: { readonly remoteRef?: string; readonly projectId?: string }) => ({
  id: RepositoryId.make("repo"),
  displayName: "Repo",
  aliases: [],
  ...(input.remoteRef === undefined ? {} : { remoteRef: input.remoteRef }),
  ...(input.projectId === undefined ? {} : { projectId: CoreProjectId.make(input.projectId) }),
});

const space = (
  id: string,
  repositories: ReadonlyArray<ReturnType<typeof binding>>,
  lifecycle = "active",
) => ({ id, lifecycle, repositories });

describe("resolveSpaceIdsForProject", () => {
  const t3 = project("p-t3", ["github.com/awtprod/t3-code"]);
  const t3Binding = binding({ remoteRef: "https://github.com/awtprod/t3-code.git" });

  it("matches a binding by configured project id", () => {
    expect(
      resolveSpaceIdsForProject(project("p-config"), [
        space("command-center", [binding({ projectId: "p-config" })]),
      ]),
    ).toEqual(["command-center"]);
  });

  it("matches a binding by canonical git remote", () => {
    expect(
      resolveSpaceIdsForProject(t3, [
        space("command-center", [t3Binding]),
        space("acme", [binding({ remoteRef: "https://github.com/Acme/other" })]),
      ]),
    ).toEqual(["command-center"]);
  });

  it("matches a fork's origin binding even though upstream is its primary remote", () => {
    const fork = project("p-fork", ["github.com/pingdotgg/t3code", "github.com/awtprod/t3-code"]);
    expect(resolveSpaceIdsForProject(fork, [space("command-center", [t3Binding])])).toEqual([
      "command-center",
    ]);
  });

  it("maps a project without remotes, an archived Space, or a conflicting binding to nothing", () => {
    expect(
      resolveSpaceIdsForProject(project("p-home"), [
        space("command-center", [t3Binding]),
        space("personal", []),
      ]),
    ).toEqual([]);
    expect(resolveSpaceIdsForProject(t3, [space("archived", [t3Binding], "archived")])).toEqual([]);
    // A configured project id whose remotes disagree with the binding does not match.
    expect(
      resolveSpaceIdsForProject(t3, [
        space("conflict", [
          binding({ projectId: "p-t3", remoteRef: "https://github.com/awtprod/elsewhere" }),
        ]),
      ]),
    ).toEqual([]);
  });

  it("returns every Space that binds the same repository", () => {
    expect(
      resolveSpaceIdsForProject(t3, [
        space("command-center", [binding({ remoteRef: "git@github.com:awtprod/t3-code.git" })]),
        space("personal", [binding({ projectId: "p-t3" })]),
        space("unbound", []),
      ]),
    ).toEqual(["command-center", "personal"]);
  });

  it("maps every project that shares a bound repository", () => {
    const spaces = [space("acme", [binding({ remoteRef: "https://github.com/Acme/p" })])];
    expect(resolveSpaceIdsForProject(project("a", ["github.com/acme/p"]), spaces)).toEqual([
      "acme",
    ]);
    expect(resolveSpaceIdsForProject(project("b", ["github.com/acme/p"]), spaces)).toEqual([
      "acme",
    ]);
  });
});

describe("helpers", () => {
  it("recognizes Space agent threads by prefix", () => {
    expect(isSpaceAgentThreadId("cc-space-agent-command-center")).toBe(true);
    expect(isSpaceAgentThreadId("thread-cc-space-agent-")).toBe(false);
  });

  it("finds the newest GitHub pull request URL", () => {
    expect(
      findPullRequestUrl(
        "Opened https://github.com/awtprod/t3-code/pull/12 then https://github.com/awtprod/t3-code/pull/140.",
      ),
    ).toBe("https://github.com/awtprod/t3-code/pull/140");
    expect(findPullRequestUrl("see https://github.com/awtprod/t3-code/issues/3")).toBeUndefined();
  });
});

const testLayer = spaceActivityLayer.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const insertSpace = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO command_center_spaces (id, slug, name, kind, created_at, updated_at)
      VALUES (${id}, ${id}, ${id}, 'business', ${NOW}, ${NOW})
    `;
  });

const row = (input: { readonly sequence: number; readonly occurredAt?: string }) => ({
  spaceId: "command-center",
  occurredAt: input.occurredAt ?? NOW,
  sourceKind: "thread" as const,
  sourceId: "thread-1",
  projectId: "p-t3",
  title: "Fix the feed",
  status: "completed",
  text: `${"x".repeat(5_000)} https://github.com/awtprod/t3-code/pull/7`,
  eventSequence: input.sequence,
});

it.layer(testLayer)("SpaceActivity service", (it) => {
  it.effect("records once per event, clips the summary, and keeps the PR URL", () =>
    Effect.gen(function* () {
      yield* insertSpace("command-center");
      const activity = yield* SpaceActivity;
      expect(yield* activity.record(row({ sequence: 1 }))).toBe(true);
      expect(yield* activity.record(row({ sequence: 1 }))).toBe(false);
      const [entry, ...rest] = yield* activity.recent({ spaceId: "command-center" });
      expect(rest).toEqual([]);
      expect(entry?.summary.length).toBeLessThanOrEqual(1_000);
      expect(entry).toMatchObject({
        title: "Fix the feed",
        status: "completed",
        url: "https://github.com/awtprod/t3-code/pull/7",
        sourceKind: "thread",
        sourceId: "thread-1",
      });
      expect(yield* activity.latestEventSequence("thread")).toBe(1);
      expect(yield* activity.latestEventSequence("run")).toBeUndefined();
    }),
  );

  it.effect("shows phone rows in recent, unlike mail rows, and keeps them out of the cursor", () =>
    Effect.gen(function* () {
      yield* insertSpace("phones");
      const activity = yield* SpaceActivity;
      expect(
        yield* activity.record({
          ...row({ sequence: SPACE_ACTIVITY_EXTERNAL_EVENT_SEQUENCE }),
          spaceId: "phones",
          sourceKind: "run",
          sourceId: "phone-start:conv_1",
          url: "https://api.elevenlabs.io/v1/convai/conversations/conv_1",
        }),
      ).toBe(true);
      // A newer mail row with the same sequence 0: hidden unless asked for.
      expect(
        yield* activity.record({
          ...row({
            sequence: SPACE_ACTIVITY_EXTERNAL_EVENT_SEQUENCE,
            occurredAt: secondsAfterNow(1),
          }),
          spaceId: "phones",
          sourceKind: "run",
          sourceId: "gmail:thread-9:1",
        }),
      ).toBe(true);
      // The layer's database is shared and the next test asserts no Run cursor
      // yet, so no run row with a real sequence is written here.
      expect(yield* activity.latestEventSequence("run")).toBeUndefined();
      const visible = yield* activity.recent({ spaceId: "phones" });
      expect(visible.map((entry) => [entry.sourceId, entry.url])).toEqual([
        ["phone-start:conv_1", "https://api.elevenlabs.io/v1/convai/conversations/conv_1"],
      ]);
      const all = yield* activity.recent({ spaceId: "phones", includeExternal: true });
      expect(all.map((entry) => entry.sourceId)).toEqual([
        "gmail:thread-9:1",
        "phone-start:conv_1",
      ]);
    }),
  );

  it.effect("keeps a source-supplied link and leaves external rows out of the cursors", () =>
    Effect.gen(function* () {
      yield* insertSpace("personal");
      const activity = yield* SpaceActivity;
      const external = {
        spaceId: "personal",
        occurredAt: NOW,
        sourceKind: "run" as const,
        sourceId: "gmail:thread-1:1",
        projectId: null,
        title: "Mail: Contract draft",
        status: "new",
        text: "from Pat Example <pat@example.com> https://github.com/acme/app/pull/9",
        eventSequence: SPACE_ACTIVITY_EXTERNAL_EVENT_SEQUENCE,
        url: "https://mail.google.com/mail/#all/thread-1",
      };
      expect(yield* activity.record(external)).toBe(true);
      expect(yield* activity.record(external)).toBe(false);
      expect(
        yield* activity.record({
          ...external,
          sourceId: "gmail:thread-2:1",
          url: `https://mail.google.com/${"x".repeat(600)}`,
        }),
      ).toBe(true);
      const entries = yield* activity.recent({ spaceId: "personal", includeExternal: true });
      expect(entries.map((entry) => [entry.sourceId, entry.url])).toEqual([
        ["gmail:thread-2:1", undefined],
        ["gmail:thread-1:1", "https://mail.google.com/mail/#all/thread-1"],
      ]);
      // Sequence-0 rows never become a resume cursor for the Run or thread streams.
      expect(yield* activity.latestEventSequence("run")).toBeUndefined();
      expect(
        yield* activity.record({
          ...row({ sequence: 42 }),
          spaceId: "personal",
          sourceKind: "run",
        }),
      ).toBe(true);
      expect(yield* activity.latestEventSequence("run")).toBe(42);
    }),
  );

  it.effect("leaves mail and calendar rows out of recent unless asked, before the limit", () =>
    Effect.gen(function* () {
      yield* insertSpace("household");
      const activity = yield* SpaceActivity;
      for (const [index, sourceId] of ["thread-a", "thread-b"].entries()) {
        yield* activity.record({
          ...row({ sequence: 100 + index, occurredAt: secondsAfterNow(-60 + index) }),
          spaceId: "household",
          sourceId,
        });
      }
      // A newer poll's worth of external rows (more than the limit) on top.
      const external = ["gmail:t-1:1", "gmail:t-2:1", "gmail:t-3:2", "calendar:standup:x"];
      for (const [index, sourceId] of external.entries()) {
        yield* activity.record({
          spaceId: "household",
          occurredAt: secondsAfterNow(index + 1),
          sourceKind: "run",
          sourceId,
          projectId: null,
          title: `External ${sourceId}`,
          status: "new",
          text: "from Pat Example <pat@example.com>",
          eventSequence: SPACE_ACTIVITY_EXTERNAL_EVENT_SEQUENCE,
        });
      }
      const ids = (entries: ReadonlyArray<{ readonly sourceId: string }>) =>
        entries.map((entry) => entry.sourceId);

      expect(ids(yield* activity.recent({ spaceId: "household", limit: 2 }))).toEqual([
        "thread-b",
        "thread-a",
      ]);
      expect(
        ids(
          yield* activity.recent({ spaceId: "household", since: secondsAfterNow(-120), limit: 50 }),
        ),
      ).toEqual(["thread-b", "thread-a"]);
      expect(
        ids(yield* activity.recent({ spaceId: "household", limit: 2, includeExternal: true })),
      ).toEqual(["calendar:standup:x", "gmail:t-3:2"]);
    }),
  );

  it.effect("prunes each Space to its newest rows and honors since/limit", () =>
    Effect.gen(function* () {
      yield* insertSpace("acme");
      const activity = yield* SpaceActivity;
      for (let index = 0; index < SPACE_ACTIVITY_RETENTION + 5; index += 1) {
        yield* activity.record({
          ...row({ sequence: 100 + index }),
          spaceId: "acme",
          occurredAt: secondsAfterNow(index),
        });
      }
      const sql = yield* SqlClient.SqlClient;
      const [count] = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM command_center_space_activity WHERE space_id = 'acme'
      `;
      expect(count?.n).toBe(SPACE_ACTIVITY_RETENTION);
      const newest = yield* activity.recent({ spaceId: "acme", limit: 500 });
      expect(newest).toHaveLength(50);
      // A caller-supplied ceiling (the `cc.spaceAgent.activity` RPC uses 100).
      expect(yield* activity.recent({ spaceId: "acme", limit: 500, maxLimit: 100 })).toHaveLength(
        100,
      );
      expect(yield* activity.recent({ spaceId: "acme", maxLimit: 100 })).toHaveLength(20);
      expect(newest[0]?.occurredAt).toBe(secondsAfterNow(SPACE_ACTIVITY_RETENTION + 4));
      const since = yield* activity.recent({
        spaceId: "acme",
        since: secondsAfterNow(SPACE_ACTIVITY_RETENTION + 2),
      });
      expect(since).toHaveLength(2);
      // Another Space's rows are untouched by the prune.
      expect(yield* activity.recent({ spaceId: "command-center" })).toHaveLength(1);
      const invalid = yield* Effect.flip(activity.recent({ spaceId: "acme", since: "soon" }));
      expect(invalid.reason).toBe("validation");
    }),
  );

  it.effect("never prunes phone rows, which daily call caps and the webhook read", () =>
    Effect.gen(function* () {
      yield* insertSpace("dialer");
      const activity = yield* SpaceActivity;
      const oldest = {
        ...row({ sequence: SPACE_ACTIVITY_EXTERNAL_EVENT_SEQUENCE }),
        spaceId: "dialer",
        sourceKind: "run" as const,
      };
      yield* activity.record({ ...oldest, sourceId: "phone-start:conv_old" });
      yield* activity.record({ ...oldest, sourceId: "phone-uncertain:owner:dialer:a1" });
      // Only run rows are phone rows; a thread whose id looks similar is pruned as usual.
      yield* activity.record({ ...oldest, sourceKind: "thread", sourceId: "phone-lookalike" });
      for (let index = 0; index < SPACE_ACTIVITY_RETENTION + 5; index += 1) {
        yield* activity.record({
          ...row({ sequence: 100 + index }),
          spaceId: "dialer",
          occurredAt: secondsAfterNow(index + 1),
        });
      }
      const sql = yield* SqlClient.SqlClient;
      const kept = yield* sql<{ readonly sourceId: string; readonly n: number }>`
        SELECT source_id AS "sourceId", COUNT(*) AS n FROM command_center_space_activity
        WHERE space_id = 'dialer' GROUP BY source_id ORDER BY source_id
      `;
      expect(kept).toEqual([
        { sourceId: "phone-start:conv_old", n: 1 },
        { sourceId: "phone-uncertain:owner:dialer:a1", n: 1 },
        { sourceId: "thread-1", n: SPACE_ACTIVITY_RETENTION },
      ]);
    }),
  );
});
