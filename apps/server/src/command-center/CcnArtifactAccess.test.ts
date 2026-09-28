// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ccnByteRange, issueCcnPreviewUrl, resolveCcnPreview } from "./CcnArtifactAccess.ts";

const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "ccn-preview-test-",
});
const testLayer = Layer.mergeAll(
  SqlitePersistenceMemory,
  configLayer,
  ServerSecretStore.layer.pipe(Layer.provide(configLayer)),
).pipe(Layer.provideMerge(NodeServices.layer));

it("bounds and rejects malformed single byte ranges", () => {
  expect(ccnByteRange(undefined, 100)).toEqual({ status: 200, offset: 0, bytesToRead: 100 });
  expect(ccnByteRange("bytes=10-19", 100)).toEqual({
    status: 206,
    offset: 10,
    bytesToRead: 10,
    contentRange: "bytes 10-19/100",
  });
  expect(ccnByteRange("bytes=-5", 100)).toEqual({
    status: 206,
    offset: 95,
    bytesToRead: 5,
    contentRange: "bytes 95-99/100",
  });
  expect(ccnByteRange("bytes=90-", 100)).toEqual({
    status: 206,
    offset: 90,
    bytesToRead: 10,
    contentRange: "bytes 90-99/100",
  });
  for (const header of ["bytes=100-", "bytes=20-10", "bytes=-0", "bytes=0-1,3-4", "bytes=NaN-"]) {
    expect(ccnByteRange(header, 100).status).toBe(416);
  }
  const cap = ccnByteRange("bytes=0-", 20 * 1024 * 1024);
  expect(cap.status).toBe(206);
  expect(cap.bytesToRead).toBe(8 * 1024 * 1024);
  const suffixCap = ccnByteRange("bytes=-20000000", 20 * 1024 * 1024);
  expect(suffixCap.offset).toBe(12 * 1024 * 1024);
});

it.effect("issues a signed URL only for a matching Space receipt and rejects tampering", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const config = yield* ServerConfig.ServerConfig;
    const artifactId = `ccn-clip-${"a".repeat(48)}`;
    const file = NodePath.join(config.attachmentsDir, "exports", "ccn", `${artifactId}.mp4`);
    const bytes = Buffer.from("synthetic-review-bytes");
    const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
    yield* Effect.promise(() => NodeFSP.mkdir(NodePath.dirname(file), { recursive: true }));
    yield* Effect.promise(() => NodeFSP.writeFile(file, bytes));
    const timestamp = "2026-09-28T12:00:00.000Z";
    yield* sql`INSERT INTO command_center_spaces (id, slug, name, kind, created_at, updated_at)
      VALUES ('space-a', 'space-a', 'A', 'business', ${timestamp}, ${timestamp})`;
    yield* sql`INSERT INTO command_center_spaces (id, slug, name, kind, created_at, updated_at)
      VALUES ('space-b', 'space-b', 'B', 'business', ${timestamp}, ${timestamp})`;
    yield* sql`INSERT INTO command_center_sprint_plans
      (id, space_id, version, source_version, current_import_id, current_json, created_at, updated_at)
      VALUES ('plan-a', 'space-a', 1, 1, 'import-a', '{}', ${timestamp}, ${timestamp})`;
    yield* sql`INSERT INTO command_center_runs
      (id, command_id, space_id, kind, state, route_json, input_json, started_at)
      VALUES ('run-a', 'command-a', 'space-a', 'automation', 'succeeded', '{}', '{}', ${timestamp})`;
    yield* sql`INSERT INTO command_center_ccn_recording_bindings
      (id, space_id, plan_id, task_id, candidate_kind, plan_version, version,
       performer_id, performer_name, recording_id, recording_version,
       root_id, relative_path, source_sha256, created_at, updated_at)
      VALUES ('binding-a', 'space-a', 'plan-a', 'task-a', 'clip', 1, 1,
        'performer-a', 'Performer A', 'recording-a', 'v1', 'root-a', 'fixture.mp4',
        ${"b".repeat(64)}, ${timestamp}, ${timestamp})`;
    yield* sql`INSERT INTO command_center_artifacts
      (id, space_id, run_id, kind, title, uri, content_digest, created_at)
      VALUES (${artifactId}, 'space-a', 'run-a', 'export', 'Synthetic clip',
        ${`cc-artifact://${artifactId}`}, ${digest}, ${timestamp})`;
    yield* sql`INSERT INTO command_center_ccn_exports
      (request_id, request_digest, space_id, plan_id, task_id, binding_id,
       binding_version, plan_version, run_id, artifact_id, content_digest,
       size_bytes, provenance_json, created_at)
      VALUES ('request-a', ${"c".repeat(64)}, 'space-a', 'plan-a', 'task-a',
        'binding-a', 1, 1, 'run-a', ${artifactId}, ${digest}, ${bytes.length}, '{}', ${timestamp})`;
    expect(yield* issueCcnPreviewUrl({ spaceId: "space-b", artifactId })).toBeNull();
    const issued = yield* issueCcnPreviewUrl({ spaceId: "space-a", artifactId });
    expect(issued?.relativeUrl).toContain(`/api/ccn/artifacts/`);
    const token = issued!.relativeUrl.split("/")[4]!;
    expect(yield* resolveCcnPreview(token, artifactId)).toEqual({ file, sizeBytes: bytes.length });
    expect(yield* resolveCcnPreview(`${token}x`, artifactId)).toBeNull();
    expect(yield* resolveCcnPreview(token, `ccn-clip-${"d".repeat(48)}`)).toBeNull();
    yield* sql`UPDATE command_center_spaces SET lifecycle = 'archived' WHERE id = 'space-a'`;
    expect(yield* resolveCcnPreview(token, artifactId)).toBeNull();
    yield* sql`UPDATE command_center_spaces SET lifecycle = 'active' WHERE id = 'space-a'`;
    yield* Effect.promise(() => NodeFSP.writeFile(file, Buffer.alloc(bytes.length, 0)));
    expect(yield* resolveCcnPreview(token, artifactId)).toBeNull();
    yield* Effect.promise(() => NodeFSP.rm(file));
    yield* Effect.promise(() =>
      NodeFSP.symlink(NodePath.join(config.attachmentsDir, "other.mp4"), file),
    );
    expect(yield* resolveCcnPreview(token, artifactId)).toBeNull();
  }).pipe(Effect.provide(testLayer)),
);
