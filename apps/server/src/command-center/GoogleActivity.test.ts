import { Connection, Space, type Space as SpaceType } from "@command-center/core";
import { describe, expect, it } from "@effect/vitest";
import { CommandCenterError, type GoogleReadRequest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import {
  BRIEF_MAIL_QUERY,
  GoogleActivityBrief,
  gmailThreadUrl,
  layer as googleActivityBriefLayer,
  parseCalendarEvents,
  parseGmailSearch,
  parseGogLocalDate,
  rfc3339Seconds,
  selectSpaceGoogleSources,
} from "./GoogleActivity.ts";
import { GoogleReadConnector, GoogleReadConnectorError } from "./GoogleReadConnector.ts";
import * as CommandCenterService from "./Service.ts";
import { renderMailCalendarSection } from "./SpaceBrief.ts";

const decodeSpace = Schema.decodeUnknownSync(Space);
const decodeConnection = Schema.decodeUnknownSync(Connection);

const makeSpace = (id: string, allowedCapabilities: ReadonlyArray<string>): SpaceType =>
  decodeSpace({
    id,
    slug: id,
    displayName: id,
    kind: "personal",
    instructions: "",
    policy: { allowedCapabilities, autoRunRiskLevels: [] },
    agent: {
      enabled: true,
      checkIns: { cron: [], timezone: "America/New_York" },
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

const makeConnection = (id: string, spaceId: string, capabilities: ReadonlyArray<string>) =>
  decodeConnection({
    id,
    spaceId,
    kind: "google",
    label: "Acme mailbox",
    capabilities,
    health: "connected",
  });

const GMAIL = "cc.connections.google.gmail.read";
const CALENDAR = "cc.connections.google.calendar.read";

/** The shape of `gog --json gmail search` (gog 0.15.0 `threadItem`). */
const gmailOutput = (threads: ReadonlyArray<unknown>) => ({ threads, nextPageToken: "" });
const thread = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  date: "2026-10-17 07:45",
  from: "Pat Example <pat@example.com>",
  subject: `Subject ${id}`,
  labels: ["INBOX", "UNREAD", "IMPORTANT"],
  messageCount: 1,
  ...overrides,
});

/** The shape of `gog --json calendar events` (Calendar v3 events plus gog's local keys). */
const calendarOutput = (events: ReadonlyArray<unknown>) => ({ events, nextPageToken: "" });
const calendarEvent = (id: string, start: string, end: string, overrides = {}) => ({
  id,
  status: "confirmed",
  summary: `Event ${id}`,
  htmlLink: `https://www.google.com/calendar/event?eid=${id}`,
  start: { dateTime: start, timeZone: "America/New_York" },
  end: { dateTime: end, timeZone: "America/New_York" },
  startLocal: start,
  ...overrides,
});

describe("Google activity source selection", () => {
  const connections = [
    makeConnection("google-b", "personal", [GMAIL, CALENDAR]),
    makeConnection("google-a", "personal", [GMAIL]),
    makeConnection("google-elsewhere", "acme", [GMAIL, CALENDAR]),
  ];

  it("needs both the Space policy and an enabled connection carrying the capability", () => {
    expect(selectSpaceGoogleSources(makeSpace("personal", [GMAIL, CALENDAR]), connections)).toEqual(
      { mail: "google-a", calendar: "google-b" },
    );
    expect(selectSpaceGoogleSources(makeSpace("personal", [GMAIL]), connections)).toEqual({
      mail: "google-a",
    });
    expect(selectSpaceGoogleSources(makeSpace("personal", ["cc.items.read"]), connections)).toEqual(
      {},
    );
    // Another Space's connection is never used, whatever the policy says.
    expect(selectSpaceGoogleSources(makeSpace("quiet", [GMAIL, CALENDAR]), connections)).toEqual(
      {},
    );
  });
});

describe("gog output parsing", () => {
  it("keeps well-formed Gmail threads and drops anything else", () => {
    const parsed = parseGmailSearch(
      gmailOutput([
        thread("18c2f0a1b2c3d4e5", { messageCount: 3 }),
        thread("bad id/with slash"),
        { subject: "no id" },
        "not an object",
        thread("18c2f0a1b2c3d4e6", { date: "Fri, 17 Oct 2026 07:45:00 +0000", messageCount: 0 }),
      ]),
      20,
    );
    expect(parsed?.dropped).toBe(3);
    expect(parsed?.entries.map((entry) => [entry.threadId, entry.messageCount])).toEqual([
      ["18c2f0a1b2c3d4e5", 3],
      ["18c2f0a1b2c3d4e6", 1],
    ]);
    expect(parsed?.entries[0]?.receivedAtMs).toBe(parseGogLocalDate("2026-10-17 07:45"));
    // gog falls back to the raw header when it cannot parse a date; that reads as unknown.
    expect(parsed?.entries[1]?.receivedAtMs).toBeUndefined();
    expect(parseGmailSearch(gmailOutput([]), 20)).toEqual({ entries: [], dropped: 0 });
    expect(parseGmailSearch({ messages: [] }, 20)).toBeUndefined();
    expect(parseGmailSearch(null, 20)).toBeUndefined();
  });

  it("bounds how many entries it reads and clips untrusted text", () => {
    const parsed = parseGmailSearch(
      gmailOutput(
        Array.from({ length: 30 }, (_, index) =>
          thread(`t${index}`, { subject: `line one\nline two ${"x".repeat(2_000)}` }),
        ),
      ),
      20,
    );
    expect(parsed?.entries).toHaveLength(20);
    expect(parsed?.entries[0]?.subject.length).toBeLessThanOrEqual(300);
    expect(parsed?.entries[0]?.subject).not.toContain("\n");
  });

  it("reads timed and all-day events and leaves out cancelled, declined, and malformed ones", () => {
    const parsed = parseCalendarEvents(
      calendarOutput([
        calendarEvent("standup", "2026-10-17T09:30:00-04:00", "2026-10-17T10:00:00-04:00", {
          attendees: [{ email: "pat@example.com" }, { email: "me@example.com", self: true }],
        }),
        {
          id: "offsite",
          summary: "Offsite",
          start: { date: "2026-10-18" },
          end: { date: "2026-10-19" },
          htmlLink: "javascript:alert(1)",
        },
        calendarEvent("gone", "2026-10-17T11:00:00Z", "2026-10-17T12:00:00Z", {
          status: "cancelled",
        }),
        calendarEvent("declined", "2026-10-17T11:00:00Z", "2026-10-17T12:00:00Z", {
          attendees: [{ email: "me@example.com", self: true, responseStatus: "declined" }],
        }),
        calendarEvent("no-end", "2026-10-17T15:00:00Z", "", { end: undefined }),
        { id: "no-start", summary: "Broken" },
        calendarEvent("bad time", "2026-10-17T15:00:00Z", "2026-10-17T16:00:00Z"),
      ]),
      25,
    );
    expect(parsed?.dropped).toBe(2);
    expect(parsed?.entries).toEqual([
      {
        id: "standup",
        title: "Event standup",
        startMs: Date.parse("2026-10-17T13:30:00.000Z"),
        endMs: Date.parse("2026-10-17T14:00:00.000Z"),
        allDay: false,
        attendeeCount: 2,
        url: "https://www.google.com/calendar/event?eid=standup",
      },
      {
        id: "offsite",
        title: "Offsite",
        startMs: Date.parse("2026-10-18T00:00:00.000Z"),
        endMs: Date.parse("2026-10-19T00:00:00.000Z"),
        allDay: true,
        attendeeCount: 0,
      },
      {
        id: "no-end",
        title: "Event no-end",
        startMs: Date.parse("2026-10-17T15:00:00.000Z"),
        endMs: Date.parse("2026-10-17T15:00:00.000Z"),
        allDay: false,
        attendeeCount: 0,
        url: "https://www.google.com/calendar/event?eid=no-end",
      },
    ]);
    expect(parseCalendarEvents({ items: [] }, 25)).toBeUndefined();
  });

  it("builds whole-second RFC 3339 windows and account-specific Gmail links", () => {
    expect(rfc3339Seconds(Date.parse("2026-10-17T12:34:56.789Z"))).toBe("2026-10-17T12:34:56Z");
    expect(gmailThreadUrl("18c2f0a1", "person+cc@example.com")).toBe(
      "https://mail.google.com/mail/?authuser=person%2Bcc%40example.com#all/18c2f0a1",
    );
    expect(gmailThreadUrl("18c2f0a1", "primary")).toBe(
      "https://mail.google.com/mail/#all/18c2f0a1",
    );
  });
});

const NOW_MS = Date.parse("2026-10-17T12:00:00.000Z");

const briefHarness = (input: {
  /** `"fail"` makes the connections query fail as storage would. */
  readonly connections: ReadonlyArray<ReturnType<typeof makeConnection>> | "fail";
  readonly read: (request: GoogleReadRequest) => Effect.Effect<unknown, GoogleReadConnectorError>;
}) => {
  const requests: Array<GoogleReadRequest> = [];
  const layer = googleActivityBriefLayer.pipe(
    Layer.provide(
      Layer.succeed(
        GoogleReadConnector,
        GoogleReadConnector.of({
          verify: () => Effect.void,
          read: (request) =>
            Effect.suspend(() => {
              requests.push(request);
              return input.read(request);
            }).pipe(
              Effect.map((data) => ({
                operation: request.operation as "gmail.search",
                contentTrust: "untrusted-external" as const,
                data,
              })),
            ),
          exportDrive: () => Effect.die("unused"),
          discardExport: () => Effect.void,
        }),
      ),
    ),
    Layer.provide(
      Layer.mock(CommandCenterService.CommandCenterService)({
        queryConnections: () =>
          input.connections === "fail"
            ? Effect.fail(
                new CommandCenterError({ reason: "persistence", message: "database is locked" }),
              )
            : Effect.succeed({ connections: input.connections }),
      }),
    ),
  );
  return { layer, requests };
};

describe("Space brief Google feed", () => {
  const personal = makeSpace("personal", [GMAIL, CALENDAR]);
  const connections = [makeConnection("google-primary", "personal", [GMAIL, CALENDAR])];

  it.effect("reads both feeds once per five minutes and renders ages on the current clock", () => {
    const harness = briefHarness({
      connections,
      read: (request) =>
        Effect.succeed(
          request.operation === "gmail.search"
            ? gmailOutput([thread("18c2f0a1")])
            : calendarOutput([
                calendarEvent("standup", "2026-10-17T13:30:00Z", "2026-10-17T14:00:00Z"),
              ]),
        ),
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const brief = yield* GoogleActivityBrief;
      const first = yield* brief.section(personal);
      yield* TestClock.adjust("4 minutes");
      const second = yield* brief.section(personal);
      expect(harness.requests).toHaveLength(2);
      expect(first?.mail).toMatchObject({ status: "ok", entries: [{ threadId: "18c2f0a1" }] });
      expect(first?.calendar).toMatchObject({ status: "ok", entries: [{ id: "standup" }] });
      expect(first?.timezone).toBe("America/New_York");
      expect(second?.nowMs).toBe(NOW_MS + 4 * 60_000);
      yield* TestClock.adjust("2 minutes");
      yield* brief.section(personal);
      expect(harness.requests).toHaveLength(4);
      const [mail, calendar] = harness.requests;
      expect(mail).toMatchObject({
        operation: "gmail.search",
        query: BRIEF_MAIL_QUERY,
        limit: 10,
        connectionId: "google-primary",
      });
      expect(calendar).toMatchObject({
        operation: "calendar.events",
        from: "2026-10-17T12:00:00Z",
        to: "2026-10-19T12:00:00Z",
      });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("turns a slow or failing feed into a short reason without gog's stderr", () => {
    const harness = briefHarness({
      connections,
      read: (request) =>
        request.operation === "gmail.search"
          ? Effect.never
          : Effect.fail(
              new GoogleReadConnectorError({
                reason: "process",
                message: "oauth2: token for person@example.com expired",
              }),
            ),
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const brief = yield* GoogleActivityBrief;
      const fiber = yield* Effect.forkChild(brief.section(personal));
      yield* TestClock.adjust("10 seconds");
      const section = yield* Fiber.join(fiber);
      expect(section?.mail).toEqual({ status: "unavailable", reason: "timed out after 10 s" });
      expect(section?.calendar).toEqual({
        status: "unavailable",
        reason: "the Google read failed",
      });
      // Failures are retried after a minute, not five.
      yield* TestClock.adjust("61 seconds");
      const retry = yield* Effect.forkChild(brief.section(personal));
      yield* TestClock.adjust("10 seconds");
      yield* Fiber.join(retry);
      expect(harness.requests).toHaveLength(4);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("says mail and calendar are unavailable when the connections cannot be read", () => {
    const harness = briefHarness({ connections: "fail", read: () => Effect.die("must not read") });
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const brief = yield* GoogleActivityBrief;
      const failed = { status: "unavailable", reason: "the Google connections could not be read" };
      const section = yield* brief.section(personal);
      expect(section).toEqual({
        nowMs: NOW_MS,
        timezone: "America/New_York",
        mail: failed,
        calendar: failed,
      });
      expect(section === undefined ? undefined : renderMailCalendarSection(section)).toBe(
        "Mail + calendar unavailable: the Google connections could not be read",
      );
      // Only the feeds the policy allows are reported, and none for a Space without Google reads.
      const mailOnly = yield* brief.section(makeSpace("personal", [GMAIL]));
      expect(mailOnly?.mail).toEqual(failed);
      expect(mailOnly?.calendar).toBeUndefined();
      expect(yield* brief.section(makeSpace("personal", ["cc.items.read"]))).toBeUndefined();
      expect(harness.requests).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("reads nothing for a Space whose policy does not allow Google reads", () => {
    const harness = briefHarness({ connections, read: () => Effect.die("must not read") });
    return Effect.gen(function* () {
      const brief = yield* GoogleActivityBrief;
      expect(yield* brief.section(makeSpace("personal", ["cc.items.read"]))).toBeUndefined();
      expect(harness.requests).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });
});
