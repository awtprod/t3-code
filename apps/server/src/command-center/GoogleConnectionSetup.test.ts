import * as NodeServices from "@effect/platform-node/NodeServices";
import { Space } from "@command-center/core";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { CommandCenterConfig, type LoadedCommandCenterConfig } from "./Config.ts";
import {
  GoogleConnectionSetup,
  layer as googleConnectionSetupLayer,
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
            return output('{"auth_url":"https://accounts.google.test/auth","state_reused":false}');
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
      redirectUrl: "http://127.0.0.1/oauth2/callback?code=code&state=state",
    });
    expect(
      yield* setup.remove({
        spaceId: space.id,
        connectionId: completed.connectionId,
      }),
    ).toEqual({ connectionId: "google-person-example", removed: true });

    expect(begun.authUrl).toBe("https://accounts.google.test/auth");
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
        "http://127.0.0.1/oauth2/callback?code=code&state=state",
      ]),
    );
    for (const invocation of invocations) {
      expect(invocation.extendEnv).toBe(false);
      expect(invocation.env).toEqual(
        expect.objectContaining({
          HOME: expect.stringContaining("/secrets/gog"),
          XDG_CONFIG_HOME: expect.stringContaining("/secrets/gog"),
        }),
      );
    }
  }).pipe(Effect.provide(testLayer));
});
