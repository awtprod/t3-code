import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { SalesDraftRequest } from "@command-center/core";
import { CommandCenterError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import { ProcessTimeoutError } from "../processRunner.ts";
import * as ServerConfig from "../config.ts";
import { CommandCenterConfig } from "./Config.ts";
import { ConnectionHealth } from "./ConnectionHealth.ts";

import {
  GOOGLE_DRAFT_COMMAND_ALLOWLIST,
  buildGoogleDraftCreateInvocation,
  buildGoogleDraftGetInvocation,
  buildGoogleDraftListInvocation,
  googleDraftMatches,
  GoogleDraftConnector,
  layer as googleDraftConnectorLayer,
} from "./GoogleDraftConnector.ts";

describe("GoogleDraftConnector invocation boundary", () => {
  const request = {
    recipient: "creator@example.com",
    subject: "A focused thumbnail sprint idea",
    body: "This body is supplied only through standard input.",
  };

  it("exposes only exact draft create/list/get commands and always retains no-send", () => {
    const invocations = [
      buildGoogleDraftCreateInvocation("sales-space", request),
      buildGoogleDraftListInvocation("sales-space"),
      buildGoogleDraftGetInvocation("sales-space", "draft-123"),
    ];

    expect(GOOGLE_DRAFT_COMMAND_ALLOWLIST).toEqual([
      "gmail.drafts.create",
      "gmail.drafts.list",
      "gmail.drafts.get",
    ]);
    for (const args of invocations) {
      expect(args).toContain("--gmail-no-send");
      expect(args).toContain("--no-input");
      expect(args).toContain("--enable-commands-exact");
      expect(args).toContain(GOOGLE_DRAFT_COMMAND_ALLOWLIST.join(","));
      expect(args).not.toContain("send");
      expect(args).not.toContain("forward");
      expect(args).not.toContain("delete");
      expect(args).not.toContain("modify");
    }
  });

  it("keeps the body out of argv so it can only be passed through standard input", () => {
    const args = buildGoogleDraftCreateInvocation("sales-space", request);

    expect(args).toEqual(
      expect.arrayContaining([
        "gmail",
        "drafts",
        "create",
        "--to",
        request.recipient,
        "--subject",
        request.subject,
        "--body-file",
        "-",
      ]),
    );
    expect(args).not.toContain(request.body);
  });

  it("protects the draft id from being interpreted as an option", () => {
    const args = buildGoogleDraftGetInvocation("sales-space", "--account=another-account");
    expect(args.slice(-2)).toEqual(["--", "--account=another-account"]);
  });

  it("reconciles only an exact recipient, subject, and body match", () => {
    expect(
      googleDraftMatches(
        {
          id: "draft-1",
          headers: { to: request.recipient, subject: request.subject },
          body: request.body,
        },
        request,
      ),
    ).toBe(true);
    expect(
      googleDraftMatches(
        {
          id: "draft-1",
          headers: { to: request.recipient, subject: request.subject },
          body: "changed",
        },
        request,
      ),
    ).toBe(false);
  });
});

const decodeDraftRequest = Schema.decodeUnknownSync(SalesDraftRequest);
const baseRequest = decodeDraftRequest({
  id: "request-1",
  prospectId: "prospect-1",
  spaceId: "sales-space",
  connectionId: "sales-google",
  recipient: "creator@example.com",
  subject: "A focused thumbnail sprint idea",
  body: "Body supplied through standard input.",
  payloadDigest: "digest-1",
  status: "approved",
  requestedAt: "2026-08-01T00:00:00.000Z",
});

const invocations: ProcessRunner.ProcessRunInput[] = [];
const runnerLayer = Layer.succeed(
  ProcessRunner.ProcessRunner,
  ProcessRunner.ProcessRunner.of({
    run: (input) => {
      invocations.push(input);
      if (input.args[0] === "--version") {
        return Effect.succeed({
          stdout: "gog 0.15.0",
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        });
      }
      if (input.args.includes("timeout-subject")) {
        return Effect.fail(
          new ProcessTimeoutError({
            command: input.command,
            argumentCount: input.args.length,
            timeoutMs: 45_000,
          }),
        );
      }
      const output = input.args.includes("list")
        ? '{"drafts":[{"id":"existing-draft"}]}'
        : input.args.includes("get")
          ? JSON.stringify({
              id: "existing-draft",
              headers: { to: baseRequest.recipient, subject: baseRequest.subject },
              body: baseRequest.body,
            })
          : input.args.includes("malformed-subject")
            ? "{not-json"
            : '{"id":"created-draft"}';
      const oauthFailure = input.args.includes("oauth-subject");
      return Effect.succeed({
        stdout: oauthFailure ? "" : output,
        stderr: oauthFailure ? "invalid_grant" : "",
        code: ChildProcessSpawner.ExitCode(oauthFailure ? 1 : 0),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      });
    },
  }),
);

const connectorLayer = googleDraftConnectorLayer.pipe(
  Layer.provideMerge(runnerLayer),
  Layer.provideMerge(
    Layer.succeed(
      CommandCenterConfig,
      CommandCenterConfig.of({
        configDirectory: "runtime-config",
        load: Effect.die("not used"),
        resolveGoogleAccount: ({ spaceId, connectionId }) =>
          spaceId === baseRequest.spaceId && connectionId === baseRequest.connectionId
            ? Effect.succeed({ accountAlias: "sales-space", label: "Sales Gmail" })
            : Effect.fail(new CommandCenterError({ reason: "config", message: "disabled" })),
      }),
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      ConnectionHealth,
      ConnectionHealth.of({
        syncConfigured: () => Effect.void,
        markConnected: () => Effect.void,
        markDegraded: () => Effect.void,
        markDisconnected: () => Effect.void,
      }),
    ),
  ),
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "gmail-draft-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("passes the exact approved body through stdin and returns the Gmail draft id", () =>
  Effect.gen(function* () {
    invocations.length = 0;
    const connector = yield* GoogleDraftConnector;
    const created = yield* connector.create(baseRequest);
    const call = invocations.find((input) => input.args.includes("create"));
    expect(created.draftId).toBe("created-draft");
    expect(call?.stdin).toBe(baseRequest.body);
    expect(call?.args).not.toContain(baseRequest.body);
  }).pipe(Effect.provide(connectorLayer)),
);

it.effect("reconciles an exact existing draft before a retry creates anything", () =>
  Effect.gen(function* () {
    invocations.length = 0;
    const connector = yield* GoogleDraftConnector;
    const existing = yield* connector.findExisting(baseRequest);
    expect(existing).toBe("existing-draft");
    expect(invocations.some((input) => input.args.includes("create"))).toBe(false);
  }).pipe(Effect.provide(connectorLayer)),
);

it.effect(
  "reports invalid OAuth, malformed JSON, and timeouts without exposing a send fallback",
  () =>
    Effect.gen(function* () {
      const connector = yield* GoogleDraftConnector;
      const oauth = yield* connector
        .create({ ...baseRequest, subject: "oauth-subject" })
        .pipe(Effect.flip);
      const malformed = yield* connector
        .create({ ...baseRequest, subject: "malformed-subject" })
        .pipe(Effect.flip);
      const timeout = yield* connector
        .create({ ...baseRequest, subject: "timeout-subject" })
        .pipe(Effect.flip);
      expect(oauth.reason).toBe("process");
      expect(malformed.reason).toBe("output");
      expect(timeout.reason).toBe("process");
      for (const invocation of invocations) {
        expect(invocation.args).not.toContain("send");
        expect(invocation.args).not.toContain("forward");
        expect(invocation.args).not.toContain("delete");
      }
    }).pipe(Effect.provide(connectorLayer)),
);
