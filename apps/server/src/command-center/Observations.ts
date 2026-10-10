import * as NodeCrypto from "node:crypto";

import {
  ObservationActor,
  ObservationDraft,
  ObservationSnapshot,
  type ObservationDraft as ObservationDraftType,
  type ObservationSnapshot as ObservationSnapshotType,
} from "@command-center/core";
import {
  CommandCenterObservationCorrectionRequest,
  CommandCenterObservationGetRequest,
  CommandCenterObservationHistoryRequest,
  CommandCenterObservationImportRequest,
  CommandCenterObservationListRequest,
  CommandCenterObservationManualCreateRequest,
  CommandCenterObservationMutationReceipt,
  CommandCenterObservationImportReceipt,
  CommandCenterObservationRetirementRequest,
  type CommandCenterObservationListPage,
} from "../../../../packages/contracts/src/commandCenterObservations.ts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { canonicalJson } from "./automation/Digest.ts";

const decodeDraft = Schema.decodeUnknownEffect(ObservationDraft);
const decodeSnapshot = Schema.decodeUnknownEffect(ObservationSnapshot);
const decodeActor = Schema.decodeUnknownEffect(ObservationActor);
const decodeManual = Schema.decodeUnknownEffect(CommandCenterObservationManualCreateRequest);
const decodeImport = Schema.decodeUnknownEffect(CommandCenterObservationImportRequest);
const decodeCorrection = Schema.decodeUnknownEffect(CommandCenterObservationCorrectionRequest);
const decodeRetirement = Schema.decodeUnknownEffect(CommandCenterObservationRetirementRequest);
const decodeGet = Schema.decodeUnknownEffect(CommandCenterObservationGetRequest);
const decodeList = Schema.decodeUnknownEffect(CommandCenterObservationListRequest);
const decodeHistory = Schema.decodeUnknownEffect(CommandCenterObservationHistoryRequest);
const decodeStoredDraft = Schema.decodeUnknownEffect(Schema.fromJsonString(ObservationDraft));
const decodeStoredReceipt = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Union([CommandCenterObservationMutationReceipt, CommandCenterObservationImportReceipt]),
  ),
);

export class ObservationError extends Schema.TaggedError<ObservationError>()("ObservationError", {
  reason: Schema.Literals(["validation", "not-found", "conflict", "persistence"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const failure = (reason: ObservationError["reason"], message: string, cause?: unknown) =>
  new ObservationError({ reason, message, ...(cause === undefined ? {} : { cause }) });
const validation = (cause: unknown) =>
  failure("validation", "The observation request is invalid.", cause);
const isObservationError = Schema.is(ObservationError);
const mapFailure = (cause: unknown) =>
  isObservationError(cause)
    ? cause
    : failure("persistence", "The observation could not be stored or read.", cause);
const digest = (value: unknown) =>
  `sha256:${NodeCrypto.createHash("sha256")
    .update(canonicalJson(value as Schema.Json))
    .digest("hex")}`;
const revisionId = (
  spaceId: string,
  observationId: string,
  version: number,
  revisionDigest: string,
) =>
  `observation-revision:${NodeCrypto.createHash("sha256")
    .update(`${spaceId}\n${observationId}\n${version}\n${revisionDigest}`)
    .digest("hex")}`;

interface ObservationRow {
  readonly spaceId: string;
  readonly id: string;
  readonly sourcePayloadDigest: string;
  readonly currentRevisionId: string | null;
  readonly currentVersion: number;
  readonly createdAt: string;
  readonly retiredAt: string | null;
}
interface RevisionRow {
  readonly revisionId: string;
  readonly version: number;
  readonly revisionKind: "created" | "corrected" | "retired";
  readonly revisionReason: string | null;
  readonly actorKind: "user" | "system" | "connector";
  readonly actorId: string;
  readonly snapshotJson: string;
  readonly revisionDigest: string;
  readonly revisedAt: string;
  readonly retired: number;
}

export interface ObservationServiceShape {
  readonly createManual: (
    request: unknown,
    serverActor: unknown,
  ) => Effect.Effect<CommandCenterObservationMutationReceipt, ObservationError>;
  readonly importBatch: (
    spaceId: string,
    request: unknown,
    serverActor: unknown,
  ) => Effect.Effect<CommandCenterObservationImportReceipt, ObservationError>;
  /** Internal connector boundary; never expose through a public RPC. */
  readonly ingestConnected: (
    observation: unknown,
    mutationId: string,
    serverActor: unknown,
  ) => Effect.Effect<CommandCenterObservationMutationReceipt, ObservationError>;
  readonly correct: (
    request: unknown,
    serverActor: unknown,
  ) => Effect.Effect<CommandCenterObservationMutationReceipt, ObservationError>;
  readonly retire: (
    request: unknown,
    serverActor: unknown,
  ) => Effect.Effect<CommandCenterObservationMutationReceipt, ObservationError>;
  readonly get: (request: unknown) => Effect.Effect<ObservationSnapshotType, ObservationError>;
  readonly list: (
    request: unknown,
  ) => Effect.Effect<CommandCenterObservationListPage, ObservationError>;
  readonly history: (
    request: unknown,
  ) => Effect.Effect<ReadonlyArray<ObservationSnapshotType>, ObservationError>;
}
export class ObservationService extends Context.Service<
  ObservationService,
  ObservationServiceShape
>()("@awtprod/command-center/command-center/Observations/ObservationService") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = () => DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const requireSpace = Effect.fn("Observations.requireSpace")(function* (spaceId: string) {
    const rows = yield* sql<{ readonly id: string }>`
      SELECT id FROM command_center_spaces WHERE id = ${spaceId} AND lifecycle = 'active' LIMIT 1
    `;
    if (rows.length === 0) return yield* failure("not-found", "The Space was not found.");
  });

  const readObservation = Effect.fn("Observations.readObservation")(function* (
    spaceId: string,
    id: string,
  ) {
    const rows = yield* sql<ObservationRow>`
        SELECT space_id AS "spaceId", id, source_payload_digest AS "sourcePayloadDigest",
          current_revision_id AS "currentRevisionId", current_version AS "currentVersion",
          created_at AS "createdAt", retired_at AS "retiredAt"
        FROM command_center_observations WHERE space_id = ${spaceId} AND id = ${id} LIMIT 1
      `;
    return rows[0];
  });

  const readRevision = Effect.fn("Observations.readRevision")(function* (revision: string) {
    const rows = yield* sql<RevisionRow>`
        SELECT revision_id AS "revisionId", version, revision_kind AS "revisionKind",
          revision_reason AS "revisionReason", actor_kind AS "actorKind", actor_id AS "actorId",
          snapshot_json AS "snapshotJson", revision_digest AS "revisionDigest",
          revised_at AS "revisedAt", retired
        FROM command_center_observation_revisions WHERE revision_id = ${revision} LIMIT 1
      `;
    return rows[0];
  });

  const snapshot = Effect.fn("Observations.snapshot")(function* (
    row: ObservationRow,
    revision: RevisionRow,
  ) {
    const observation = yield* decodeStoredDraft(revision.snapshotJson).pipe(
      Effect.mapError((cause) =>
        failure("persistence", "Stored observation revision is invalid.", cause),
      ),
    );
    const conflict = yield* sql<{ readonly id: string }>`
        SELECT other.id
        FROM command_center_observations other
        JOIN command_center_observation_revisions other_revision
          ON other_revision.revision_id = other.current_revision_id
        WHERE other.space_id = ${row.spaceId}
          AND other.id != ${row.id}
          AND other.retired_at IS NULL
          AND other.subject_id = ${observation.subjectId}
          AND other.metric_kind = ${observation.metric.kind}
          AND other.content_kind = ${observation.contentKind}
          AND COALESCE(other.channel_id, '') = ${observation.channelId ?? ""}
          AND COALESCE(other.cohort_id, '') = ${observation.cohortId ?? ""}
          AND COALESCE(other.content_id, '') = ${observation.contentId ?? ""}
          AND other.collection_method != ${observation.collectionMethod}
          AND json_extract(other_revision.snapshot_json, '$.data.period.start') = ${observation.data.period.start}
          AND json_extract(other_revision.snapshot_json, '$.data.period.end') = ${observation.data.period.end}
        LIMIT 1
      `;
    return yield* decodeSnapshot({
      observation,
      revisionId: revision.revisionId,
      version: revision.version,
      revisionDigest: revision.revisionDigest,
      revisionKind: revision.revisionKind,
      revisionReason: revision.revisionReason,
      actor: { kind: revision.actorKind, id: revision.actorId },
      revisedAt: revision.revisedAt,
      retired: revision.retired === 1,
      hasCollectionConflict: conflict.length > 0,
    }).pipe(
      Effect.mapError((cause) => failure("persistence", "Stored observation is invalid.", cause)),
    );
  });

  const getCurrent = Effect.fn("Observations.getCurrent")(function* (
    spaceId: string,
    observationId: string,
  ) {
    const row = yield* readObservation(spaceId, observationId);
    if (row?.currentRevisionId === null || row === undefined) {
      return yield* failure("not-found", "The observation was not found in this Space.");
    }
    const revision = yield* readRevision(row.currentRevisionId);
    if (revision === undefined) {
      return yield* failure("persistence", "The observation revision is missing.");
    }
    return yield* snapshot(row, revision);
  });

  const previousMutation = Effect.fn("Observations.previousMutation")(function* (
    spaceId: string,
    mutationId: string,
    requestDigest: string,
  ) {
    const rows = yield* sql<{ readonly requestDigest: string; readonly resultJson: string }>`
        SELECT request_digest AS "requestDigest", result_json AS "resultJson"
        FROM command_center_observation_mutations
        WHERE space_id = ${spaceId} AND mutation_id = ${mutationId} LIMIT 1
      `;
    const row = rows[0];
    if (row === undefined) return undefined;
    if (row.requestDigest !== requestDigest) {
      return yield* failure("conflict", "The mutation ID is already bound to another request.");
    }
    return yield* decodeStoredReceipt(row.resultJson).pipe(
      Effect.mapError((cause) =>
        failure("persistence", "Stored mutation receipt is invalid.", cause),
      ),
    );
  });

  const saveMutation = Effect.fn("Observations.saveMutation")(function* (
    spaceId: string,
    mutationId: string,
    requestDigest: string,
    result: unknown,
    at: string,
  ) {
    yield* sql`
        INSERT INTO command_center_observation_mutations (
          space_id, mutation_id, request_digest, result_json, created_at
        ) VALUES (${spaceId}, ${mutationId}, ${requestDigest}, ${canonicalJson(result as Schema.Json)}, ${at})
      `;
  });

  const createOne = Effect.fn("Observations.createOne")(function* (
    observation: ObservationDraftType,
    actor: ObservationActor,
    at: string,
  ) {
    const payloadDigest = digest(observation);
    const bySource = yield* sql<ObservationRow>`
        SELECT space_id AS "spaceId", id, source_payload_digest AS "sourcePayloadDigest",
          current_revision_id AS "currentRevisionId", current_version AS "currentVersion",
          created_at AS "createdAt", retired_at AS "retiredAt"
        FROM command_center_observations
        WHERE space_id = ${observation.spaceId}
          AND source_identity = ${observation.source.identity}
          AND source_revision = ${observation.source.revision}
        LIMIT 1
      `;
    const existingSource = bySource[0];
    if (existingSource !== undefined) {
      if (existingSource.sourcePayloadDigest !== payloadDigest) {
        return yield* failure(
          "conflict",
          "The source identity and revision contain different data.",
        );
      }
      if (existingSource.currentRevisionId === null) {
        return yield* failure("persistence", "The source observation has no revision.");
      }
      return {
        observationId: existingSource.id,
        revisionId: existingSource.currentRevisionId,
        version: existingSource.currentVersion,
        deduplicated: true,
      } as CommandCenterObservationMutationReceipt;
    }
    if ((yield* readObservation(observation.spaceId, observation.id)) !== undefined) {
      return yield* failure("conflict", "The observation ID is already used in this Space.");
    }
    const revisionDigest = digest({ observation, version: 1, kind: "created" });
    const newRevisionId = revisionId(observation.spaceId, observation.id, 1, revisionDigest);
    yield* sql`
        INSERT INTO command_center_observations (
          space_id, id, responsibility_id, plan_id, subject_id, content_id, channel_id,
          cohort_id, content_kind, source_identity, source_revision, source_payload_digest,
          metric_kind, metric_unit, metric_definition, collection_method, current_revision_id,
          current_version, created_at
        ) VALUES (
          ${observation.spaceId}, ${observation.id}, ${observation.responsibilityId ?? null},
          ${observation.planId ?? null}, ${observation.subjectId}, ${observation.contentId ?? null},
          ${observation.channelId ?? null}, ${observation.cohortId ?? null}, ${observation.contentKind},
          ${observation.source.identity}, ${observation.source.revision}, ${payloadDigest},
          ${observation.metric.kind}, ${observation.metric.unit}, ${observation.metric.definition},
          ${observation.collectionMethod}, ${newRevisionId}, 1, ${at}
        )
      `;
    yield* sql`
        INSERT INTO command_center_observation_revisions (
          revision_id, space_id, observation_id, version, revision_kind, revision_reason,
          actor_kind, actor_id, snapshot_json, revision_digest, revised_at, retired
        ) VALUES (
          ${newRevisionId}, ${observation.spaceId}, ${observation.id}, 1, 'created', NULL,
          ${actor.kind}, ${actor.id}, ${canonicalJson(observation as unknown as Schema.Json)}, ${revisionDigest}, ${at}, 0
        )
      `;
    return {
      observationId: observation.id,
      revisionId: newRevisionId,
      version: 1,
      deduplicated: false,
    } as CommandCenterObservationMutationReceipt;
  });

  const createManual: ObservationServiceShape["createManual"] = (raw, actorRaw) =>
    Effect.gen(function* () {
      const request = yield* decodeManual(raw).pipe(Effect.mapError(validation));
      const actor = yield* decodeActor(actorRaw).pipe(Effect.mapError(validation));
      if (actor.kind !== "user")
        return yield* failure("validation", "Manual entry requires a user actor.");
      const spaceId = request.observation.spaceId;
      yield* requireSpace(spaceId);
      const requestDigest = digest({ request, actor });
      const at = yield* now();
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const previous = yield* previousMutation(spaceId, request.mutationId, requestDigest);
          if (previous !== undefined) {
            return { ...(previous as CommandCenterObservationMutationReceipt), deduplicated: true };
          }
          const result = yield* createOne(request.observation, actor, at);
          yield* saveMutation(spaceId, request.mutationId, requestDigest, result, at);
          return result;
        }),
      );
    }).pipe(Effect.mapError(mapFailure));

  const importBatch: ObservationServiceShape["importBatch"] = (spaceId, raw, actorRaw) =>
    Effect.gen(function* () {
      const request = yield* decodeImport(raw).pipe(Effect.mapError(validation));
      const actor = yield* decodeActor(actorRaw).pipe(Effect.mapError(validation));
      if (actor.kind !== "user" && actor.kind !== "system") {
        return yield* failure("validation", "Import requires an authorized server actor.");
      }
      yield* requireSpace(spaceId);
      if (request.observations.some((observation) => observation.spaceId !== spaceId)) {
        return yield* failure("validation", "All imported observations must belong to one Space.");
      }
      const requestDigest = digest({ request, actor });
      const at = yield* now();
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const previous = yield* previousMutation(spaceId, request.mutationId, requestDigest);
          if (previous !== undefined) {
            return {
              observations: (previous as CommandCenterObservationImportReceipt).observations.map(
                (item) => ({
                  ...item,
                  deduplicated: true,
                }),
              ),
            };
          }
          const observations = yield* Effect.forEach(
            request.observations,
            (observation) => createOne(observation, actor, at),
            { concurrency: 1 },
          );
          const result = { observations };
          yield* saveMutation(spaceId, request.mutationId, requestDigest, result, at);
          return result;
        }),
      );
    }).pipe(Effect.mapError(mapFailure));

  const ingestConnected: ObservationServiceShape["ingestConnected"] = (raw, mutationId, actorRaw) =>
    Effect.gen(function* () {
      const observation = yield* decodeDraft(raw).pipe(Effect.mapError(validation));
      const actor = yield* decodeActor(actorRaw).pipe(Effect.mapError(validation));
      if (observation.collectionMethod !== "connected" || actor.kind !== "connector") {
        return yield* failure(
          "validation",
          "Connected ingestion requires a connector actor and source.",
        );
      }
      if (mutationId.length === 0 || mutationId.length > 256) {
        return yield* failure("validation", "The mutation ID is invalid.");
      }
      yield* requireSpace(observation.spaceId);
      const requestDigest = digest({ observation, mutationId, actor });
      const at = yield* now();
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const previous = yield* previousMutation(observation.spaceId, mutationId, requestDigest);
          if (previous !== undefined) {
            return { ...(previous as CommandCenterObservationMutationReceipt), deduplicated: true };
          }
          const result = yield* createOne(observation, actor, at);
          yield* saveMutation(observation.spaceId, mutationId, requestDigest, result, at);
          return result;
        }),
      );
    }).pipe(Effect.mapError(mapFailure));

  const amend = Effect.fn("Observations.amend")(function* (
    raw: unknown,
    actorRaw: unknown,
    retire: boolean,
  ) {
    const request = retire
      ? yield* decodeRetirement(raw).pipe(Effect.mapError(validation))
      : yield* decodeCorrection(raw).pipe(Effect.mapError(validation));
    const actor = yield* decodeActor(actorRaw).pipe(Effect.mapError(validation));
    if (actor.kind !== "user")
      return yield* failure("validation", "Only a user can correct or retire an observation.");
    yield* requireSpace(request.spaceId);
    const requestDigest = digest({ request, actor });
    const at = yield* now();
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const previous = yield* previousMutation(
          request.spaceId,
          request.mutationId,
          requestDigest,
        );
        if (previous !== undefined) {
          return { ...(previous as CommandCenterObservationMutationReceipt), deduplicated: true };
        }
        const current = yield* getCurrent(request.spaceId, request.observationId);
        if (current.retired) return yield* failure("conflict", "The observation is retired.");
        if (current.version !== request.expectedVersion) {
          return yield* failure(
            "conflict",
            "The observation changed; reload its current revision.",
          );
        }
        const observation = retire
          ? current.observation
          : yield* decodeDraft({
              ...current.observation,
              data: (request as CommandCenterObservationCorrectionRequest).data,
            }).pipe(Effect.mapError(validation));
        const version = current.version + 1;
        const revisionDigest = digest({
          observation,
          version,
          kind: retire ? "retired" : "corrected",
          reason: request.reason,
        });
        const newRevisionId = revisionId(
          request.spaceId,
          request.observationId,
          version,
          revisionDigest,
        );
        yield* sql`
          INSERT INTO command_center_observation_revisions (
            revision_id, space_id, observation_id, version, revision_kind, revision_reason,
            actor_kind, actor_id, snapshot_json, revision_digest, revised_at, retired
          ) VALUES (
            ${newRevisionId}, ${request.spaceId}, ${request.observationId}, ${version},
            ${retire ? "retired" : "corrected"}, ${request.reason}, ${actor.kind}, ${actor.id},
            ${canonicalJson(observation as unknown as Schema.Json)}, ${revisionDigest}, ${at}, ${retire ? 1 : 0}
          )
        `;
        const updated = yield* sql<{ readonly id: string }>`
          UPDATE command_center_observations
          SET current_revision_id = ${newRevisionId}, current_version = ${version},
            retired_at = ${retire ? at : null}
          WHERE space_id = ${request.spaceId} AND id = ${request.observationId}
            AND current_version = ${current.version} AND retired_at IS NULL
          RETURNING id
        `;
        if (updated.length === 0) return yield* failure("conflict", "The observation changed.");
        const result = {
          observationId: request.observationId,
          revisionId: newRevisionId,
          version,
          deduplicated: false,
        } as CommandCenterObservationMutationReceipt;
        yield* saveMutation(request.spaceId, request.mutationId, requestDigest, result, at);
        return result;
      }),
    );
  });

  const correct: ObservationServiceShape["correct"] = (request, actor) =>
    amend(request, actor, false).pipe(Effect.mapError(mapFailure));
  const retire: ObservationServiceShape["retire"] = (request, actor) =>
    amend(request, actor, true).pipe(Effect.mapError(mapFailure));
  const get: ObservationServiceShape["get"] = (raw) =>
    Effect.gen(function* () {
      const request = yield* decodeGet(raw).pipe(Effect.mapError(validation));
      yield* requireSpace(request.spaceId);
      return yield* getCurrent(request.spaceId, request.observationId);
    }).pipe(Effect.mapError(mapFailure));
  const list: ObservationServiceShape["list"] = (raw) =>
    Effect.gen(function* () {
      const request = yield* decodeList(raw).pipe(Effect.mapError(validation));
      yield* requireSpace(request.spaceId);
      const cursor = request.cursor;
      const rows = yield* sql<ObservationRow>`
        SELECT space_id AS "spaceId", id, source_payload_digest AS "sourcePayloadDigest",
          current_revision_id AS "currentRevisionId", current_version AS "currentVersion",
          created_at AS "createdAt", retired_at AS "retiredAt"
        FROM command_center_observations
        WHERE space_id = ${request.spaceId}
          AND (${cursor?.createdAt ?? null} IS NULL OR created_at < ${cursor?.createdAt ?? null}
            OR (created_at = ${cursor?.createdAt ?? null} AND id < ${cursor?.observationId ?? null}))
        ORDER BY created_at DESC, id DESC
        LIMIT ${request.limit + 1}
      `;
      const page = rows.slice(0, request.limit);
      const observations = yield* Effect.forEach(page, (row) => getCurrent(row.spaceId, row.id));
      return {
        observations,
        nextCursor:
          rows.length > request.limit && page.at(-1) !== undefined
            ? { createdAt: page.at(-1)!.createdAt, observationId: page.at(-1)!.id }
            : null,
      } as CommandCenterObservationListPage;
    }).pipe(Effect.mapError(mapFailure));
  const history: ObservationServiceShape["history"] = (raw) =>
    Effect.gen(function* () {
      const request = yield* decodeHistory(raw).pipe(Effect.mapError(validation));
      yield* requireSpace(request.spaceId);
      const row = yield* readObservation(request.spaceId, request.observationId);
      if (row === undefined)
        return yield* failure("not-found", "The observation was not found in this Space.");
      const revisions = yield* sql<RevisionRow>`
        SELECT revision_id AS "revisionId", version, revision_kind AS "revisionKind",
          revision_reason AS "revisionReason", actor_kind AS "actorKind", actor_id AS "actorId",
          snapshot_json AS "snapshotJson", revision_digest AS "revisionDigest",
          revised_at AS "revisedAt", retired
        FROM command_center_observation_revisions
        WHERE space_id = ${request.spaceId} AND observation_id = ${request.observationId}
          AND (${request.beforeVersion ?? null} IS NULL OR version < ${request.beforeVersion ?? null})
        ORDER BY version DESC LIMIT ${request.limit}
      `;
      return yield* Effect.forEach(revisions, (revision) => snapshot(row, revision));
    }).pipe(Effect.mapError(mapFailure));

  return ObservationService.of({
    createManual,
    importBatch,
    ingestConnected,
    correct,
    retire,
    get,
    list,
    history,
  });
});

export const layer = Layer.effect(ObservationService, make);
