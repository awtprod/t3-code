import type {
  CommandCenterGoogleConnectionSetupBeginInput,
  CommandCenterGoogleConnectionSetupBeginResult,
  CommandCenterGoogleConnectionSetupCompleteInput,
  CommandCenterGoogleConnectionRemoveInput,
} from "@t3tools/contracts";
import { CommandCenterError } from "@t3tools/contracts";
import { ConnectionId, type Connection as ConnectionType } from "@command-center/core";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import { ProcessRunner } from "../processRunner.ts";
import { CommandCenterConfig } from "./Config.ts";
import {
  buildGoogleHelperSearchPath,
  hasPinnedGogVersion,
  PINNED_GOG_VERSION,
} from "./GoogleReadConnector.ts";

const GOOGLE_OAUTH_SESSION_TTL_MINUTES = 10;
const GMAIL_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";

const OAuthClientsResult = Schema.Struct({
  clients: Schema.Array(Schema.Struct({ client: Schema.String })),
});
const OAuthBeginResult = Schema.Struct({
  auth_url: Schema.String,
  state_reused: Schema.Boolean,
});
const OAuthCompleteResult = Schema.Struct({
  stored: Schema.Boolean,
  email: Schema.String,
  services: Schema.Array(Schema.String),
  client: Schema.String,
});

interface SetupSession {
  readonly spaceId: CommandCenterGoogleConnectionSetupBeginInput["spaceId"];
  readonly email: string;
  readonly capabilities: CommandCenterGoogleConnectionSetupBeginInput["capabilities"];
  readonly replayArgs: ReadonlyArray<string>;
  readonly expectedRedirectUri: string;
  readonly expectedState: string;
  readonly expiresAtMs: number;
}

interface GoogleConnectionSetupShape {
  readonly begin: (
    input: CommandCenterGoogleConnectionSetupBeginInput,
  ) => Effect.Effect<CommandCenterGoogleConnectionSetupBeginResult, CommandCenterError>;
  readonly complete: (input: CommandCenterGoogleConnectionSetupCompleteInput) => Effect.Effect<
    {
      readonly spaceId: CommandCenterGoogleConnectionSetupBeginInput["spaceId"];
      readonly connectionId: ConnectionType["id"];
    },
    CommandCenterError
  >;
  readonly remove: (
    input: CommandCenterGoogleConnectionRemoveInput,
  ) => Effect.Effect<
    { readonly connectionId: ConnectionType["id"]; readonly removed: true },
    CommandCenterError
  >;
}

export class GoogleConnectionSetup extends Context.Service<
  GoogleConnectionSetup,
  GoogleConnectionSetupShape
>()("@awtprod/command-center/command-center/GoogleConnectionSetup") {}

const connectorError = (message: string, cause?: unknown) =>
  new CommandCenterError({
    reason: "connector",
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const singleLine = (value: string) => value.replace(/\s+/gu, " ").trim();

export function googleSetupFailureMessage(stderr: string): string {
  const detail = singleLine(stderr);
  const normalized = detail.toLowerCase();

  if (normalized.includes("authorized as") && normalized.includes("expected")) {
    return detail.slice(0, 500);
  }
  if (normalized.includes("no code found") || normalized.includes("missing code")) {
    return "The pasted address does not contain Google's authorization code. Copy the complete 127.0.0.1 address from the browser address bar.";
  }
  if (normalized.includes("state mismatch") || normalized.includes("manual auth state")) {
    return "This browser address belongs to another or expired Google setup attempt. Start again and paste the address from the newly opened authorization tab.";
  }
  if (normalized.includes("no refresh token")) {
    return "Google did not issue a reusable sign-in token. Start again and approve access when Google asks for consent.";
  }
  if (normalized.includes("saving the refresh token failed") || normalized.includes("keyring")) {
    return "Google approved access, but this environment could not securely store the account token. Check the environment credential store and try again.";
  }
  if (normalized.includes("fetch authorized email")) {
    return "Google approved access, but the authorized account identity could not be verified. Make sure the Google People API is available to the OAuth project and try again.";
  }
  if (normalized.includes("exchange code") || normalized.includes("invalid_grant")) {
    return "Google rejected this authorization code. Start again and immediately paste the newest browser address; authorization codes cannot be reused.";
  }

  return "Google authorization failed after approval. Start again, choose the same account entered in Command Center, and paste the newest complete browser address.";
}

interface GoogleOAuthExpectation {
  readonly redirectUri: string;
  readonly state: string;
}

export function prepareGoogleAuthorizationUrl(
  authUrl: string,
  email: string,
): { readonly authUrl: string; readonly expectation: GoogleOAuthExpectation } | undefined {
  try {
    const url = new URL(authUrl);
    if (url.protocol !== "https:") return undefined;
    const redirectUri = url.searchParams.get("redirect_uri")?.trim();
    const state = url.searchParams.get("state")?.trim();
    if (!redirectUri || !state) return undefined;
    const redirect = new URL(redirectUri);
    if (
      redirect.protocol !== "http:" ||
      redirect.hostname !== "127.0.0.1" ||
      redirect.pathname !== "/oauth2/callback"
    ) {
      return undefined;
    }
    url.searchParams.set("login_hint", email);
    return {
      authUrl: url.toString(),
      expectation: { redirectUri: redirect.toString(), state },
    };
  } catch {
    return undefined;
  }
}

export function validateGoogleCallbackAddress(
  callbackAddress: string,
  expectation: GoogleOAuthExpectation,
): string | undefined {
  try {
    const callback = new URL(callbackAddress);
    const expected = new URL(expectation.redirectUri);
    if (
      callback.protocol !== expected.protocol ||
      callback.host !== expected.host ||
      callback.pathname !== expected.pathname
    ) {
      return "Paste the complete 127.0.0.1 address from the browser tab opened by this setup.";
    }
    const providerError = callback.searchParams.get("error");
    if (providerError) {
      return providerError === "access_denied"
        ? "Google access was not approved. Start again and approve the requested permissions."
        : "Google did not approve this authorization request. Start again and review the OAuth app configuration.";
    }
    if (callback.searchParams.get("state") !== expectation.state) {
      return "This browser address belongs to another or expired Google setup attempt. Start again and use the newly opened authorization tab.";
    }
    if (!callback.searchParams.get("code")) {
      return "The pasted address does not contain Google's authorization code. Copy the complete address from the browser address bar.";
    }
    return undefined;
  } catch {
    return "The pasted browser address is not valid. Copy the complete address from the browser address bar and try again.";
  }
}

const decodeOAuthClients = Schema.decodeUnknownEffect(Schema.fromJsonString(OAuthClientsResult));
const decodeOAuthBegin = Schema.decodeUnknownEffect(Schema.fromJsonString(OAuthBeginResult));
const decodeOAuthComplete = Schema.decodeUnknownEffect(Schema.fromJsonString(OAuthCompleteResult));
const decodeHelperOutput = <A>(
  decode: (input: unknown) => Effect.Effect<A, Schema.SchemaError>,
  value: string,
) =>
  decode(value).pipe(
    Effect.mapError((cause) =>
      connectorError("The Google connection helper returned an unexpected response.", cause),
    ),
  );

export const layer = Layer.effect(
  GoogleConnectionSetup,
  Effect.gen(function* () {
    const runner = yield* ProcessRunner;
    const serverConfig = yield* ServerConfig;
    const commandCenterConfig = yield* CommandCenterConfig;
    const crypto = yield* Crypto.Crypto;
    const path = yield* Path.Path;
    const sessions = yield* Ref.make(new Map<string, SetupSession>());
    const binary = process.env.COMMAND_CENTER_GOG_BINARY ?? "gog";
    const gogHome = `${serverConfig.secretsDir}/gog`;
    const env: NodeJS.ProcessEnv = {
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

    const run = Effect.fn("GoogleConnectionSetup.run")(function* (
      args: ReadonlyArray<string>,
      stdin?: string,
    ) {
      const result = yield* runner
        .run({
          command: binary,
          args,
          env,
          extendEnv: false,
          ...(stdin === undefined ? {} : { stdin }),
          timeout: "45 seconds",
          maxOutputBytes: 1024 * 1024,
        })
        .pipe(
          Effect.mapError((cause) =>
            connectorError(
              `Google setup could not start. Install gog ${PINNED_GOG_VERSION} on this environment.`,
              cause,
            ),
          ),
        );
      if (result.code !== 0) {
        return yield* connectorError(googleSetupFailureMessage(result.stderr));
      }
      return result.stdout;
    });

    const verifyBinary = Effect.fn("GoogleConnectionSetup.verifyBinary")(function* () {
      const result = yield* run(["--version"]);
      if (!hasPinnedGogVersion(result)) {
        return yield* connectorError(
          `This environment requires gog ${PINNED_GOG_VERSION} before a Google account can be connected.`,
        );
      }
    });

    const ensureOAuthClient = Effect.fn("GoogleConnectionSetup.ensureOAuthClient")(function* (
      oauthClientJson?: string,
    ) {
      const clients = yield* run(["--json", "--no-input", "auth", "credentials", "list"]).pipe(
        Effect.flatMap((value) => decodeHelperOutput(decodeOAuthClients, value)),
      );
      if (clients.clients.length > 0) return;
      if (oauthClientJson === undefined)
        return yield* connectorError(
          "Upload a Google Desktop OAuth client JSON file to connect the first account on this environment.",
        );
      yield* run(["--json", "--no-input", "auth", "credentials", "-"], oauthClientJson);
    });

    const authReplayArgs = (
      email: string,
      capabilities: CommandCenterGoogleConnectionSetupBeginInput["capabilities"],
    ): ReadonlyArray<string> => [
      "auth",
      "add",
      email,
      "--services",
      "gmail",
      "--gmail-scope",
      "readonly",
      ...(capabilities.includes("gmail.drafts.create")
        ? ["--extra-scopes", GMAIL_COMPOSE_SCOPE]
        : ["--readonly"]),
      "--force-consent",
    ];

    const begin = Effect.fn("GoogleConnectionSetup.begin")(function* (
      input: CommandCenterGoogleConnectionSetupBeginInput,
    ) {
      yield* commandCenterConfig.load.pipe(
        Effect.flatMap((loaded) =>
          loaded.spaces.some((space) => space.id === input.spaceId)
            ? Effect.void
            : Effect.fail(
                new CommandCenterError({
                  reason: "not_found",
                  message: "The selected Space was not found.",
                }),
              ),
        ),
      );
      yield* verifyBinary();
      yield* ensureOAuthClient(input.oauthClientJson);
      const replayArgs = authReplayArgs(input.email, input.capabilities);
      const result = yield* run([
        "--json",
        "--no-input",
        ...replayArgs,
        "--remote",
        "--step",
        "1",
      ]).pipe(Effect.flatMap((value) => decodeHelperOutput(decodeOAuthBegin, value)));
      const prepared = prepareGoogleAuthorizationUrl(result.auth_url, input.email);
      if (prepared === undefined)
        return yield* connectorError("Google setup returned an invalid authorization URL.");
      const sessionId = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) =>
          connectorError("Could not create a Google setup session.", cause),
        ),
      );
      const now = yield* DateTime.now;
      const expiresAt = DateTime.add(now, { minutes: GOOGLE_OAUTH_SESSION_TTL_MINUTES });
      yield* Ref.update(sessions, (current) => {
        const next = new Map(current);
        next.set(sessionId, {
          spaceId: input.spaceId,
          email: input.email,
          capabilities: input.capabilities,
          replayArgs,
          expectedRedirectUri: prepared.expectation.redirectUri,
          expectedState: prepared.expectation.state,
          expiresAtMs: DateTime.toEpochMillis(expiresAt),
        });
        return next;
      });
      return {
        sessionId,
        authUrl: prepared.authUrl,
        expiresAt: DateTime.formatIso(expiresAt),
      };
    });

    const complete = Effect.fn("GoogleConnectionSetup.complete")(function* (
      input: CommandCenterGoogleConnectionSetupCompleteInput,
    ) {
      const session = (yield* Ref.get(sessions)).get(input.sessionId);
      const now = yield* DateTime.now;
      if (session === undefined || session.expiresAtMs <= DateTime.toEpochMillis(now)) {
        return yield* new CommandCenterError({
          reason: "validation",
          message: "This Google setup session expired. Start the connection again.",
        });
      }
      const callbackError = validateGoogleCallbackAddress(input.redirectUrl, {
        redirectUri: session.expectedRedirectUri,
        state: session.expectedState,
      });
      if (callbackError !== undefined) {
        return yield* new CommandCenterError({ reason: "validation", message: callbackError });
      }
      const result = yield* run([
        "--json",
        "--no-input",
        ...session.replayArgs,
        "--remote",
        "--step",
        "2",
        "--auth-url",
        input.redirectUrl,
      ]).pipe(Effect.flatMap((value) => decodeHelperOutput(decodeOAuthComplete, value)));
      if (!result.stored || result.email.toLowerCase() !== session.email.toLowerCase()) {
        return yield* connectorError(
          `Google authorized ${result.email || "a different account"}; expected ${session.email}.`,
        );
      }
      if (commandCenterConfig.upsertRuntimeGoogleConnection === undefined) {
        return yield* connectorError("This environment cannot store Google connections.");
      }
      const { connectionId } = yield* commandCenterConfig.upsertRuntimeGoogleConnection({
        spaceId: session.spaceId,
        accountAlias: result.email,
        accountLabel: result.email,
        capabilities: session.capabilities,
      });
      yield* Ref.update(sessions, (current) => {
        const next = new Map(current);
        next.delete(input.sessionId);
        return next;
      });
      return { spaceId: session.spaceId, connectionId: ConnectionId.make(connectionId) };
    });

    const remove = Effect.fn("GoogleConnectionSetup.remove")(function* (
      input: CommandCenterGoogleConnectionRemoveInput,
    ) {
      if (commandCenterConfig.removeRuntimeGoogleConnection === undefined) {
        return yield* connectorError("This environment cannot remove Google connections.");
      }
      yield* commandCenterConfig.removeRuntimeGoogleConnection(input);
      return { connectionId: ConnectionId.make(input.connectionId), removed: true as const };
    });

    return GoogleConnectionSetup.of({ begin, complete, remove });
  }),
);
