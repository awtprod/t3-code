// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodePath from "node:path";
import { CommandCenterError, type InstagramReelBinding } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import { InstagramTokenStore } from "./InstagramTokenStore.ts";
import { InstagramClient } from "./client.ts";
import { InstagramPublish, make, type InstagramPublishPorts } from "./InstagramPublish.ts";

import { makeInstagramReelMedia, type InstagramReelMediaOptions } from "./InstagramReelMedia.ts";

/** This is the host port used by the production layer, with injectable provider I/O. */
export const makeLiveReelHost = (
  options: InstagramReelMediaOptions,
): InstagramPublishPorts["host"] => {
  const media = makeInstagramReelMedia(options);
  return (binding) =>
    Effect.tryPromise({
      try: (signal) => media(binding, signal),
      catch: () => unavailable("Verified Instagram media hosting failed or is not configured."),
    });
};

const unavailable = (message: string) => new CommandCenterError({ reason: "validation", message });
const probe = NodeUtil.promisify(NodeChildProcess.execFile);
const DurationOutput = Schema.Struct({ format: Schema.Struct({ duration: Schema.String }) });
const decodeDuration = Schema.decodeUnknownSync(Schema.fromJsonString(DurationOutput));

/** Bounded streaming inspection; paths come only from the authorized thread/project root. */
export async function inspectReelFile(
  path: string,
  root: string,
  binding: InstagramReelBinding,
  signal: AbortSignal,
): Promise<void> {
  const [canonicalRoot, file] = await Promise.all([NodeFSP.realpath(root), NodeFSP.realpath(path)]);
  const rel = NodePath.relative(canonicalRoot, file);
  if (
    canonicalRoot !== binding.workspaceRoot ||
    rel !== binding.relativePath ||
    rel.startsWith("..") ||
    NodePath.isAbsolute(rel)
  )
    throw unavailable("Asset escaped or changed its approved canonical workspace binding.");
  const before = await NodeFSP.stat(file);
  if (!before.isFile() || before.size !== binding.sizeBytes)
    throw unavailable("Approved asset byte count changed.");
  const digest = NodeCrypto.createHash("sha256");
  let bytes = 0;
  const stream = NodeFS.createReadStream(file, { signal, highWaterMark: 65536 });
  try {
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > binding.sizeBytes) throw unavailable("Approved asset exceeded its byte bound.");
      digest.update(chunk);
    }
  } finally {
    stream.destroy();
  }
  if (bytes !== binding.sizeBytes || digest.digest("hex") !== binding.sha256)
    throw unavailable("Approved asset hash changed.");
  const output = await probe(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "json", file],
    { timeout: 5000, maxBuffer: 8192, signal },
  );
  const duration = decodeDuration(output.stdout);
  const ms = Math.round(Number(duration.format.duration) * 1000);
  const after = await NodeFSP.stat(file);
  if (
    !Number.isFinite(ms) ||
    ms !== binding.durationMs ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  )
    throw unavailable("Approved asset duration or bytes changed during inspection.");
}

export const layer = Layer.effect(
  InstagramPublish,
  Effect.gen(function* () {
    const tokens = yield* InstagramTokenStore;
    const projection = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const paths = yield* WorkspacePaths.WorkspacePaths;
    const inspect: InstagramPublishPorts["inspect"] = Effect.fn("InstagramPublishLive.inspect")(
      function* (b) {
        const thread = yield* projection
          .getThreadShellById(b.threadId)
          .pipe(Effect.mapError(() => unavailable("Authorized asset thread unavailable.")));
        if (Option.isNone(thread))
          return yield* unavailable("Authorized asset thread unavailable.");
        const project = yield* projection
          .getProjectShellById(thread.value.projectId)
          .pipe(Effect.mapError(() => unavailable("Authorized asset project unavailable.")));
        if (Option.isNone(project))
          return yield* unavailable("Authorized asset project unavailable.");
        const root = thread.value.worktreePath ?? project.value.workspaceRoot;
        const file = yield* paths
          .resolveRelativePathWithinRoot({ workspaceRoot: root, relativePath: b.relativePath })
          .pipe(Effect.mapError(() => unavailable("Asset is outside its authorized workspace.")));
        yield* Effect.tryPromise({
          try: (signal) => inspectReelFile(file.absolutePath, root, b, signal),
          catch: () => unavailable("Approved asset inspection failed or identity changed."),
        }).pipe(
          Effect.timeout("10 seconds"),
          Effect.mapError(() =>
            unavailable("Approved asset inspection failed or exceeded its deadline."),
          ),
        );
      },
    );
    const account: InstagramPublishPorts["account"] = Effect.gen(function* () {
      const snapshot = yield* tokens.publishingCredential;
      if (Option.isNone(snapshot))
        return yield* unavailable("Instagram account disconnected or token expired.");
      const credential = snapshot.value;
      const client = (signal: AbortSignal) =>
        new InstagramClient({ accessToken: credential.accessToken, signal });
      return {
        id: credential.igUserId,
        revision: credential.accountRevision,
        api: {
          create: (b, url, signal) =>
            client(signal).createMediaContainer(b.accountId, {
              mediaType: "REELS",
              videoUrl: url,
              caption: b.caption,
            }),
          status: (id, signal) => client(signal).getContainerStatus(id),
          publish: (b, id, signal) => client(signal).publishMedia(b.accountId, id),
          permalink: (id, signal) => client(signal).getMediaFields(id, ["permalink"]),
          recent: (b, signal) => client(signal).getUserMedia(b.accountId, { limit: 25 }),
        },
      };
    });
    return yield* make({
      account,
      inspect,
      host: makeLiveReelHost({
        receiptPath: Option.getOrUndefined(
          yield* Config.option(Config.String("INSTAGRAM_REEL_MEDIA_RECEIPT_PATH")),
        ),
        urlPath: Option.getOrUndefined(
          yield* Config.option(Config.String("INSTAGRAM_REEL_MEDIA_URL_PATH")),
        ),
      }),
    });
  }),
);
