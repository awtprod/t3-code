import {
  Automation,
  type Automation as AutomationType,
  type Space as SpaceType,
} from "@command-center/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ProcessRunner } from "../../processRunner.ts";
import {
  hardenedHostGitArguments,
  hardenedHostGitEnvironment,
  resolveTrustedHostExecutable,
} from "../../vcs/HostGitSecurity.ts";
import {
  type AutomationDefinition,
  type AutomationFileTrigger,
  validateAutomationDefinition,
} from "./Definition.ts";
import { digestAutomationDefinition } from "./Digest.ts";

export interface CommittedAutomationSnapshot {
  readonly commitSha: string | null;
  readonly automations: ReadonlyArray<AutomationType>;
}

const COMMIT_SHA_PATTERN = /^[a-f0-9]{40,64}$/u;
const COMMITTED_AUTOMATION_PATH_PATTERN = /^automations\/[^/]+\.json$/u;
const decodeAutomation = Schema.decodeUnknownEffect(Automation);
const decodeUnknownJsonString = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

export class CommittedAutomationConfigError extends Schema.TaggedErrorClass<CommittedAutomationConfigError>()(
  "CommittedAutomationConfigError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const loadError = (detail: string, cause?: unknown): CommittedAutomationConfigError =>
  new CommittedAutomationConfigError({
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

function coreTrigger(trigger: AutomationFileTrigger): AutomationType["trigger"] {
  switch (trigger.kind) {
    case "manual":
      return { type: "manual" };
    case "schedule":
      return {
        type: "schedule",
        expression: trigger.expression,
        timezone: trigger.timezone,
      };
    case "webhook":
      return { type: "webhook", route: trigger.route };
  }
}

function isJsonObject(value: unknown): value is Readonly<Record<string, Schema.Json>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nodePosition(
  definition: AutomationDefinition,
  nodeId: string,
  index: number,
): { readonly x: number; readonly y: number } {
  const positions = definition.layout.nodes ?? definition.layout.positions;
  const position = isJsonObject(positions) ? positions[nodeId] : undefined;
  if (isJsonObject(position) && typeof position.x === "number" && typeof position.y === "number") {
    return { x: position.x, y: position.y };
  }
  return { x: 0, y: index * 120 };
}

const toCoreAutomation = Effect.fn("CommandCenter.toCoreAutomation")(function* (
  definition: AutomationDefinition,
  commitSha: string,
  committedAt: string,
) {
  return yield* decodeAutomation({
    id: definition.id,
    spaceId: definition.spaceId,
    name: definition.name,
    version: definition.schemaVersion,
    enabled: definition.enabled,
    trigger: coreTrigger(definition.trigger),
    nodes: definition.nodes.map((node, index) => ({
      id: node.id,
      kind: node.kind === "agent.run" ? "agent" : node.kind,
      config: node.config,
      position: nodePosition(definition, node.id, index),
    })),
    edges: definition.edges.map((edge) => ({
      sourceNodeId: edge.from,
      targetNodeId: edge.to,
    })),
    definitionDigest: digestAutomationDefinition(definition),
    configCommit: commitSha,
    createdAt: committedAt,
    updatedAt: committedAt,
  }).pipe(
    Effect.mapError((cause) =>
      loadError(`Committed automation '${definition.id}' could not be normalized.`, cause),
    ),
  );
});

/**
 * Reads automation source exclusively from the checkout's HEAD tree. Working-tree
 * files and edits are intentionally ignored so runtime definitions always have a
 * verifiable commit and content digest.
 */
export const loadCommittedAutomations = Effect.fn("CommandCenter.loadCommittedAutomations")(
  function* (configDirectory: string, spaces: ReadonlyArray<SpaceType>) {
    const runner = yield* ProcessRunner;
    const gitExecutable = resolveTrustedHostExecutable("git", {
      writableRoots: [configDirectory],
    });
    if (gitExecutable === undefined) {
      return yield* loadError("Could not resolve Git outside the writable config checkout.");
    }

    const runGit = Effect.fn("CommandCenter.loadCommittedAutomations.git")(function* (
      args: ReadonlyArray<string>,
    ) {
      return yield* runner
        .run({
          command: gitExecutable,
          args: hardenedHostGitArguments(["-C", configDirectory, ...args]),
          env: hardenedHostGitEnvironment([], { writableRoots: [configDirectory] }),
          extendEnv: false,
          timeout: "10 seconds",
          maxOutputBytes: 4 * 1024 * 1024,
        })
        .pipe(
          Effect.mapError((cause) => loadError("Could not inspect the config checkout.", cause)),
        );
    });

    const repository = yield* runGit(["rev-parse", "--is-inside-work-tree"]);
    if (repository.code !== 0 || repository.stdout.trim() !== "true") {
      return { commitSha: null, automations: [] } satisfies CommittedAutomationSnapshot;
    }

    const head = yield* runGit(["rev-parse", "--verify", "HEAD^{commit}"]);
    if (head.code !== 0) {
      return { commitSha: null, automations: [] } satisfies CommittedAutomationSnapshot;
    }
    const commitSha = head.stdout.trim().toLowerCase();
    if (!COMMIT_SHA_PATTERN.test(commitSha)) {
      return yield* loadError("The config checkout returned an invalid commit identifier.");
    }

    const timestamp = yield* runGit(["show", "-s", "--format=%cI", commitSha]);
    if (timestamp.code !== 0) {
      return yield* loadError("Could not read the config commit timestamp.");
    }
    const committedAt = timestamp.stdout.trim();
    if (committedAt.length === 0 || Number.isNaN(Date.parse(committedAt))) {
      return yield* loadError("The config commit returned an invalid timestamp.");
    }

    const tree = yield* runGit(["ls-tree", "-rz", "--name-only", commitSha, "--", "automations"]);
    if (tree.code !== 0) {
      return yield* loadError("Could not list committed automation definitions.");
    }

    const paths = tree.stdout
      .split("\0")
      .filter((filePath) => COMMITTED_AUTOMATION_PATH_PATTERN.test(filePath))
      .sort();
    const spaceIds = new Set(spaces.map((space) => space.id));
    const automationIds = new Set<string>();
    const automations = yield* Effect.forEach(paths, (filePath) =>
      Effect.gen(function* () {
        const source = yield* runGit(["show", `${commitSha}:${filePath}`]);
        if (source.code !== 0) {
          return yield* loadError(`Could not read committed automation file '${filePath}'.`);
        }
        const parsed = yield* decodeUnknownJsonString(source.stdout).pipe(
          Effect.mapError((cause) =>
            loadError(`Committed automation '${filePath}' is not valid JSON.`, cause),
          ),
        );
        const validated = validateAutomationDefinition(parsed);
        if (!validated.ok) {
          const details = validated.issues.map((issue) => issue.message).join("; ");
          return yield* loadError(`Committed automation '${filePath}' is invalid: ${details}`);
        }
        if (!spaceIds.has(validated.definition.spaceId)) {
          return yield* loadError(
            `Committed automation '${filePath}' references an unknown Space.`,
          );
        }
        if (automationIds.has(validated.definition.id)) {
          return yield* loadError(
            `Committed automation id '${validated.definition.id}' is declared more than once.`,
          );
        }
        automationIds.add(validated.definition.id);
        return yield* toCoreAutomation(validated.definition, commitSha, committedAt);
      }),
    );

    return { commitSha, automations } satisfies CommittedAutomationSnapshot;
  },
);
