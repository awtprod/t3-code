import { expect, it } from "@effect/vitest";
import { CAPABILITY_NAMES, Space } from "@command-center/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ProcessRunner, type ProcessRunInput, type ProcessRunOutput } from "../../processRunner.ts";
import { HOST_GIT_HARDENED_CONFIG_ARGS } from "../../vcs/HostGitSecurity.ts";
import {
  CommittedAutomationConfigError,
  loadCommittedAutomations,
} from "./CommittedDefinitions.ts";

const commitSha = "1234567890abcdef1234567890abcdef12345678";
const committedAt = "2026-01-01T12:00:00+00:00";
const automationPath = "automations/sample-brief.json";
const decodeSpace = Schema.decodeUnknownSync(Space);

const sampleSpace = decodeSpace({
  id: "sample-space",
  slug: "sample-space",
  displayName: "Sample Space",
  kind: "business",
  instructions: "Use sample-only fixtures.",
  policy: {
    allowedCapabilities: CAPABILITY_NAMES,
    autoRunRiskLevels: ["low", "reversible"],
  },
  connectionIds: [],
  repositories: [],
  aliases: [],
  lifecycle: "active",
  createdAt: committedAt,
  updatedAt: committedAt,
});

const sampleDefinition = () => ({
  $schema: "../schemas/automation.schema.json",
  schemaVersion: 1,
  id: "sample-brief",
  name: "Sample brief",
  spaceId: "sample-space",
  enabled: true,
  trigger: {
    kind: "schedule",
    expression: "0 9 * * 1",
    timezone: "Etc/UTC",
  },
  nodes: [
    { id: "collect", kind: "connector.read", config: { source: "sample" } },
    { id: "summarize", kind: "transform", config: { template: "Summarize" } },
  ],
  edges: [{ from: "collect", to: "summarize" }],
  layout: { positions: { summarize: { x: 240, y: 80 } } },
  policy: { approval: { external: true } },
});

function output(stdout: string, code = 0): ProcessRunOutput {
  return {
    stdout,
    stderr: "",
    code: code as ProcessRunOutput["code"],
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function gitLayer(
  definition: unknown,
  options: { readonly hasHead?: boolean } = {},
): Layer.Layer<ProcessRunner> {
  const run = (input: ProcessRunInput) => {
    expect(input.args.slice(0, HOST_GIT_HARDENED_CONFIG_ARGS.length)).toEqual(
      HOST_GIT_HARDENED_CONFIG_ARGS,
    );
    expect(input.env).toMatchObject({
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    });
    expect(input.extendEnv).toBe(false);
    const args = input.args.slice(HOST_GIT_HARDENED_CONFIG_ARGS.length + 2);
    if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
      return Effect.succeed(output("true\n"));
    }
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      return Effect.succeed(options.hasHead === false ? output("", 128) : output(`${commitSha}\n`));
    }
    if (args[0] === "show" && args[1] === "-s") {
      return Effect.succeed(output(`${committedAt}\n`));
    }
    if (args[0] === "ls-tree") {
      return Effect.succeed(output(`${automationPath}\0`));
    }
    if (args[0] === "show" && args[1] === `${commitSha}:${automationPath}`) {
      return Effect.succeed(output(JSON.stringify(definition)));
    }
    return Effect.succeed(output("", 1));
  };

  return Layer.succeed(ProcessRunner, ProcessRunner.of({ run }));
}

it.effect("loads and normalizes automation definitions from the committed tree", () =>
  Effect.gen(function* () {
    const snapshot = yield* loadCommittedAutomations("/sample/config", [sampleSpace]);

    expect(snapshot.commitSha).toBe(commitSha);
    expect(snapshot.automations).toHaveLength(1);
    expect(snapshot.automations[0]).toMatchObject({
      id: "sample-brief",
      configCommit: commitSha,
      enabled: true,
      trigger: {
        type: "schedule",
        expression: "0 9 * * 1",
        timezone: "Etc/UTC",
      },
      nodes: [
        expect.objectContaining({ id: "collect", kind: "connector.read" }),
        expect.objectContaining({
          id: "summarize",
          kind: "transform",
          position: { x: 240, y: 80 },
        }),
      ],
    });
    expect(snapshot.automations[0]?.definitionDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  }).pipe(Effect.provide(gitLayer(sampleDefinition()))),
);

it.effect("loads normalized webhook definitions from the committed tree", () => {
  const definition = sampleDefinition();
  definition.trigger = { kind: "webhook", route: "/hooks/sample" } as never;

  return Effect.gen(function* () {
    const snapshot = yield* loadCommittedAutomations("/sample/config", [sampleSpace]);
    expect(snapshot.automations[0]?.trigger).toEqual({
      type: "webhook",
      route: "/hooks/sample",
    });
    expect(snapshot.automations[0]?.configCommit).toBe(commitSha);
    expect(snapshot.automations[0]?.definitionDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  }).pipe(Effect.provide(gitLayer(definition)));
});

it.effect("loads positions written by the visual editor's canonical layout key", () => {
  const definition = sampleDefinition();
  definition.layout = { nodes: { collect: { x: 120, y: 160 } } } as never;

  return Effect.gen(function* () {
    const snapshot = yield* loadCommittedAutomations("/sample/config", [sampleSpace]);
    expect(snapshot.automations[0]?.nodes[0]?.position).toEqual({ x: 120, y: 160 });
  }).pipe(Effect.provide(gitLayer(definition)));
});

it.effect("loads unfinished graphs as disabled drafts", () => {
  const definition = sampleDefinition();
  definition.edges.push({ from: "summarize", to: "collect" });

  return Effect.gen(function* () {
    const snapshot = yield* loadCommittedAutomations("/sample/config", [sampleSpace]);
    expect(snapshot.automations[0]).toMatchObject({ enabled: false });
    expect(snapshot.automations[0]?.edges).toHaveLength(2);
  }).pipe(Effect.provide(gitLayer(definition)));
});

it.effect("loads unfinished schedules as disabled drafts", () => {
  const definition = sampleDefinition();
  definition.trigger = {
    kind: "schedule",
    expression: "every weekday",
    timezone: "Not/AZone",
  };

  return Effect.gen(function* () {
    const snapshot = yield* loadCommittedAutomations("/sample/config", [sampleSpace]);
    expect(snapshot.automations[0]).toMatchObject({
      enabled: false,
      trigger: { type: "schedule", expression: "every weekday", timezone: "Not/AZone" },
    });
  }).pipe(Effect.provide(gitLayer(definition)));
});

it.effect("loads typed agent definitions from the committed tree", () => {
  const definition = sampleDefinition();
  definition.nodes[1]!.kind = "agent.run";
  definition.nodes[1]!.config = { prompt: "Summarize the collected sample" } as never;
  return Effect.gen(function* () {
    const snapshot = yield* loadCommittedAutomations("/sample/config", [sampleSpace]);
    expect(snapshot.automations[0]?.nodes).toContainEqual(
      expect.objectContaining({ id: "summarize", kind: "agent" }),
    );
  }).pipe(Effect.provide(gitLayer(definition)));
});

it.effect("loads incomplete action definitions as disabled drafts", () =>
  Effect.forEach(
    [
      { kind: "agent.run", config: { prompt: "Summarize", spaceId: "other-space" } },
      { kind: "shell.scoped", config: {} },
    ] as const,
    ({ kind, config }) => {
      const definition = sampleDefinition();
      definition.nodes[1]!.kind = kind;
      definition.nodes[1]!.config = config as never;
      return Effect.gen(function* () {
        const snapshot = yield* loadCommittedAutomations("/sample/config", [sampleSpace]);
        expect(snapshot.automations[0]).toMatchObject({ enabled: false });
      }).pipe(Effect.provide(gitLayer(definition)));
    },
  ),
);

it.effect("does not expose working-tree automations before the first commit", () =>
  Effect.gen(function* () {
    const snapshot = yield* loadCommittedAutomations("/sample/config", [sampleSpace]);
    expect(snapshot).toEqual({ commitSha: null, automations: [] });
  }).pipe(Effect.provide(gitLayer(sampleDefinition(), { hasHead: false }))),
);

it("uses a typed config error for committed-definition failures", () => {
  const error = new CommittedAutomationConfigError({ detail: "invalid sample" });
  expect(error._tag).toBe("CommittedAutomationConfigError");
});
