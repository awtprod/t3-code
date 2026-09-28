// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";

const SIGNING_SECRET_NAME = "asset-access-signing-key";
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_RANGE_BYTES = 8 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
const ARTIFACT_ID = /^ccn-clip-[a-f0-9]{48}$/u;
const Claims = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    spaceId: Schema.String,
    artifactId: Schema.String,
    contentDigest: Schema.String,
    sizeBytes: Schema.Int,
    expiresAt: Schema.Number,
  }),
);
const encodeClaims = Schema.encodeSync(Claims);
const decodeClaims = Schema.decodeUnknownOption(Claims);
type ClaimsType = typeof Claims.Type;

export interface CcnByteRange {
  readonly status: 200 | 206 | 416;
  readonly offset: number;
  readonly bytesToRead: number;
  readonly contentRange?: string;
}

export function ccnByteRange(header: string | undefined, size: number): CcnByteRange {
  if (!Number.isSafeInteger(size) || size <= 0)
    return { status: 416, offset: 0, bytesToRead: 0, contentRange: `bytes */${size}` };
  if (header === undefined) return { status: 200, offset: 0, bytesToRead: size };
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header);
  if (!match || (match[1] === "" && match[2] === "")) {
    return { status: 416, offset: 0, bytesToRead: 0, contentRange: `bytes */${size}` };
  }
  const suffix = match[1] === "";
  const first = Number(match[1]);
  const last = Number(match[2]);
  if (
    !Number.isSafeInteger(first) ||
    !Number.isSafeInteger(last) ||
    (suffix && last <= 0) ||
    (!suffix && first >= size) ||
    (!suffix && match[2] !== "" && last < first)
  ) {
    return { status: 416, offset: 0, bytesToRead: 0, contentRange: `bytes */${size}` };
  }
  const offset = suffix ? Math.max(0, size - Math.min(last, MAX_RANGE_BYTES)) : first;
  const requestedLast = suffix ? size - 1 : match[2] === "" ? size - 1 : Math.min(last, size - 1);
  const end = Math.min(requestedLast, offset + MAX_RANGE_BYTES - 1);
  return {
    status: 206,
    offset,
    bytesToRead: end - offset + 1,
    contentRange: `bytes ${offset}-${end}/${size}`,
  };
}

async function digestFile(file: string): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function inspectFile(
  file: string,
  size: number,
  digest: string,
  verifyDigest: boolean,
): Promise<boolean> {
  try {
    const info = await NodeFSP.lstat(file);
    return (
      info.isFile() &&
      !info.isSymbolicLink() &&
      info.size === size &&
      (!verifyDigest || (await digestFile(file)) === digest)
    );
  } catch {
    return false;
  }
}

const artifactRow = (sql: SqlClient.SqlClient, spaceId: string, artifactId: string) =>
  sql<{ readonly contentDigest: string; readonly sizeBytes: number }>`
    SELECT e.content_digest AS "contentDigest", e.size_bytes AS "sizeBytes"
    FROM command_center_ccn_exports e
    JOIN command_center_artifacts a ON a.id = e.artifact_id AND a.space_id = e.space_id
    JOIN command_center_spaces s ON s.id = e.space_id AND s.lifecycle = 'active'
    WHERE e.space_id = ${spaceId} AND e.artifact_id = ${artifactId}
      AND a.kind = 'export' AND a.uri = ${`cc-artifact://${artifactId}`}
      AND a.content_digest = e.content_digest
    LIMIT 1
  `;

export const issueCcnPreviewUrl = Effect.fn("CcnArtifactAccess.issue")(function* (input: {
  readonly spaceId: string;
  readonly artifactId: string;
}) {
  if (!ARTIFACT_ID.test(input.artifactId)) return null;
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  const rows = yield* artifactRow(sql, input.spaceId, input.artifactId);
  const row = rows[0];
  if (
    row === undefined ||
    !Number.isSafeInteger(row.sizeBytes) ||
    row.sizeBytes <= 0 ||
    row.sizeBytes > MAX_ARTIFACT_BYTES
  )
    return null;
  const file = NodePath.join(config.attachmentsDir, "exports", "ccn", `${input.artifactId}.mp4`);
  if (!(yield* Effect.promise(() => inspectFile(file, row.sizeBytes, row.contentDigest, true))))
    return null;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const secret = yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32);
  const expiresAt = (yield* Clock.currentTimeMillis) + PREVIEW_TTL_MS;
  const payload = base64UrlEncode(
    encodeClaims({
      version: 1,
      ...input,
      contentDigest: row.contentDigest,
      sizeBytes: row.sizeBytes,
      expiresAt,
    }),
  );
  return {
    relativeUrl: `/api/ccn/artifacts/${payload}.${signPayload(payload, secret)}/${input.artifactId}.mp4`,
    expiresAt,
  };
});

export const resolveCcnPreview = Effect.fn("CcnArtifactAccess.resolve")(function* (
  token: string,
  artifactId: string,
) {
  if (!ARTIFACT_ID.test(artifactId) || token.length > 2048) return null;
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra !== undefined) return null;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const secret = yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32);
  if (!timingSafeEqualBase64Url(signature, signPayload(encoded, secret))) return null;
  let claims: ClaimsType | null = null;
  try {
    claims = Option.getOrNull(decodeClaims(base64UrlDecodeUtf8(encoded)));
  } catch {
    return null;
  }
  if (
    claims === null ||
    claims.artifactId !== artifactId ||
    claims.expiresAt <= (yield* Clock.currentTimeMillis)
  )
    return null;
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* artifactRow(sql, claims.spaceId, artifactId);
  const row = rows[0];
  if (
    row === undefined ||
    !Number.isSafeInteger(row.sizeBytes) ||
    row.sizeBytes <= 0 ||
    row.sizeBytes > MAX_ARTIFACT_BYTES ||
    row.contentDigest !== claims.contentDigest ||
    row.sizeBytes !== claims.sizeBytes
  )
    return null;
  const config = yield* ServerConfig.ServerConfig;
  const file = NodePath.join(config.attachmentsDir, "exports", "ccn", `${artifactId}.mp4`);
  if (!(yield* Effect.promise(() => inspectFile(file, row.sizeBytes, row.contentDigest, true))))
    return null;
  return { file, sizeBytes: row.sizeBytes };
});
