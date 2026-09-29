import { ItemId, SpaceId, Timestamp, TrimmedNonEmptyString } from "@command-center/core";
import * as Schema from "effect/Schema";

const Clock = Schema.String.check(Schema.isPattern(/^([01][0-9]|2[0-3]):[0-5][0-9]$/u));
const Version = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const DigestId = TrimmedNonEmptyString.check(Schema.isMaxLength(100));
const TimeZone = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export const CommandCenterDigestPreferences = Schema.Struct({
  timezone: TimeZone,
  quietStart: Schema.NullOr(Clock),
  quietEnd: Schema.NullOr(Clock),
  version: Version,
  source: Schema.Literals(["command-center-config", "personal"]),
});
export type CommandCenterDigestPreferences = typeof CommandCenterDigestPreferences.Type;

export const CommandCenterDigestItem = Schema.Struct({
  spaceId: SpaceId,
  itemId: ItemId,
  revisionId: Schema.NullOr(TrimmedNonEmptyString),
  itemVersion: Version,
  title: TrimmedNonEmptyString,
  kind: Schema.Literals(["decision", "approval", "alert", "task", "idea"]),
  status: Schema.Literals(["captured", "ready", "in_progress", "waiting", "review"]),
  updatedAt: Timestamp,
});
export type CommandCenterDigestItem = typeof CommandCenterDigestItem.Type;

export const CommandCenterDigestSnapshot = Schema.Struct({
  id: DigestId,
  recipientSubject: TrimmedNonEmptyString,
  localDate: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u)),
  timezone: TimeZone,
  periodStartAt: Timestamp,
  periodEndAt: Timestamp,
  generatedAt: Timestamp,
  contentDigest: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/u)),
  supersedesId: Schema.NullOr(DigestId),
  viewedAt: Schema.NullOr(Timestamp),
  items: Schema.Array(CommandCenterDigestItem).check(Schema.isMaxLength(100)),
});
export type CommandCenterDigestSnapshot = typeof CommandCenterDigestSnapshot.Type;

export const CommandCenterDigestQueryInput = Schema.Struct({});
export const CommandCenterDigestQueryResult = Schema.Struct({
  recipientSubject: TrimmedNonEmptyString,
  preferences: CommandCenterDigestPreferences,
  period: Schema.Struct({
    localDate: Schema.String,
    startAt: Timestamp,
    endAt: Timestamp,
  }),
  snapshot: Schema.NullOr(CommandCenterDigestSnapshot),
  /** Actionable changes in the period; the snapshot lists at most the first 100 of them. */
  totalCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** True when more actionable changes exist than the snapshot lists. */
  truncated: Schema.Boolean,
  notification: Schema.Literals(["available", "seen", "empty", "quiet-hours"]),
});
export type CommandCenterDigestQueryResult = typeof CommandCenterDigestQueryResult.Type;

export const CommandCenterDigestPreferencesUpdateInput = Schema.Struct({
  expectedVersion: Version,
  timezone: TimeZone,
  quietStart: Schema.NullOr(Clock),
  quietEnd: Schema.NullOr(Clock),
}).check(
  Schema.makeFilter(
    (value) =>
      ((value.quietStart === null) === (value.quietEnd === null) &&
        (value.quietStart === null || value.quietStart !== value.quietEnd)) ||
      "Quiet hours must have two distinct times or be off.",
  ),
);
export type CommandCenterDigestPreferencesUpdateInput =
  typeof CommandCenterDigestPreferencesUpdateInput.Type;

export const CommandCenterDigestMarkViewedInput = Schema.Struct({ snapshotId: DigestId });
export type CommandCenterDigestMarkViewedInput = typeof CommandCenterDigestMarkViewedInput.Type;
