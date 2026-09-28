// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import type { ServerConfig } from "../config.ts";
import type { CcnClipExportConfig } from "./CcnClipExport.ts";

const RootDocument = Schema.fromJsonString(
  Schema.Struct({
    roots: Schema.Array(
      Schema.Struct({
        id: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
        path: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1024)),
      }),
    ).check(Schema.isMaxLength(16)),
  }),
);
const decodeRootDocument = Schema.decodeUnknownSync(RootDocument);
const MAX_CONFIG_BYTES = 32 * 1024;

/** An absent file leaves clip preparation unavailable until an operator supplies roots. */
export async function loadCcnClipConfig(
  config: ServerConfig["Service"],
): Promise<CcnClipExportConfig> {
  const exportsDirectory = NodePath.join(config.attachmentsDir, "exports", "ccn");
  const approvedRoots: Record<string, string> = {};
  const disabled = {
    approvedRoots,
    exportsDirectory,
    ffprobePath: "/usr/bin/ffprobe",
    ffmpegPath: "/usr/bin/ffmpeg",
  };
  if (config.commandCenterConfigDir === undefined) {
    return disabled;
  }
  const file = NodePath.join(config.commandCenterConfigDir, "ccn-recording-roots.json");
  let handle;
  try {
    handle = await NodeFSP.open(
      file,
      NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
    );
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return disabled;
    }
    throw cause;
  }
  let content: string;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) {
      throw new Error("CCN recording root configuration is not a bounded regular file.");
    }
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_CONFIG_BYTES || bytesRead !== info.size) {
      throw new Error("CCN recording root configuration changed while reading.");
    }
    content = buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
  const document = decodeRootDocument(content);
  for (const entry of document.roots) {
    if (!NodePath.isAbsolute(entry.path) || approvedRoots[entry.id] !== undefined) {
      throw new Error("CCN recording roots must be unique absolute paths.");
    }
    approvedRoots[entry.id] = entry.path;
  }
  return disabled;
}
