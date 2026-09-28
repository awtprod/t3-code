import { SpaceId, AutomationId, TrimmedNonEmptyString } from "@command-center/core";
import * as Schema from "effect/Schema";

const Limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }));
const Version = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const BoundedReason = TrimmedNonEmptyString.check(Schema.isMaxLength(500));
const BoundedText = Schema.String.check(Schema.isMaxLength(500));

export const CommandCenterResponsibilitiesListInput = Schema.Struct({
  spaceId: Schema.optionalKey(SpaceId),
  limit: Schema.optionalKey(Limit),
});
export type CommandCenterResponsibilitiesListInput =
  typeof CommandCenterResponsibilitiesListInput.Type;

export const CommandCenterResponsibilityGetInput = Schema.Struct({
  spaceId: SpaceId,
  automationId: AutomationId,
  historyLimit: Schema.optionalKey(Limit),
});
export type CommandCenterResponsibilityGetInput = typeof CommandCenterResponsibilityGetInput.Type;

export const CommandCenterResponsibilityPauseInput = Schema.Struct({
  spaceId: SpaceId,
  automationId: AutomationId,
  expectedVersion: Version,
  reason: Schema.optionalKey(BoundedReason),
});
export type CommandCenterResponsibilityPauseInput =
  typeof CommandCenterResponsibilityPauseInput.Type;

export class CommandCenterResponsibilityError extends Schema.TaggedErrorClass<CommandCenterResponsibilityError>()(
  "CommandCenterResponsibilityError",
  {
    code: Schema.Literals([
      "validation",
      "not-found",
      "conflict",
      "config-unavailable",
      "persistence",
    ]),
    message: Schema.String,
  },
) {}

export const CommandCenterResponsibilityResultReference = Schema.Struct({
  kind: Schema.Literal("artifact"),
  artifactId: TrimmedNonEmptyString,
  runId: TrimmedNonEmptyString,
  executionId: TrimmedNonEmptyString,
  spaceId: TrimmedNonEmptyString,
  automationId: TrimmedNonEmptyString,
});

export const CommandCenterResponsibilityIncident = Schema.Struct({
  id: TrimmedNonEmptyString,
  state: Schema.Literals(["transient", "blocked", "resolved"]),
  canonicalCode: TrimmedNonEmptyString,
  resource: Schema.String,
  subject: Schema.String,
  firstSeenAt: TrimmedNonEmptyString,
  lastSeenAt: TrimmedNonEmptyString,
  occurrenceCount: Version,
  latestExecutionId: Schema.NullOr(TrimmedNonEmptyString),
  retryAt: Schema.NullOr(TrimmedNonEmptyString),
  recoveryInstruction: Schema.String,
  displayError: BoundedText,
  resolvedAt: Schema.NullOr(TrimmedNonEmptyString),
});

export const CommandCenterResponsibilityHistoryEntry = Schema.Struct({
  executionId: TrimmedNonEmptyString,
  workIdentity: TrimmedNonEmptyString,
  state: TrimmedNonEmptyString,
  startedAt: TrimmedNonEmptyString,
  finishedAt: Schema.NullOr(TrimmedNonEmptyString),
  error: Schema.NullOr(BoundedText),
  usefulResultRef: Schema.NullOr(CommandCenterResponsibilityResultReference),
});

export const CommandCenterResponsibilityStatus = Schema.Struct({
  automationId: TrimmedNonEmptyString,
  spaceId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  purpose: TrimmedNonEmptyString,
  owner: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  watchedSources: Schema.Array(TrimmedNonEmptyString),
  authority: Schema.Null,
  limits: Schema.Null,
  authorityExplanation: Schema.String,
  limitsExplanation: Schema.String,
  paused: Schema.Boolean,
  pauseActor: Schema.NullOr(TrimmedNonEmptyString),
  pauseReason: Schema.NullOr(Schema.String),
  pauseVersion: Version,
  health: Schema.Literals(["paused", "blocked", "temporarily-failing", "healthy", "unknown"]),
  lastAdmissionAttemptAt: Schema.NullOr(TrimmedNonEmptyString),
  lastAdmissionStatus: Schema.NullOr(Schema.Literals(["admitted", "paused", "blocked"])),
  lastCheckedAt: Schema.NullOr(TrimmedNonEmptyString),
  lastCheckStatus: Schema.NullOr(Schema.Literals(["ok", "transient-error", "blocked", "paused"])),
  lastSuccessfulAt: Schema.NullOr(TrimmedNonEmptyString),
  lastUsefulResultAt: Schema.NullOr(TrimmedNonEmptyString),
  lastUsefulResultRef: Schema.NullOr(CommandCenterResponsibilityResultReference),
  currentExecutionId: Schema.NullOr(TrimmedNonEmptyString),
  nextScheduledAt: Schema.NullOr(TrimmedNonEmptyString),
  incidentId: Schema.NullOr(TrimmedNonEmptyString),
  incident: Schema.NullOr(CommandCenterResponsibilityIncident),
});
export type CommandCenterResponsibilityStatus = typeof CommandCenterResponsibilityStatus.Type;

export const CommandCenterResponsibilityDetail = Schema.Struct({
  ...CommandCenterResponsibilityStatus.fields,
  history: Schema.Array(CommandCenterResponsibilityHistoryEntry),
});
export type CommandCenterResponsibilityDetail = typeof CommandCenterResponsibilityDetail.Type;

export const CommandCenterResponsibilitiesListResult = Schema.Struct({
  responsibilities: Schema.Array(CommandCenterResponsibilityStatus),
});
