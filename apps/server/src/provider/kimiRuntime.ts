// @effect-diagnostics globalFetchInEffect:off preferSchemaOverJson:off cryptoRandomUUID:off nodeBuiltinImport:off globalTimers:off
import * as NodeOS from "node:os";
import * as NodeNet from "node:net";
import * as NodeProcess from "node:process";

import type { KimiSettings } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { expandHomePath } from "../pathExpansion.ts";

const KIMI_MINIMUM_VERSION = "0.31.1";
const KIMI_WS_BEARER_PREFIX = "kimi-code.bearer.";

export class KimiRuntimeError extends Data.TaggedError("KimiRuntimeError")<{
  readonly operation: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {}

export interface KimiEnvelope<T = unknown> {
  readonly code: number;
  readonly msg?: string;
  readonly data: T;
  readonly request_id?: string;
}

export interface KimiServerConnection {
  readonly origin: string;
  readonly token: string;
}

export interface KimiSocket {
  readonly close: Effect.Effect<void>;
}

export interface KimiRuntimeClient {
  readonly ensureServer: Effect.Effect<KimiServerConnection, KimiRuntimeError>;
  readonly request: <T>(
    path: string,
    init?: { readonly method?: string; readonly body?: unknown },
  ) => Effect.Effect<T, KimiRuntimeError>;
  readonly subscribe: (
    sessionId: string,
    onEvent: (event: Record<string, unknown>) => void,
  ) => Effect.Effect<KimiSocket, KimiRuntimeError, Scope.Scope>;
  readonly workspacePath?: string;
}

export interface KimiRuntimeLaunchOptions {
  readonly command: string;
  readonly argsPrefix: ReadonlyArray<string>;
  readonly tokenHomePath: string;
  readonly daemonHomePath: string;
  readonly workspacePath?: string;
}

export function parseKimiVersion(raw: string): string | null {
  return raw.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
}

function compareVersion(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export function isSupportedKimiVersion(version: string): boolean {
  return compareVersion(version, KIMI_MINIMUM_VERSION) >= 0;
}

const reserveLoopbackPort: Effect.Effect<number, KimiRuntimeError> = Effect.callback((resume) => {
  const server = NodeNet.createServer();
  server.unref();
  server.once("error", (cause) =>
    resume(
      Effect.fail(
        new KimiRuntimeError({
          operation: "startServer",
          detail: "Could not allocate a loopback port for Kimi Code.",
          cause,
        }),
      ),
    ),
  );
  server.listen({ host: "127.0.0.1", port: 0 }, () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    server.close(() =>
      resume(
        port > 0
          ? Effect.succeed(port)
          : Effect.fail(
              new KimiRuntimeError({
                operation: "startServer",
                detail: "The loopback port allocator returned an invalid address.",
              }),
            ),
      ),
    );
  });
  return Effect.sync(() => server.close());
});

const fetchEnvelope = <T>(
  connection: KimiServerConnection,
  path: string,
  init?: { readonly method?: string; readonly body?: unknown },
): Effect.Effect<T, KimiRuntimeError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${connection.origin}/api/v1${path}`, {
        method: init?.method ?? "GET",
        headers: {
          Authorization: `Bearer ${connection.token}`,
          Accept: "application/json",
          ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      const envelope = (await response.json()) as KimiEnvelope<T>;
      if (!response.ok || envelope.code !== 0) {
        throw new Error(envelope.msg || `HTTP ${response.status}`);
      }
      return envelope.data;
    },
    catch: (cause) =>
      new KimiRuntimeError({
        operation: `${init?.method ?? "GET"} ${path}`,
        detail: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });

export const makeKimiRuntimeClient = Effect.fn("makeKimiRuntimeClient")(function* (
  settings: KimiSettings,
  environment: NodeJS.ProcessEnv = process.env,
  launch?: KimiRuntimeLaunchOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const cryptoService = yield* Crypto.Crypto;
  const driverScope = yield* Scope.Scope;

  const resolvedHome =
    launch?.tokenHomePath ??
    path.resolve(
      settings.homePath.trim().length > 0
        ? expandHomePath(settings.homePath)
        : environment.KIMI_CODE_HOME?.trim() || path.join(NodeOS.homedir(), ".kimi-code"),
    );
  const daemonHome = launch?.daemonHomePath ?? resolvedHome;

  const startServer = Effect.gen(function* () {
    const port = yield* reserveLoopbackPort;
    const origin = `http://127.0.0.1:${port}`;
    const serverArgs = [
      "web",
      "--no-open",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--log-level",
      "warn",
    ];
    const spawn = yield* (
      launch
        ? Effect.succeed({
            command: launch.command,
            args: [...launch.argsPrefix, ...serverArgs],
            shell: false,
          })
        : resolveSpawnCommand(settings.binaryPath, serverArgs, { env: environment })
    ).pipe(
      Effect.mapError(
        (cause) =>
          new KimiRuntimeError({
            operation: "startServer",
            detail: `Could not resolve Kimi executable '${settings.binaryPath}'.`,
            cause,
          }),
      ),
    );
    const child = yield* spawner
      .spawn(
        ChildProcess.make(spawn.command, spawn.args, {
          shell: spawn.shell,
          detached: NodeProcess.platform !== "win32",
          env: { ...environment, KIMI_CODE_HOME: daemonHome },
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, driverScope),
        Effect.mapError(
          (cause) =>
            new KimiRuntimeError({
              operation: "startServer",
              detail: "Failed to start the Kimi Code web server.",
              cause,
            }),
        ),
      );

    yield* child.stdout.pipe(Stream.runDrain, Effect.ignore, Effect.forkIn(driverScope));
    yield* child.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkIn(driverScope));
    yield* Scope.addFinalizer(
      driverScope,
      child.kill({ killSignal: "SIGTERM", forceKillAfter: "2 seconds" }).pipe(Effect.ignore),
    );

    const tokenPath = path.join(resolvedHome, "server.token");
    const awaitReady = (remaining: number): Effect.Effect<KimiServerConnection, KimiRuntimeError> =>
      Effect.gen(function* () {
        const token = yield* fileSystem.readFileString(tokenPath).pipe(
          Effect.map((value) => value.trim()),
          Effect.orElseSucceed(() => ""),
        );
        if (token.length > 0) {
          const connection = { origin, token } satisfies KimiServerConnection;
          const ready = yield* fetchEnvelope(connection, "/meta").pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
          if (ready) return connection;
        }
        if (remaining <= 0) {
          return yield* new KimiRuntimeError({
            operation: "startServer",
            detail: "Timed out waiting for the authenticated Kimi Code server.",
          });
        }
        yield* Effect.sleep("200 millis");
        return yield* awaitReady(remaining - 1);
      });

    return yield* awaitReady(150);
  });

  const ensureServer = yield* Effect.cached(startServer);
  const request: KimiRuntimeClient["request"] = (requestPath, init) =>
    ensureServer.pipe(Effect.flatMap((connection) => fetchEnvelope(connection, requestPath, init)));

  const subscribe: KimiRuntimeClient["subscribe"] = (sessionId, onEvent) =>
    Effect.gen(function* () {
      const [clientUuid, helloId, subscribeId] = yield* Effect.all([
        cryptoService.randomUUIDv4,
        cryptoService.randomUUIDv4,
        cryptoService.randomUUIDv4,
      ]).pipe(
        Effect.mapError(
          (cause) =>
            new KimiRuntimeError({
              operation: "subscribe",
              detail: "Could not create Kimi WebSocket identifiers.",
              cause,
            }),
        ),
      );
      return yield* Effect.acquireRelease(
        ensureServer.pipe(
          Effect.flatMap((connection) =>
            Effect.callback<KimiSocket, KimiRuntimeError>((resume) => {
              const clientId = `t3_${clientUuid}`;
              const wsUrl = new URL(`${connection.origin}/api/v1/ws`);
              wsUrl.protocol = "ws:";
              wsUrl.searchParams.set("client_id", clientId);
              let ready = false;
              let stopped = false;
              let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
              let currentSocket: WebSocket | undefined;
              const fail = (detail: string, cause?: unknown) => {
                if (!ready) {
                  ready = true;
                  resume(
                    Effect.fail(new KimiRuntimeError({ operation: "subscribe", detail, cause })),
                  );
                }
              };
              const connect = () => {
                if (stopped) return;
                const socket = new WebSocket(wsUrl, `${KIMI_WS_BEARER_PREFIX}${connection.token}`);
                currentSocket = socket;
                let helloAcknowledged = false;
                socket.addEventListener("error", (event) => {
                  if (!ready) fail("Kimi WebSocket failed.", event);
                });
                socket.addEventListener("close", () => {
                  if (currentSocket === socket) currentSocket = undefined;
                  if (!ready) {
                    fail("Kimi WebSocket closed during startup.");
                    return;
                  }
                  if (!stopped) reconnectTimer = setTimeout(connect, 500);
                });
                socket.addEventListener("message", (message) => {
                  let frame: Record<string, unknown>;
                  try {
                    frame = JSON.parse(String(message.data)) as Record<string, unknown>;
                  } catch {
                    return;
                  }
                  if (frame.type === "server_hello") {
                    socket.send(
                      JSON.stringify({
                        type: "client_hello",
                        id: helloId,
                        payload: {
                          client_id: clientId,
                          client_name: "t3-code",
                          client_version: "0.0.0",
                          client_ui_mode: "command-center",
                          subscriptions: [],
                        },
                      }),
                    );
                    return;
                  }
                  if (frame.type === "ping") {
                    const payload = frame.payload as Record<string, unknown> | undefined;
                    socket.send(
                      JSON.stringify({ type: "pong", payload: { nonce: payload?.nonce } }),
                    );
                    return;
                  }
                  if (frame.type === "ack" && !helloAcknowledged) {
                    helloAcknowledged = true;
                    socket.send(
                      JSON.stringify({
                        type: "subscribe",
                        id: subscribeId,
                        payload: { session_ids: [sessionId] },
                      }),
                    );
                    if (!ready) {
                      ready = true;
                      resume(
                        Effect.succeed({
                          close: Effect.sync(() => {
                            stopped = true;
                            if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
                            currentSocket?.close();
                          }).pipe(Effect.asVoid),
                        }),
                      );
                    }
                    return;
                  }
                  if (typeof frame.session_id === "string" && frame.session_id === sessionId) {
                    onEvent(frame);
                  }
                });
              };
              connect();
            }),
          ),
        ),
        (socket) => socket.close,
      );
    });

  return {
    ensureServer,
    request,
    subscribe,
    ...(launch?.workspacePath === undefined ? {} : { workspacePath: launch.workspacePath }),
  } satisfies KimiRuntimeClient;
});
