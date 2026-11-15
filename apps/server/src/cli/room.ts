import { AuthCommandCenterApproveScope, AuthCommandCenterOperateScope } from "@t3tools/contracts";
import { RoomRequest } from "../../../../packages/contracts/src/teammateRooms.ts";
import * as ByteSize from "effect/ByteSize";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpIncomingMessage } from "effect/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

class RoomCliError extends Schema.TaggedError<RoomCliError>()("RoomCliError", {
  reason: Schema.Literals([
    "stdin-required",
    "json-required",
    "input-too-large",
    "invalid-input",
    "server-not-running",
    "request-rejected",
  ]),
  status: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect()),
}) {
  override readonly [Runtime.errorReported] = false;
  override get message() {
    return `Room request failed: ${this.reason}${this.status === undefined ? "" : ` (HTTP ${this.status})`}.`;
  }
}

const decodeRequest = Schema.decodeEffect(Schema.fromJsonString(RoomRequest));
const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(RoomRequest));
const decodeResponse = Schema.decodeUnknownEffect(Schema.Json);
const encodeResponse = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));
const isRoomCliError = Schema.is(RoomCliError);

const runRequest = Effect.fn("cli.room.request")(function* (flags: {
  readonly baseDir: Option.Option<string>;
  readonly input: string;
  readonly json: boolean;
}) {
  if (!flags.json) return yield* new RoomCliError({ reason: "json-required" });
  if (flags.input !== "-") return yield* new RoomCliError({ reason: "stdin-required" });
  const stdio = yield* Stdio.Stdio;
  const input = yield* stdio.stdin.pipe(
    Stream.decodeText(),
    Stream.runFoldEffect(
      () => ({ text: "", bytes: 0 }),
      (acc, chunk) => {
        const bytes = acc.bytes + new TextEncoder().encode(chunk).length;
        return bytes > 128 * 1024
          ? Effect.fail(new RoomCliError({ reason: "input-too-large" }))
          : Effect.succeed({ text: acc.text + chunk, bytes });
      },
    ),
    Effect.map((value) => value.text),
    Effect.timeout("10 seconds"),
  );
  const request = yield* decodeRequest(input).pipe(
    Effect.mapError((cause) => new RoomCliError({ reason: "invalid-input", cause })),
  );
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  return yield* Effect.gen(function* () {
    const state = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(state)) return yield* new RoomCliError({ reason: "server-not-running" });
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const client = yield* HttpClient.HttpClient;
    return yield* Effect.acquireUseRelease(
      auth.issueSession({
        subject: "local-room-owner",
        label: "t3 room cli",
        ttl: Duration.minutes(1),
        scopes: [AuthCommandCenterApproveScope, AuthCommandCenterOperateScope],
      }),
      (issued) =>
        Effect.gen(function* () {
          const encoded = yield* encodeRequest(request);
          const response = yield* client.execute(
            HttpClientRequest.post(
              new URL("/api/command-center/rooms", state.value.origin).href,
            ).pipe(
              HttpClientRequest.setHeader("authorization", `Bearer ${issued.token}`),
              HttpClientRequest.bodyText(encoded, "application/json"),
            ),
          );
          const body = yield* response.json.pipe(Effect.flatMap(decodeResponse));
          yield* Console.log(yield* encodeResponse(body));
          if (response.status < 200 || response.status >= 300)
            return yield* new RoomCliError({ reason: "request-rejected", status: response.status });
        }).pipe(
          Effect.timeout("30 seconds"),
          Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.mebibytes(8)),
        ),
      (issued) => auth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(EnvironmentAuth.layerRuntime, FetchHttpClient.layer).pipe(
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
      ),
    ),
  );
});

export const roomCommand = Command.make("room").pipe(
  Command.withSubcommands([
    Command.make("request", {
      ...projectLocationFlags,
      json: Flag.Boolean("json").pipe(Flag.withDefault(true)),
      input: Argument.String("input").pipe(
        Argument.withDescription("Pass - to read a bounded JSON room request from stdin."),
      ),
    }).pipe(
      Command.withDescription(
        "Call the running server's room API as the local owner using a temporary scoped session.",
      ),
      Command.withHandler((flags) =>
        runRequest(flags).pipe(
          Effect.tapError((error) =>
            isRoomCliError(error) ? Console.error(error.message) : Effect.void,
          ),
        ),
      ),
    ),
  ]),
);
