import * as NodeServices from "@effect/platform-node/NodeServices";
import { Connection, Space } from "@command-center/core";
import { expect, it } from "@effect/vitest";
import { CommandCenterError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CommandCenterConfig, type LoadedCommandCenterConfig } from "./Config.ts";
import {
  buildGoogleAuthReplayArgs,
  googleSetupFailureMessage,
  GoogleConnectionSetup,
  layer as googleConnectionSetupLayer,
  prepareGoogleAuthorizationUrl,
  validateGoogleCallbackAddress,
} from "./GoogleConnectionSetup.ts";

const space = Schema.decodeUnknownSync(Space)({
  id: "example-space",
  slug: "example-space",
  displayName: "Example Space",
  kind: "personal",
  instructions: "",
  policy: { allowedCapabilities: [], autoRunRiskLevels: [] },
  connectionIds: [],
  repositories: [],
  aliases: [],
  lifecycle: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const loadedConfig = {
  spaces: [space],
  connections: [],
  automations: [],
  timezone: "Etc/UTC",
  routing: null,
  health: { status: "loaded", configDirectory: "/private/config" },
} satisfies LoadedCommandCenterConfig;

const output = (stdout: string) => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

it("targets the entered Google account and validates the matching callback", () => {
  const prepared = prepareGoogleAuthorizationUrl(
    "https://accounts.google.test/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A43123%2Foauth2%2Fcallback&state=state-123",
    "person@example.com",
  );
  expect(prepared).toBeDefined();
  expect(new URL(prepared?.authUrl ?? "").searchParams.get("login_hint")).toBe(
    "person@example.com",
  );
  expect(
    validateGoogleCallbackAddress(
      "http://127.0.0.1:43123/oauth2/callback?code=code&state=state-123",
      prepared?.expectation ?? { redirectUri: "", state: "" },
    ),
  ).toBeUndefined();
  expect(
    validateGoogleCallbackAddress(
      "http://127.0.0.1:43123/oauth2/callback?code=code&state=stale",
      prepared?.expectation ?? { redirectUri: "", state: "" },
    ),
  ).toContain("another or expired");
});

it("turns Google helper failures into actionable messages without echoing callback secrets", () => {
  expect(
    googleSetupFailureMessage("authorized as other@example.com, expected person@example.com"),
  ).toBe("authorized as other@example.com, expected person@example.com");
  expect(
    googleSetupFailureMessage(
      "exchange code: oauth2: invalid_grant code=secret-code state=secret-state",
    ),
  ).toBe(
    "Google rejected this authorization code. Start again and immediately paste the newest browser address; authorization codes cannot be reused.",
  );
});

it.effect("runs split remote OAuth and stores only the runtime account binding", () => {
  const invocations: ProcessRunner.ProcessRunInput[] = [];
  const stored: Array<{
    readonly spaceId: string;
    readonly accountAlias: string;
    readonly capabilities: ReadonlyArray<string>;
  }> = [];
  const removed: Array<{ readonly spaceId: string; readonly connectionId: string }> = [];
  const processLayer = Layer.succeed(
    ProcessRunner.ProcessRunner,
    ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Effect.sync(() => {
          invocations.push(input);
          if (input.args.includes("--version")) return output("gog version 0.15.0");
          if (input.args.includes("list")) return output('{"clients":[]}');
          if (input.args.at(-1) === "-")
            return output('{"saved":true,"path":"runtime","client":"default"}');
          if (input.args.includes("--step") && input.args.includes("1")) {
            return output(
              '{"auth_url":"https://accounts.google.test/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A43123%2Foauth2%2Fcallback&state=state","state_reused":false}',
            );
          }
          return output(
            '{"stored":true,"email":"person@example.com","services":["gmail"],"client":"default"}',
          );
        }),
    }),
  );
  const configLayer = Layer.succeed(
    CommandCenterConfig,
    CommandCenterConfig.of({
      configDirectory: "/private/config",
      load: Effect.succeed(loadedConfig),
      resolveGoogleAccount: () => Effect.die("not used"),
      upsertRuntimeGoogleConnection: (input) =>
        Effect.sync(() => {
          stored.push(input);
          return { connectionId: "google-person-example" };
        }),
      removeRuntimeGoogleConnection: (input) =>
        Effect.sync(() => {
          removed.push(input);
          return { removed: true };
        }),
    }),
  );
  const testLayer = googleConnectionSetupLayer.pipe(
    Layer.provide(processLayer),
    Layer.provide(configLayer),
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(
      ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "command-center-google-setup-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const setup = yield* GoogleConnectionSetup;
    const begun = yield* setup.begin({
      spaceId: space.id,
      email: "person@example.com",
      capabilities: ["gmail.read", "gmail.drafts.create"],
      oauthClientJson: '{"installed":{"client_id":"client","client_secret":"secret"}}',
    });
    const completed = yield* setup.complete({
      sessionId: begun.sessionId,
      redirectUrl: "http://127.0.0.1:43123/oauth2/callback?code=code&state=state",
    });
    expect(
      yield* setup.remove({
        spaceId: space.id,
        connectionId: completed.connectionId,
      }),
    ).toEqual({ connectionId: "google-person-example", removed: true });

    expect(new URL(begun.authUrl).searchParams.get("login_hint")).toBe("person@example.com");
    expect(completed).toEqual({
      spaceId: space.id,
      connectionId: "google-person-example",
    });
    expect(stored).toEqual([
      {
        spaceId: space.id,
        accountAlias: "person@example.com",
        accountLabel: "person@example.com",
        capabilities: ["gmail.read", "gmail.drafts.create"],
      },
    ]);
    expect(removed).toEqual([{ spaceId: space.id, connectionId: "google-person-example" }]);
    const beginArgs = invocations.find((entry) => entry.args.includes("1"))?.args ?? [];
    const completeArgs = invocations.find((entry) => entry.args.includes("2"))?.args ?? [];
    expect(beginArgs).toEqual(expect.arrayContaining(["--remote", "--step", "1"]));
    expect(beginArgs).toContain("https://www.googleapis.com/auth/gmail.compose");
    expect(beginArgs).toContain("--force-consent");
    const credentialsInvocation = invocations.find((entry) => entry.args.at(-1) === "-");
    expect(credentialsInvocation?.stdin).toBe(
      '{"installed":{"client_id":"client","client_secret":"secret"}}',
    );
    expect(credentialsInvocation?.args).not.toContain("secret");
    expect(completeArgs).toEqual(
      expect.arrayContaining([
        "--remote",
        "--step",
        "2",
        "--auth-url",
        "http://127.0.0.1:43123/oauth2/callback?code=code&state=state",
      ]),
    );
    for (const invocation of invocations) {
      expect(invocation.extendEnv).toBe(false);
      expect(invocation.env).toEqual(
        expect.objectContaining({
          HOME: expect.stringContaining("/secrets/gog"),
          XDG_CONFIG_HOME: expect.stringContaining("/secrets/gog"),
          GOG_KEYRING_BACKEND: "file",
          GOG_KEYRING_PASSWORD: expect.any(String),
        }),
      );
    }
  }).pipe(Effect.provide(testLayer));
});

it("requests read-only scopes, adding Calendar and the compose scope only when asked", () => {
  const compose = "https://www.googleapis.com/auth/gmail.compose";
  const base = ["auth", "add", "person@example.com"];
  expect(buildGoogleAuthReplayArgs("person@example.com", ["gmail.read"])).toEqual([
    ...base,
    "--services",
    "gmail",
    "--gmail-scope",
    "readonly",
    "--readonly",
    "--force-consent",
  ]);
  expect(buildGoogleAuthReplayArgs("person@example.com", ["gmail.read", "calendar.read"])).toEqual([
    ...base,
    "--services",
    "gmail,calendar",
    "--gmail-scope",
    "readonly",
    "--readonly",
    "--force-consent",
  ]);
  expect(
    buildGoogleAuthReplayArgs("person@example.com", [
      "gmail.read",
      "gmail.drafts.create",
      "calendar.read",
    ]),
  ).toEqual([
    ...base,
    "--services",
    "gmail,calendar",
    "--gmail-scope",
    "readonly",
    "--readonly",
    "--extra-scopes",
    compose,
    "--force-consent",
  ]);
});

const setupHarness = (input: {
  readonly connections: LoadedCommandCenterConfig["connections"];
  readonly accountAliasFor: (connectionId: string) => string | undefined;
}) => {
  const invocations: ProcessRunner.ProcessRunInput[] = [];
  const stored: Array<ReadonlyArray<string>> = [];
  const processLayer = Layer.succeed(
    ProcessRunner.ProcessRunner,
    ProcessRunner.ProcessRunner.of({
      run: (run) =>
        Effect.sync(() => {
          invocations.push(run);
          if (run.args.includes("--version")) return output("gog version 0.15.0");
          if (run.args.includes("list")) return output('{"clients":[{"client":"default"}]}');
          if (run.args.includes("--step") && run.args.includes("1")) {
            return output(
              '{"auth_url":"https://accounts.google.test/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A43123%2Foauth2%2Fcallback&state=state","state_reused":false}',
            );
          }
          return output(
            '{"stored":true,"email":"person@example.com","services":["gmail","calendar"],"client":"default"}',
          );
        }),
    }),
  );
  const configLayer = Layer.succeed(
    CommandCenterConfig,
    CommandCenterConfig.of({
      configDirectory: "/private/config",
      load: Effect.succeed({ ...loadedConfig, connections: input.connections }),
      resolveGoogleAccount: ({ connectionId }) => {
        const accountAlias = input.accountAliasFor(connectionId);
        return accountAlias === undefined
          ? Effect.fail(new CommandCenterError({ reason: "config", message: "not enabled" }))
          : Effect.succeed({ accountAlias, label: accountAlias });
      },
      upsertRuntimeGoogleConnection: (upsert) =>
        Effect.sync(() => {
          stored.push(upsert.capabilities);
          return { connectionId: "google-primary" };
        }),
    }),
  );
  const layer = googleConnectionSetupLayer.pipe(
    Layer.provide(processLayer),
    Layer.provide(configLayer),
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(
      ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "command-center-google-setup-calendar-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  const connectOnce = Effect.gen(function* () {
    const setup = yield* GoogleConnectionSetup;
    const begun = yield* setup.begin({
      spaceId: space.id,
      email: "Person@Example.com",
      capabilities: ["gmail.read"],
    });
    yield* setup.complete({
      sessionId: begun.sessionId,
      redirectUrl: "http://127.0.0.1:43123/oauth2/callback?code=code&state=state",
    });
    return invocations.find((entry) => entry.args.includes("1"))?.args ?? [];
  }).pipe(Effect.provide(layer));
  return { connectOnce, stored };
};

const decodeConnection = Schema.decodeUnknownSync(Connection);
const declaredConnection = (id: string, capabilities: ReadonlyArray<string>) =>
  decodeConnection({
    id,
    spaceId: space.id,
    kind: "google",
    label: "Primary account",
    capabilities,
    health: "disconnected",
  });

it.effect("grants Calendar read when the Space's connection for that account declares it", () => {
  const harness = setupHarness({
    connections: [
      declaredConnection("google-primary", [
        "cc.connections.google.gmail.read",
        "cc.connections.google.calendar.read",
      ]),
    ],
    accountAliasFor: (connectionId) =>
      connectionId === "google-primary" ? "person@example.com" : undefined,
  });
  return Effect.gen(function* () {
    const beginArgs = yield* harness.connectOnce;
    expect(beginArgs).toEqual(
      expect.arrayContaining(["--services", "gmail,calendar", "--readonly"]),
    );
    expect(harness.stored).toEqual([["gmail.read", "calendar.read"]]);
  });
});

it.effect("keeps Gmail-only consent when the declaring connection is another account", () => {
  const harness = setupHarness({
    connections: [
      declaredConnection("google-other", ["cc.connections.google.calendar.read"]),
      declaredConnection("google-unresolvable", ["cc.connections.google.calendar.read"]),
    ],
    accountAliasFor: (connectionId) =>
      connectionId === "google-other" ? "other@example.com" : undefined,
  });
  return Effect.gen(function* () {
    const beginArgs = yield* harness.connectOnce;
    expect(beginArgs).toEqual(expect.arrayContaining(["--services", "gmail", "--readonly"]));
    expect(beginArgs).not.toContain("gmail,calendar");
    expect(harness.stored).toEqual([["gmail.read"]]);
  });
});
