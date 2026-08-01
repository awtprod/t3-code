import {
  COMMAND_CENTER_EVENT_ACTIONS,
  CommandCenterApprovalChangedPayload,
  CommandCenterArtifactChangedPayload,
  CommandCenterAutomationRunChangedPayload,
  CommandCenterCommandSubmitInput,
  CommandCenterEventEnvelope,
  type CommandCenterEventEnvelope as CommandCenterEventEnvelopeType,
  type CommandCenterEventPage,
  type CommandCenterEventReplayInput,
  type CommandCenterEventSubscribeInput,
  CommandCenterEventStreamError,
  CommandCenterFailurePayload,
  CommandCenterItemChangedPayload,
  CommandCenterMemoryChangedPayload,
  CommandCenterRouteSelectedPayload,
  CommandCenterRunStateChangedPayload,
  CommandCenterTimelineEntry,
  type CommandCenterTimelinePage,
  type CommandCenterTimelineQuery,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { Artifact, RouteDecision } from "@command-center/core";

import { commandCenterAuditHashDocument, type CommandCenterAuditHashVersion } from "./AuditLog.ts";

const DEFAULT_REPLAY_LIMIT = 200;
const MAX_REPLAY_LIMIT = 500;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MIN_POLL_INTERVAL_MS = 100;
const MAX_POLL_INTERVAL_MS = 30_000;

interface AuditRow {
  readonly sequence: number;
  readonly eventId: string;
  readonly hashVersion: number;
  readonly previousHash: string | null;
  readonly eventHash: string;
  readonly actorKind: string;
  readonly action: string;
  readonly spaceId: string | null;
  readonly runId: string | null;
  readonly payloadJson: string;
  readonly occurredAt: string;
}

interface TimelineRow {
  readonly sequence: number;
  readonly runId: string;
  readonly commandId: string;
  readonly spaceId: string;
  readonly projectId: string | null;
  readonly threadId: string | null;
  readonly status: string;
  readonly routeJson: string;
  readonly inputJson: string;
  readonly responseText: string | null;
  readonly responseCreatedAt: string | null;
  readonly error: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

interface TimelineArtifactRow {
  readonly id: string;
  readonly spaceId: string;
  readonly runId: string;
  readonly kind: string;
  readonly title: string;
  readonly uri: string | null;
  readonly contentDigest: string;
  readonly provenanceJson: string;
  readonly metadataJson: string;
  readonly createdAt: string;
}

const ApprovalDecisionAuditPayload = Schema.Struct({
  approvalId: Schema.String,
  decision: Schema.Literals(["approved", "declined"]),
  payloadDigest: Schema.String,
});

const ApprovalExpiredAuditPayload = Schema.Struct({
  approvalId: Schema.String,
  payloadDigest: Schema.String,
});

const ItemCreatedAuditPayload = Schema.Struct({
  itemId: Schema.String,
  kind: Schema.String,
});

const MemoryAuditPayload = Schema.Struct({
  memoryId: Schema.String,
  kind: Schema.String,
  status: Schema.String,
});

const decodeUnknownJsonString = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const decodeEventEnvelope = Schema.decodeUnknownEffect(CommandCenterEventEnvelope);
const decodeRoutePayload = Schema.decodeUnknownEffect(CommandCenterRouteSelectedPayload);
const decodeRunStatePayload = Schema.decodeUnknownEffect(CommandCenterRunStateChangedPayload);
const decodeApprovalPayload = Schema.decodeUnknownEffect(CommandCenterApprovalChangedPayload);
const decodeArtifactPayload = Schema.decodeUnknownEffect(CommandCenterArtifactChangedPayload);
const decodeItemPayload = Schema.decodeUnknownEffect(CommandCenterItemChangedPayload);
const decodeMemoryPayload = Schema.decodeUnknownEffect(CommandCenterMemoryChangedPayload);
const decodeFailurePayload = Schema.decodeUnknownEffect(CommandCenterFailurePayload);
const decodeAutomationRunPayload = Schema.decodeUnknownEffect(
  CommandCenterAutomationRunChangedPayload,
);
const decodeApprovalDecision = Schema.decodeUnknownEffect(ApprovalDecisionAuditPayload);
const decodeApprovalExpired = Schema.decodeUnknownEffect(ApprovalExpiredAuditPayload);
const decodeItemCreated = Schema.decodeUnknownEffect(ItemCreatedAuditPayload);
const decodeMemoryAudit = Schema.decodeUnknownEffect(MemoryAuditPayload);
const decodeRoute = Schema.decodeUnknownEffect(RouteDecision);
const decodeArtifact = Schema.decodeUnknownEffect(Artifact);
const decodeCommand = Schema.decodeUnknownEffect(CommandCenterCommandSubmitInput);
const decodeTimelineEntry = Schema.decodeUnknownEffect(CommandCenterTimelineEntry);

const eventStreamError = (
  reason: CommandCenterEventStreamError["reason"],
  message: string,
  sequence?: number,
  cause?: unknown,
) =>
  new CommandCenterEventStreamError({
    reason,
    message,
    ...(sequence === undefined ? {} : { sequence }),
    ...(cause === undefined ? {} : { cause }),
  });

const decodeAtSequence = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  sequence: number,
  description: string,
): Effect.Effect<A, CommandCenterEventStreamError, R> =>
  effect.pipe(
    Effect.mapError((cause) =>
      eventStreamError("decode", `Could not decode ${description}.`, sequence, cause),
    ),
  );

const clampInteger = (
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) => Math.min(maximum, Math.max(minimum, Math.floor(value ?? fallback)));

const toEnvelope = Effect.fn("CommandCenterEventStream.toEnvelope")(function* (
  row: AuditRow,
  payload: unknown,
) {
  const common = {
    sequence: row.sequence,
    eventId: row.eventId,
    previousHash: row.previousHash,
    eventHash: row.eventHash,
    actorKind: row.actorKind,
    spaceId: row.spaceId,
    runId: row.runId,
    occurredAt: row.occurredAt,
  };

  switch (row.action) {
    case COMMAND_CENTER_EVENT_ACTIONS.routeSelected:
    case "cc.routes.selected":
      return yield* decodeAtSequence(
        decodeEventEnvelope({
          _tag: "RouteSelected",
          ...common,
          payload: yield* decodeAtSequence(
            decodeRoutePayload(payload),
            row.sequence,
            "route-selected payload",
          ),
        }),
        row.sequence,
        "route-selected event",
      );
    case COMMAND_CENTER_EVENT_ACTIONS.runStateChanged:
      return yield* decodeAtSequence(
        decodeEventEnvelope({
          _tag: "RunStateChanged",
          ...common,
          payload: yield* decodeAtSequence(
            decodeRunStatePayload(payload),
            row.sequence,
            "Run state payload",
          ),
        }),
        row.sequence,
        "Run state event",
      );
    case COMMAND_CENTER_EVENT_ACTIONS.approvalChanged:
      return yield* decodeAtSequence(
        decodeEventEnvelope({
          _tag: "ApprovalChanged",
          ...common,
          payload: yield* decodeAtSequence(
            decodeApprovalPayload(payload),
            row.sequence,
            "Approval payload",
          ),
        }),
        row.sequence,
        "Approval event",
      );
    case "cc.approvals.decide": {
      const decision = yield* decodeAtSequence(
        decodeApprovalDecision(payload),
        row.sequence,
        "Approval decision payload",
      );
      return yield* decodeAtSequence(
        decodeEventEnvelope({
          _tag: "ApprovalChanged",
          ...common,
          payload: {
            approvalId: decision.approvalId,
            status: decision.decision,
            payloadDigest: decision.payloadDigest,
          },
        }),
        row.sequence,
        "Approval decision event",
      );
    }
    case "cc.approvals.expire": {
      const expired = yield* decodeAtSequence(
        decodeApprovalExpired(payload),
        row.sequence,
        "expired Approval payload",
      );
      return yield* decodeAtSequence(
        decodeEventEnvelope({
          _tag: "ApprovalChanged",
          ...common,
          payload: { ...expired, status: "expired" },
        }),
        row.sequence,
        "expired Approval event",
      );
    }
    case COMMAND_CENTER_EVENT_ACTIONS.artifactChanged:
      return yield* decodeAtSequence(
        decodeEventEnvelope({
          _tag: "ArtifactChanged",
          ...common,
          payload: yield* decodeAtSequence(
            decodeArtifactPayload(payload),
            row.sequence,
            "Artifact payload",
          ),
        }),
        row.sequence,
        "Artifact event",
      );
    case COMMAND_CENTER_EVENT_ACTIONS.itemChanged:
      return yield* decodeAtSequence(
        decodeEventEnvelope({
          _tag: "ItemChanged",
          ...common,
          payload: yield* decodeAtSequence(
            decodeItemPayload(payload),
            row.sequence,
            "Item payload",
          ),
        }),
        row.sequence,
        "Item event",
      );
    case "cc.items.create": {
      const created = yield* decodeAtSequence(
        decodeItemCreated(payload),
        row.sequence,
        "created Item payload",
      );
      return yield* decodeAtSequence(
        decodeEventEnvelope({
          _tag: "ItemChanged",
          ...common,
          payload: { ...created, change: "created", status: "captured" },
        }),
        row.sequence,
        "created Item event",
      );
    }
    case COMMAND_CENTER_EVENT_ACTIONS.memoryChanged:
      return yield* decodeAtSequence(
        decodeEventEnvelope({
          _tag: "MemoryChanged",
          ...common,
          payload: yield* decodeAtSequence(
            decodeMemoryPayload(payload),
            row.sequence,
            "Memory payload",
          ),
        }),
        row.sequence,
        "Memory event",
      );
    case "cc.memory.remember":
    case "cc.memory.propose": {
      const memory = yield* decodeAtSequence(
        decodeMemoryAudit(payload),
        row.sequence,
        "Memory audit payload",
      );
      return yield* decodeAtSequence(
        decodeEventEnvelope({
          _tag: "MemoryChanged",
          ...common,
          payload: {
            ...memory,
            change: row.action === "cc.memory.remember" ? "remembered" : "proposed",
          },
        }),
        row.sequence,
        "Memory event",
      );
    }
    case COMMAND_CENTER_EVENT_ACTIONS.failureRecorded:
      return yield* decodeAtSequence(
        decodeEventEnvelope({
          _tag: "CommandCenterFailure",
          ...common,
          payload: yield* decodeAtSequence(
            decodeFailurePayload(payload),
            row.sequence,
            "failure payload",
          ),
        }),
        row.sequence,
        "failure event",
      );
    case COMMAND_CENTER_EVENT_ACTIONS.automationRunChanged:
      return yield* decodeAtSequence(
        decodeEventEnvelope({
          _tag: "AutomationRunChanged",
          ...common,
          payload: yield* decodeAtSequence(
            decodeAutomationRunPayload(payload),
            row.sequence,
            "automation execution payload",
          ),
        }),
        row.sequence,
        "automation execution event",
      );
    default:
      return yield* decodeAtSequence(
        decodeEventEnvelope({
          _tag: "AuditRecorded",
          ...common,
          action: row.action,
          payload,
        }),
        row.sequence,
        "audit event",
      );
  }
});

export interface CommandCenterEventStreamShape {
  readonly replay: (
    input: CommandCenterEventReplayInput,
  ) => Effect.Effect<CommandCenterEventPage, CommandCenterEventStreamError>;
  readonly changes: (
    input: CommandCenterEventSubscribeInput,
  ) => Stream.Stream<CommandCenterEventEnvelopeType, CommandCenterEventStreamError>;
  readonly timeline: (
    input: CommandCenterTimelineQuery,
  ) => Effect.Effect<CommandCenterTimelinePage, CommandCenterEventStreamError>;
}

export class CommandCenterEventStream extends Context.Service<
  CommandCenterEventStream,
  CommandCenterEventStreamShape
>()("@awtprod/command-center/command-center/EventStream/CommandCenterEventStream") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const textEncoder = new TextEncoder();

  const readRows = (afterSequence: number, limit: number) =>
    sql<AuditRow>`
      SELECT sequence, event_id AS "eventId", hash_version AS "hashVersion",
        previous_hash AS "previousHash",
        event_hash AS "eventHash", actor_kind AS "actorKind", action,
        space_id AS "spaceId", run_id AS "runId", payload_json AS "payloadJson",
        occurred_at AS "occurredAt"
      FROM command_center_audit_events
      WHERE sequence > ${afterSequence}
      ORDER BY sequence ASC
      LIMIT ${limit}
    `.pipe(
      Effect.mapError((cause) =>
        eventStreamError("query", "Could not read Command Center audit events.", undefined, cause),
      ),
    );

  const readPredecessorHash = (sequence: number) =>
    sql<{ readonly eventHash: string }>`
      SELECT event_hash AS "eventHash"
      FROM command_center_audit_events
      WHERE sequence <= ${sequence}
      ORDER BY sequence DESC
      LIMIT 1
    `.pipe(
      Effect.mapError((cause) =>
        eventStreamError("query", "Could not read the audit cursor predecessor.", undefined, cause),
      ),
    );

  const verifyAndDecode = Effect.fn("CommandCenterEventStream.verifyAndDecode")(function* (
    row: AuditRow,
    expectedPreviousHash: string | null,
  ) {
    if (row.previousHash !== expectedPreviousHash) {
      return yield* eventStreamError(
        "hash-chain",
        "The Command Center audit chain is discontinuous.",
        row.sequence,
      );
    }
    if (row.hashVersion !== 1 && row.hashVersion !== 2) {
      return yield* eventStreamError(
        "hash-mismatch",
        "The Command Center audit event uses an unsupported digest version.",
        row.sequence,
      );
    }
    const payload = yield* decodeUnknownJsonString(row.payloadJson).pipe(
      Effect.mapError((cause) =>
        eventStreamError("decode", "Could not decode the audit payload.", row.sequence, cause),
      ),
    );
    const calculatedHash = Encoding.encodeHex(
      yield* crypto
        .digest(
          "SHA-256",
          textEncoder.encode(
            commandCenterAuditHashDocument({
              hashVersion: row.hashVersion as CommandCenterAuditHashVersion,
              eventId: row.eventId,
              previousHash: row.previousHash,
              actorKind: row.actorKind,
              action: row.action,
              ...(row.spaceId === null ? {} : { spaceId: row.spaceId }),
              ...(row.runId === null ? {} : { runId: row.runId }),
              payload,
              occurredAt: row.occurredAt,
            }),
          ),
        )
        .pipe(
          Effect.mapError((cause) =>
            eventStreamError(
              "hash-mismatch",
              "Could not calculate the Command Center audit event digest.",
              row.sequence,
              cause,
            ),
          ),
        ),
    );
    if (calculatedHash !== row.eventHash) {
      return yield* eventStreamError(
        "hash-mismatch",
        "The Command Center audit event digest does not match its contents.",
        row.sequence,
      );
    }
    return yield* toEnvelope(row, payload);
  });

  const replay: CommandCenterEventStreamShape["replay"] = (input) =>
    Effect.gen(function* () {
      const limit = clampInteger(input.limit, DEFAULT_REPLAY_LIMIT, 1, MAX_REPLAY_LIMIT);
      const [predecessor, rows, activeSpaces] = yield* Effect.all(
        [
          readPredecessorHash(input.afterSequence),
          readRows(input.afterSequence, limit),
          sql<{ readonly id: string }>`
            SELECT id FROM command_center_spaces WHERE lifecycle = 'active'
          `.pipe(
            Effect.mapError((cause) =>
              eventStreamError(
                "query",
                "Could not verify active Command Center Spaces.",
                undefined,
                cause,
              ),
            ),
          ),
        ],
        { concurrency: 2 },
      );
      const activeSpaceIds = new Set(activeSpaces.map(({ id }) => id));
      let expectedPreviousHash = predecessor[0]?.eventHash ?? null;
      const events: Array<CommandCenterEventEnvelopeType> = [];
      for (const row of rows) {
        const event = yield* verifyAndDecode(row, expectedPreviousHash);
        expectedPreviousHash = row.eventHash;
        const spaceIsVisible = event.spaceId === null || activeSpaceIds.has(event.spaceId);
        if (spaceIsVisible && (input.spaceId === undefined || event.spaceId === input.spaceId)) {
          events.push(event);
        }
      }
      return {
        events,
        nextSequence: rows.at(-1)?.sequence ?? input.afterSequence,
      } satisfies CommandCenterEventPage;
    });

  const changes: CommandCenterEventStreamShape["changes"] = (input) => {
    const batchSize = clampInteger(input.batchSize, DEFAULT_REPLAY_LIMIT, 1, MAX_REPLAY_LIMIT);
    const pollIntervalMs = clampInteger(
      input.pollIntervalMs,
      DEFAULT_POLL_INTERVAL_MS,
      MIN_POLL_INTERVAL_MS,
      MAX_POLL_INTERVAL_MS,
    );
    return Stream.paginate(input.afterSequence, (cursor) =>
      replay({
        afterSequence: cursor,
        limit: batchSize,
        ...(input.spaceId === undefined ? {} : { spaceId: input.spaceId }),
      }).pipe(
        Effect.flatMap((page) => {
          const next = Option.some(page.nextSequence);
          return page.nextSequence === cursor
            ? Effect.sleep(Duration.millis(pollIntervalMs)).pipe(
                Effect.as([page.events, next] as const),
              )
            : Effect.succeed([page.events, next] as const);
        }),
      ),
    );
  };

  const queryTimelineRows = (
    input: CommandCenterTimelineQuery,
    limit: number,
  ): Effect.Effect<ReadonlyArray<TimelineRow>, CommandCenterEventStreamError> => {
    const query =
      input.afterSequence === undefined
        ? sql<TimelineRow>`
            SELECT e.sequence, r.id AS "runId", r.command_id AS "commandId",
              r.space_id AS "spaceId", r.project_id AS "projectId",
              r.thread_id AS "threadId", r.state AS status, r.route_json AS "routeJson",
              r.input_json AS "inputJson", r.error,
              (
                SELECT message.text
                FROM projection_thread_messages message
                WHERE message.thread_id = r.thread_id
                  AND message.role = 'assistant'
                  AND message.is_streaming = 0
                ORDER BY message.created_at DESC, message.message_id DESC
                LIMIT 1
              ) AS "responseText",
              (
                SELECT message.created_at
                FROM projection_thread_messages message
                WHERE message.thread_id = r.thread_id
                  AND message.role = 'assistant'
                  AND message.is_streaming = 0
                ORDER BY message.created_at DESC, message.message_id DESC
                LIMIT 1
              ) AS "responseCreatedAt",
              r.started_at AS "startedAt",
              r.finished_at AS "finishedAt"
            FROM command_center_runs r
            JOIN command_center_spaces s
              ON s.id = r.space_id AND s.lifecycle = 'active'
            JOIN command_center_audit_events e
              ON e.run_id = r.id AND e.action = 'cc.command.submit'
            WHERE (${input.spaceId ?? null} IS NULL OR r.space_id = ${input.spaceId ?? null})
            ORDER BY e.sequence DESC
            LIMIT ${limit}
          `
        : sql<TimelineRow>`
            SELECT e.sequence, r.id AS "runId", r.command_id AS "commandId",
              r.space_id AS "spaceId", r.project_id AS "projectId",
              r.thread_id AS "threadId", r.state AS status, r.route_json AS "routeJson",
              r.input_json AS "inputJson", r.error,
              (
                SELECT message.text
                FROM projection_thread_messages message
                WHERE message.thread_id = r.thread_id
                  AND message.role = 'assistant'
                  AND message.is_streaming = 0
                ORDER BY message.created_at DESC, message.message_id DESC
                LIMIT 1
              ) AS "responseText",
              (
                SELECT message.created_at
                FROM projection_thread_messages message
                WHERE message.thread_id = r.thread_id
                  AND message.role = 'assistant'
                  AND message.is_streaming = 0
                ORDER BY message.created_at DESC, message.message_id DESC
                LIMIT 1
              ) AS "responseCreatedAt",
              r.started_at AS "startedAt",
              r.finished_at AS "finishedAt"
            FROM command_center_runs r
            JOIN command_center_spaces s
              ON s.id = r.space_id AND s.lifecycle = 'active'
            JOIN command_center_audit_events e
              ON e.run_id = r.id AND e.action = 'cc.command.submit'
            WHERE e.sequence > ${input.afterSequence}
              AND (${input.spaceId ?? null} IS NULL OR r.space_id = ${input.spaceId ?? null})
            ORDER BY e.sequence ASC
            LIMIT ${limit}
          `;
    return query.pipe(
      Effect.mapError((cause) =>
        eventStreamError("query", "Could not read the Command timeline.", undefined, cause),
      ),
      Effect.map((rows) => (input.afterSequence === undefined ? rows.toReversed() : rows)),
    );
  };

  const timelineArtifacts = (runId: string) =>
    sql<TimelineArtifactRow>`
      SELECT id, space_id AS "spaceId", run_id AS "runId", kind, title,
        uri, content_digest AS "contentDigest", provenance_json AS "provenanceJson",
        metadata_json AS "metadataJson", created_at AS "createdAt"
      FROM command_center_artifacts
      WHERE run_id = ${runId}
      ORDER BY created_at ASC, id ASC
    `.pipe(
      Effect.mapError((cause) =>
        eventStreamError("query", "Could not read Command timeline Artifacts.", undefined, cause),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          Effect.gen(function* () {
            if (row.uri === null || !row.uri.startsWith("cc-artifact://")) {
              return yield* eventStreamError(
                "decode",
                "A Command timeline Artifact has an unsafe locator.",
              );
            }
            const metadata = yield* decodeUnknownJsonString(row.metadataJson).pipe(
              Effect.mapError((cause) =>
                eventStreamError(
                  "decode",
                  "Could not decode Command timeline Artifact metadata.",
                  undefined,
                  cause,
                ),
              ),
            );
            const provenance = yield* decodeUnknownJsonString(row.provenanceJson).pipe(
              Effect.mapError((cause) =>
                eventStreamError(
                  "decode",
                  "Could not decode Command timeline Artifact provenance.",
                  undefined,
                  cause,
                ),
              ),
            );
            const mimeType =
              typeof metadata === "object" &&
              metadata !== null &&
              "mimeType" in metadata &&
              typeof metadata.mimeType === "string"
                ? metadata.mimeType
                : undefined;
            return yield* decodeArtifact({
              id: row.id,
              spaceId: row.spaceId,
              runId: row.runId,
              kind: row.kind,
              name: row.title,
              locator: row.uri,
              ...(mimeType === undefined ? {} : { mimeType }),
              contentDigest: row.contentDigest,
              provenance,
              createdAt: row.createdAt,
            }).pipe(
              Effect.mapError((cause) =>
                eventStreamError(
                  "decode",
                  "Could not decode a Command timeline Artifact.",
                  undefined,
                  cause,
                ),
              ),
            );
          }),
        ),
      ),
    );

  const timeline: CommandCenterEventStreamShape["timeline"] = (input) =>
    Effect.gen(function* () {
      const limit = clampInteger(input.limit, DEFAULT_REPLAY_LIMIT, 1, MAX_REPLAY_LIMIT);
      const rows = yield* queryTimelineRows(input, limit);
      const entries = yield* Effect.forEach(
        rows,
        (row) =>
          Effect.gen(function* () {
            const route = yield* decodeAtSequence(
              decodeUnknownJsonString(row.routeJson).pipe(Effect.flatMap(decodeRoute)),
              row.sequence,
              "timeline route",
            );
            const command = yield* decodeAtSequence(
              decodeUnknownJsonString(row.inputJson).pipe(Effect.flatMap(decodeCommand)),
              row.sequence,
              "timeline command",
            );
            const responseText = row.responseText?.trim();
            const response =
              row.status === "failed" || row.status === "canceled"
                ? {
                    kind: "failure" as const,
                    text: (row.error?.trim() || `The Run ${row.status}.`).slice(0, 64 * 1024),
                    createdAt: row.finishedAt ?? row.startedAt,
                  }
                : responseText
                  ? {
                      kind: "assistant" as const,
                      text: responseText.slice(0, 64 * 1024),
                      createdAt: row.responseCreatedAt ?? row.finishedAt ?? row.startedAt,
                    }
                  : null;
            const artifacts = yield* timelineArtifacts(row.runId);
            return yield* decodeAtSequence(
              decodeTimelineEntry({
                sequence: row.sequence,
                runId: row.runId,
                commandId: row.commandId,
                text: command.text,
                spaceId: row.spaceId,
                repositoryId: route.repositoryId,
                projectId: row.projectId,
                threadId: row.threadId,
                status: row.status,
                route,
                response,
                artifacts,
                startedAt: row.startedAt,
                finishedAt: row.finishedAt,
              }),
              row.sequence,
              "timeline entry",
            );
          }),
        { concurrency: 8 },
      );
      return {
        entries,
        nextSequence: entries.at(-1)?.sequence ?? input.afterSequence ?? 0,
      } satisfies CommandCenterTimelinePage;
    });

  return CommandCenterEventStream.of({ replay, changes, timeline });
});

export const layer = Layer.effect(CommandCenterEventStream, make);
