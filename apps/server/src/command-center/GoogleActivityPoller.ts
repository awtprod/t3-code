/**
 * GoogleActivityPoller - turns new important mail and imminent calendar events
 * into Space activity rows, so the Space agent's existing event wake fires.
 *
 * Every `GOOGLE_ACTIVITY_POLL_INTERVAL`, for each active Space whose agent is
 * enabled and whose policy and enabled Google connection allow the read (see
 * `selectSpaceGoogleSources`):
 *
 * - mail: `is:unread is:important newer_than:1d`, at most 20 threads. One row
 *   per thread and message count not seen before, so a new reply in a known
 *   thread is announced once more.
 * - calendar: timed events starting within the next 60 minutes, one row per
 *   event and start time not announced before (a moved event is announced
 *   again at its new time).
 *
 * Rows go through `SpaceActivity.record` with deterministic source ids and the
 * external event sequence, so the table's unique key is the dedupe and no
 * cursor is needed. At most `GOOGLE_ACTIVITY_MAX_ROWS_PER_POLL` rows are added
 * per Space per poll (calendar first). Quiet hours, debounce, and the daily
 * wake cap stay with `SpaceAgentWaker`. A feed that fails (gog missing, the
 * connection unavailable, a timeout) is logged once per failure streak and
 * skipped; it never stops the loop or another Space.
 *
 * @module GoogleActivityPoller
 */
import type { Connection as ConnectionType, Space as SpaceType } from "@command-center/core";
import { CommandCenterError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { CommandCenterConfig } from "./Config.ts";
import {
  calendarEventsRequest,
  gmailSearchRequest,
  gmailThreadUrl,
  parseCalendarEvents,
  parseGmailSearch,
  publicGoogleFailure,
  readGoogleData,
  selectSpaceGoogleSources,
  type SpaceGoogleSources,
} from "./GoogleActivity.ts";
import { GoogleReadConnector, GoogleReadConnectorError } from "./GoogleReadConnector.ts";
import * as CommandCenterService from "./Service.ts";
import { SPACE_ACTIVITY_EXTERNAL_EVENT_SEQUENCE, SpaceActivity } from "./SpaceActivity.ts";
import { spaceAgentTimezone } from "./SpaceAgentWakeState.ts";
import { formatBriefLocalTime } from "./SpaceBrief.ts";

const GOOGLE_ACTIVITY_POLL_INTERVAL = Duration.minutes(10);
/** Lets startup settle (config sync, connection verification) before the first poll. */
const GOOGLE_ACTIVITY_POLL_START_DELAY = Duration.minutes(1);
export const GOOGLE_ACTIVITY_MAX_ROWS_PER_POLL = 20;
export const POLL_MAIL_QUERY = "is:unread is:important newer_than:1d";
const POLL_MAIL_LIMIT = 20;
const POLL_CALENDAR_LIMIT = 10;
const POLL_CALENDAR_LEAD_MINUTES = 60;
/** Per feed, on top of the connector's own process timeout. */
const POLL_FEED_TIMEOUT = Duration.seconds(60);
const MAIL_SENDER_CHARS = 240;

export type GoogleActivityFeed = "mail" | "calendar";

export interface GoogleActivityPollReport {
  readonly spaces: ReadonlyArray<{
    readonly spaceId: string;
    readonly recorded: number;
    readonly failed: ReadonlyArray<GoogleActivityFeed>;
  }>;
}

export interface GoogleActivityPollerShape {
  /** One pass over every eligible Space. The loop calls it; tests drive it. */
  readonly poll: Effect.Effect<GoogleActivityPollReport>;
  /** Start the polling loop in the caller's scope. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class GoogleActivityPoller extends Context.Service<
  GoogleActivityPoller,
  GoogleActivityPollerShape
>()("@awtprod/command-center/command-center/GoogleActivityPoller") {}

class FeedTimeout extends Schema.TaggedError<FeedTimeout>()("FeedTimeout", {}) {
  override get message(): string {
    return `timed out after ${Duration.toSeconds(POLL_FEED_TIMEOUT)} s`;
  }
}

const isConnectorError = Schema.is(GoogleReadConnectorError);
const isCommandCenterError = Schema.is(CommandCenterError);
const isFeedTimeout = Schema.is(FeedTimeout);

/** A failure for the operator log: the category, plus the source's own message. */
const describeFailure = (cause: unknown): { readonly reason: string; readonly message: string } => {
  if (isConnectorError(cause)) {
    return { reason: publicGoogleFailure(cause), message: cause.message.slice(0, 300) };
  }
  if (isCommandCenterError(cause)) {
    return { reason: cause.reason, message: cause.message.slice(0, 300) };
  }
  if (isFeedTimeout(cause)) return { reason: "timeout", message: cause.message };
  return { reason: "unexpected", message: String(cause).slice(0, 300) };
};

const make = Effect.gen(function* () {
  const service = yield* CommandCenterService.CommandCenterService;
  const connector = yield* GoogleReadConnector;
  const activity = yield* SpaceActivity;
  const config = yield* CommandCenterConfig;
  /** `spaceId:feed` keys in a failure streak; pruned to the Spaces still polled. */
  const failing = new Set<string>();

  const noteOutcome = (
    spaceId: string,
    feed: GoogleActivityFeed | "spaces" | "connections",
    failure: unknown | undefined,
  ) => {
    const key = `${spaceId}:${feed}`;
    if (failure === undefined) {
      if (!failing.delete(key)) return Effect.void;
      return Effect.logInfo("google activity poll recovered", { spaceId, feed });
    }
    if (failing.has(key)) return Effect.void;
    failing.add(key);
    return Effect.logWarning("google activity poll failed; skipping until it recovers", {
      spaceId,
      feed,
      ...describeFailure(failure),
    });
  };

  const record = (input: {
    readonly spaceId: string;
    readonly occurredAt: string;
    readonly sourceId: string;
    readonly title: string;
    readonly status: string;
    readonly text: string;
    readonly url?: string | undefined;
  }) =>
    activity.record({
      spaceId: input.spaceId,
      occurredAt: input.occurredAt,
      sourceKind: "run",
      sourceId: input.sourceId,
      projectId: null,
      title: input.title,
      status: input.status,
      text: input.text,
      eventSequence: SPACE_ACTIVITY_EXTERNAL_EVENT_SEQUENCE,
      ...(input.url === undefined ? {} : { url: input.url }),
    });

  /** Calendar events starting in the next hour; returns rows added. */
  const pollCalendar = Effect.fn("GoogleActivityPoller.pollCalendar")(function* (
    space: SpaceType,
    connectionId: string,
    budget: number,
    nowMs: number,
  ) {
    const untilMs = nowMs + POLL_CALENDAR_LEAD_MINUTES * 60_000;
    const data = yield* readGoogleData(
      connector,
      calendarEventsRequest({
        spaceId: space.id,
        connectionId,
        fromMs: nowMs,
        toMs: untilMs,
        limit: POLL_CALENDAR_LIMIT,
      }),
    );
    const parsed = parseCalendarEvents(data, POLL_CALENDAR_LIMIT);
    if (parsed === undefined) {
      return yield* new GoogleReadConnectorError({
        reason: "output",
        message: "gog calendar events output did not match its expected shape.",
      });
    }
    const timezone = space.agent === undefined ? "UTC" : spaceAgentTimezone(space.agent);
    const occurredAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
    const upcoming = parsed.entries
      .filter((event) => !event.allDay && event.startMs >= nowMs && event.startMs <= untilMs)
      .toSorted((left, right) => left.startMs - right.startMs);
    let added = 0;
    for (const event of upcoming) {
      if (added >= budget) break;
      const local = formatBriefLocalTime(event.startMs, timezone);
      const minutes = Math.max(0, Math.round((event.startMs - nowMs) / 60_000));
      const attendees =
        event.attendeeCount === 0
          ? ""
          : ` · ${event.attendeeCount} attendee${event.attendeeCount === 1 ? "" : "s"}`;
      const inserted = yield* record({
        spaceId: space.id,
        occurredAt,
        sourceId: `calendar:${event.id}:${DateTime.formatIso(DateTime.makeUnsafe(event.startMs))}`,
        title: `Calendar: ${event.title || "(no title)"} at ${local.slice(-5)}`,
        status: "upcoming",
        text: `starts in ${minutes} min (${local} ${timezone})${attendees}`,
        url: event.url,
      });
      if (inserted) added += 1;
    }
    return added;
  });

  /** New important unread threads; returns rows added. */
  const pollMail = Effect.fn("GoogleActivityPoller.pollMail")(function* (
    space: SpaceType,
    connectionId: string,
    budget: number,
    nowMs: number,
  ) {
    if (budget <= 0) return 0;
    const data = yield* readGoogleData(
      connector,
      gmailSearchRequest({
        spaceId: space.id,
        connectionId,
        query: POLL_MAIL_QUERY,
        limit: POLL_MAIL_LIMIT,
      }),
    );
    const parsed = parseGmailSearch(data, POLL_MAIL_LIMIT);
    if (parsed === undefined) {
      return yield* new GoogleReadConnectorError({
        reason: "output",
        message: "gog gmail search output did not match its expected shape.",
      });
    }
    if (parsed.entries.length === 0) return 0;
    // Only for the link: a mailbox the alias does not name opens Gmail's default account.
    const account = yield* config
      .resolveGoogleAccount({ spaceId: space.id, connectionId })
      .pipe(Effect.option);
    const accountAlias = Option.getOrUndefined(account)?.accountAlias;
    const occurredAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
    let added = 0;
    for (const thread of parsed.entries) {
      if (added >= budget) break;
      const messages =
        thread.messageCount > 1 ? ` · ${thread.messageCount} messages in thread` : "";
      const inserted = yield* record({
        spaceId: space.id,
        occurredAt,
        sourceId: `gmail:${thread.threadId}:${thread.messageCount}`,
        title: `Mail: ${thread.subject || "(no subject)"}`,
        status: "new",
        text: `from ${(thread.from || "unknown sender").slice(0, MAIL_SENDER_CHARS)}${messages}`,
        url: gmailThreadUrl(thread.threadId, accountAlias),
      });
      if (inserted) added += 1;
    }
    return added;
  });

  /** Run one feed under its timeout and note the outcome; never fails. */
  const runFeed = (
    spaceId: string,
    feed: GoogleActivityFeed,
    effect: Effect.Effect<number, GoogleReadConnectorError | CommandCenterError>,
  ) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: POLL_FEED_TIMEOUT,
        orElse: () => Effect.fail(new FeedTimeout()),
      }),
      Effect.tap(() => noteOutcome(spaceId, feed, undefined)),
      Effect.map((added) => ({ added, failed: false })),
      Effect.catch((cause) =>
        noteOutcome(spaceId, feed, cause).pipe(Effect.as({ added: 0, failed: true })),
      ),
    );

  const pollSpace = Effect.fn("GoogleActivityPoller.pollSpace")(function* (
    space: SpaceType,
    sources: SpaceGoogleSources,
  ) {
    const nowMs = yield* Clock.currentTimeMillis;
    const failed: Array<GoogleActivityFeed> = [];
    let recorded = 0;
    // Calendar first: an event in the next hour is the more time-critical row.
    if (sources.calendar !== undefined) {
      const result = yield* runFeed(
        space.id,
        "calendar",
        pollCalendar(space, sources.calendar, GOOGLE_ACTIVITY_MAX_ROWS_PER_POLL, nowMs),
      );
      recorded += result.added;
      if (result.failed) failed.push("calendar");
    }
    if (sources.mail !== undefined) {
      const result = yield* runFeed(
        space.id,
        "mail",
        pollMail(space, sources.mail, GOOGLE_ACTIVITY_MAX_ROWS_PER_POLL - recorded, nowMs),
      );
      recorded += result.added;
      if (result.failed) failed.push("mail");
    }
    return { spaceId: space.id, recorded, failed };
  });

  const eligibleSpaces = service.querySpaces({}).pipe(
    Effect.map((result) =>
      result.spaces.filter(
        (space) => space.lifecycle === "active" && space.agent?.enabled === true,
      ),
    ),
    Effect.tap(() => noteOutcome("*", "spaces", undefined)),
    Effect.catch((cause) =>
      noteOutcome("*", "spaces", cause).pipe(Effect.as([] as ReadonlyArray<SpaceType>)),
    ),
  );

  const connectionsOf = (spaceId: SpaceType["id"]) =>
    service.queryConnections({ spaceId }).pipe(
      Effect.map((result) => result.connections),
      Effect.tap(() => noteOutcome(spaceId, "connections", undefined)),
      Effect.catch((cause) =>
        noteOutcome(spaceId, "connections", cause).pipe(
          Effect.as([] as ReadonlyArray<ConnectionType>),
        ),
      ),
    );

  const poll: GoogleActivityPollerShape["poll"] = Effect.gen(function* () {
    const spaces = yield* eligibleSpaces;
    const polled = new Set<string>(["*"]);
    const reports: Array<GoogleActivityPollReport["spaces"][number]> = [];
    for (const space of spaces) {
      polled.add(space.id);
      const sources = selectSpaceGoogleSources(space, yield* connectionsOf(space.id));
      if (sources.mail === undefined && sources.calendar === undefined) continue;
      reports.push(yield* pollSpace(space, sources));
    }
    for (const key of failing) {
      if (!polled.has(key.slice(0, key.lastIndexOf(":")))) failing.delete(key);
    }
    return { spaces: reports };
  });

  const start: GoogleActivityPollerShape["start"] = () =>
    Effect.gen(function* () {
      yield* Effect.forkScoped(
        Effect.sleep(GOOGLE_ACTIVITY_POLL_START_DELAY).pipe(
          Effect.andThen(
            poll.pipe(
              Effect.catchCauseIf(
                (cause) => !Cause.hasInterruptsOnly(cause),
                (cause) =>
                  Effect.logWarning("google activity poll failed", { cause: Cause.pretty(cause) }),
              ),
              Effect.repeat(Schedule.spaced(GOOGLE_ACTIVITY_POLL_INTERVAL)),
            ),
          ),
        ),
      );
      yield* Effect.logInfo("command-center.google-activity.poller-started", {
        intervalMs: Duration.toMillis(GOOGLE_ACTIVITY_POLL_INTERVAL),
      });
    });

  return GoogleActivityPoller.of({ poll, start });
});

export const layer = Layer.effect(GoogleActivityPoller, make);
