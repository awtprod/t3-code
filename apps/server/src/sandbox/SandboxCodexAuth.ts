import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

const MAX_CODEX_AUTH_BYTES = 1024 * 1024;
const BoundedCredential = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_CODEX_AUTH_BYTES),
);
const CodexAuthEnvelope = Schema.Struct({
  auth_mode: Schema.optionalKey(Schema.String),
});
const CodexChatgptAuth = Schema.Struct({
  auth_mode: Schema.Literal("chatgpt"),
  tokens: Schema.Struct({
    access_token: BoundedCredential,
    account_id: BoundedCredential,
  }),
});
const decodeCodexAuthEnvelope = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CodexAuthEnvelope),
);
const decodeCodexChatgptAuth = Schema.decodeUnknownEffect(Schema.fromJsonString(CodexChatgptAuth));

export interface SandboxCodexChatgptAuth {
  readonly accessToken: string;
  readonly chatgptAccountId: string;
}

export class SandboxCodexAuthError extends Schema.TaggedErrorClass<SandboxCodexAuthError>()(
  "SandboxCodexAuthError",
  {
    issue: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.issue;
  }
}

function isNotFound(cause: PlatformError.PlatformError): boolean {
  return cause.reason._tag === "NotFound";
}

/**
 * Read only the short-lived fields required by Codex's external ChatGPT auth
 * mode. The refresh and ID tokens in auth.json never leave the host.
 */
export const readSandboxCodexChatgptAuth = Effect.fn("SandboxCodexAuth.readChatgptAuth")(function* (
  sourceHomePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const authPath = path.join(path.resolve(sourceHomePath), "auth.json");
  const stat = yield* fileSystem.stat(authPath).pipe(
    Effect.map(Option.some),
    Effect.catchTags({
      PlatformError: (cause) =>
        isNotFound(cause)
          ? Effect.succeed(Option.none())
          : Effect.fail(
              new SandboxCodexAuthError({
                issue: "Command Center could not inspect Codex subscription authentication.",
                cause,
              }),
            ),
    }),
  );
  if (Option.isNone(stat)) return undefined;
  if (
    stat.value.type !== "File" ||
    stat.value.size <= 0 ||
    stat.value.size > MAX_CODEX_AUTH_BYTES
  ) {
    return yield* new SandboxCodexAuthError({
      issue: `Codex subscription authentication must be a non-empty regular file no larger than ${MAX_CODEX_AUTH_BYTES} bytes.`,
    });
  }

  const contents = yield* fileSystem.readFileString(authPath).pipe(
    Effect.mapError(
      (cause) =>
        new SandboxCodexAuthError({
          issue: "Command Center could not read Codex subscription authentication.",
          cause,
        }),
    ),
  );
  if (new TextEncoder().encode(contents).byteLength > MAX_CODEX_AUTH_BYTES) {
    return yield* new SandboxCodexAuthError({
      issue: `Codex subscription authentication exceeded ${MAX_CODEX_AUTH_BYTES} bytes while it was read.`,
    });
  }

  const envelope = yield* decodeCodexAuthEnvelope(contents).pipe(
    // Schema diagnostics can contain the rejected input. Never attach them to
    // an error that may be logged because auth.json contains live credentials.
    Effect.mapError(
      () =>
        new SandboxCodexAuthError({
          issue: "Codex subscription authentication is not valid auth.json data.",
        }),
    ),
  );
  if (envelope.auth_mode !== "chatgpt") return undefined;

  const auth = yield* decodeCodexChatgptAuth(contents).pipe(
    Effect.mapError(
      () =>
        new SandboxCodexAuthError({
          issue:
            "Codex ChatGPT authentication is missing its access token or account identifier. Sign in again with this Codex identity.",
        }),
    ),
  );
  return {
    accessToken: auth.tokens.access_token,
    chatgptAccountId: auth.tokens.account_id,
  } satisfies SandboxCodexChatgptAuth;
});
