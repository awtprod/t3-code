/**
 * GoogleActivity - Gmail and Calendar observations for Space agents.
 *
 * Shared by the Space agent brief ("Mail + calendar", cached five minutes per
 * Space) and `GoogleActivityPoller` (activity rows that wake the agent). Both
 * read only through `GoogleReadConnector` (pinned gog, read allowlist, bounded
 * process timeout), and only for a Space whose policy allows the granular
 * Google read capability AND whose enabled connection carries it: the same two
 * checks `cc_google_read` makes. gog output is untrusted, so every field is
 * shape-checked here and malformed entries are dropped.
 *
 * @module GoogleActivity
 */
import {
  ConnectionId,
  SpaceId,
  type CapabilityName,
  type Connection as ConnectionType,
  type Space as SpaceType,
} from "@command-center/core";
import type { GoogleReadRequest } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { GoogleReadConnector, type GoogleReadConnectorError } from "./GoogleReadConnector.ts";
import * as CommandCenterService from "./Service.ts";
import { spaceAgentTimezone } from "./SpaceAgentWakeState.ts";
import type {
  SpaceBriefEvent,
  SpaceBriefFeed,
  SpaceBriefMail,
  SpaceBriefMailCalendar,
} from "./SpaceBrief.ts";

const GMAIL_READ: CapabilityName = "cc.connections.google.gmail.read";
const CALENDAR_READ: CapabilityName = "cc.connections.google.calendar.read";

/** Inbox mail the brief lists: unread, last day, without the promotion and social tabs. */
export const BRIEF_MAIL_QUERY =
  "in:inbox is:unread newer_than:1d -category:promotions -category:social";
const BRIEF_MAIL_LIMIT = 10;
const BRIEF_CALENDAR_LIMIT = 25;
const BRIEF_CALENDAR_WINDOW_HOURS = 48;
/** Both feeds run concurrently, so this is also the brief's total wait. */
const BRIEF_FETCH_TIMEOUT = Duration.seconds(10);
const BRIEF_CACHE_TTL = Duration.minutes(5);
/** A feed that failed is retried sooner than a good one is refreshed. */
const BRIEF_FAILURE_CACHE_TTL = Duration.minutes(1);
const BRIEF_CACHE_CAPACITY = 64;

/** Longest untrusted text kept per field before the brief or activity clips it further. */
const FIELD_CHARS = 300;
/** gog thread and event ids; anything else is dropped rather than put in an id or URL. */
const SAFE_ID = /^[A-Za-z0-9_.@-]{1,256}$/u;
const MAX_URL_CHARS = 500;

/** The connection each Google feed of a Space reads from, when the Space may read it. */
export interface SpaceGoogleSources {
  readonly mail?: ConnectionType["id"];
  readonly calendar?: ConnectionType["id"];
}

const sourceFor = (
  space: Pick<SpaceType, "id" | "policy">,
  connections: ReadonlyArray<ConnectionType>,
  capability: CapabilityName,
): ConnectionType["id"] | undefined =>
  space.policy.allowedCapabilities.includes(capability)
    ? connections
        .filter(
          (connection) =>
            connection.spaceId === space.id &&
            connection.kind === "google" &&
            connection.capabilities.includes(capability),
        )
        .map((connection) => connection.id)
        .toSorted()[0]
    : undefined;

/**
 * The first enabled Google connection (by id) of the Space that carries each
 * read capability its policy allows. `connections` are the projected enabled
 * connections, so a disabled or unassigned account never appears.
 */
export const selectSpaceGoogleSources = (
  space: Pick<SpaceType, "id" | "policy">,
  connections: ReadonlyArray<ConnectionType>,
): SpaceGoogleSources => {
  const mail = sourceFor(space, connections, GMAIL_READ);
  const calendar = sourceFor(space, connections, CALENDAR_READ);
  return {
    ...(mail === undefined ? {} : { mail }),
    ...(calendar === undefined ? {} : { calendar }),
  };
};

const clipField = (value: string | undefined): string =>
  (value ?? "").replace(/\s+/gu, " ").trim().slice(0, FIELD_CHARS);

/**
 * gog prints a thread's newest Gmail date as `YYYY-MM-DD HH:mm` in its local
 * zone, which the connector shares with the server (it falls back to the raw
 * header when it cannot parse one; that reads as unknown here).
 */
export const parseGogLocalDate = (value: string | undefined): number | undefined => {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/u.exec(value?.trim() ?? "");
  if (match === null) return undefined;
  const [year, month, day, hours, minutes] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  // @effect-diagnostics-next-line globalDate:off -- gog prints wall time on the host clock.
  const epochMs = new Date(year, month - 1, day, hours, minutes).getTime();
  return Number.isFinite(epochMs) ? epochMs : undefined;
};

const GmailSearchOutput = Schema.Struct({ threads: Schema.Array(Schema.Unknown) });
const GmailThreadOutput = Schema.Struct({
  id: Schema.String,
  date: Schema.optional(Schema.String),
  from: Schema.optional(Schema.String),
  subject: Schema.optional(Schema.String),
  messageCount: Schema.optional(Schema.Number),
});
const decodeGmailSearchOutput = Schema.decodeUnknownOption(GmailSearchOutput);
const decodeGmailThreadOutput = Schema.decodeUnknownOption(GmailThreadOutput);

/** One Gmail thread from `gog gmail search` (gog 0.15.0 returns threads, without snippets). */
export interface GmailThreadSummary extends SpaceBriefMail {
  readonly threadId: string;
}

export interface ParsedGoogleFeed<A> {
  readonly entries: ReadonlyArray<A>;
  /** Entries dropped because their shape did not check out. */
  readonly dropped: number;
}

/** Shape-check `gog --json gmail search` output; undefined when the envelope itself is wrong. */
export const parseGmailSearch = (
  data: unknown,
  limit: number,
): ParsedGoogleFeed<GmailThreadSummary> | undefined => {
  const output = Option.getOrUndefined(decodeGmailSearchOutput(data));
  if (output === undefined) return undefined;
  const candidates = output.threads.slice(0, limit);
  const entries = candidates.flatMap((candidate) => {
    const thread = Option.getOrUndefined(decodeGmailThreadOutput(candidate));
    if (thread === undefined || !SAFE_ID.test(thread.id)) return [];
    const messageCount =
      thread.messageCount !== undefined &&
      Number.isInteger(thread.messageCount) &&
      thread.messageCount > 0
        ? thread.messageCount
        : 1;
    return [
      {
        threadId: thread.id,
        from: clipField(thread.from),
        subject: clipField(thread.subject),
        receivedAtMs: parseGogLocalDate(thread.date),
        messageCount,
      },
    ];
  });
  return { entries, dropped: candidates.length - entries.length };
};

const CalendarTimeOutput = Schema.Struct({
  dateTime: Schema.optional(Schema.String),
  date: Schema.optional(Schema.String),
});
const CalendarEventOutput = Schema.Struct({
  id: Schema.String,
  status: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  htmlLink: Schema.optional(Schema.String),
  start: CalendarTimeOutput,
  end: Schema.optional(CalendarTimeOutput),
  attendees: Schema.optional(Schema.Array(Schema.Unknown)),
});
const CalendarAttendeeOutput = Schema.Struct({
  self: Schema.optional(Schema.Boolean),
  responseStatus: Schema.optional(Schema.String),
});
const CalendarEventsOutput = Schema.Struct({ events: Schema.Array(Schema.Unknown) });
const decodeCalendarEventsOutput = Schema.decodeUnknownOption(CalendarEventsOutput);
const decodeCalendarEventOutput = Schema.decodeUnknownOption(CalendarEventOutput);
const decodeCalendarAttendeeOutput = Schema.decodeUnknownOption(CalendarAttendeeOutput);

const instantMs = (value: string): number | undefined => {
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? DateTime.toEpochMillis(parsed.value) : undefined;
};

/** `{dateTime}` is an instant; `{date}` (all day) reads as UTC midnight of that date. */
const calendarTimeMs = (
  time: typeof CalendarTimeOutput.Type,
): { readonly epochMs: number; readonly allDay: boolean } | undefined => {
  if (time.dateTime !== undefined) {
    const epochMs = instantMs(time.dateTime);
    return epochMs === undefined ? undefined : { epochMs, allDay: false };
  }
  if (time.date !== undefined && /^\d{4}-\d{2}-\d{2}$/u.test(time.date)) {
    const epochMs = instantMs(`${time.date}T00:00:00Z`);
    return epochMs === undefined ? undefined : { epochMs, allDay: true };
  }
  return undefined;
};

const isGoogleCalendarLink = (value: string | undefined): value is string =>
  value !== undefined &&
  value.length <= MAX_URL_CHARS &&
  /^https:\/\/(?:www\.google\.com\/calendar\/|calendar\.google\.com\/)/u.test(value);

/** One calendar event from `gog calendar events` (a Calendar v3 Event). */
export interface CalendarEventSummary extends SpaceBriefEvent {
  readonly url?: string | undefined;
}

/**
 * Shape-check `gog --json calendar events` output; undefined when the envelope
 * itself is wrong. Cancelled events and events the account declined are left
 * out: they are not on the calendar owner's plate.
 */
export const parseCalendarEvents = (
  data: unknown,
  limit: number,
): ParsedGoogleFeed<CalendarEventSummary> | undefined => {
  const output = Option.getOrUndefined(decodeCalendarEventsOutput(data));
  if (output === undefined) return undefined;
  const candidates = output.events.slice(0, limit);
  let dropped = 0;
  const entries = candidates.flatMap((candidate): ReadonlyArray<CalendarEventSummary> => {
    const event = Option.getOrUndefined(decodeCalendarEventOutput(candidate));
    const start = event === undefined ? undefined : calendarTimeMs(event.start);
    if (event === undefined || start === undefined || !SAFE_ID.test(event.id)) {
      dropped += 1;
      return [];
    }
    const declined = (event.attendees ?? []).some((attendee) => {
      const decoded = Option.getOrUndefined(decodeCalendarAttendeeOutput(attendee));
      return decoded?.self === true && decoded.responseStatus === "declined";
    });
    if (event.status === "cancelled" || declined) return [];
    const end = event.end === undefined ? undefined : calendarTimeMs(event.end);
    return [
      {
        id: event.id,
        title: clipField(event.summary),
        startMs: start.epochMs,
        endMs: end === undefined || end.epochMs < start.epochMs ? start.epochMs : end.epochMs,
        allDay: start.allDay,
        attendeeCount: event.attendees?.length ?? 0,
        ...(isGoogleCalendarLink(event.htmlLink) ? { url: event.htmlLink } : {}),
      },
    ];
  });
  return { entries, dropped };
};

/** RFC 3339 at whole seconds, the form gog's `--from`/`--to` document. */
export const rfc3339Seconds = (epochMs: number): string =>
  DateTime.formatIso(DateTime.makeUnsafe(Math.floor(epochMs / 1_000) * 1_000)).replace(
    /\.\d{3}Z$/u,
    "Z",
  );

/** A Gmail web link to one thread in the connected account's mailbox. */
export const gmailThreadUrl = (threadId: string, accountAlias: string | undefined): string =>
  accountAlias !== undefined && accountAlias.includes("@")
    ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(accountAlias)}#all/${threadId}`
    : `https://mail.google.com/mail/#all/${threadId}`;

/** A failure an agent may see: the category only, never gog's stderr. */
export const publicGoogleFailure = (cause: GoogleReadConnectorError): string => {
  switch (cause.reason) {
    case "configuration":
      return "the Google connection is not available in this Space";
    case "version":
      return "the pinned gog connector is not installed on this environment";
    case "process":
      return "the Google read failed";
    case "output":
      return "Google returned an unexpected response";
  }
};

type MetadataReadRequest = Exclude<GoogleReadRequest, { readonly operation: "drive.export" }>;

/** Run one metadata read and return its untrusted `data`. */
export const readGoogleData = (
  connector: GoogleReadConnector["Service"],
  request: MetadataReadRequest,
): Effect.Effect<unknown, GoogleReadConnectorError> =>
  connector.read(request).pipe(Effect.map((result) => ("data" in result ? result.data : null)));

export const gmailSearchRequest = (input: {
  readonly spaceId: string;
  readonly connectionId: string;
  readonly query: string;
  readonly limit: number;
}): MetadataReadRequest => ({
  operation: "gmail.search",
  spaceId: SpaceId.make(input.spaceId),
  connectionId: ConnectionId.make(input.connectionId),
  query: input.query,
  limit: input.limit,
});

export const calendarEventsRequest = (input: {
  readonly spaceId: string;
  readonly connectionId: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly limit: number;
}): MetadataReadRequest => ({
  operation: "calendar.events",
  spaceId: SpaceId.make(input.spaceId),
  connectionId: ConnectionId.make(input.connectionId),
  from: rfc3339Seconds(input.fromMs),
  to: rfc3339Seconds(input.toMs),
  limit: input.limit,
});

export interface GoogleActivityBriefShape {
  /**
   * The Space's "Mail + calendar" brief input, or undefined when the Space
   * reads neither feed. Never fails: a feed that cannot be read within
   * `BRIEF_FETCH_TIMEOUT` comes back `unavailable` with a short reason, and
   * so does every feed the policy allows when the Space's connections cannot
   * be listed.
   */
  readonly section: (space: SpaceType) => Effect.Effect<SpaceBriefMailCalendar | undefined>;
}

export class GoogleActivityBrief extends Context.Service<
  GoogleActivityBrief,
  GoogleActivityBriefShape
>()("@awtprod/command-center/command-center/GoogleActivity/GoogleActivityBrief") {}

interface BriefFeeds {
  readonly mail?: SpaceBriefFeed<SpaceBriefMail>;
  readonly calendar?: SpaceBriefFeed<SpaceBriefEvent>;
}

/** Space and connection ids are non-empty config ids; NUL never occurs in them. */
const KEY_SEPARATOR = "\u0000";
const briefCacheKey = (spaceId: string, sources: SpaceGoogleSources): string =>
  [spaceId, sources.mail ?? "", sources.calendar ?? ""].join(KEY_SEPARATOR);
const parseBriefCacheKey = (key: string) => {
  const [spaceId = "", mail = "", calendar = ""] = key.split(KEY_SEPARATOR);
  return {
    spaceId,
    mail: mail.length === 0 ? null : mail,
    calendar: calendar.length === 0 ? null : calendar,
  };
};

const unavailable = (reason: string) => ({ status: "unavailable" as const, reason });

const make = Effect.gen(function* () {
  const connector = yield* GoogleReadConnector;
  const service = yield* CommandCenterService.CommandCenterService;

  /** One feed, bounded by the brief timeout; any failure becomes a reason line. */
  const fetchFeed = <A>(
    spaceId: string,
    feed: "mail" | "calendar",
    read: Effect.Effect<ParsedGoogleFeed<A> | undefined, GoogleReadConnectorError>,
  ): Effect.Effect<SpaceBriefFeed<A>> =>
    read.pipe(
      Effect.map((parsed): SpaceBriefFeed<A> =>
        parsed === undefined
          ? unavailable("Google returned an unexpected response")
          : { status: "ok", entries: parsed.entries },
      ),
      Effect.catch((cause) => Effect.succeed(unavailable(publicGoogleFailure(cause)))),
      Effect.timeoutOption(BRIEF_FETCH_TIMEOUT),
      Effect.map((result) =>
        Option.getOrElse(result, () =>
          unavailable(`timed out after ${Duration.toSeconds(BRIEF_FETCH_TIMEOUT)} s`),
        ),
      ),
      Effect.tap((result) =>
        result.status === "unavailable"
          ? Effect.logWarning("space brief Google feed unavailable", {
              spaceId,
              feed,
              reason: result.reason,
            })
          : Effect.void,
      ),
    );

  const lookup = (encoded: string): Effect.Effect<BriefFeeds> =>
    Effect.gen(function* () {
      const key = parseBriefCacheKey(encoded);
      const nowMs = yield* Clock.currentTimeMillis;
      const mail =
        key.mail === null
          ? Effect.undefined
          : fetchFeed(
              key.spaceId,
              "mail",
              readGoogleData(
                connector,
                gmailSearchRequest({
                  spaceId: key.spaceId,
                  connectionId: key.mail,
                  query: BRIEF_MAIL_QUERY,
                  limit: BRIEF_MAIL_LIMIT,
                }),
              ).pipe(Effect.map((data) => parseGmailSearch(data, BRIEF_MAIL_LIMIT))),
            );
      const calendar =
        key.calendar === null
          ? Effect.undefined
          : fetchFeed(
              key.spaceId,
              "calendar",
              readGoogleData(
                connector,
                calendarEventsRequest({
                  spaceId: key.spaceId,
                  connectionId: key.calendar,
                  fromMs: nowMs,
                  toMs: nowMs + BRIEF_CALENDAR_WINDOW_HOURS * 3_600_000,
                  limit: BRIEF_CALENDAR_LIMIT,
                }),
              ).pipe(Effect.map((data) => parseCalendarEvents(data, BRIEF_CALENDAR_LIMIT))),
            );
      const [mailFeed, calendarFeed] = yield* Effect.all([mail, calendar], {
        concurrency: "unbounded",
      });
      return {
        ...(mailFeed === undefined ? {} : { mail: mailFeed }),
        ...(calendarFeed === undefined ? {} : { calendar: calendarFeed }),
      };
    });

  const cache = yield* Cache.makeWith<string, BriefFeeds>(lookup, {
    capacity: BRIEF_CACHE_CAPACITY,
    timeToLive: Exit.match({
      onSuccess: (feeds) =>
        feeds.mail?.status === "unavailable" || feeds.calendar?.status === "unavailable"
          ? BRIEF_FAILURE_CACHE_TTL
          : BRIEF_CACHE_TTL,
      onFailure: () => Duration.zero,
    }),
  });

  const section: GoogleActivityBriefShape["section"] = (space) =>
    Effect.gen(function* () {
      const timezone = space.agent === undefined ? "UTC" : spaceAgentTimezone(space.agent);
      const connections = yield* service.queryConnections({ spaceId: space.id }).pipe(
        Effect.map((result) => result.connections),
        Effect.tapError((error) =>
          Effect.logWarning("space brief Google connections unavailable", {
            spaceId: space.id,
            message: error.message,
          }),
        ),
        Effect.option,
      );
      if (Option.isNone(connections)) {
        // Which connection would serve a feed is unknown, so every feed the
        // policy allows is reported unavailable rather than silently dropped.
        const failed = unavailable("the Google connections could not be read");
        const allows = (capability: CapabilityName) =>
          space.policy.allowedCapabilities.includes(capability);
        if (!allows(GMAIL_READ) && !allows(CALENDAR_READ)) return undefined;
        return {
          nowMs: yield* Clock.currentTimeMillis,
          timezone,
          ...(allows(GMAIL_READ) ? { mail: failed } : {}),
          ...(allows(CALENDAR_READ) ? { calendar: failed } : {}),
        } satisfies SpaceBriefMailCalendar;
      }
      const sources = selectSpaceGoogleSources(space, connections.value);
      if (sources.mail === undefined && sources.calendar === undefined) return undefined;
      const feeds = yield* Cache.get(cache, briefCacheKey(space.id, sources));
      return {
        nowMs: yield* Clock.currentTimeMillis,
        timezone,
        ...feeds,
      } satisfies SpaceBriefMailCalendar;
    });

  return GoogleActivityBrief.of({ section });
});

export const layer = Layer.effect(GoogleActivityBrief, make);
