// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { Artifact, type Artifact as ArtifactType } from "@command-center/core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { CcnRecordingBinding } from "./CcnPreparation.ts";
import { canonicalJson } from "./automation/Digest.ts";
import type { CommandCenterServiceShape } from "./Service.ts";

const MAX_PROBE_OUTPUT = 32 * 1024;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024 * 1024;
const MAX_CLIP_SECONDS = 90;
const SOURCE_EXTENSIONS = new Set([".mp4", ".mov", ".mkv"]);
const decodeArtifact = Schema.decodeUnknownSync(Artifact);
const decodeProbeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");

export class CcnClipExportError extends Error {
  readonly reason: "validation" | "source" | "probe" | "render" | "output";
  constructor(reason: "validation" | "source" | "probe" | "render" | "output", message: string) {
    super(message);
    this.name = "CcnClipExportError";
    this.reason = reason;
  }
}

export interface CcnClipExportInput extends Omit<CcnClipRequest, "createdAt"> {
  readonly bindingId: string;
}

export interface CcnClipReceipt {
  readonly artifactId: string;
  readonly contentDigest: string;
  readonly sizeBytes: number;
  readonly semanticStatus: "unverified";
  readonly duplicate: boolean;
}

export const makeCcnClipExporter = Effect.fn("CcnClipExport.make")(function* (dependencies: {
  readonly config: CcnClipExportConfig;
  readonly commandCenter: Pick<CommandCenterServiceShape, "recordArtifact">;
}) {
  const sql = yield* SqlClient.SqlClient;

  const exportClip = Effect.fn("CcnClipExport.exportClip")(function* (input: CcnClipExportInput) {
    const requestDigest = sha256(
      canonicalJson([
        input.bindingId,
        input.spaceId,
        input.planId,
        input.taskId,
        input.planVersion,
        input.bindingVersion,
        input.performerId,
        input.runId,
        input.requestId,
        input.startSeconds,
        input.endSeconds,
      ]),
    );
    const previous = yield* sql<{
      readonly requestDigest: string;
      readonly artifactId: string;
      readonly contentDigest: string;
      readonly sizeBytes: number;
    }>`
      SELECT request_digest AS "requestDigest", artifact_id AS "artifactId",
        content_digest AS "contentDigest", size_bytes AS "sizeBytes"
      FROM command_center_ccn_exports WHERE request_id = ${input.requestId} LIMIT 1
    `;
    if (previous[0] !== undefined) {
      if (previous[0].requestDigest !== requestDigest) {
        return yield* Effect.fail(
          new CcnClipExportError("validation", "Clip request ID was reused with different input."),
        );
      }
      const artifactPath = NodePath.join(
        dependencies.config.exportsDirectory,
        `${previous[0].artifactId}.mp4`,
      );
      const info = yield* Effect.tryPromise({
        try: () => NodeFSP.stat(artifactPath),
        catch: () => new CcnClipExportError("output", "Recorded clip file is unavailable."),
      });
      if (
        !info.isFile() ||
        info.size !== previous[0].sizeBytes ||
        (yield* Effect.tryPromise({
          try: () => hashFile(artifactPath),
          catch: () => new CcnClipExportError("output", "Recorded clip checksum is unavailable."),
        })) !== previous[0].contentDigest
      ) {
        return yield* Effect.fail(
          new CcnClipExportError("output", "Recorded clip no longer matches its receipt."),
        );
      }
      return {
        artifactId: previous[0].artifactId,
        contentDigest: previous[0].contentDigest,
        sizeBytes: previous[0].sizeBytes,
        semanticStatus: "unverified" as const,
        duplicate: true,
      };
    }
    const rows = yield* sql<CcnRecordingBinding>`
      SELECT id, space_id AS "spaceId", plan_id AS "planId", task_id AS "taskId",
        candidate_kind AS "candidateKind", plan_version AS "planVersion", version,
        performer_id AS "performerId", performer_name AS "performerName",
        recording_id AS "recordingId", recording_version AS "recordingVersion",
        root_id AS "rootId", relative_path AS "relativePath", source_sha256 AS "sourceSha256"
      FROM command_center_ccn_recording_bindings
      WHERE id = ${input.bindingId} AND space_id = ${input.spaceId}
        AND plan_id = ${input.planId} AND task_id = ${input.taskId}
      LIMIT 1
    `;
    const binding = rows[0];
    if (binding === undefined) {
      return yield* Effect.fail(
        new CcnClipExportError("validation", "Recording binding is unavailable."),
      );
    }
    const plans = yield* sql<{ readonly version: number }>`
      SELECT version FROM command_center_sprint_plans
      WHERE id = ${input.planId} AND space_id = ${input.spaceId} LIMIT 1
    `;
    if (plans[0]?.version !== input.planVersion) {
      return yield* Effect.fail(
        new CcnClipExportError("validation", "Sprint Plan version changed."),
      );
    }
    const runs = yield* sql<{ readonly startedAt: string | null }>`
      SELECT started_at AS "startedAt" FROM command_center_runs
      WHERE id = ${input.runId} AND space_id = ${input.spaceId}
        AND kind = 'automation' AND state = 'running' LIMIT 1
    `;
    if (runs[0]?.startedAt === undefined || runs[0]?.startedAt === null) {
      return yield* Effect.fail(
        new CcnClipExportError(
          "validation",
          "A running automation Run in the same Space is required.",
        ),
      );
    }
    const today = DateTime.formatIsoDateUtc(yield* DateTime.now);
    const [taskCount, runCount, dayCount] = yield* Effect.all([
      sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM command_center_ccn_exports
        WHERE space_id = ${input.spaceId} AND plan_id = ${input.planId} AND task_id = ${input.taskId}
      `,
      sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM command_center_ccn_exports WHERE run_id = ${input.runId}
      `,
      sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM command_center_ccn_exports
        WHERE space_id = ${input.spaceId}
          AND substr(created_at, 1, 10) = ${today}
      `,
    ]);
    if (
      (taskCount[0]?.count ?? 0) >= 30 ||
      (runCount[0]?.count ?? 0) >= 30 ||
      (dayCount[0]?.count ?? 0) >= 30
    ) {
      return yield* Effect.fail(
        new CcnClipExportError("validation", "CCN clip count budget is exhausted."),
      );
    }
    const rendered = yield* Effect.tryPromise({
      try: () =>
        renderBoundCcnClip(
          { ...input, createdAt: runs[0]!.startedAt! },
          binding,
          dependencies.config,
        ),
      catch: (cause) =>
        cause instanceof CcnClipExportError
          ? cause
          : new CcnClipExportError("render", "Clip export failed."),
    });
    yield* dependencies.commandCenter
      .recordArtifact({
        artifact: rendered.artifact,
        sizeBytes: rendered.sizeBytes,
        format: "mp4",
      })
      .pipe(
        Effect.mapError(
          () => new CcnClipExportError("output", "Clip artifact could not be registered."),
        ),
      );
    const provenance = canonicalJson({
      planId: input.planId,
      taskId: input.taskId,
      planVersion: input.planVersion,
      performerId: binding.performerId,
      recordingId: binding.recordingId,
      recordingVersion: binding.recordingVersion,
      bindingVersion: binding.version,
      sourceSha256: rendered.sourceDigest,
      sourceDurationSeconds: rendered.sourceDurationSeconds,
      startSeconds: rendered.startSeconds,
      endSeconds: rendered.endSeconds,
      renderProfile: "h264-aac-v1",
      semanticStatus: rendered.semanticStatus,
    });
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
        INSERT INTO command_center_ccn_exports (
          request_id, request_digest, space_id, plan_id, task_id, binding_id,
          binding_version, plan_version, run_id, artifact_id, content_digest,
          size_bytes, provenance_json, created_at
        ) VALUES (
          ${input.requestId}, ${requestDigest}, ${input.spaceId}, ${input.planId},
          ${input.taskId}, ${binding.id}, ${binding.version}, ${input.planVersion},
          ${input.runId}, ${rendered.artifact.id}, ${rendered.artifact.contentDigest},
          ${rendered.sizeBytes}, ${provenance}, ${now}
        )
      `;
        const itemId = `ccn-review:${sha256(rendered.artifact.id)}`;
        yield* sql`
        INSERT INTO command_center_items (
          id, space_id, kind, status, title, body, priority, due_at,
          source_json, links_json, metadata_json, created_at, updated_at
        ) VALUES (
          ${itemId}, ${input.spaceId}, 'task', 'review',
          ${`Review CCN clip for ${input.taskId}`},
          ${`Performer: ${binding.performerName}. Recording: ${binding.recordingId} (${binding.recordingVersion}). Range: ${input.startSeconds}–${input.endSeconds} seconds. Video stream verified; semantic fit requires human review. Sprint Plan task ${input.taskId} remains incomplete.`},
          'normal', NULL,
          ${canonicalJson({ kind: "automation", sourceRef: `ccn-preparation:${input.planId}:${input.taskId}`, capturedAt: now })},
          ${canonicalJson([rendered.artifact.id])},
          ${canonicalJson({
            ccn: {
              kind: "clip-review",
              planId: input.planId,
              taskId: input.taskId,
              performerId: binding.performerId,
              performerName: binding.performerName,
              recordingId: binding.recordingId,
              recordingVersion: binding.recordingVersion,
              startSeconds: input.startSeconds,
              endSeconds: input.endSeconds,
              sourceDurationSeconds: rendered.sourceDurationSeconds,
              semanticStatus: rendered.semanticStatus,
            },
          })},
          ${now}, ${now}
        )
      `;
      }),
    );
    return {
      artifactId: rendered.artifact.id,
      contentDigest: rendered.artifact.contentDigest,
      sizeBytes: rendered.sizeBytes,
      semanticStatus: "unverified" as const,
      duplicate: false,
    };
  });

  return { exportClip };
});

export interface CcnClipRequest {
  readonly spaceId: string;
  readonly planId: string;
  readonly taskId: string;
  readonly planVersion: number;
  readonly bindingVersion: number;
  readonly performerId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly createdAt: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
}

export interface CcnClipExportConfig {
  readonly approvedRoots: Readonly<Record<string, string>>;
  readonly exportsDirectory: string;
  readonly ffprobePath: string;
  readonly ffmpegPath: string;
  readonly maxSourceBytes?: number;
  readonly maxOutputBytes?: number;
  readonly maxClipSeconds?: number;
}

export interface CcnClipExportResult {
  readonly artifact: ArtifactType;
  readonly absolutePath: string;
  readonly sizeBytes: number;
  readonly sourceDigest: string;
  readonly sourceDurationSeconds: number;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly semanticStatus: "unverified";
}

async function runCommand(
  binary: string,
  args: ReadonlyArray<string>,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const commandSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  return await new Promise<string>((resolve, reject) => {
    const child = NodeChildProcess.spawn(binary, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      signal: commandSignal,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(error);
    };
    child.on("error", (error) => fail(error));
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout) > MAX_PROBE_OUTPUT)
        fail(new Error("Process output exceeded its limit."));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (Buffer.byteLength(stderr) > MAX_PROBE_OUTPUT)
        fail(new Error("Process error output exceeded its limit."));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve(stdout);
      else reject(new Error(`Process exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

async function probeVideo(binary: string, file: string, signal?: AbortSignal): Promise<number> {
  let parsed: unknown;
  try {
    const output = await runCommand(
      binary,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_type,width,height",
        "-of",
        "json",
        file,
      ],
      15_000,
      signal,
    );
    parsed = decodeProbeJson(output);
  } catch {
    throw new CcnClipExportError("probe", "Video probe failed or returned invalid data.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CcnClipExportError("probe", "Video probe returned an invalid document.");
  }
  const record = parsed as Record<string, unknown>;
  const format = record.format;
  const streams = record.streams;
  const duration =
    format !== null && typeof format === "object" && !Array.isArray(format)
      ? Number((format as Record<string, unknown>).duration)
      : NaN;
  const hasVideo =
    Array.isArray(streams) &&
    streams.some(
      (stream) =>
        stream !== null &&
        typeof stream === "object" &&
        !Array.isArray(stream) &&
        (stream as Record<string, unknown>).codec_type === "video" &&
        Number.isFinite((stream as Record<string, unknown>).width) &&
        Number.isFinite((stream as Record<string, unknown>).height),
    );
  if (!Number.isFinite(duration) || duration <= 0 || !hasVideo) {
    throw new CcnClipExportError("probe", "Source has no valid video stream or duration.");
  }
  return duration;
}

async function hashFile(file: string): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function resolveSource(
  binding: CcnRecordingBinding,
  config: CcnClipExportConfig,
  verifyDigest = true,
) {
  const root = config.approvedRoots[binding.rootId];
  if (root === undefined)
    throw new CcnClipExportError("source", "Approved recording root is unavailable.");
  if (
    NodePath.isAbsolute(binding.relativePath) ||
    binding.relativePath
      .split(/[\\/]/u)
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new CcnClipExportError("source", "Recording path escapes the approved root.");
  }
  const canonicalRoot = await NodeFSP.realpath(root);
  const source = NodePath.resolve(canonicalRoot, binding.relativePath);
  const canonicalSource = await NodeFSP.realpath(source);
  const relative = NodePath.relative(canonicalRoot, canonicalSource);
  if (relative === "" || relative.startsWith("..") || NodePath.isAbsolute(relative)) {
    throw new CcnClipExportError("source", "Recording resolves outside its approved root.");
  }
  if (!SOURCE_EXTENSIONS.has(NodePath.extname(canonicalSource).toLowerCase())) {
    throw new CcnClipExportError("source", "Recording container is not approved.");
  }
  const [linkInfo, info] = await Promise.all([
    NodeFSP.lstat(source),
    NodeFSP.stat(canonicalSource),
  ]);
  if (
    linkInfo.isSymbolicLink() ||
    !info.isFile() ||
    info.size <= 0 ||
    info.size > (config.maxSourceBytes ?? MAX_SOURCE_BYTES)
  ) {
    throw new CcnClipExportError("source", "Recording is not a bounded regular file.");
  }
  const sourceDigest = verifyDigest ? await hashFile(canonicalSource) : binding.sourceSha256;
  if (verifyDigest && sourceDigest !== binding.sourceSha256) {
    throw new CcnClipExportError("source", "Recording checksum changed after binding.");
  }
  return { canonicalSource, info, sourceDigest };
}

/** Availability preflight; the exporter repeats full checksum verification before rendering. */
export async function isCcnBindingSourceReady(
  binding: CcnRecordingBinding,
  config: CcnClipExportConfig,
): Promise<boolean> {
  try {
    await resolveSource(binding, config, false);
    return true;
  } catch {
    return false;
  }
}

export async function renderBoundCcnClip(
  request: CcnClipRequest,
  binding: CcnRecordingBinding,
  config: CcnClipExportConfig,
  signal?: AbortSignal,
): Promise<CcnClipExportResult> {
  if (
    binding.spaceId !== request.spaceId ||
    binding.planId !== request.planId ||
    binding.taskId !== request.taskId ||
    binding.planVersion !== request.planVersion ||
    binding.version !== request.bindingVersion ||
    binding.performerId !== request.performerId ||
    binding.candidateKind !== "clip"
  ) {
    throw new CcnClipExportError(
      "validation",
      "Recording binding no longer matches the selected task.",
    );
  }
  const length = request.endSeconds - request.startSeconds;
  if (
    !Number.isFinite(request.startSeconds) ||
    !Number.isFinite(request.endSeconds) ||
    request.startSeconds < 0 ||
    length <= 0 ||
    length > (config.maxClipSeconds ?? MAX_CLIP_SECONDS)
  ) {
    throw new CcnClipExportError("validation", "Clip range is invalid or exceeds the limit.");
  }
  if (!request.runId || !request.requestId || request.requestId.length > 200) {
    throw new CcnClipExportError("validation", "A bounded Run and request identity are required.");
  }
  const source = await resolveSource(binding, config);
  const duration = await probeVideo(config.ffprobePath, source.canonicalSource, signal);
  if (request.endSeconds > duration) {
    throw new CcnClipExportError("validation", "Clip range exceeds the probed source duration.");
  }
  const afterProbe = await NodeFSP.stat(source.canonicalSource);
  if (
    afterProbe.dev !== source.info.dev ||
    afterProbe.ino !== source.info.ino ||
    afterProbe.size !== source.info.size ||
    afterProbe.mtimeMs !== source.info.mtimeMs
  ) {
    throw new CcnClipExportError("source", "Recording changed after source verification.");
  }
  const id = `ccn-clip-${sha256(
    canonicalJson([
      request.requestId,
      request.spaceId,
      request.planId,
      request.taskId,
      request.planVersion,
      request.bindingVersion,
      request.performerId,
      request.runId,
      request.startSeconds,
      request.endSeconds,
      binding.recordingId,
      binding.recordingVersion,
      binding.sourceSha256,
    ]),
  ).slice(0, 48)}`;
  await NodeFSP.mkdir(config.exportsDirectory, { recursive: true });
  const finalPath = NodePath.join(config.exportsDirectory, `${id}.mp4`);
  const temporaryPath = NodePath.join(
    config.exportsDirectory,
    `.${id}.${NodeCrypto.randomUUID()}.tmp.mp4`,
  );
  let created = false;
  try {
    try {
      await NodeFSP.stat(finalPath);
    } catch {
      const args = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-ss",
        String(request.startSeconds),
        "-i",
        source.canonicalSource,
        "-t",
        String(length),
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-threads",
        "2",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        "-fs",
        String(config.maxOutputBytes ?? MAX_OUTPUT_BYTES),
        "-f",
        "mp4",
        temporaryPath,
      ];
      try {
        await runCommand(config.ffmpegPath, args, 120_000, signal);
      } catch {
        throw new CcnClipExportError("render", "Clip render failed or timed out.");
      }
      const afterRender = await NodeFSP.stat(source.canonicalSource);
      if (
        afterRender.dev !== source.info.dev ||
        afterRender.ino !== source.info.ino ||
        afterRender.size !== source.info.size ||
        afterRender.mtimeMs !== source.info.mtimeMs
      ) {
        throw new CcnClipExportError("source", "Recording changed during render.");
      }
      const tempInfo = await NodeFSP.stat(temporaryPath);
      if (
        !tempInfo.isFile() ||
        tempInfo.size <= 0 ||
        tempInfo.size > (config.maxOutputBytes ?? MAX_OUTPUT_BYTES)
      ) {
        throw new CcnClipExportError("output", "Rendered clip exceeds its output limit.");
      }
      await probeVideo(config.ffprobePath, temporaryPath, signal);
      try {
        await NodeFSP.link(temporaryPath, finalPath);
        created = true;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      }
    }
    const finalInfo = await NodeFSP.stat(finalPath);
    if (
      !finalInfo.isFile() ||
      finalInfo.size <= 0 ||
      finalInfo.size > (config.maxOutputBytes ?? MAX_OUTPUT_BYTES)
    ) {
      throw new CcnClipExportError(
        "output",
        "Rendered clip is missing or exceeds its output limit.",
      );
    }
    await probeVideo(config.ffprobePath, finalPath, signal);
    const contentDigest = await hashFile(finalPath);
    const createdAt = request.createdAt;
    const artifact = decodeArtifact({
      id,
      spaceId: request.spaceId,
      runId: request.runId,
      kind: "export",
      name: `CCN clip ${request.taskId}.mp4`,
      locator: `cc-artifact://${id}`,
      mimeType: "video/mp4",
      contentDigest,
      provenance: {
        kind: "automation",
        sourceRef: `ccn-recording:${binding.recordingId}@${binding.recordingVersion}`,
        capturedAt: createdAt,
      },
      createdAt,
    });
    return {
      artifact,
      absolutePath: finalPath,
      sizeBytes: finalInfo.size,
      sourceDigest: source.sourceDigest,
      sourceDurationSeconds: duration,
      startSeconds: request.startSeconds,
      endSeconds: request.endSeconds,
      semanticStatus: "unverified",
    };
  } catch (cause) {
    if (created) await NodeFSP.rm(finalPath, { force: true });
    throw cause;
  } finally {
    await NodeFSP.rm(temporaryPath, { force: true });
  }
}
