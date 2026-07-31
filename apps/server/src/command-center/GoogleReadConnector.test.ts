import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { CommandCenterError, GoogleReadRequest } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { CommandCenterConfig } from "./Config.ts";
import { ConnectionHealth } from "./ConnectionHealth.ts";
import {
  GOOGLE_READ_COMMAND_ALLOWLIST,
  GoogleReadConnector,
  buildGoogleReadInvocation,
  buildGoogleDriveExportInvocation,
  hasPinnedGogVersion,
  layer as googleReadConnectorLayer,
} from "./GoogleReadConnector.ts";

const connectionSelection = {
  spaceId: "example-space" as never,
  connectionId: "google-primary" as never,
};
const decodeGoogleReadRequest = Schema.decodeUnknownSync(GoogleReadRequest);

describe("GoogleReadConnector invocation policy", () => {
  const expectProtectedPositional = (args: ReadonlyArray<string>, value: string) => {
    const optionBoundary = args.indexOf("--");
    expect(optionBoundary).toBeGreaterThanOrEqual(0);
    expect(args.slice(optionBoundary + 1)).toEqual([value]);
    expect(args.slice(0, optionBoundary)).not.toContain(value);
  };

  it("matches the pinned gog version exactly", () => {
    expect(hasPinnedGogVersion("gog version 0.15.0 (build example)")).toBe(true);
    expect(hasPinnedGogVersion("gog version 0.15.01")).toBe(false);
    expect(hasPinnedGogVersion("gog version 10.15.0")).toBe(false);
  });

  it("drops caller-controlled ambient account selectors at the public contract", () => {
    const request = decodeGoogleReadRequest({
      ...connectionSelection,
      operation: "gmail.search",
      query: "newer_than:7d",
      account: "attacker-selected-host-account",
    });

    expect("account" in request).toBe(false);
  });

  it("always enables runtime read-only command restrictions supported by gog 0.15", () => {
    const args = buildGoogleReadInvocation({
      operation: "gmail.search",
      ...connectionSelection,
      account: "account-alias",
      query: "newer_than:7d",
      limit: 10,
    });

    expect(args).toContain("--gmail-no-send");
    expect(args).toContain("--no-input");
    expect(args).toContain("--enable-commands");
    expect(args).toContain(GOOGLE_READ_COMMAND_ALLOWLIST.join(","));
    expect(args).not.toContain("send");
    expect(args).not.toContain("create");
    expect(args).not.toContain("update");
    expect(args).not.toContain("delete");
  });

  it("passes user text as one argv value instead of shell syntax", () => {
    const query = "subject:report; calendar create --summary injected";
    const args = buildGoogleReadInvocation({
      operation: "drive.search",
      ...connectionSelection,
      account: "work",
      query,
      limit: 5,
    });

    expect(args).toContain(query);
    expect(args.filter((value) => value === query)).toHaveLength(1);
    expectProtectedPositional(args, query);
  });

  it("terminates option parsing before every caller-controlled positional value", () => {
    const accountOverride = "--account=another-configured-account";
    const commandOverride = "--enable-commands=gmail.send,calendar.create";
    const leadingHyphen = "-label:spam";
    const cases: ReadonlyArray<readonly [ReadonlyArray<string>, string]> = [
      [
        buildGoogleReadInvocation({
          operation: "gmail.search",
          ...connectionSelection,
          account: "configured-account",
          query: accountOverride,
        }),
        accountOverride,
      ],
      [
        buildGoogleReadInvocation({
          operation: "gmail.get",
          ...connectionSelection,
          account: "configured-account",
          messageId: commandOverride,
        }),
        commandOverride,
      ],
      [
        buildGoogleReadInvocation({
          operation: "gmail.thread.get",
          ...connectionSelection,
          account: "configured-account",
          threadId: leadingHyphen,
        }),
        leadingHyphen,
      ],
      [
        buildGoogleReadInvocation({
          operation: "calendar.events",
          ...connectionSelection,
          account: "configured-account",
          calendarId: accountOverride,
          from: "2026-01-01T00:00:00Z",
          to: "2026-01-02T00:00:00Z",
        }),
        accountOverride,
      ],
      [
        buildGoogleReadInvocation({
          operation: "calendar.freebusy",
          ...connectionSelection,
          account: "configured-account",
          calendarIds: [commandOverride],
          from: "2026-01-01T00:00:00Z",
          to: "2026-01-02T00:00:00Z",
        }),
        commandOverride,
      ],
      [
        buildGoogleReadInvocation({
          operation: "drive.search",
          ...connectionSelection,
          account: "configured-account",
          query: leadingHyphen,
        }),
        leadingHyphen,
      ],
      [
        buildGoogleReadInvocation({
          operation: "drive.get",
          ...connectionSelection,
          account: "configured-account",
          fileId: accountOverride,
        }),
        accountOverride,
      ],
      [
        buildGoogleDriveExportInvocation(
          {
            operation: "drive.export",
            ...connectionSelection,
            account: "configured-account",
            fileId: commandOverride,
            format: "pdf",
          },
          "/runtime/attachments/exports/generated-id.pdf",
        ),
        commandOverride,
      ],
    ];

    for (const [args, value] of cases) expectProtectedPositional(args, value);
  });

  it("uses the pinned gog Drive download argv with only a server-controlled output path", () => {
    const args = buildGoogleDriveExportInvocation(
      {
        operation: "drive.export",
        ...connectionSelection,
        account: "work",
        fileId: "drive-file-id",
        format: "pdf",
      },
      "/runtime/attachments/exports/generated-id.pdf",
    );

    expect(args).toEqual(
      expect.arrayContaining([
        "drive",
        "download",
        "--out",
        "/runtime/attachments/exports/generated-id.pdf",
        "--format",
        "pdf",
        "--",
        "drive-file-id",
      ]),
    );
    expectProtectedPositional(args, "drive-file-id");
    expect(GOOGLE_READ_COMMAND_ALLOWLIST).toContain("drive.download");
  });

  it("sanitizes individual Gmail messages and threads", () => {
    const message = buildGoogleReadInvocation({
      operation: "gmail.get",
      ...connectionSelection,
      account: "work",
      messageId: "message-id",
    });
    const thread = buildGoogleReadInvocation({
      operation: "gmail.thread.get",
      ...connectionSelection,
      account: "work",
      threadId: "thread-id",
    });

    expect(message).toContain("--sanitize-content");
    expect(thread).toContain("--sanitize-content");
  });

  it("requires bounded calendar windows in every invocation shape", () => {
    const args = buildGoogleReadInvocation({
      operation: "calendar.events",
      ...connectionSelection,
      account: "work",
      calendarId: "primary",
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-02T00:00:00Z",
      limit: 25,
    });

    expect(args).toEqual(
      expect.arrayContaining([
        "calendar",
        "events",
        "--from",
        "2026-01-01T00:00:00Z",
        "--to",
        "2026-01-02T00:00:00Z",
      ]),
    );
  });

  it("passes free/busy calendar ids as the command's documented CSV positional value", () => {
    const args = buildGoogleReadInvocation({
      operation: "calendar.freebusy",
      ...connectionSelection,
      account: "work",
      calendarIds: ["primary", "team"],
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-02T00:00:00Z",
    });

    expect(args).toContain("primary,team");
    expect(args).not.toContain("primary");
    expect(args).not.toContain("team");
  });
});

const recordedArgs: Array<ReadonlyArray<string>> = [];
const recordedInvocations: Array<ProcessRunner.ProcessRunInput> = [];
const healthUpdates: Array<{
  readonly health: "connected" | "degraded" | "disconnected";
  readonly spaceId: string;
  readonly connectionId: string;
}> = [];

const fakeRunnerLayer = Layer.effect(
  ProcessRunner.ProcessRunner,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return ProcessRunner.ProcessRunner.of({
      run: (input) => {
        recordedInvocations.push(input);
        return input.args[0] === "--version"
          ? Effect.succeed({
              stdout: "gog 0.15.0",
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
            })
          : Effect.gen(function* () {
              recordedArgs.push(input.args);
              if (input.args.includes("force-failure")) {
                return {
                  stdout: "",
                  stderr: "read failed",
                  code: ChildProcessSpawner.ExitCode(1),
                  timedOut: false,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                };
              }
              const outputIndex = input.args.indexOf("--out");
              const outputPath = input.args[outputIndex + 1];
              if (outputIndex < 0 || outputPath === undefined) {
                return {
                  stdout: '{"ok":true}',
                  stderr: "",
                  code: ChildProcessSpawner.ExitCode(0),
                  timedOut: false,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                };
              }
              yield* fs.writeFileString(outputPath, "safe export contents").pipe(Effect.orDie);
              return {
                stdout: "{}",
                stderr: "",
                code: ChildProcessSpawner.ExitCode(0),
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
              };
            });
      },
    });
  }),
);

const connectorTestLayer = googleReadConnectorLayer.pipe(
  Layer.provideMerge(fakeRunnerLayer),
  Layer.provideMerge(
    Layer.succeed(
      CommandCenterConfig,
      CommandCenterConfig.of({
        configDirectory: "runtime-config",
        load: Effect.die("Config loading is not used by this connector test."),
        resolveGoogleAccount: ({ spaceId, connectionId }) =>
          spaceId === connectionSelection.spaceId &&
          connectionId === connectionSelection.connectionId
            ? Effect.succeed({ accountAlias: "configured-account", label: "Configured account" })
            : Effect.fail(
                new CommandCenterError({
                  reason: "config",
                  message: "The connection is disabled.",
                }),
              ),
      }),
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      ConnectionHealth,
      ConnectionHealth.of({
        syncConfigured: () => Effect.void,
        markConnected: ({ connectionId, spaceId }) =>
          Effect.sync(() =>
            healthUpdates.push({ health: "connected", spaceId, connectionId }),
          ).pipe(Effect.asVoid),
        markDegraded: ({ connectionId, spaceId }) =>
          Effect.sync(() => healthUpdates.push({ health: "degraded", spaceId, connectionId })).pipe(
            Effect.asVoid,
          ),
        markDisconnected: ({ connectionId, spaceId }) =>
          Effect.sync(() =>
            healthUpdates.push({ health: "disconnected", spaceId, connectionId }),
          ).pipe(Effect.asVoid),
      }),
    ),
  ),
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "command-center-google-export-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("stores Drive exports only under runtime attachments and hashes the file", () =>
  Effect.gen(function* () {
    recordedArgs.length = 0;
    recordedInvocations.length = 0;
    healthUpdates.length = 0;
    const connector = yield* GoogleReadConnector;
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const exported = yield* connector.exportDrive({
      operation: "drive.export",
      ...connectionSelection,
      fileId: "drive-file-id",
      format: "pdf",
    });

    const relative = path.relative(
      path.join(config.attachmentsDir, "exports"),
      exported.absolutePath,
    );
    expect(relative.startsWith("..")).toBe(false);
    expect(path.isAbsolute(relative)).toBe(false);
    expect(exported.artifact.locator).toMatch(/^cc-artifact:\/\//u);
    expect(exported.artifact.locator).not.toContain(config.baseDir);
    expect(exported.artifact.contentDigest).toBe(
      NodeCrypto.createHash("sha256").update("safe export contents").digest("hex"),
    );
    expect(exported.sizeBytes).toBe(20);
    expect(recordedArgs[0]).toEqual(expect.arrayContaining(["--account", "configured-account"]));
    expect(recordedInvocations).toHaveLength(2);
    for (const invocation of recordedInvocations) {
      expect(invocation.extendEnv).toBe(false);
      expect(invocation.env).toEqual(
        expect.objectContaining({
          HOME: expect.stringContaining("/secrets/gog"),
          XDG_CONFIG_HOME: expect.stringContaining("/secrets/gog"),
          PATH: expect.any(String),
        }),
      );
      expect(invocation.env).not.toHaveProperty("COMMAND_CENTER_GOG_BINARY");
    }
    expect(healthUpdates).toContainEqual({
      health: "connected",
      spaceId: connectionSelection.spaceId,
      connectionId: connectionSelection.connectionId,
    });
    expect(yield* fs.exists(exported.absolutePath)).toBe(true);

    yield* connector.discardExport(exported);
    expect(yield* fs.exists(exported.absolutePath)).toBe(false);
  }).pipe(Effect.provide(connectorTestLayer)),
);

it.effect("marks exact successful verify and read selections connected", () =>
  Effect.gen(function* () {
    healthUpdates.length = 0;
    const connector = yield* GoogleReadConnector;

    yield* connector.verify(connectionSelection);
    yield* connector.read(
      decodeGoogleReadRequest({
        ...connectionSelection,
        operation: "gmail.search",
        query: "newer_than:7d",
      }),
    );

    expect(healthUpdates).toEqual([
      { health: "connected", ...connectionSelection },
      { health: "connected", ...connectionSelection },
    ]);
  }).pipe(Effect.provide(connectorTestLayer)),
);

it.effect("marks operation failures degraded and disabled configuration disconnected", () =>
  Effect.gen(function* () {
    healthUpdates.length = 0;
    const connector = yield* GoogleReadConnector;
    const failed = decodeGoogleReadRequest({
      ...connectionSelection,
      operation: "gmail.search",
      query: "force-failure",
    });
    const disabled = decodeGoogleReadRequest({
      spaceId: connectionSelection.spaceId,
      connectionId: "google-disabled",
      operation: "gmail.search",
      query: "newer_than:7d",
    });

    expect((yield* connector.read(failed).pipe(Effect.flip)).reason).toBe("process");
    expect((yield* connector.read(disabled).pipe(Effect.flip)).reason).toBe("configuration");
    expect(healthUpdates).toEqual([
      { health: "degraded", ...connectionSelection },
      {
        health: "disconnected",
        spaceId: connectionSelection.spaceId,
        connectionId: "google-disabled",
      },
    ]);
  }).pipe(Effect.provide(connectorTestLayer)),
);
