/**
 * WindowsMediaConnector - browse a remote Windows host over SSH for the
 * composer's Windows media picker (`cc.windowsMedia.roots` / `.list`).
 *
 * Injection safety is structural, not escaping-based:
 * - `ssh` is spawned directly with an argv array (no local shell).
 * - The remote command is a STATIC PowerShell script passed via
 *   `-EncodedCommand`; it contains no request data at all.
 * - The requested path travels on stdin, base64-encoded UTF-8, and PowerShell
 *   only ever uses it as `-LiteralPath` data. A path such as
 *   `C:\x"; Remove-Item ...` is just a directory that does not exist.
 * - Output comes back as base64 UTF-8 JSON, so console code pages cannot
 *   mangle non-ASCII file names.
 *
 * @module WindowsMediaConnector
 */
import {
  type CommandCenterWindowsMediaEntry,
  type CommandCenterWindowsMediaListResult,
  type CommandCenterWindowsMediaRootsResult,
  WINDOWS_MEDIA_MAX_ENTRIES,
  type WindowsMediaEntryKind,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ProcessRunner } from "../processRunner.ts";
import {
  isDriveRoot,
  isPathAllowed,
  joinWindowsPath,
  normalizeWindowsPath,
  readWindowsMediaSettings,
  windowsParentPath,
  type WindowsMediaSettings,
} from "./WindowsMediaConfig.ts";

/** Cap on raw ssh stdout; the base64 JSON for WINDOWS_MEDIA_MAX_ENTRIES fits well inside. */
export const WINDOWS_MEDIA_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const WINDOWS_MEDIA_TIMEOUT = "30 seconds";

export class WindowsMediaConnectorError extends Schema.TaggedErrorClass<WindowsMediaConnectorError>()(
  "WindowsMediaConnectorError",
  {
    reason: Schema.Literals([
      "disabled",
      "forbidden",
      "invalid_path",
      "not_found",
      "process",
      "output",
    ]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

// ---------------------------------------------------------------------------
// Static PowerShell scripts. They never contain request data.
// ---------------------------------------------------------------------------

const PS_EMIT = `$j=ConvertTo-Json -InputObject $o -Depth 5 -Compress
[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j)))`;

export const WINDOWS_MEDIA_LIST_SCRIPT = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$max=${WINDOWS_MEDIA_MAX_ENTRIES}
try{
$b=[Console]::In.ReadToEnd().Trim()
$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b))
$d=Get-Item -LiteralPath $p
if(-not $d.PSIsContainer){$o=@{ok=$false;code='not_dir';err='Not a directory.'}}else{
$all=@(Get-ChildItem -LiteralPath $p -ErrorAction SilentlyContinue)
$e=@($all|Select-Object -First $max|ForEach-Object{@{n=$_.Name;d=[bool]$_.PSIsContainer;s=$(if($_.PSIsContainer){[int64]0}else{[int64]$_.Length});m=$_.LastWriteTimeUtc.ToString('o')}})
$o=@{ok=$true;t=($all.Count -gt $max);e=$e}}
}catch [System.Management.Automation.ItemNotFoundException]{$o=@{ok=$false;code='not_found';err=$_.Exception.Message}
}catch{$o=@{ok=$false;code='error';err=$_.Exception.Message}}
${PS_EMIT}`;

export const WINDOWS_MEDIA_ROOTS_SCRIPT = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
try{
$r=@(Get-PSDrive -PSProvider FileSystem|ForEach-Object{@{n=$_.Name;root=$_.Root;l=[string]$_.Description}})
$o=@{ok=$true;r=$r}
}catch{$o=@{ok=$false;code='error';err=$_.Exception.Message}}
${PS_EMIT}`;

const encodePowerShellCommand = (script: string): string =>
  Buffer.from(script, "utf16le").toString("base64");

const LIST_ENCODED = encodePowerShellCommand(WINDOWS_MEDIA_LIST_SCRIPT);
const ROOTS_ENCODED = encodePowerShellCommand(WINDOWS_MEDIA_ROOTS_SCRIPT);

/**
 * The full ssh argv. Only settings (validated alias, absolute config path) and
 * the static encoded script appear here — never the requested path.
 */
export function windowsMediaSshArgs(
  settings: Pick<WindowsMediaSettings, "sshConfigPath" | "hostAlias">,
  operation: "list" | "roots",
): ReadonlyArray<string> {
  return [
    "-F",
    settings.sshConfigPath,
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-T",
    "--",
    settings.hostAlias,
    "powershell",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    operation === "list" ? LIST_ENCODED : ROOTS_ENCODED,
  ];
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

const VIDEO_MIME: Record<string, string> = {
  mov: "video/quicktime",
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  mkv: "video/x-matroska",
  webm: "video/webm",
  avi: "video/x-msvideo",
  mxf: "application/mxf",
  mts: "video/mp2t",
  m2ts: "video/mp2t",
  ts: "video/mp2t",
  wmv: "video/x-ms-wmv",
  braw: "video/x-braw",
  r3d: "video/x-r3d",
  mpg: "video/mpeg",
  mpeg: "video/mpeg",
};
const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  tif: "image/tiff",
  tiff: "image/tiff",
  bmp: "image/bmp",
  heic: "image/heic",
  dng: "image/x-adobe-dng",
  exr: "image/x-exr",
  dpx: "image/x-dpx",
};
const AUDIO_MIME: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  aac: "audio/aac",
  m4a: "audio/mp4",
  flac: "audio/flac",
  aif: "audio/aiff",
  aiff: "audio/aiff",
  ogg: "audio/ogg",
};

export function classifyWindowsMediaEntry(
  name: string,
  isDir: boolean,
): { readonly kind: WindowsMediaEntryKind; readonly mimeType: string } {
  if (isDir) return { kind: "dir", mimeType: "inode/directory" };
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  const video = VIDEO_MIME[extension];
  if (video) return { kind: "video", mimeType: video };
  const image = IMAGE_MIME[extension];
  if (image) return { kind: "image", mimeType: image };
  const audio = AUDIO_MIME[extension];
  if (audio) return { kind: "audio", mimeType: audio };
  return { kind: "other", mimeType: "application/octet-stream" };
}

const RawListEntry = Schema.Struct({
  n: Schema.String,
  d: Schema.Boolean,
  s: Schema.Number,
  m: Schema.optional(Schema.NullOr(Schema.String)),
});
const RawRoot = Schema.Struct({
  n: Schema.String,
  root: Schema.String,
  l: Schema.optional(Schema.NullOr(Schema.String)),
});
/** ConvertTo-Json may emit one element as a bare object; accept both shapes. */
const arrayOrSingle = <S extends Schema.Top>(item: S) => Schema.Union([Schema.Array(item), item]);
const RawResponse = Schema.Struct({
  ok: Schema.Boolean,
  code: Schema.optional(Schema.String),
  err: Schema.optional(Schema.NullOr(Schema.String)),
  t: Schema.optional(Schema.Boolean),
  e: Schema.optional(Schema.NullOr(arrayOrSingle(RawListEntry))),
  r: Schema.optional(Schema.NullOr(arrayOrSingle(RawRoot))),
});
type RawResponse = typeof RawResponse.Type;
const decodeRawResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(RawResponse));

const toArray = <A>(value: ReadonlyArray<A> | A | null | undefined): ReadonlyArray<A> =>
  value === null || value === undefined ? [] : Array.isArray(value) ? value : [value as A];

/** Decode the connector's base64(UTF-8 JSON) stdout. Exposed for tests. */
export const decodeWindowsMediaOutput = (stdout: string) =>
  Effect.gen(function* () {
    const line =
      stdout
        .split(/\r?\n/u)
        .map((entry) => entry.trim())
        .findLast((entry) => /^[A-Za-z0-9+/=]+$/u.test(entry) && entry.length > 0) ?? "";
    if (line.length === 0) {
      return yield* new WindowsMediaConnectorError({
        reason: "output",
        message: "The Windows host returned no listing.",
      });
    }
    const json = Buffer.from(line, "base64").toString("utf8");
    return yield* decodeRawResponse(json).pipe(
      Effect.mapError(
        (cause) =>
          new WindowsMediaConnectorError({
            reason: "output",
            message: "The Windows host returned an unreadable listing.",
            cause,
          }),
      ),
    );
  });

export function toListResult(input: {
  readonly host: string;
  readonly path: string;
  readonly roots: ReadonlyArray<string> | null;
  readonly raw: RawResponse;
}): CommandCenterWindowsMediaListResult {
  const rawEntries = toArray(input.raw.e);
  const entries: CommandCenterWindowsMediaEntry[] = [];
  for (const raw of rawEntries.slice(0, WINDOWS_MEDIA_MAX_ENTRIES)) {
    // A name with a separator or control characters cannot be a real child.
    if (raw.n.length === 0 || /[\\/\u0000-\u001f]/u.test(raw.n)) continue;
    const classified = classifyWindowsMediaEntry(raw.n, raw.d);
    entries.push({
      name: raw.n,
      path: joinWindowsPath(input.path, raw.n),
      isDir: raw.d,
      sizeBytes: raw.d ? 0 : Math.max(0, raw.s),
      mtime: raw.m ?? null,
      kind: classified.kind,
      mimeType: classified.mimeType,
    });
  }
  entries.sort((left, right) =>
    left.isDir === right.isDir
      ? left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true })
      : left.isDir
        ? -1
        : 1,
  );
  return {
    host: input.host,
    path: input.path,
    parent: windowsParentPath(input.path, input.roots),
    entries,
    truncated: input.raw.t === true || rawEntries.length > WINDOWS_MEDIA_MAX_ENTRIES,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface WindowsMediaConnectorShape {
  readonly settings: WindowsMediaSettings;
  readonly roots: () => Effect.Effect<
    CommandCenterWindowsMediaRootsResult,
    WindowsMediaConnectorError
  >;
  readonly list: (
    path: string,
  ) => Effect.Effect<CommandCenterWindowsMediaListResult, WindowsMediaConnectorError>;
}

export class WindowsMediaConnector extends Context.Service<
  WindowsMediaConnector,
  WindowsMediaConnectorShape
>()("@awtprod/command-center/command-center/WindowsMediaConnector") {}

export const make = (settings: WindowsMediaSettings) =>
  Effect.gen(function* () {
    const runner = yield* ProcessRunner;

    const requireEnabled = settings.enabled
      ? Effect.void
      : Effect.fail(
          new WindowsMediaConnectorError({
            reason: "disabled",
            message: "The Windows media picker is not enabled on this server.",
          }),
        );

    const runRemote = Effect.fn("WindowsMediaConnector.runRemote")(function* (
      operation: "list" | "roots",
      stdin: string,
    ) {
      const result = yield* runner
        .run({
          command: "ssh",
          args: windowsMediaSshArgs(settings, operation),
          stdin,
          timeout: WINDOWS_MEDIA_TIMEOUT,
          maxOutputBytes: WINDOWS_MEDIA_MAX_OUTPUT_BYTES,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new WindowsMediaConnectorError({
                reason: "process",
                message: `Could not reach Windows host ${settings.hostAlias} over SSH.`,
                cause,
              }),
          ),
        );
      if (result.code !== 0) {
        return yield* new WindowsMediaConnectorError({
          reason: "process",
          message: `SSH to ${settings.hostAlias} failed (exit ${String(result.code)}): ${result.stderr.trim().slice(0, 500)}`,
        });
      }
      return yield* decodeWindowsMediaOutput(result.stdout);
    });

    const roots: WindowsMediaConnectorShape["roots"] = Effect.fn("WindowsMediaConnector.roots")(
      function* () {
        yield* requireEnabled;
        if (settings.roots !== null) {
          return {
            host: settings.hostAlias,
            roots: settings.roots.map((root) => ({ label: root, path: root })),
          };
        }
        const raw = yield* runRemote("roots", "");
        if (!raw.ok) {
          return yield* new WindowsMediaConnectorError({
            reason: "process",
            message: raw.err ?? "Could not enumerate drives.",
          });
        }
        const drives = toArray(raw.r)
          .map((drive) => ({ drive, path: normalizeWindowsPath(drive.root) }))
          .filter(
            (entry): entry is { drive: (typeof entry)["drive"]; path: string } =>
              entry.path !== null && isDriveRoot(entry.path),
          )
          .map(({ drive, path }) => ({
            label:
              drive.l && drive.l.trim().length > 0
                ? `${drive.l.trim()} (${drive.n}:)`
                : `${drive.n}:`,
            path,
          }))
          .sort((left, right) => left.path.localeCompare(right.path));
        return { host: settings.hostAlias, roots: drives };
      },
    );

    const list: WindowsMediaConnectorShape["list"] = Effect.fn("WindowsMediaConnector.list")(
      function* (requestedPath: string) {
        yield* requireEnabled;
        const path = normalizeWindowsPath(requestedPath);
        if (path === null) {
          return yield* new WindowsMediaConnectorError({
            reason: "invalid_path",
            message: "Expected an absolute Windows path such as C:\\Users.",
          });
        }
        if (!isPathAllowed(path, settings.roots)) {
          return yield* new WindowsMediaConnectorError({
            reason: "forbidden",
            message: "That folder is outside the browsable roots configured for this server.",
          });
        }
        const stdin = Buffer.from(path, "utf8").toString("base64");
        const raw = yield* runRemote("list", stdin);
        if (!raw.ok) {
          return yield* new WindowsMediaConnectorError({
            reason: raw.code === "not_found" || raw.code === "not_dir" ? "not_found" : "process",
            message: raw.err ?? "Could not list that folder.",
          });
        }
        return toListResult({ host: settings.hostAlias, path, roots: settings.roots, raw });
      },
    );

    return WindowsMediaConnector.of({ settings, roots, list });
  });

export const layerWithSettings = (settings: WindowsMediaSettings) =>
  Layer.effect(WindowsMediaConnector, make(settings));

export const layer = Layer.effect(
  WindowsMediaConnector,
  Effect.flatMap(readWindowsMediaSettings, make),
);
