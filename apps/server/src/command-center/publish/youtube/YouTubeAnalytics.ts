// @effect-diagnostics globalDate:off
import * as NodeCrypto from "node:crypto";

import {
  CommandCenterError,
  type CommandCenterYouTubeAnalyticsFetchInput,
  type CommandCenterYouTubeAnalyticsFetchResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ObservationService } from "../../Observations.ts";
import { canonicalJson } from "../../automation/Digest.ts";
import type { FetchLike } from "./YouTubeOAuth.ts";
import {
  fetchYouTubeAnalyticsReport,
  validateYouTubeAnalyticsPeriod,
  YouTubeAnalyticsReportError,
  type YouTubeAnalyticsReport,
} from "./YouTubeAnalyticsReport.ts";
import { YouTubeTokenStore } from "./YouTubeTokenStore.ts";

interface YouTubeAnalyticsShape {
  readonly fetch: (
    input: CommandCenterYouTubeAnalyticsFetchInput,
  ) => Effect.Effect<CommandCenterYouTubeAnalyticsFetchResult, CommandCenterError>;
}

export class YouTubeAnalytics extends Context.Service<YouTubeAnalytics, YouTubeAnalyticsShape>()(
  "@awtprod/command-center/command-center/publish/youtube/YouTubeAnalytics",
) {}

const error = (reason: CommandCenterError["reason"], message: string, cause?: unknown) =>
  new CommandCenterError({ reason, message, ...(cause === undefined ? {} : { cause }) });
const isCommandCenterError = Schema.is(CommandCenterError);

const digest = (value: unknown) =>
  NodeCrypto.createHash("sha256")
    .update(canonicalJson(value as never))
    .digest("hex");

const reportFields = (report: YouTubeAnalyticsReport) => ({
  views: report.views,
  averageViewDurationSeconds: report.averageViewDurationSeconds,
  averageViewPercentage: report.averageViewPercentage,
  freshThroughDate: report.freshThroughDate,
});

/** YouTube report days end at 23:59:59.999 Pacific, including daylight saving changes. */
export const pacificDayEnd = (day: string): string => {
  const nextUtcMidnight = Date.parse(`${day}T00:00:00.000Z`) + 86_400_000;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    timeZoneName: "shortOffset",
  }).formatToParts(new Date(nextUtcMidnight + 8 * 3_600_000));
  const offset = /^GMT([+-]\d{1,2})$/u.exec(
    parts.find((part) => part.type === "timeZoneName")?.value ?? "",
  );
  if (offset === null) throw new Error("Pacific time offset is unavailable.");
  return new Date(nextUtcMidnight - Number(offset[1]) * 3_600_000 - 1).toISOString();
};

export const make = Effect.fn("YouTubeAnalytics.make")(function* (
  options: {
    readonly fetchImpl?: FetchLike;
    readonly endpoint?: string;
  } = {},
) {
  const tokens = yield* YouTubeTokenStore;
  const observations = yield* ObservationService;
  const sql = yield* SqlClient.SqlClient;

  const existingSource = Effect.fn("YouTubeAnalytics.existingSource")(function* (
    spaceId: string,
    identity: string,
    revision: string,
  ) {
    const rows = yield* sql<{
      readonly id: string;
      readonly revisionId: string;
    }>`
      SELECT id, current_revision_id AS "revisionId"
      FROM command_center_observations
      WHERE space_id = ${spaceId} AND source_identity = ${identity}
        AND source_revision = ${revision}
      LIMIT 1
    `;
    return rows[0];
  });

  const fetchAnalytics = Effect.fn("YouTubeAnalytics.fetch")(function* (
    input: CommandCenterYouTubeAnalyticsFetchInput,
  ) {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    const validation = validateYouTubeAnalyticsPeriod(input, nowMs);
    if (validation !== undefined) return yield* error("validation", validation);
    const source = yield* observations
      .get({ spaceId: input.spaceId, observationId: input.sourceObservationId })
      .pipe(Effect.mapError((cause) => error("not_found", cause.message, cause)));
    const sourceObservation = source.observation;
    if (
      source.retired ||
      source.revisionId !== input.expectedSourceRevisionId ||
      sourceObservation.channelId !== input.channelId ||
      sourceObservation.contentId !== input.videoId ||
      (sourceObservation.contentKind !== "short-form" &&
        sourceObservation.contentKind !== "long-form") ||
      sourceObservation.cohortId === undefined ||
      sourceObservation.data.publishedAt === undefined
    ) {
      return yield* error(
        "validation",
        "Select a current video Observation with matching channel, video, publication, and Space scope.",
      );
    }
    const request = {
      channelId: input.channelId,
      videoId: input.videoId,
      startDate: input.startDate,
      endDate: input.endDate,
    };
    let accessToken = yield* tokens.analyticsAccessToken;
    const query = (token: string) =>
      Effect.tryPromise({
        try: (signal) =>
          fetchYouTubeAnalyticsReport({
            request,
            accessToken: token,
            signal,
            ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
            ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
          }),
        catch: (cause) =>
          error(
            "connector",
            cause instanceof YouTubeAnalyticsReportError
              ? cause.message
              : "YouTube Analytics could not be reached.",
            cause,
          ),
      });
    let result = yield* query(accessToken).pipe(Effect.result);
    if (
      result._tag === "Failure" &&
      result.failure.cause instanceof YouTubeAnalyticsReportError &&
      result.failure.cause.status === 401
    ) {
      yield* tokens.invalidateAccessToken;
      accessToken = yield* tokens.analyticsAccessToken;
      result = yield* query(accessToken).pipe(Effect.result);
    }
    if (result._tag === "Failure") {
      yield* tokens.recordAnalyticsCheck(result.failure.message);
      return yield* result.failure;
    }
    yield* tokens.recordAnalyticsCheck();
    const report = result.success;
    const retrievedAt = DateTime.formatIso(yield* DateTime.now);
    const sourceIdentity = (metric: "average-view-percentage" | "average-view-duration") =>
      `youtube-analytics:${input.channelId}:${input.videoId}:${input.startDate}:${input.endDate}:${metric}`;
    const freshThrough =
      report.freshThroughDate === null ? null : pacificDayEnd(report.freshThroughDate);
    const reportingLagMs =
      freshThrough === null
        ? null
        : Math.max(0, Date.parse(retrievedAt) - Date.parse(freshThrough));
    const build = (metric: "average-view-percentage" | "average-view-duration") => {
      const value =
        metric === "average-view-percentage"
          ? report.averageViewPercentage
          : report.averageViewDurationSeconds === null
            ? null
            : Math.round(report.averageViewDurationSeconds * 1000);
      const boundedValue =
        value !== null &&
        Number.isFinite(value) &&
        (metric !== "average-view-duration" || Number.isSafeInteger(value))
          ? value
          : null;
      const identity = sourceIdentity(metric);
      const revision = `sha256:${digest({
        request,
        metric,
        value: boundedValue,
        ...reportFields(report),
      })}`;
      const id = `youtube-analytics:${digest([identity, revision])}`;
      const missingReason =
        report.status === "missing"
          ? "YouTube Analytics returned no rows for this closed period."
          : report.views === 0
            ? "YouTube Analytics reported zero views, so a view average is unavailable."
            : "YouTube Analytics returned an unusable average for this period.";
      return {
        id,
        spaceId: input.spaceId,
        ...(sourceObservation.responsibilityId === undefined
          ? {}
          : { responsibilityId: sourceObservation.responsibilityId }),
        ...(sourceObservation.planId === undefined ? {} : { planId: sourceObservation.planId }),
        subjectId: sourceObservation.subjectId,
        contentId: input.videoId,
        channelId: input.channelId,
        cohortId: sourceObservation.cohortId,
        contentKind: sourceObservation.contentKind,
        source: { identity, revision },
        metric: {
          kind: metric,
          unit: metric === "average-view-percentage" ? "percent" : "milliseconds",
          definition:
            metric === "average-view-percentage"
              ? "Average percentage watched, as reported by YouTube Analytics for this video."
              : "Average playback duration in milliseconds, as reported by YouTube Analytics for this video.",
        },
        collectionMethod: "connected",
        data: {
          value: boundedValue,
          ...(boundedValue === null ? { missingReason } : {}),
          observedAt: retrievedAt,
          collectedAt: retrievedAt,
          period: {
            start: input.startDate,
            end: input.endDate,
            timeZone: "America/Los_Angeles",
          },
          publishedAt: sourceObservation.data.publishedAt,
          sampleCount: report.views,
          denominator: { kind: "views", value: report.views },
          completeness: {
            status: boundedValue === null ? "missing" : report.status,
            ...(boundedValue === null
              ? { reason: missingReason }
              : report.status === "partial"
                ? {
                    reason: `YouTube Analytics currently reports through ${report.freshThroughDate}.`,
                  }
                : {}),
          },
          reportingLagMs,
          freshThrough,
          metadata: {
            retrievedAt,
            sourceObservationId: input.sourceObservationId,
            reportStartDate: input.startDate,
            reportEndDate: input.endDate,
            reportedThroughDate: report.freshThroughDate,
            reportMetrics: "views,averageViewDuration,averageViewPercentage",
            reportDimensions: "day",
            channelId: input.channelId,
            videoId: input.videoId,
          },
        },
      };
    };
    const ids: Array<typeof input.sourceObservationId> = [];
    let deduplicated = true;
    for (const metric of ["average-view-percentage", "average-view-duration"] as const) {
      const observation = build(metric);
      const existing = yield* existingSource(
        input.spaceId,
        observation.source.identity,
        observation.source.revision,
      );
      if (existing !== undefined) {
        ids.push(existing.id as typeof input.sourceObservationId);
        continue;
      }
      const mutationId = `youtube-analytics:${digest([
        observation.source.identity,
        observation.source.revision,
      ])}`;
      const stored = yield* observations
        .ingestConnected(observation, mutationId, { kind: "connector", id: "youtube-analytics" })
        .pipe(
          Effect.mapError((cause) => error("connector", cause.message, cause)),
          Effect.result,
        );
      if (stored._tag === "Failure") {
        const raced = yield* existingSource(
          input.spaceId,
          observation.source.identity,
          observation.source.revision,
        );
        if (raced === undefined) return yield* stored.failure;
        ids.push(raced.id as typeof input.sourceObservationId);
      } else {
        ids.push(stored.success.observationId);
        deduplicated = deduplicated && stored.success.deduplicated;
      }
    }
    return {
      observationIds: ids,
      status: report.status,
      requestedEndDate: input.endDate,
      freshThroughDate: report.freshThroughDate,
      views: report.views,
      deduplicated,
    } satisfies CommandCenterYouTubeAnalyticsFetchResult;
  });

  return YouTubeAnalytics.of({
    fetch: (input) =>
      fetchAnalytics(input).pipe(
        Effect.mapError((cause) =>
          isCommandCenterError(cause)
            ? cause
            : error("persistence", "YouTube Analytics could not store the observations.", cause),
        ),
      ),
  });
});

export const layer = Layer.effect(YouTubeAnalytics, make());
