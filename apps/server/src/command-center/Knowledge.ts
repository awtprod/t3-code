// @effect-diagnostics nodeBuiltinImport:off - SHA-256 binds immutable evidence and mutation receipts.
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  CommandCenterKnowledgeCaptureInput,
  CommandCenterKnowledgeDocument,
  CommandCenterKnowledgeSearchInput,
  CommandCenterKnowledgeGetInput,
  CommandCenterKnowledgeRetireInput,
  CommandCenterKnowledgeEvidence,
  CommandCenterKnowledgeReceipt,
} from "@t3tools/contracts";
import { canonicalJson } from "./automation/Digest.ts";
import { CommandCenterConfig } from "./Config.ts";
import { googleCapabilityForOperation } from "./GoogleCapabilities.ts";

export class KnowledgeError extends Schema.TaggedError<KnowledgeError>()("KnowledgeError", {
  reason: Schema.Literals(["validation", "not_found", "conflict", "denied", "persistence"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
const error = (reason: KnowledgeError["reason"], message: string) =>
  new KnowledgeError({ reason, message });
const mapError = (cause: unknown) =>
  Schema.is(KnowledgeError)(cause)
    ? cause
    : new KnowledgeError({
        reason: "persistence",
        message: "Knowledge could not be stored or read.",
        cause,
      });
const decode =
  <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  (raw: unknown) =>
    Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(raw).pipe(
      Effect.mapError(
        (cause) =>
          new KnowledgeError({
            reason: "validation",
            message: "The knowledge request is invalid.",
            cause,
          }),
      ),
    );
const digest = (value: unknown) =>
  NodeCrypto.createHash("sha256")
    .update(canonicalJson(value as Schema.Json))
    .digest("hex");

export type KnowledgeAccess = { readonly actorId: string } & (
  | { readonly kind: "owner" }
  | {
      readonly kind: "scoped";
      readonly spaceId: string;
      readonly repositoryId: string | null;
      readonly capabilities: ReadonlyArray<string>;
    }
);
type Scope = { readonly spaceId: string; readonly repositoryId: string | null };
type Connected = {
  readonly operation: "gmail.get" | "gmail.thread.get" | "calendar.events" | "drive.get";
  readonly account: string;
};
interface EvidenceRow {
  readonly id: string;
  readonly sourceId: string;
  readonly spaceId: string;
  readonly repositoryId: string | null;
  readonly currentRevisionId: string;
  readonly retiredAt: string | null;
  readonly documentJson: string;
  readonly capturedAt: string;
  readonly actorId: string;
  readonly acquisition: "imported" | "connected";
  readonly connectedOperation: Connected["operation"] | null;
  readonly connectedAccount: string | null;
  readonly chunk: number;
  readonly start: number;
  readonly end: number;
  readonly excerpt: string;
}
export class Knowledge extends Context.Service<
  Knowledge,
  {
    readonly capture: (
      raw: unknown,
      access: KnowledgeAccess,
    ) => Effect.Effect<CommandCenterKnowledgeReceipt, KnowledgeError>;
    /** Internal connector boundary only; public capture always records imported evidence. */
    readonly ingestConnected: (
      raw: unknown,
      access: KnowledgeAccess,
      connection: Connected,
    ) => Effect.Effect<CommandCenterKnowledgeReceipt, KnowledgeError>;
    readonly search: (
      raw: unknown,
      access: KnowledgeAccess,
    ) => Effect.Effect<ReadonlyArray<CommandCenterKnowledgeEvidence>, KnowledgeError>;
    readonly get: (
      raw: unknown,
      access: KnowledgeAccess,
    ) => Effect.Effect<CommandCenterKnowledgeEvidence, KnowledgeError>;
    readonly retire: (
      raw: unknown,
      access: KnowledgeAccess,
    ) => Effect.Effect<CommandCenterKnowledgeReceipt, KnowledgeError>;
  }
>()("@awtprod/command-center/command-center/Knowledge") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* Effect.serviceOption(CommandCenterConfig);
  const requireScope = Effect.fn("Knowledge.requireScope")(function* (
    scope: Scope,
    access: KnowledgeAccess,
    capability: "cc.items.read" | "cc.items.write",
  ) {
    if (
      access.kind === "scoped" &&
      (scope.spaceId !== access.spaceId || scope.repositoryId !== access.repositoryId)
    )
      return yield* error("denied", "This credential cannot access the requested knowledge scope.");
    if (Option.isNone(config))
      return yield* error("denied", "The current Space configuration is unavailable.");
    const loaded = yield* config.value.load.pipe(
      Effect.catchCause((cause) =>
        Effect.fail(
          new KnowledgeError({
            reason: "denied",
            message: "The current Space configuration is unavailable.",
            cause,
          }),
        ),
      ),
    );
    const space = loaded.spaces.find((space) => space.id === scope.spaceId);
    if (
      space === undefined ||
      (scope.repositoryId !== null &&
        !space.repositories.some((repository) => repository.id === scope.repositoryId))
    )
      return yield* error("denied", "The requested repository scope is unavailable.");
    if (
      access.kind === "scoped" &&
      (!access.capabilities.includes(capability) ||
        !space.policy.allowedCapabilities.includes(capability))
    )
      return yield* error("denied", "The Space no longer permits this knowledge operation.");
    const rows =
      yield* sql`SELECT id FROM command_center_spaces WHERE id=${scope.spaceId} AND lifecycle='active' LIMIT 1`;
    if (rows.length === 0) return yield* error("not_found", "The Space was not found.");
  });
  const requireConnected = Effect.fn("Knowledge.requireConnected")(
    function* (scope: Scope, bindingId: string, connected: Connected, access: KnowledgeAccess) {
      if (Option.isNone(config))
        return yield* error("denied", "The source binding is unavailable.");
      const capability = googleCapabilityForOperation(connected.operation);
      if (access.kind === "scoped" && !access.capabilities.includes(capability))
        return yield* error("denied", "This credential cannot read the original source service.");
      const loaded = yield* config.value.load;
      if (
        access.kind === "scoped" &&
        !loaded.spaces
          .find((space) => space.id === scope.spaceId)
          ?.policy.allowedCapabilities.includes(capability)
      )
        return yield* error(
          "denied",
          "The Space no longer permits the original source capability.",
        );
      const binding = loaded.connections.find(
        (c) =>
          c.id === bindingId &&
          c.spaceId === scope.spaceId &&
          c.kind === "google" &&
          c.capabilities.includes(capability),
      );
      if (binding === undefined)
        return yield* error("denied", "The source binding is no longer available.");
      const resolved = yield* config.value.resolveGoogleAccount({
        spaceId: scope.spaceId,
        connectionId: bindingId,
      });
      if (resolved.accountAlias !== connected.account)
        return yield* error("denied", "The source account has changed.");
    },
    Effect.mapError((cause) =>
      Schema.is(KnowledgeError)(cause)
        ? cause
        : new KnowledgeError({
            reason: "denied",
            message: "The source binding is unavailable.",
            cause,
          }),
    ),
  );
  const previous = Effect.fn("Knowledge.previous")(function* (
    spaceId: string,
    mutationId: string,
    hash: string,
  ) {
    const rows = yield* sql<{
      digest: string;
      receipt: string;
    }>`SELECT digest, receipt_json AS receipt FROM command_center_knowledge_mutations WHERE space_id=${spaceId} AND mutation_id=${mutationId}`;
    if (!rows[0]) return undefined;
    if (rows[0].digest !== hash)
      return yield* error("conflict", "The mutation ID is bound to a different request or actor.");
    return yield* Schema.decodeEffect(Schema.fromJsonString(CommandCenterKnowledgeReceipt))(
      rows[0].receipt,
    );
  });
  const saveReceipt = Effect.fn("Knowledge.saveReceipt")(function* (
    spaceId: string,
    hash: string,
    receipt: CommandCenterKnowledgeReceipt,
  ) {
    yield* sql`INSERT INTO command_center_knowledge_mutations(space_id,mutation_id,digest,receipt_json) VALUES(${spaceId},${receipt.mutationId},${hash},${canonicalJson(receipt)})`;
  });
  const capture = Effect.fn("Knowledge.capture")(function* (
    raw: unknown,
    access: KnowledgeAccess,
    connected?: Connected,
  ) {
    const request = yield* decode(CommandCenterKnowledgeCaptureInput)(raw);
    yield* requireScope(request, access, "cc.items.write");
    if (
      new Set(
        request.documents.map((doc) =>
          canonicalJson([doc.sourceKind, doc.bindingId, doc.accountId, doc.externalId]),
        ),
      ).size !== request.documents.length
    )
      return yield* error("validation", "A batch may contain each source only once.");
    if (connected)
      for (const doc of request.documents) {
        if (doc.accountId !== connected.account)
          return yield* error("validation", "The captured account must match server acquisition.");
        yield* requireConnected(request, doc.bindingId, connected, access);
      }
    const hash = digest({ request, actorId: access.actorId, acquisition: connected ?? "imported" });
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const prior = yield* previous(request.spaceId, request.mutationId, hash);
        if (prior) return prior;
        const at = DateTime.formatIso(yield* DateTime.now);
        const revisions = yield* Effect.forEach(
          request.documents,
          Effect.fn("Knowledge.captureDocument")(function* (doc) {
            const identity = canonicalJson([
              request.spaceId,
              request.repositoryId,
              connected ? "connected" : "imported",
              doc.sourceKind,
              doc.bindingId,
              connected?.account ?? doc.accountId,
              doc.externalId,
            ]);
            const sourceId = `knowledge:${digest(identity)}`;
            const revisionId = `knowledge-revision:${digest({ hash, sourceId, doc })}`;
            const existing = yield* sql<{
              retiredAt: string | null;
              updatedAt: string | null;
            }>`SELECT s.retired_at AS "retiredAt", json_extract(r.document_json,'$.sourceUpdatedAt') AS "updatedAt" FROM command_center_knowledge_sources s LEFT JOIN command_center_knowledge_revisions r ON r.id=s.current_revision_id WHERE s.id=${sourceId}`;
            if (existing[0]?.updatedAt && existing[0].updatedAt > doc.sourceUpdatedAt)
              return yield* error(
                "conflict",
                "The source update is older than its current revision.",
              );
            if (existing[0]?.retiredAt) return yield* error("conflict", "The source is retired.");
            yield* sql`INSERT INTO command_center_knowledge_sources(id,space_id,repository_id,identity) VALUES(${sourceId},${request.spaceId},${request.repositoryId},${identity}) ON CONFLICT(id) DO NOTHING`;
            yield* sql`DELETE FROM command_center_knowledge_current WHERE id IN (SELECT c.id FROM command_center_knowledge_chunks c JOIN command_center_knowledge_sources s ON s.current_revision_id=c.revision_id WHERE s.id=${sourceId})`;
            yield* sql`INSERT INTO command_center_knowledge_revisions(id,source_id,document_json,captured_at,actor_id,acquisition,connected_operation,connected_account)
          VALUES(${revisionId},${sourceId},${canonicalJson(doc)},${at},${access.actorId},${connected ? "connected" : "imported"},${connected?.operation ?? null},${connected?.account ?? null})`;
            for (let start = 0, chunk = 0; start < doc.text.length; chunk++) {
              let end = Math.min(start + 2048, doc.text.length);
              if (end < doc.text.length) {
                // Keep ordinary words together, with at least 1536 code units of progress.
                const boundary = doc.text
                  .slice(start + 1536, end)
                  .match(/[^\p{L}\p{N}\p{M}_](?=[\p{L}\p{N}\p{M}_]*$)/u);
                if (boundary) end = start + 1536 + boundary.index! + boundary[0].length;
                if (/[\uD800-\uDBFF]/u.test(doc.text[end - 1]!)) end--;
              }
              const rows = yield* sql<{
                id: number;
              }>`INSERT INTO command_center_knowledge_chunks(revision_id,chunk,start,end,text) VALUES(${revisionId},${chunk},${start},${end},${doc.text.slice(start, end)}) RETURNING id`;
              yield* sql`INSERT INTO command_center_knowledge_current(id,space_id,repository_id,scope_key,text) VALUES(${rows[0]!.id},${request.spaceId},${request.repositoryId},${digest([request.spaceId, request.repositoryId])},${doc.text.slice(start, end)})`;
              start = end;
            }
            yield* sql`UPDATE command_center_knowledge_sources SET current_revision_id=${revisionId} WHERE id=${sourceId}`;
            return { sourceId, revisionId };
          }),
          { concurrency: 1 },
        );
        const receipt = { mutationId: request.mutationId, revisions };
        yield* saveReceipt(request.spaceId, hash, receipt);
        return receipt;
      }),
    );
  }, Effect.mapError(mapError));
  const evidence = Effect.fn("Knowledge.evidence")(function* (
    row: EvidenceRow,
    access: KnowledgeAccess,
  ) {
    const doc = yield* Schema.decodeEffect(Schema.fromJsonString(CommandCenterKnowledgeDocument))(
      row.documentJson,
    );
    if (row.acquisition === "connected") {
      if (!row.connectedOperation || !row.connectedAccount)
        return yield* error("persistence", "Connected provenance is missing.");
      yield* requireConnected(
        row,
        doc.bindingId,
        { operation: row.connectedOperation, account: row.connectedAccount },
        access,
      );
    }
    return yield* Schema.decodeEffect(CommandCenterKnowledgeEvidence)({
      ...doc,
      spaceId: row.spaceId,
      repositoryId: row.repositoryId,
      sourceId: row.sourceId,
      revisionId: row.id,
      chunk: row.chunk,
      start: row.start,
      end: row.end,
      excerpt: row.excerpt,
      capturedAt: row.capturedAt,
      actorId: row.actorId,
      acquisition: row.acquisition,
      contentTrust: "untrusted-evidence",
      status: row.retiredAt
        ? "retired"
        : row.currentRevisionId === row.id
          ? "current"
          : "superseded",
    });
  });
  const get = Effect.fn("Knowledge.get")(function* (
    raw: unknown,
    access: KnowledgeAccess,
    capability: "cc.items.read" | "cc.items.write" = "cc.items.read",
  ) {
    const request = yield* decode(CommandCenterKnowledgeGetInput)(raw);
    yield* requireScope(request, access, capability);
    const rows =
      yield* sql<EvidenceRow>`SELECT r.id, r.source_id AS "sourceId", s.space_id AS "spaceId", s.repository_id AS "repositoryId", s.current_revision_id AS "currentRevisionId", s.retired_at AS "retiredAt", r.document_json AS "documentJson", r.captured_at AS "capturedAt", r.actor_id AS "actorId", r.acquisition, r.connected_operation AS "connectedOperation", r.connected_account AS "connectedAccount", c.chunk,c.start,c.end,c.text AS excerpt
      FROM command_center_knowledge_revisions r JOIN command_center_knowledge_sources s ON s.id=r.source_id JOIN command_center_knowledge_chunks c ON c.revision_id=r.id
      WHERE s.space_id=${request.spaceId} AND s.repository_id IS ${request.repositoryId} AND r.id=${request.revisionId} AND c.chunk=${request.chunk} LIMIT 1`;
    if (!rows[0])
      return yield* error("not_found", "The cited revision was not found in this scope.");
    return yield* evidence(rows[0], access);
  }, Effect.mapError(mapError));
  const search = Effect.fn("Knowledge.search")(
    function* (raw: unknown, access: KnowledgeAccess) {
      const request = yield* decode(CommandCenterKnowledgeSearchInput)(raw);
      yield* requireScope(request, access, "cc.items.read");
      const terms = (request.query.match(/[\p{L}\p{N}_][\p{L}\p{N}\p{M}_]*/gu) ?? [])
        .map((term) => `"${term}"`)
        .join(" AND ");
      const query = `scope_key : "${digest([request.spaceId, request.repositoryId])}" AND text : (${terms})`;
      const rows = yield* sql<{
        revisionId: string;
        chunk: number;
      }>`SELECT c.revision_id AS "revisionId",c.chunk FROM command_center_knowledge_fts f
      JOIN command_center_knowledge_current i ON i.id=f.rowid JOIN command_center_knowledge_chunks c ON c.id=i.id
      WHERE command_center_knowledge_fts MATCH ${query} AND i.space_id=${request.spaceId} AND i.repository_id IS ${request.repositoryId}
      ORDER BY bm25(command_center_knowledge_fts),i.id LIMIT ${request.limit}`;
      const results: CommandCenterKnowledgeEvidence[] = [];
      for (const row of rows) {
        const result = yield* get(
          { spaceId: request.spaceId, repositoryId: request.repositoryId, ...row },
          access,
        ).pipe(Effect.result);
        if (result._tag === "Success") results.push(result.success);
        else if (result.failure.reason !== "denied") return yield* result.failure;
      }
      return results;
    },
    (effect) => sql.withTransaction(effect),
    Effect.mapError(mapError),
  );
  const retire = Effect.fn("Knowledge.retire")(function* (raw: unknown, access: KnowledgeAccess) {
    const request = yield* decode(CommandCenterKnowledgeRetireInput)(raw);
    yield* requireScope(request, access, "cc.items.write");
    const hash = digest({ request, actorId: access.actorId });
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const prior = yield* previous(request.spaceId, request.mutationId, hash);
        if (prior) return prior;
        yield* get(
          {
            spaceId: request.spaceId,
            repositoryId: request.repositoryId,
            revisionId: request.expectedRevisionId,
            chunk: 0,
          },
          access,
          "cc.items.write",
        );
        const rows = yield* sql<{
          id: string;
        }>`UPDATE command_center_knowledge_sources SET retired_at=${DateTime.formatIso(yield* DateTime.now)}
        WHERE id=${request.sourceId} AND space_id=${request.spaceId} AND repository_id IS ${request.repositoryId} AND current_revision_id=${request.expectedRevisionId} AND retired_at IS NULL RETURNING id`;
        if (!rows[0])
          return yield* error("conflict", "The source changed or is unavailable in this scope.");
        yield* sql`DELETE FROM command_center_knowledge_current WHERE id IN (SELECT c.id FROM command_center_knowledge_chunks c WHERE c.revision_id=${request.expectedRevisionId})`;
        const receipt = {
          mutationId: request.mutationId,
          revisions: [{ sourceId: request.sourceId, revisionId: request.expectedRevisionId }],
        };
        yield* saveReceipt(request.spaceId, hash, receipt);
        return receipt;
      }),
    );
  }, Effect.mapError(mapError));
  return Knowledge.of({
    capture: (raw, access) => capture(raw, access),
    ingestConnected: capture,
    search,
    get,
    retire,
  });
});
export const layer = Layer.effect(Knowledge, make);
