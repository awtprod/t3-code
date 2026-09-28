import {
  ObservationCalendarDate,
  ObservationId,
  ObservationRevisionId,
  SpaceId,
  TrimmedNonEmptyString,
} from "@command-center/core";
import * as Schema from "effect/Schema";
import { COMMAND_CENTER_WS_METHODS } from "./commandCenter.ts";

export const COMMAND_CENTER_YOUTUBE_ANALYTICS_FETCH_METHOD =
  COMMAND_CENTER_WS_METHODS.youtubeAnalyticsFetch;

const YouTubeId = TrimmedNonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9_-]{11,24}$/u));

export const CommandCenterYouTubeAnalyticsFetchInput = Schema.Struct({
  spaceId: SpaceId,
  sourceObservationId: ObservationId,
  expectedSourceRevisionId: ObservationRevisionId,
  channelId: YouTubeId,
  videoId: YouTubeId,
  startDate: ObservationCalendarDate,
  endDate: ObservationCalendarDate,
});
export type CommandCenterYouTubeAnalyticsFetchInput =
  typeof CommandCenterYouTubeAnalyticsFetchInput.Type;

export const CommandCenterYouTubeAnalyticsFetchResult = Schema.Struct({
  observationIds: Schema.Array(ObservationId).check(Schema.isMaxLength(2)),
  status: Schema.Literals(["complete", "partial", "missing"]),
  requestedEndDate: ObservationCalendarDate,
  freshThroughDate: Schema.NullOr(ObservationCalendarDate),
  views: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  deduplicated: Schema.Boolean,
});
export type CommandCenterYouTubeAnalyticsFetchResult =
  typeof CommandCenterYouTubeAnalyticsFetchResult.Type;
