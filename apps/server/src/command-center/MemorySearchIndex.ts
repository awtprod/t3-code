import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export class MemorySearchIndexError extends Schema.TaggedErrorClass<MemorySearchIndexError>()(
  "MemorySearchIndexError",
  {
    reason: Schema.Literals(["invalid-query", "persistence"]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export type MemorySearchTrust = "trusted" | "untrusted-archive";

export interface MemorySearchResult {
  readonly memoryId: string;
  readonly spaceId: string;
  readonly repositoryRef?: string | undefined;
  readonly scope: "global" | "space" | "repository";
  readonly kind: string;
  readonly content: string;
  readonly confidence: number;
  readonly trust: MemorySearchTrust;
  readonly readOnly: boolean;
  readonly provenance: unknown;
  readonly sourceCreatedAt: string;
  readonly sourceUpdatedAt: string;
  readonly rank: number;
}

export interface MemorySearchInput {
  readonly query: string;
  readonly spaceId: string;
  readonly repositoryRef?: string | undefined;
  readonly ownerId?: string | undefined;
  readonly includeArchives?: boolean | undefined;
  readonly limit?: number | undefined;
}

export interface MemorySearchRebuildResult {
  readonly generation: number;
  readonly rebuiltAt: string;
  readonly documentCount: number;
  readonly trustedCount: number;
  readonly archiveCount: number;
}

export interface MemorySearchIndexShape {
  readonly rebuild: () => Effect.Effect<MemorySearchRebuildResult, MemorySearchIndexError>;
  readonly ensureCurrent: () => Effect.Effect<
    MemorySearchRebuildResult | null,
    MemorySearchIndexError
  >;
  readonly search: (
    input: MemorySearchInput,
  ) => Effect.Effect<ReadonlyArray<MemorySearchResult>, MemorySearchIndexError>;
}

export class MemorySearchIndex extends Context.Service<MemorySearchIndex, MemorySearchIndexShape>()(
  "t3/command-center/MemorySearchIndex",
) {}

interface SourceMemoryRow {
  readonly id: string;
  readonly ownerId: string;
  readonly spaceId: string;
  readonly repositoryRef: string | null;
  readonly scope: "global" | "space" | "repository";
  readonly kind: string;
  readonly status: "approved" | "archive";
  readonly content: string;
  readonly confidence: number;
  readonly provenanceJson: string;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface SearchRow {
  readonly memoryId: string;
  readonly spaceId: string;
  readonly repositoryRef: string | null;
  readonly scope: "global" | "space" | "repository";
  readonly kind: string;
  readonly content: string;
  readonly confidence: number;
  readonly trust: "trusted" | "untrusted_archive";
  readonly readOnly: number;
  readonly provenanceJson: string;
  readonly sourceCreatedAt: string;
  readonly sourceUpdatedAt: string;
  readonly rank: number;
}

interface SearchStateRow {
  readonly generation: number;
  readonly sourceGeneration: number;
  readonly indexedSourceGeneration: number;
}

const decodeUnknownJsonString = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const isMemorySearchIndexError = Schema.is(MemorySearchIndexError);

const persistenceError = (cause: unknown) =>
  isMemorySearchIndexError(cause)
    ? cause
    : new MemorySearchIndexError({
        reason: "persistence",
        message: "The Command Center memory search index operation failed.",
        cause,
      });

const compileFtsQuery = (query: string): string | undefined => {
  const terms = query
    .normalize("NFKC")
    .match(/[\p{L}\p{N}]+/gu)
    ?.slice(0, 32);
  if (terms === undefined || terms.length === 0) return undefined;
  return terms.map((term) => `"${term}"`).join(" AND ");
};

const boundedLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) return 20;
  return Math.max(1, Math.min(100, Math.trunc(limit)));
};

export const layer = Layer.effect(
  MemorySearchIndex,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const textEncoder = new TextEncoder();
    const rebuildLock = yield* Semaphore.make(1);

    const digest = Effect.fn("MemorySearchIndex.digest")(function* (content: string) {
      const value = yield* crypto.digest("SHA-256", textEncoder.encode(content));
      return `sha256:${Encoding.encodeHex(value)}`;
    });

    const rebuild = Effect.fn("MemorySearchIndex.rebuild")(function* () {
      const rebuiltAt = DateTime.formatIso(yield* DateTime.now);
      const sourceRows = yield* sql<SourceMemoryRow>`
          SELECT memory.id, memory.owner_id AS "ownerId", memory.space_id AS "spaceId",
            memory.repository_ref AS "repositoryRef", memory.scope, memory.kind, memory.status,
            memory.content, memory.confidence, memory.provenance_json AS "provenanceJson",
            memory.expires_at AS "expiresAt", memory.created_at AS "createdAt",
            memory.updated_at AS "updatedAt"
          FROM command_center_memories memory
          JOIN command_center_spaces space
            ON space.id = memory.space_id AND space.lifecycle = 'active'
          WHERE memory.status IN ('approved', 'archive')
            AND (memory.scope != 'repository' OR memory.repository_ref IS NOT NULL)
            AND (
              memory.status = 'archive' OR memory.kind = 'archive' OR
              memory.expires_at IS NULL OR memory.expires_at > ${rebuiltAt}
            )
          ORDER BY memory.created_at, memory.id
        `;

      let trustedCount = 0;
      let archiveCount = 0;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM command_center_memory_search_fts`;
          yield* sql`DELETE FROM command_center_memory_search_embeddings`;
          yield* sql`DELETE FROM command_center_memory_search_documents`;

          for (const row of sourceRows) {
            const isArchive = row.status === "archive" || row.kind === "archive";
            if (isArchive) archiveCount += 1;
            else trustedCount += 1;
            const contentDigest = yield* digest(row.content);
            const trust = isArchive ? "untrusted_archive" : "trusted";
            const readOnly = isArchive ? 1 : 0;
            yield* sql`
                INSERT INTO command_center_memory_search_documents (
                  memory_id, owner_id, space_id, repository_ref, scope, kind, trust,
                  read_only, content, confidence, content_digest, provenance_json,
                  source_status, source_created_at, source_updated_at, expires_at, indexed_at
                ) VALUES (
                  ${row.id}, ${row.ownerId}, ${row.spaceId}, ${row.repositoryRef}, ${row.scope},
                  ${row.kind}, ${trust}, ${readOnly}, ${row.content}, ${row.confidence},
                  ${contentDigest}, ${row.provenanceJson}, ${row.status}, ${row.createdAt},
                  ${row.updatedAt}, ${row.expiresAt}, ${rebuiltAt}
                )
              `;
            yield* sql`
                INSERT INTO command_center_memory_search_fts (memory_id, content)
                VALUES (${row.id}, ${row.content})
              `;
          }

          yield* sql`
              INSERT INTO command_center_memory_search_state (
                singleton, generation, rebuilt_at, document_count, trusted_count, archive_count,
                source_generation, indexed_source_generation
              ) VALUES (
                1, 1, ${rebuiltAt}, ${sourceRows.length}, ${trustedCount}, ${archiveCount}, 0, 0
              )
              ON CONFLICT(singleton) DO UPDATE SET
                generation = generation + 1,
                rebuilt_at = excluded.rebuilt_at,
                document_count = excluded.document_count,
                trusted_count = excluded.trusted_count,
                archive_count = excluded.archive_count,
                indexed_source_generation = source_generation
            `;
        }),
      );

      const state = yield* sql<SearchStateRow>`
          SELECT generation
          FROM command_center_memory_search_state
          WHERE singleton = 1
        `;
      const generation = state[0]?.generation;
      if (generation === undefined) {
        return yield* new MemorySearchIndexError({
          reason: "persistence",
          message: "The memory search index state is missing.",
        });
      }
      return {
        generation,
        rebuiltAt,
        documentCount: sourceRows.length,
        trustedCount,
        archiveCount,
      } satisfies MemorySearchRebuildResult;
    }, Effect.mapError(persistenceError));

    const readState = Effect.fn("MemorySearchIndex.readState")(function* () {
      const rows = yield* sql<SearchStateRow>`
        SELECT generation, source_generation AS "sourceGeneration",
          indexed_source_generation AS "indexedSourceGeneration"
        FROM command_center_memory_search_state
        WHERE singleton = 1
      `;
      const state = rows[0];
      if (state === undefined) {
        return yield* new MemorySearchIndexError({
          reason: "persistence",
          message: "The memory search index state is missing.",
        });
      }
      return state;
    }, Effect.mapError(persistenceError));

    const ensureCurrent = Effect.fn("MemorySearchIndex.ensureCurrent")(function* () {
      const state = yield* readState();
      if (state.sourceGeneration === state.indexedSourceGeneration) return null;
      return yield* rebuildLock.withPermits(1)(
        Effect.gen(function* () {
          const lockedState = yield* readState();
          if (lockedState.sourceGeneration === lockedState.indexedSourceGeneration) return null;
          return yield* rebuild();
        }),
      );
    }, Effect.mapError(persistenceError));

    const search = Effect.fn("MemorySearchIndex.search")(function* (input: MemorySearchInput) {
      const ftsQuery = compileFtsQuery(input.query);
      if (ftsQuery === undefined) {
        return yield* new MemorySearchIndexError({
          reason: "invalid-query",
          message: "Memory search needs at least one letter or number.",
        });
      }

      yield* ensureCurrent();

      const now = DateTime.formatIso(yield* DateTime.now);
      const repositoryRef = input.repositoryRef ?? null;
      const includeArchives = input.includeArchives === false ? 0 : 1;
      const rows = yield* sql<SearchRow>`
          SELECT document.memory_id AS "memoryId", document.space_id AS "spaceId",
            document.repository_ref AS "repositoryRef", document.scope, document.kind,
            document.content, document.confidence, document.trust,
            document.read_only AS "readOnly", document.provenance_json AS "provenanceJson",
            document.source_created_at AS "sourceCreatedAt",
            document.source_updated_at AS "sourceUpdatedAt",
            bm25(command_center_memory_search_fts) AS rank
          FROM command_center_memory_search_fts
          JOIN command_center_memory_search_documents document
            ON document.memory_id = command_center_memory_search_fts.memory_id
          JOIN command_center_memories memory ON memory.id = document.memory_id
          JOIN command_center_spaces space
            ON space.id = document.space_id AND space.lifecycle = 'active'
          WHERE command_center_memory_search_fts MATCH ${ftsQuery}
            AND document.owner_id = ${input.ownerId ?? "local-user"}
            AND document.space_id = ${input.spaceId}
            AND document.source_updated_at = memory.updated_at
            AND (
              document.scope IN ('global', 'space') OR
              (
                document.scope = 'repository' AND ${repositoryRef} IS NOT NULL AND
                document.repository_ref = ${repositoryRef}
              )
            )
            AND (
              (
                document.trust = 'trusted' AND memory.status = 'approved' AND
                memory.kind != 'archive' AND
                (memory.expires_at IS NULL OR memory.expires_at > ${now})
              ) OR (
                ${includeArchives} = 1 AND document.trust = 'untrusted_archive' AND
                memory.status IN ('approved', 'archive') AND
                (memory.status = 'archive' OR memory.kind = 'archive')
              )
            )
          ORDER BY rank, document.source_updated_at DESC
          LIMIT ${boundedLimit(input.limit)}
        `;

      return yield* Effect.forEach(rows, (row) =>
        decodeUnknownJsonString(row.provenanceJson).pipe(
          Effect.map(
            (provenance) =>
              ({
                memoryId: row.memoryId,
                spaceId: row.spaceId,
                ...(row.repositoryRef === null ? {} : { repositoryRef: row.repositoryRef }),
                scope: row.scope,
                kind: row.kind,
                content: row.content,
                confidence: row.confidence,
                trust: row.trust === "trusted" ? "trusted" : "untrusted-archive",
                readOnly: row.readOnly === 1,
                provenance,
                sourceCreatedAt: row.sourceCreatedAt,
                sourceUpdatedAt: row.sourceUpdatedAt,
                rank: row.rank,
              }) satisfies MemorySearchResult,
          ),
        ),
      );
    }, Effect.mapError(persistenceError));

    return MemorySearchIndex.of({ rebuild, ensureCurrent, search });
  }),
);
