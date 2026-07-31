import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeUtil from "node:util";

export type CommandCenterAuditHashVersion = 1 | 2;
export const COMMAND_CENTER_AUDIT_HASH_VERSION = 2 as const;

export interface CommandCenterAuditInput {
  readonly eventId?: string;
  readonly actorKind: string;
  readonly action: string;
  readonly spaceId?: string;
  readonly runId?: string;
  readonly payload: unknown;
  readonly occurredAt: string;
}

export interface CommandCenterAuditChainVerification {
  readonly valid: boolean;
  readonly eventCount: number;
  readonly headSequence: number | null;
  readonly headHash: string | null;
  readonly invalidSequence?: number;
  readonly reason?: "previous-hash" | "event-hash" | "chain-head";
}

interface AuditHeadRow {
  readonly eventSequence: number | null;
  readonly eventHash: string | null;
}

interface AuditEventRow {
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

const encodeJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);
const decodeJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const textEncoder = new TextEncoder();

export const commandCenterAuditHashDocument = (input: {
  readonly hashVersion: CommandCenterAuditHashVersion;
  readonly eventId: string;
  readonly previousHash: string | null;
  readonly actorKind: string;
  readonly action: string;
  readonly spaceId?: string;
  readonly runId?: string;
  readonly payload: unknown;
  readonly occurredAt: string;
}) => {
  const event = {
    previousHash: input.previousHash,
    actorKind: input.actorKind,
    action: input.action,
    ...(input.spaceId === undefined ? {} : { spaceId: input.spaceId }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    payload: input.payload,
    occurredAt: input.occurredAt,
  };
  // Version 1 is retained exactly for verification of pre-migration history.
  // Version 2 binds the durable event identity and the format version itself.
  return input.hashVersion === 1
    ? encodeJson(event)
    : encodeJson({ hashVersion: 2, eventId: input.eventId, ...event });
};

export class CommandCenterAuditReplayConflictError extends Schema.TaggedErrorClass<CommandCenterAuditReplayConflictError>()(
  "CommandCenterAuditReplayConflictError",
  {
    eventId: Schema.String,
  },
) {
  override get message(): string {
    return `Audit event '${this.eventId}' is already bound to different content.`;
  }
}

const auditReplayConflict = (eventId: string) =>
  new CommandCenterAuditReplayConflictError({ eventId });

/**
 * Shared Command Center audit writer. Each append runs in a transaction and
 * reads the database-maintained head before hashing. The migration's INSERT
 * trigger validates and advances that head in the same SQLite statement.
 */
export const makeCommandCenterAuditLog = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const localAppendLock = yield* Semaphore.make(1);

  const digest = Effect.fn("CommandCenterAuditLog.digest")(function* (value: string) {
    return Encoding.encodeHex(yield* crypto.digest("SHA-256", textEncoder.encode(value)));
  });

  const appendUnlocked = Effect.fn("CommandCenterAuditLog.appendUnlocked")(function* (
    input: CommandCenterAuditInput,
  ) {
    const payloadJson = encodeJson(input.payload);
    if (input.eventId !== undefined) {
      const recorded = yield* sql<AuditEventRow>`
        SELECT sequence, event_id AS "eventId", hash_version AS "hashVersion",
          previous_hash AS "previousHash", event_hash AS "eventHash",
          actor_kind AS "actorKind", action, space_id AS "spaceId", run_id AS "runId",
          payload_json AS "payloadJson", occurred_at AS "occurredAt"
        FROM command_center_audit_events
        WHERE event_id = ${input.eventId}
        LIMIT 1
      `;
      const existing = recorded[0];
      if (existing !== undefined) {
        if (existing.hashVersion !== 1 && existing.hashVersion !== 2) {
          return yield* auditReplayConflict(input.eventId);
        }
        const [storedPayload, requestedPayload] = yield* Effect.all([
          decodeJson(existing.payloadJson),
          decodeJson(payloadJson),
        ]).pipe(Effect.mapError(() => auditReplayConflict(input.eventId!)));
        const expectedHash = yield* digest(
          commandCenterAuditHashDocument({
            hashVersion: existing.hashVersion,
            eventId: existing.eventId,
            previousHash: existing.previousHash,
            actorKind: existing.actorKind,
            action: existing.action,
            ...(existing.spaceId === null ? {} : { spaceId: existing.spaceId }),
            ...(existing.runId === null ? {} : { runId: existing.runId }),
            payload: storedPayload,
            occurredAt: existing.occurredAt,
          }),
        );
        if (
          existing.eventHash !== expectedHash ||
          existing.actorKind !== input.actorKind ||
          existing.action !== input.action ||
          existing.spaceId !== (input.spaceId ?? null) ||
          existing.runId !== (input.runId ?? null) ||
          existing.occurredAt !== input.occurredAt ||
          !NodeUtil.isDeepStrictEqual(storedPayload, requestedPayload)
        ) {
          return yield* auditReplayConflict(input.eventId);
        }
        return false;
      }
    }

    const heads = yield* sql<AuditHeadRow>`
      SELECT event_sequence AS "eventSequence", event_hash AS "eventHash"
      FROM command_center_audit_chain_head
      WHERE singleton_id = 1
      LIMIT 1
    `;
    const head = heads[0];
    if (head === undefined) {
      return yield* Effect.die(new Error("Command Center audit chain head is missing."));
    }

    const eventId = input.eventId ?? (yield* crypto.randomUUIDv4);
    const eventHash = yield* digest(
      commandCenterAuditHashDocument({
        hashVersion: COMMAND_CENTER_AUDIT_HASH_VERSION,
        eventId,
        previousHash: head.eventHash,
        actorKind: input.actorKind,
        action: input.action,
        ...(input.spaceId === undefined ? {} : { spaceId: input.spaceId }),
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        payload: input.payload,
        occurredAt: input.occurredAt,
      }),
    );

    yield* sql`
      INSERT INTO command_center_audit_events (
        event_id, hash_version, previous_hash, event_hash, actor_kind, action,
        space_id, run_id, payload_json, occurred_at
      ) VALUES (
        ${eventId}, ${COMMAND_CENTER_AUDIT_HASH_VERSION}, ${head.eventHash}, ${eventHash},
        ${input.actorKind}, ${input.action}, ${input.spaceId ?? null}, ${input.runId ?? null},
        ${payloadJson}, ${input.occurredAt}
      )
    `;
    return true;
  });

  const append = (input: CommandCenterAuditInput) =>
    localAppendLock.withPermits(1)(sql.withTransaction(appendUnlocked(input)));

  const verify = Effect.gen(function* () {
    const rows = yield* sql<AuditEventRow>`
      SELECT sequence, event_id AS "eventId", hash_version AS "hashVersion",
        previous_hash AS "previousHash", event_hash AS "eventHash",
        actor_kind AS "actorKind", action, space_id AS "spaceId", run_id AS "runId",
        payload_json AS "payloadJson", occurred_at AS "occurredAt"
      FROM command_center_audit_events
      ORDER BY sequence
    `;
    const heads = yield* sql<AuditHeadRow>`
      SELECT event_sequence AS "eventSequence", event_hash AS "eventHash"
      FROM command_center_audit_chain_head
      WHERE singleton_id = 1
      LIMIT 1
    `;
    const head = heads[0];
    if (head === undefined) {
      return {
        valid: false,
        eventCount: rows.length,
        headSequence: null,
        headHash: null,
        reason: "chain-head",
      } satisfies CommandCenterAuditChainVerification;
    }

    let previousHash: string | null = null;
    for (const row of rows) {
      if (row.previousHash !== previousHash) {
        return {
          valid: false,
          eventCount: rows.length,
          headSequence: head.eventSequence,
          headHash: head.eventHash,
          invalidSequence: row.sequence,
          reason: "previous-hash",
        } satisfies CommandCenterAuditChainVerification;
      }
      if (row.hashVersion !== 1 && row.hashVersion !== 2) {
        return {
          valid: false,
          eventCount: rows.length,
          headSequence: head.eventSequence,
          headHash: head.eventHash,
          invalidSequence: row.sequence,
          reason: "event-hash",
        } satisfies CommandCenterAuditChainVerification;
      }
      const payload = yield* decodeJson(row.payloadJson);
      const expectedHash: string = yield* digest(
        commandCenterAuditHashDocument({
          hashVersion: row.hashVersion,
          eventId: row.eventId,
          previousHash,
          actorKind: row.actorKind,
          action: row.action,
          ...(row.spaceId === null ? {} : { spaceId: row.spaceId }),
          ...(row.runId === null ? {} : { runId: row.runId }),
          payload,
          occurredAt: row.occurredAt,
        }),
      );
      if (row.eventHash !== expectedHash) {
        return {
          valid: false,
          eventCount: rows.length,
          headSequence: head.eventSequence,
          headHash: head.eventHash,
          invalidSequence: row.sequence,
          reason: "event-hash",
        } satisfies CommandCenterAuditChainVerification;
      }
      previousHash = row.eventHash;
    }

    const finalRow = rows.at(-1);
    if (
      head.eventSequence !== (finalRow?.sequence ?? null) ||
      head.eventHash !== (finalRow?.eventHash ?? null)
    ) {
      return {
        valid: false,
        eventCount: rows.length,
        headSequence: head.eventSequence,
        headHash: head.eventHash,
        reason: "chain-head",
      } satisfies CommandCenterAuditChainVerification;
    }

    return {
      valid: true,
      eventCount: rows.length,
      headSequence: head.eventSequence,
      headHash: head.eventHash,
    } satisfies CommandCenterAuditChainVerification;
  });

  return { append, verify } as const;
});
