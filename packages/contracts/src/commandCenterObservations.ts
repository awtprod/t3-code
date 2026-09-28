import {
  ObservationData,
  ObservationDraft,
  ObservationId,
  ObservationIsoInstant,
  ObservationMutationId,
  ObservationRevisionId,
  ObservationSnapshot,
  SpaceId,
  TrimmedNonEmptyString,
} from "@command-center/core";
import * as Schema from "effect/Schema";

export const COMMAND_CENTER_OBSERVATION_BATCH_MAX_COUNT = 100;
export const COMMAND_CENTER_OBSERVATION_BATCH_MAX_BYTES = 256 * 1_024;
export const COMMAND_CENTER_OBSERVATION_LIST_MAX_LIMIT = 100;

const reason = TrimmedNonEmptyString.check(Schema.isMaxLength(2_048));
const version = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const manualObservation = ObservationDraft.check(
  Schema.makeFilter(
    (observation) =>
      observation.collectionMethod === "manual" ||
      "Public manual creation accepts only manual observations.",
  ),
);

const importedObservation = ObservationDraft.check(
  Schema.makeFilter(
    (observation) =>
      observation.collectionMethod === "imported" ||
      "Public batch import accepts only imported observations.",
  ),
);

export const CommandCenterObservationManualCreateRequest = Schema.Struct({
  mutationId: ObservationMutationId,
  expectedVersion: Schema.Literal(0),
  observation: manualObservation,
});
export type CommandCenterObservationManualCreateRequest =
  typeof CommandCenterObservationManualCreateRequest.Type;

export const CommandCenterObservationImportRequest = Schema.Struct({
  mutationId: ObservationMutationId,
  observations: Schema.Array(importedObservation).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(COMMAND_CENTER_OBSERVATION_BATCH_MAX_COUNT),
  ),
}).check(
  Schema.makeFilter(
    (request) =>
      new TextEncoder().encode(JSON.stringify(request)).byteLength <=
        COMMAND_CENTER_OBSERVATION_BATCH_MAX_BYTES ||
      `Observation imports may contain at most ${COMMAND_CENTER_OBSERVATION_BATCH_MAX_BYTES} UTF-8 bytes.`,
  ),
);
export type CommandCenterObservationImportRequest =
  typeof CommandCenterObservationImportRequest.Type;

export const CommandCenterObservationImportInput = Schema.Struct({
  spaceId: SpaceId,
  request: CommandCenterObservationImportRequest,
});
export type CommandCenterObservationImportInput = typeof CommandCenterObservationImportInput.Type;

export const CommandCenterObservationCorrectionRequest = Schema.Struct({
  mutationId: ObservationMutationId,
  spaceId: SpaceId,
  observationId: ObservationId,
  expectedVersion: version.check(Schema.isGreaterThanOrEqualTo(1)),
  reason,
  data: ObservationData,
});
export type CommandCenterObservationCorrectionRequest =
  typeof CommandCenterObservationCorrectionRequest.Type;

export const CommandCenterObservationRetirementRequest = Schema.Struct({
  mutationId: ObservationMutationId,
  spaceId: SpaceId,
  observationId: ObservationId,
  expectedVersion: version.check(Schema.isGreaterThanOrEqualTo(1)),
  reason,
});
export type CommandCenterObservationRetirementRequest =
  typeof CommandCenterObservationRetirementRequest.Type;

export const CommandCenterObservationGetRequest = Schema.Struct({
  spaceId: SpaceId,
  observationId: ObservationId,
});
export type CommandCenterObservationGetRequest = typeof CommandCenterObservationGetRequest.Type;

export const CommandCenterObservationListCursor = Schema.Struct({
  createdAt: ObservationIsoInstant,
  observationId: ObservationId,
});
export type CommandCenterObservationListCursor = typeof CommandCenterObservationListCursor.Type;

export const CommandCenterObservationListRequest = Schema.Struct({
  spaceId: SpaceId,
  limit: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: COMMAND_CENTER_OBSERVATION_LIST_MAX_LIMIT }),
  ),
  cursor: Schema.optional(CommandCenterObservationListCursor),
});
export type CommandCenterObservationListRequest = typeof CommandCenterObservationListRequest.Type;

export const CommandCenterObservationHistoryRequest = Schema.Struct({
  spaceId: SpaceId,
  observationId: ObservationId,
  limit: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: COMMAND_CENTER_OBSERVATION_LIST_MAX_LIMIT }),
  ),
  beforeVersion: Schema.optional(version.check(Schema.isGreaterThanOrEqualTo(1))),
});
export type CommandCenterObservationHistoryRequest =
  typeof CommandCenterObservationHistoryRequest.Type;

export const CommandCenterObservationMutationReceipt = Schema.Struct({
  observationId: ObservationId,
  revisionId: ObservationRevisionId,
  version: version.check(Schema.isGreaterThanOrEqualTo(1)),
  deduplicated: Schema.Boolean,
});
export type CommandCenterObservationMutationReceipt =
  typeof CommandCenterObservationMutationReceipt.Type;

export const CommandCenterObservationImportReceipt = Schema.Struct({
  observations: Schema.Array(CommandCenterObservationMutationReceipt).check(
    Schema.isMaxLength(COMMAND_CENTER_OBSERVATION_BATCH_MAX_COUNT),
  ),
});
export type CommandCenterObservationImportReceipt =
  typeof CommandCenterObservationImportReceipt.Type;

export const CommandCenterObservationListPage = Schema.Struct({
  observations: Schema.Array(ObservationSnapshot).check(
    Schema.isMaxLength(COMMAND_CENTER_OBSERVATION_LIST_MAX_LIMIT),
  ),
  nextCursor: Schema.NullOr(CommandCenterObservationListCursor),
});
export type CommandCenterObservationListPage = typeof CommandCenterObservationListPage.Type;

export const CommandCenterObservationHistoryPage = Schema.Array(ObservationSnapshot).check(
  Schema.isMaxLength(COMMAND_CENTER_OBSERVATION_LIST_MAX_LIMIT),
);
export type CommandCenterObservationHistoryPage = typeof CommandCenterObservationHistoryPage.Type;
