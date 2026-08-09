import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { Artifact, type Artifact as ArtifactType } from "@command-center/core";
import type {
  CommandCenterError,
  GoogleDraftCreateRequest,
  GoogleReadRequest,
  GoogleReadResult,
} from "@t3tools/contracts";

import { ProcessRunner, type ProcessRunError } from "../processRunner.ts";
import { ServerConfig } from "../config.ts";
import { CommandCenterConfig } from "./Config.ts";
import { ConnectionHealth } from "./ConnectionHealth.ts";

export const PINNED_GOG_VERSION = "0.15.0";
export const MAX_GOOGLE_DRIVE_EXPORT_BYTES = 64 * 1024 * 1024;

export const hasPinnedGogVersion = (output: string): boolean =>
  /(?:^|[^0-9.])0\.15\.0(?:$|[^0-9.])/u.test(output);

/**
 * Keep helper lookup deterministic while honoring the operator-owned PATH used
 * to launch the server. Relative entries are excluded so a working-directory
 * change cannot substitute a different executable.
 */
export const buildGoogleHelperSearchPath = (
  binary: string,
  inheritedPath: string | undefined,
  path: Pick<Path.Path, "dirname" | "isAbsolute" | "sep">,
): string => {
  const delimiter = path.sep === "\\" ? ";" : ":";
  return Array.from(
    new Set(
      [
        ...(path.isAbsolute(binary) ? [path.dirname(binary)] : []),
        ...(inheritedPath?.split(delimiter) ?? []),
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
      ].filter((entry) => path.isAbsolute(entry)),
    ),
  ).join(delimiter);
};

export type GoogleDriveExportRequest = Extract<
  GoogleReadRequest,
  { readonly operation: "drive.export" }
>;
export type GoogleMetadataReadRequest = Exclude<GoogleReadRequest, GoogleDriveExportRequest>;
export type GoogleConnectionSelection = Pick<GoogleReadRequest, "spaceId" | "connectionId">;
type ResolvedGoogleMetadataReadRequest = GoogleMetadataReadRequest & {
  readonly account: string;
};
type ResolvedGoogleDriveExportRequest = GoogleDriveExportRequest & {
  readonly account: string;
};

export interface GoogleDriveExportedFile {
  readonly artifact: ArtifactType;
  readonly absolutePath: string;
  readonly sizeBytes: number;
  readonly format: GoogleDriveExportRequest["format"];
}

export const GOOGLE_READ_COMMAND_ALLOWLIST = [
  "gmail.search",
  "gmail.get",
  "gmail.thread.get",
  "calendar.events",
  "calendar.freebusy",
  "drive.search",
  "drive.ls",
  "drive.get",
  "drive.download",
] as const;
export const GOOGLE_DRAFT_COMMAND_ALLOWLIST = ["gmail.drafts.create"] as const;

export class GoogleReadConnectorError extends Schema.TaggedErrorClass<GoogleReadConnectorError>()(
  "GoogleReadConnectorError",
  {
    reason: Schema.Literals(["configuration", "version", "process", "output"]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const baseArgs = (account: string, allowlist: ReadonlyArray<string>): ReadonlyArray<string> => [
  "--account",
  account,
  "--gmail-no-send",
  "--no-input",
  "--json",
  "--enable-commands",
  allowlist.join(","),
];

/**
 * Build an argv array only; no shell interpolation is ever used. gog's Kong
 * parser accepts root flags after subcommands, so every caller-controlled
 * positional must follow `--` or it could override the server-bound account.
 */
export function buildGoogleReadInvocation(
  request: ResolvedGoogleMetadataReadRequest,
): ReadonlyArray<string> {
  const prefix = baseArgs(request.account, GOOGLE_READ_COMMAND_ALLOWLIST);
  switch (request.operation) {
    case "gmail.search":
      return [
        ...prefix,
        "gmail",
        "search",
        "--max",
        String(request.limit ?? 10),
        ...(request.page === undefined ? [] : ["--page", request.page]),
        "--",
        request.query,
      ];
    case "gmail.get":
      return [...prefix, "gmail", "get", "--sanitize-content", "--", request.messageId];
    case "gmail.thread.get":
      return [...prefix, "gmail", "thread", "get", "--sanitize-content", "--", request.threadId];
    case "calendar.events":
      return [
        ...prefix,
        "calendar",
        "events",
        "--from",
        request.from,
        "--to",
        request.to,
        "--max",
        String(request.limit ?? 25),
        "--",
        request.calendarId ?? "primary",
      ];
    case "calendar.freebusy":
      return [
        ...prefix,
        "calendar",
        "freebusy",
        "--from",
        request.from,
        "--to",
        request.to,
        "--",
        request.calendarIds.join(","),
      ];
    case "drive.search":
      return [
        ...prefix,
        "drive",
        "search",
        "--max",
        String(request.limit ?? 10),
        "--",
        request.query,
      ];
    case "drive.list":
      return [
        ...prefix,
        "drive",
        "ls",
        ...(request.parentId === undefined ? [] : ["--parent", request.parentId]),
        "--max",
        String(request.limit ?? 25),
      ];
    case "drive.get":
      return [...prefix, "drive", "get", "--", request.fileId];
  }
}

/** The output path is created by the connector; request payloads never contain filesystem paths. */
export function buildGoogleDriveExportInvocation(
  request: ResolvedGoogleDriveExportRequest,
  serverControlledOutputPath: string,
): ReadonlyArray<string> {
  return [
    ...baseArgs(request.account, GOOGLE_READ_COMMAND_ALLOWLIST),
    "drive",
    "download",
    "--out",
    serverControlledOutputPath,
    "--format",
    request.format,
    "--",
    request.fileId,
  ];
}

export interface GoogleReadConnectorShape {
  readonly verify: (
    selection: GoogleConnectionSelection,
  ) => Effect.Effect<void, GoogleReadConnectorError>;
  readonly read: (
    request: GoogleReadRequest,
  ) => Effect.Effect<GoogleReadResult, GoogleReadConnectorError>;
  readonly exportDrive: (
    request: GoogleDriveExportRequest,
  ) => Effect.Effect<GoogleDriveExportedFile, GoogleReadConnectorError>;
  readonly discardExport: (exported: GoogleDriveExportedFile) => Effect.Effect<void>;
  readonly createDraft?: (
    request: GoogleDraftCreateRequest,
    attachmentPaths: ReadonlyArray<string>,
  ) => Effect.Effect<Schema.Json, GoogleReadConnectorError>;
}

export class GoogleReadConnector extends Context.Service<
  GoogleReadConnector,
  GoogleReadConnectorShape
>()("@awtprod/command-center/command-center/GoogleReadConnector") {}

const decodeUnknownJsonString = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const decodeArtifact = Schema.decodeUnknownEffect(Artifact);
const isConnectorError = Schema.is(GoogleReadConnectorError);

const MIME_BY_EXPORT_FORMAT: Readonly<Record<GoogleDriveExportRequest["format"], string>> = {
  pdf: "application/pdf",
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  png: "image/png",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  md: "text/markdown",
};

const processFailure = (cause: ProcessRunError) =>
  new GoogleReadConnectorError({
    reason: "process",
    message: "The read-only Google connector could not be started.",
    cause,
  });

export const layer = Layer.effect(
  GoogleReadConnector,
  Effect.gen(function* () {
    const runner = yield* ProcessRunner;
    const serverConfig = yield* ServerConfig;
    const commandCenterConfig = yield* CommandCenterConfig;
    const connectionHealth = yield* ConnectionHealth;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const verified = yield* Ref.make(false);
    const binary = process.env.COMMAND_CENTER_GOG_BINARY ?? "gog";
    const gogHome = `${serverConfig.secretsDir}/gog`;
    const exportsDirectory = path.join(serverConfig.attachmentsDir, "exports");
    const googleEnvironment: NodeJS.ProcessEnv = {
      HOME: gogHome,
      XDG_CONFIG_HOME: gogHome,
      PATH: buildGoogleHelperSearchPath(binary, process.env.PATH, path),
      ...(process.env.GOG_KEYRING_PASSWORD === undefined
        ? {}
        : { GOG_KEYRING_PASSWORD: process.env.GOG_KEYRING_PASSWORD }),
      ...(process.env.GOG_KEYRING_BACKEND === undefined
        ? {}
        : { GOG_KEYRING_BACKEND: process.env.GOG_KEYRING_BACKEND }),
    };

    const resolveAccount = Effect.fn("GoogleReadConnector.resolveAccount")(function* (
      request: GoogleConnectionSelection,
    ) {
      return yield* commandCenterConfig
        .resolveGoogleAccount({
          spaceId: request.spaceId,
          connectionId: request.connectionId,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new GoogleReadConnectorError({
                reason: "configuration",
                message: "The requested Google connection is not available in this Space.",
                cause,
              }),
          ),
        );
    });

    const verifyBinary = Effect.fn("GoogleReadConnector.verifyBinary")(function* () {
      if (yield* Ref.get(verified)) return;
      const result = yield* runner
        .run({
          command: binary,
          args: ["--version"],
          env: googleEnvironment,
          extendEnv: false,
        })
        .pipe(Effect.mapError(processFailure));
      const versionOutput = `${result.stdout}\n${result.stderr}`;
      if (result.code !== 0 || !hasPinnedGogVersion(versionOutput)) {
        return yield* new GoogleReadConnectorError({
          reason: "version",
          message: `Command Center requires gog ${PINNED_GOG_VERSION}.`,
        });
      }
      yield* Ref.set(verified, true);
    });

    const ignoreHealthPersistenceFailure = <A>(update: Effect.Effect<A, CommandCenterError>) =>
      update.pipe(
        Effect.catch(() =>
          Effect.logWarning("Command Center could not persist non-secret connection health."),
        ),
      );

    const withConnectionHealth = <A>(
      selection: GoogleConnectionSelection,
      operation: Effect.Effect<A, GoogleReadConnectorError>,
    ): Effect.Effect<A, GoogleReadConnectorError> =>
      operation.pipe(
        Effect.tap(() => ignoreHealthPersistenceFailure(connectionHealth.markConnected(selection))),
        Effect.tapError((cause) =>
          ignoreHealthPersistenceFailure(
            cause.reason === "configuration"
              ? connectionHealth.markDisconnected(selection)
              : connectionHealth.markDegraded(selection),
          ),
        ),
      );

    const verify = Effect.fn("GoogleReadConnector.verify")(function* (
      selection: GoogleConnectionSelection,
    ) {
      return yield* withConnectionHealth(
        selection,
        Effect.gen(function* () {
          // Resolve first so a disabled or cross-Space connection cannot be
          // reported healthy merely because the pinned binary is installed.
          yield* resolveAccount(selection);
          yield* verifyBinary();
        }),
      );
    });

    const read = Effect.fn("GoogleReadConnector.read")(function* (request: GoogleReadRequest) {
      if (request.operation === "drive.export") {
        return yield* new GoogleReadConnectorError({
          reason: "output",
          message: "Drive exports must use the server-managed Artifact export operation.",
        });
      }
      return yield* withConnectionHealth(
        request,
        Effect.gen(function* () {
          const resolved = yield* resolveAccount(request);
          yield* verifyBinary();
          const result = yield* runner
            .run({
              command: binary,
              args: buildGoogleReadInvocation({ ...request, account: resolved.accountAlias }),
              env: googleEnvironment,
              extendEnv: false,
              timeout: "45 seconds",
              maxOutputBytes: 4 * 1024 * 1024,
            })
            .pipe(Effect.mapError(processFailure));

          if (result.code !== 0) {
            return yield* new GoogleReadConnectorError({
              reason: "process",
              message: result.stderr.trim() || "The Google read request failed.",
            });
          }

          const data = yield* decodeUnknownJsonString(result.stdout).pipe(
            Effect.mapError(
              (cause) =>
                new GoogleReadConnectorError({
                  reason: "output",
                  message: "The Google connector returned invalid JSON.",
                  cause,
                }),
            ),
          );
          return {
            operation: request.operation,
            contentTrust: "untrusted-external",
            data,
          } satisfies GoogleReadResult;
        }),
      );
    });

    const createDraft = Effect.fn("GoogleReadConnector.createDraft")(function* (
      request: GoogleDraftCreateRequest,
      attachmentPaths: ReadonlyArray<string>,
    ) {
      return yield* withConnectionHealth(
        request,
        Effect.gen(function* () {
          const resolved = yield* resolveAccount(request);
          yield* verifyBinary();
          yield* Effect.forEach(attachmentPaths, (attachmentPath) =>
            fs.stat(attachmentPath).pipe(
              Effect.flatMap((info) =>
                info.type === "File"
                  ? Effect.void
                  : new GoogleReadConnectorError({
                      reason: "output",
                      message: "A Gmail draft attachment is not a regular server-owned file.",
                    }),
              ),
              Effect.mapError((cause) =>
                isConnectorError(cause)
                  ? cause
                  : new GoogleReadConnectorError({
                      reason: "output",
                      message: "A Gmail draft attachment could not be read.",
                      cause,
                    }),
              ),
            ),
          );
          const args = [
            ...baseArgs(resolved.accountAlias, GOOGLE_DRAFT_COMMAND_ALLOWLIST),
            "gmail",
            "drafts",
            "create",
            "--to",
            request.to.join(","),
            "--subject",
            request.subject,
            ...(request.cc === undefined ? [] : ["--cc", request.cc.join(",")]),
            ...(request.bcc === undefined ? [] : ["--bcc", request.bcc.join(",")]),
            ...(request.body === undefined ? [] : ["--body", request.body]),
            ...(request.bodyHtml === undefined ? [] : ["--body-html", request.bodyHtml]),
            ...(request.replyToMessageId === undefined
              ? []
              : ["--reply-to-message-id", request.replyToMessageId]),
            ...(request.threadId === undefined ? [] : ["--thread-id", request.threadId]),
            ...attachmentPaths.flatMap((attachmentPath) => ["--attach", attachmentPath]),
          ];
          const result = yield* runner
            .run({
              command: binary,
              args,
              env: googleEnvironment,
              extendEnv: false,
              timeout: "45 seconds",
              maxOutputBytes: 1024 * 1024,
            })
            .pipe(Effect.mapError(processFailure));
          if (result.code !== 0)
            return yield* new GoogleReadConnectorError({
              reason: "process",
              message: result.stderr.trim() || "The Gmail draft request failed.",
            });
          return (yield* decodeUnknownJsonString(result.stdout).pipe(
            Effect.mapError(
              (cause) =>
                new GoogleReadConnectorError({
                  reason: "output",
                  message: "The Gmail draft response was invalid.",
                  cause,
                }),
            ),
          )) as Schema.Json;
        }),
      );
    });

    const discardPath = Effect.fn("GoogleReadConnector.discardPath")(function* (
      absolutePath: string,
    ) {
      const relative = path.relative(exportsDirectory, absolutePath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) return;
      yield* fs.remove(absolutePath, { force: true }).pipe(Effect.ignoreCause());
    });

    const discardExport = (exported: GoogleDriveExportedFile) => discardPath(exported.absolutePath);

    const exportDrive = Effect.fn("GoogleReadConnector.exportDrive")(function* (
      request: GoogleDriveExportRequest,
    ) {
      return yield* withConnectionHealth(
        request,
        Effect.gen(function* () {
          const resolved = yield* resolveAccount(request);
          yield* verifyBinary();
          const artifactId = yield* crypto.randomUUIDv4.pipe(
            Effect.mapError(
              (cause) =>
                new GoogleReadConnectorError({
                  reason: "output",
                  message: "The Google Drive export id could not be generated.",
                  cause,
                }),
            ),
          );
          const outputPath = path.join(exportsDirectory, `${artifactId}.${request.format}`);
          const exportProgram = Effect.gen(function* () {
            yield* fs.makeDirectory(exportsDirectory, { recursive: true });
            const result = yield* runner
              .run({
                command: binary,
                args: buildGoogleDriveExportInvocation(
                  { ...request, account: resolved.accountAlias },
                  outputPath,
                ),
                env: googleEnvironment,
                extendEnv: false,
                timeout: "2 minutes",
                maxOutputBytes: 1024 * 1024,
              })
              .pipe(Effect.mapError(processFailure));

            if (result.code !== 0) {
              return yield* new GoogleReadConnectorError({
                reason: "process",
                message: result.stderr.trim() || "The Google Drive export failed.",
              });
            }
            yield* decodeUnknownJsonString(result.stdout).pipe(
              Effect.mapError(
                (cause) =>
                  new GoogleReadConnectorError({
                    reason: "output",
                    message: "The Google Drive export returned invalid JSON.",
                    cause,
                  }),
              ),
            );

            const info = yield* fs.stat(outputPath);
            if (info.type !== "File") {
              return yield* new GoogleReadConnectorError({
                reason: "output",
                message: "The Google Drive export did not create a regular file.",
              });
            }
            if (info.size > FileSystem.Size(MAX_GOOGLE_DRIVE_EXPORT_BYTES)) {
              return yield* new GoogleReadConnectorError({
                reason: "output",
                message: `The Google Drive export exceeds the ${MAX_GOOGLE_DRIVE_EXPORT_BYTES}-byte limit.`,
              });
            }
            const bytes = yield* fs.readFile(outputPath);
            const contentDigest = Encoding.encodeHex(yield* crypto.digest("SHA-256", bytes));
            const createdAt = DateTime.formatIso(yield* DateTime.now);
            const artifact = yield* decodeArtifact({
              id: artifactId,
              spaceId: request.spaceId,
              ...(request.runId === undefined ? {} : { runId: request.runId }),
              kind: "export",
              name: `Google Drive export.${request.format}`,
              locator: `cc-artifact://${artifactId}`,
              mimeType: MIME_BY_EXPORT_FORMAT[request.format],
              contentDigest,
              provenance: {
                kind: "connector",
                sourceRef: `google-drive:${request.fileId}`,
                capturedAt: createdAt,
              },
              createdAt,
            });
            return {
              artifact,
              absolutePath: outputPath,
              sizeBytes: Number(info.size),
              format: request.format,
            } satisfies GoogleDriveExportedFile;
          }).pipe(
            Effect.mapError((cause) =>
              isConnectorError(cause)
                ? cause
                : new GoogleReadConnectorError({
                    reason: "output",
                    message: "The Google Drive export could not be stored safely.",
                    cause,
                  }),
            ),
          );

          return yield* exportProgram.pipe(Effect.tapError(() => discardPath(outputPath)));
        }),
      );
    });

    return GoogleReadConnector.of({ verify, read, exportDrive, discardExport, createDraft });
  }),
);
