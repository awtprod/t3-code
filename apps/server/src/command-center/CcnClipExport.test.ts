// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";
import { CommandCenterError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { CcnRecordingBinding } from "./CcnPreparation.ts";
import { makeCcnClipExporter, renderBoundCcnClip } from "./CcnClipExport.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { canonicalJson } from "./automation/Digest.ts";

const available = NodeFS.existsSync("/usr/bin/ffmpeg") && NodeFS.existsSync("/usr/bin/ffprobe");
const started = "2026-09-28T12:00:00.000Z";

it.skipIf(!available)("renders one bounded MP4 and rejects unsafe or stale sources", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ccn-clip-test-"));
  const root = NodePath.join(directory, "approved");
  const exportsDirectory = NodePath.join(directory, "exports");
  await import("node:fs/promises").then((fs) => fs.mkdir(root));
  try {
    const source = NodePath.join(root, "fixture.mp4");
    NodeChildProcess.execFileSync(
      "/usr/bin/ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=160x90:rate=10",
        "-t",
        "2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        source,
      ],
      { timeout: 15_000 },
    );
    const digest = NodeCrypto.createHash("sha256")
      .update(await NodeFSP.readFile(source))
      .digest("hex");
    const binding: CcnRecordingBinding = {
      id: "binding-a",
      spaceId: "space-a",
      planId: "plan-a",
      taskId: "task-a",
      candidateKind: "clip",
      planVersion: 1,
      version: 1,
      performerId: "performer-a",
      performerName: "Performer A",
      recordingId: "recording-a",
      recordingVersion: "v1",
      rootId: "root-a",
      relativePath: "fixture.mp4",
      sourceSha256: digest,
    };
    const request = {
      spaceId: "space-a",
      planId: "plan-a",
      taskId: "task-a",
      planVersion: 1,
      bindingVersion: 1,
      performerId: "performer-a",
      runId: "run-a",
      requestId: "request-a",
      createdAt: started,
      startSeconds: 0.2,
      endSeconds: 1.2,
    };
    const config = {
      approvedRoots: { "root-a": root },
      exportsDirectory,
      ffprobePath: "/usr/bin/ffprobe",
      ffmpegPath: "/usr/bin/ffmpeg",
      maxOutputBytes: 5_000_000,
    };
    const rendered = await renderBoundCcnClip(request, binding, config);
    const replay = await renderBoundCcnClip(request, binding, config);
    expect(rendered.artifact.id).toBe(replay.artifact.id);
    expect(rendered.artifact.contentDigest).toBe(replay.artifact.contentDigest);
    expect(rendered.artifact.locator).toBe(`cc-artifact://${rendered.artifact.id}`);
    expect(rendered.artifact.provenance).not.toHaveProperty("path");
    expect(rendered.semanticStatus).toBe("unverified");
    expect(await NodeFSP.readdir(exportsDirectory)).toEqual([`${rendered.artifact.id}.mp4`]);

    await expect(
      renderBoundCcnClip({ ...request, endSeconds: 3 }, binding, config),
    ).rejects.toMatchObject({ reason: "validation" });
    await expect(
      renderBoundCcnClip({ ...request, performerId: "wrong" }, binding, config),
    ).rejects.toMatchObject({ reason: "validation" });
    await expect(
      renderBoundCcnClip(request, { ...binding, sourceSha256: "a".repeat(64) }, config),
    ).rejects.toMatchObject({ reason: "source" });
    await expect(
      renderBoundCcnClip(request, { ...binding, relativePath: "../fixture.mp4" }, config),
    ).rejects.toMatchObject({ reason: "source" });
    await NodeFSP.symlink(source, NodePath.join(root, "alias.mp4"));
    await expect(
      renderBoundCcnClip(request, { ...binding, relativePath: "alias.mp4" }, config),
    ).rejects.toMatchObject({ reason: "source" });
    await expect(
      renderBoundCcnClip({ ...request, requestId: "bad-render" }, binding, {
        ...config,
        ffmpegPath: "/definitely/missing/ffmpeg",
      }),
    ).rejects.toMatchObject({ reason: "render" });
    expect(await NodeFSP.readdir(exportsDirectory)).toEqual([`${rendered.artifact.id}.mp4`]);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it.effect("registers one artifact and receipt for an exact request", () =>
  Effect.gen(function* () {
    if (!available) return;
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ccn-receipt-test-")),
    );
    const root = NodePath.join(directory, "approved");
    const exportsDirectory = NodePath.join(directory, "exports");
    yield* Effect.promise(() => import("node:fs/promises").then((fs) => fs.mkdir(root)));
    try {
      const source = NodePath.join(root, "fixture.mp4");
      NodeChildProcess.execFileSync(
        "/usr/bin/ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc=size=160x90:rate=10",
          "-t",
          "2",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          source,
        ],
        { timeout: 15_000 },
      );
      const digest = NodeCrypto.createHash("sha256")
        .update(yield* Effect.promise(() => NodeFSP.readFile(source)))
        .digest("hex");
      const program = Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
        INSERT INTO command_center_spaces (id, slug, name, kind, created_at, updated_at)
        VALUES ('space-a', 'space-a', 'Synthetic CCN', 'business', ${started}, ${started})
      `;
        yield* sql`
        INSERT INTO command_center_sprint_plans (
          id, space_id, version, source_version, current_import_id,
          current_json, created_at, updated_at
        ) VALUES ('plan-a', 'space-a', 1, 1, 'source-a', '{}', ${started}, ${started})
      `;
        yield* sql`
        INSERT INTO command_center_runs (
          id, command_id, space_id, kind, state, route_json, input_json,
          started_at
        ) VALUES ('run-a', 'command-a', 'space-a', 'automation', 'running', '{}', '{}', ${started})
      `;
        yield* sql`
        INSERT INTO command_center_ccn_recording_bindings (
          id, space_id, plan_id, task_id, candidate_kind, plan_version, version,
          performer_id, performer_name, recording_id, recording_version,
          root_id, relative_path, source_sha256, created_at, updated_at
        ) VALUES (
          'binding-a', 'space-a', 'plan-a', 'task-a', 'clip', 1, 1,
          'performer-a', 'Performer A', 'recording-a', 'v1',
          'root-a', 'fixture.mp4', ${digest}, ${started}, ${started}
        )
      `;
        const commandCenter = {
          recordArtifact: ({
            artifact,
            sizeBytes,
          }: {
            artifact: import("@command-center/core").Artifact;
            sizeBytes?: number;
          }) =>
            sql`
            INSERT OR IGNORE INTO command_center_artifacts (
              id, space_id, run_id, kind, title, uri, content_digest,
              provenance_json, metadata_json, created_at
            ) VALUES (
              ${artifact.id}, ${artifact.spaceId}, ${artifact.runId ?? null},
              ${artifact.kind}, ${artifact.name}, ${artifact.locator},
              ${artifact.contentDigest}, ${canonicalJson({ kind: artifact.provenance.kind, capturedAt: artifact.provenance.capturedAt, sourceRef: artifact.provenance.sourceRef ?? "" })},
              ${canonicalJson({ sizeBytes: sizeBytes ?? null })}, ${artifact.createdAt}
            )
          `.pipe(
              Effect.as(artifact),
              Effect.mapError(
                (cause) =>
                  new CommandCenterError({
                    reason: "persistence",
                    message: "Fixture artifact insert failed.",
                    cause,
                  }),
              ),
            ),
        };
        const exporter = yield* makeCcnClipExporter({
          config: {
            approvedRoots: { "root-a": root },
            exportsDirectory,
            ffprobePath: "/usr/bin/ffprobe",
            ffmpegPath: "/usr/bin/ffmpeg",
          },
          commandCenter,
        });
        const request = {
          bindingId: "binding-a",
          spaceId: "space-a",
          planId: "plan-a",
          taskId: "task-a",
          planVersion: 1,
          bindingVersion: 1,
          performerId: "performer-a",
          runId: "run-a",
          requestId: "request-a",
          startSeconds: 0.1,
          endSeconds: 1.1,
        };
        yield* sql`UPDATE command_center_runs SET state = 'succeeded' WHERE id = 'run-a'`;
        expect(yield* exporter.exportClip(request).pipe(Effect.flip)).toMatchObject({
          reason: "validation",
        });
        yield* sql`UPDATE command_center_runs SET state = 'running' WHERE id = 'run-a'`;
        const first = yield* exporter.exportClip(request);
        const replay = yield* exporter.exportClip(request);
        expect(first.duplicate).toBe(false);
        expect(replay).toMatchObject({ artifactId: first.artifactId, duplicate: true });
        const changed = yield* exporter
          .exportClip({ ...request, endSeconds: 1.4 })
          .pipe(Effect.flip);
        expect(changed).toMatchObject({ reason: "validation" });
        const counts = yield* sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM command_center_ccn_exports
      `;
        expect(counts[0]?.count).toBe(1);
        const artifacts = yield* sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM command_center_artifacts
      `;
        expect(artifacts[0]?.count).toBe(1);
        const review = yield* sql<{ readonly status: string; readonly linksJson: string }>`
        SELECT status, links_json AS "linksJson" FROM command_center_items
        WHERE space_id = 'space-a' AND title = 'Review CCN clip for task-a'
      `;
        expect(review).toHaveLength(1);
        expect(review[0]?.status).toBe("review");
        expect(review[0]?.linksJson).toBe(canonicalJson([first.artifactId]));
      });
      yield* program.pipe(Effect.provide(SqlitePersistenceMemory));
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
    }
  }),
);
