import * as NodeServices from "@effect/platform-node/NodeServices";
import { Connection, Space, type Space as SpaceType } from "@command-center/core";
import { describe, expect, it } from "@effect/vitest";
import { CommandCenterError, type GoogleReadRequest } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import { CommandCenterConfig } from "./Config.ts";
import {
  GOOGLE_ACTIVITY_MAX_ROWS_PER_POLL,
  GoogleActivityPoller,
  layer as googleActivityPollerLayer,
  POLL_MAIL_QUERY,
} from "./GoogleActivityPoller.ts";
import { GoogleReadConnector, GoogleReadConnectorError } from "./GoogleReadConnector.ts";
import * as CommandCenterService from "./Service.ts";
import { layer as spaceActivityLayer, SpaceActivity } from "./SpaceActivity.ts";

const decodeSpace = Schema.decodeUnknownSync(Space);
const decodeConnection = Schema.decodeUnknownSync(Connection);

const GMAIL = "cc.connections.google.gmail.read";
const CALENDAR = "cc.connections.google.calendar.read";
const NOW_MS = Date.parse("2026-10-17T12:00:00.000Z");
const at = (minutes: number) => DateTime.formatIso(DateTime.makeUnsafe(NOW_MS + minutes * 60_000));

const makeSpace = (
  id: string,
  options: { readonly agent?: boolean; readonly capabilities?: ReadonlyArray<string> } = {},
): SpaceType =>
  decodeSpace({
    id,
    slug: id,
    displayName: id,
    kind: "personal",
    instructions: "",
    policy: {
      allowedCapabilities: options.capabilities ?? [GMAIL, CALENDAR],
      autoRunRiskLevels: [],
    },
    agent: {
      enabled: options.agent ?? true,
      quietHours: { start: "22:00", end: "07:00", timezone: "America/New_York" },
      dailyWakeLimit: 12,
      debounceMinutes: 10,
    },
    connectionIds: [],
    repositories: [],
    aliases: [],
    lifecycle: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

const googleConnection = (spaceId: string) =>
  decodeConnection({
    id: `google-${spaceId}`,
    spaceId,
    kind: "google",
    label: "Acme mailbox",
    capabilities: [GMAIL, CALENDAR],
    health: "connected",
  });

const thread = (id: string, messageCount = 1) => ({
  id,
  date: "2026-10-17 07:45",
  from: "Pat Example <pat@example.com>",
  subject: `Subject ${id}`,
  labels: ["INBOX", "UNREAD", "IMPORTANT"],
  messageCount,
});

const calendarEvent = (
  id: string,
  startMinutes: number,
  overrides: Record<string, unknown> = {},
) => ({
  id,
  status: "confirmed",
  summary: `Event ${id}`,
  htmlLink: `https://www.google.com/calendar/event?eid=${id}`,
  start: { dateTime: at(startMinutes) },
  end: { dateTime: at(startMinutes + 30) },
  attendees: [{ email: "pat@example.com" }, { email: "me@example.com", self: true }],
  ...overrides,
});

type Feeds = Record<string, { mail?: unknown; calendar?: unknown }>;

const makeHarness = (spaces: ReadonlyArray<SpaceType>) => {
  const feeds: Feeds = {};
  const failures = new Map<string, "fail" | "hang">();
  const requests: Array<GoogleReadRequest> = [];
  const logs: Array<string> = [];
  /** Set `fail` to make the mailbox lookup fail as config storage would. */
  const account = { fail: false };
  const connector = GoogleReadConnector.of({
    verify: () => Effect.void,
    read: (request) =>
      Effect.suspend(() => {
        requests.push(request);
        const feed = request.operation === "gmail.search" ? "mail" : "calendar";
        const failure = failures.get(`${request.spaceId}:${feed}`);
        if (failure === "hang") return Effect.never;
        if (failure === "fail") {
          return Effect.fail(
            new GoogleReadConnectorError({
              reason: "version",
              message: "Command Center requires gog 0.15.0.",
            }),
          );
        }
        return Effect.succeed({
          operation: request.operation as "gmail.search",
          contentTrust: "untrusted-external" as const,
          data:
            feeds[request.spaceId]?.[feed] ?? (feed === "mail" ? { threads: [] } : { events: [] }),
        });
      }),
    exportDrive: () => Effect.die("unused"),
    discardExport: () => Effect.void,
  });
  const layer = googleActivityPollerLayer.pipe(
    Layer.provideMerge(spaceActivityLayer),
    Layer.provide(Layer.succeed(GoogleReadConnector, connector)),
    Layer.provide(
      Layer.mock(CommandCenterService.CommandCenterService)({
        querySpaces: () => Effect.succeed({ spaces }),
        queryConnections: (input) =>
          Effect.succeed({
            connections: spaces
              .filter((space) => space.id === input.spaceId)
              .map((space) => googleConnection(space.id)),
          }),
      }),
    ),
    Layer.provide(
      Layer.succeed(
        CommandCenterConfig,
        CommandCenterConfig.of({
          configDirectory: "runtime-config",
          load: Effect.die("unused"),
          resolveGoogleAccount: () =>
            account.fail
              ? Effect.fail(
                  new CommandCenterError({ reason: "persistence", message: "database is locked" }),
                )
              : Effect.succeed({ accountAlias: "person@example.com", label: "person@example.com" }),
        }),
      ),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(
      Logger.layer(
        [
          Logger.make<unknown, void>(({ message }) => {
            const [text] = Array.isArray(message) ? message : [message];
            if (typeof text === "string" && text.startsWith("google activity")) logs.push(text);
          }),
        ],
        { mergeWithExisting: false },
      ),
    ),
  );
  const seed = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* TestClock.setTime(NOW_MS);
    for (const space of spaces) {
      yield* sql`
        INSERT INTO command_center_spaces (id, slug, name, kind, created_at, updated_at)
        VALUES (${space.id}, ${space.id}, ${space.id}, 'personal', ${at(0)}, ${at(0)})
      `;
    }
  });
  const rows = (spaceId: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{
        readonly sourceKind: string;
        readonly sourceId: string;
        readonly title: string;
        readonly status: string;
        readonly summary: string;
        readonly url: string | null;
        readonly eventSequence: number;
      }>`
        SELECT source_kind AS "sourceKind", source_id AS "sourceId", title, status, summary, url,
          event_sequence AS "eventSequence"
        FROM command_center_space_activity
        WHERE space_id = ${spaceId}
        ORDER BY id
      `;
    });
  return { layer, feeds, failures, requests, logs, account, seed, rows };
};

describe("GoogleActivityPoller", () => {
  it.effect("records each new important thread and imminent event once, without a cursor", () => {
    const harness = makeHarness([makeSpace("personal")]);
    harness.feeds.personal = {
      mail: { threads: [thread("18c2f0a1"), thread("18c2f0a2", 2)], nextPageToken: "" },
      calendar: {
        events: [
          calendarEvent("standup", 30),
          calendarEvent("later", 90),
          calendarEvent("started", -5),
          calendarEvent("offsite", 10, {
            start: { date: "2026-10-17" },
            end: { date: "2026-10-18" },
          }),
        ],
      },
    };
    return Effect.gen(function* () {
      yield* harness.seed;
      const poller = yield* GoogleActivityPoller;
      const first = yield* poller.poll;
      const second = yield* poller.poll;

      expect(first.spaces).toEqual([{ spaceId: "personal", recorded: 3, failed: [] }]);
      expect(second.spaces).toEqual([{ spaceId: "personal", recorded: 0, failed: [] }]);
      const rows = yield* harness.rows("personal");
      expect(rows).toEqual([
        {
          sourceKind: "run",
          sourceId: "calendar:standup:2026-10-17T12:30:00.000Z",
          title: "Calendar: Event standup at 08:30",
          status: "upcoming",
          summary: "starts in 30 min (Sat Oct 17 08:30 America/New_York) · 2 attendees",
          url: "https://www.google.com/calendar/event?eid=standup",
          eventSequence: 0,
        },
        {
          sourceKind: "run",
          sourceId: "gmail:18c2f0a1:1",
          title: "Mail: Subject 18c2f0a1",
          status: "new",
          summary: "from Pat Example <pat@example.com>",
          url: "https://mail.google.com/mail/?authuser=person%40example.com#all/18c2f0a1",
          eventSequence: 0,
        },
        {
          sourceKind: "run",
          sourceId: "gmail:18c2f0a2:2",
          title: "Mail: Subject 18c2f0a2",
          status: "new",
          summary: "from Pat Example <pat@example.com> · 2 messages in thread",
          url: "https://mail.google.com/mail/?authuser=person%40example.com#all/18c2f0a2",
          eventSequence: 0,
        },
      ]);
      const mailRequest = harness.requests.find((request) => request.operation === "gmail.search");
      expect(mailRequest).toMatchObject({ query: POLL_MAIL_QUERY, limit: 20 });
      const calendarRequest = harness.requests.find(
        (request) => request.operation === "calendar.events",
      );
      expect(calendarRequest).toMatchObject({
        from: "2026-10-17T12:00:00Z",
        to: "2026-10-17T13:00:00Z",
        limit: 10,
      });

      // A new reply in a known thread is new mail; the external rows never move a cursor.
      harness.feeds.personal = {
        mail: { threads: [thread("18c2f0a1", 2)] },
        calendar: { events: [] },
      };
      expect((yield* poller.poll).spaces[0]?.recorded).toBe(1);
      const activity = yield* SpaceActivity;
      expect(yield* activity.latestEventSequence("run")).toBeUndefined();
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("adds at most the per-poll row cap, calendar first", () => {
    const harness = makeHarness([makeSpace("personal")]);
    harness.feeds.personal = {
      mail: { threads: Array.from({ length: 30 }, (_, index) => thread(`t${index}`)) },
      calendar: {
        events: Array.from({ length: 15 }, (_, index) => calendarEvent(`e${index}`, index + 1)),
      },
    };
    return Effect.gen(function* () {
      yield* harness.seed;
      const poller = yield* GoogleActivityPoller;
      const report = yield* poller.poll;
      const rows = yield* harness.rows("personal");
      expect(report.spaces[0]?.recorded).toBe(GOOGLE_ACTIVITY_MAX_ROWS_PER_POLL);
      expect(rows).toHaveLength(GOOGLE_ACTIVITY_MAX_ROWS_PER_POLL);
      // The calendar read is capped at 10 events; mail fills the rest.
      expect(rows.filter((row) => row.sourceId.startsWith("calendar:"))).toHaveLength(10);
      expect(rows.slice(0, 10).every((row) => row.sourceId.startsWith("calendar:"))).toBe(true);
      // The next poll picks up mail the cap held back.
      expect((yield* poller.poll).spaces[0]?.recorded).toBe(10);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("isolates a failing Space and logs each failure streak once", () => {
    const harness = makeHarness([makeSpace("broken"), makeSpace("personal")]);
    harness.failures.set("broken:mail", "fail");
    harness.failures.set("broken:calendar", "fail");
    harness.feeds.personal = { mail: { threads: [thread("18c2f0a1")] } };
    return Effect.gen(function* () {
      yield* harness.seed;
      const poller = yield* GoogleActivityPoller;
      const first = yield* poller.poll;
      yield* poller.poll;
      expect(first.spaces).toEqual([
        { spaceId: "broken", recorded: 0, failed: ["calendar", "mail"] },
        { spaceId: "personal", recorded: 1, failed: [] },
      ]);
      expect(harness.logs).toEqual([
        "google activity poll failed; skipping until it recovers",
        "google activity poll failed; skipping until it recovers",
      ]);
      harness.failures.clear();
      yield* poller.poll;
      expect(harness.logs.slice(2)).toEqual([
        "google activity poll recovered",
        "google activity poll recovered",
      ]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("links to the default mailbox when the account lookup fails, logging it once", () => {
    const harness = makeHarness([makeSpace("personal", { capabilities: [GMAIL] })]);
    harness.account.fail = true;
    harness.feeds.personal = { mail: { threads: [thread("18c2f0a1")] } };
    return Effect.gen(function* () {
      yield* harness.seed;
      const poller = yield* GoogleActivityPoller;
      expect((yield* poller.poll).spaces).toEqual([
        { spaceId: "personal", recorded: 1, failed: [] },
      ]);
      harness.feeds.personal = { mail: { threads: [thread("18c2f0a1", 2)] } };
      expect((yield* poller.poll).spaces[0]?.recorded).toBe(1);
      expect((yield* harness.rows("personal")).map((row) => row.url)).toEqual([
        "https://mail.google.com/mail/#all/18c2f0a1",
        "https://mail.google.com/mail/#all/18c2f0a1",
      ]);
      expect(harness.logs).toEqual([
        "google activity poll could not resolve the mailbox; mail links open the default account",
      ]);
      harness.account.fail = false;
      harness.feeds.personal = { mail: { threads: [thread("18c2f0a1", 3)] } };
      yield* poller.poll;
      expect(harness.logs.slice(1)).toEqual(["google activity poll recovered"]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("times out a hung feed and keeps polling the other one", () => {
    const harness = makeHarness([makeSpace("personal")]);
    harness.failures.set("personal:calendar", "hang");
    harness.feeds.personal = { mail: { threads: [thread("18c2f0a1")] } };
    return Effect.gen(function* () {
      yield* harness.seed;
      const poller = yield* GoogleActivityPoller;
      const fiber = yield* Effect.forkChild(poller.poll);
      yield* TestClock.adjust("60 seconds");
      const report = yield* Fiber.join(fiber);
      expect(report.spaces).toEqual([{ spaceId: "personal", recorded: 1, failed: ["calendar"] }]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("skips Spaces without an enabled agent or a policy that allows Google reads", () => {
    const harness = makeHarness([
      makeSpace("quiet", { agent: false }),
      makeSpace("locked", { capabilities: ["cc.items.read"] }),
    ]);
    return Effect.gen(function* () {
      yield* harness.seed;
      const poller = yield* GoogleActivityPoller;
      expect(yield* poller.poll).toEqual({ spaces: [] });
      expect(harness.requests).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });
});
