import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { Space } from "./domain.ts";
import {
  ProviderAvailability,
  ProviderModelCandidate,
  RouteSelection,
  RouteResolutionInput,
  normalizeSpaceAlias,
  resolveProviderModelSelection,
  resolveRoute,
  resolveSpaceAlias,
} from "./routing.ts";

const decodeSpace = Schema.decodeUnknownSync(Space);
const decodeProvider = Schema.decodeUnknownSync(ProviderAvailability);
const decodeRouteInput = Schema.decodeUnknownSync(RouteResolutionInput);
const decodeSelection = Schema.decodeUnknownSync(RouteSelection);
const decodeCandidate = Schema.decodeUnknownSync(ProviderModelCandidate);

const sampleStudio = decodeSpace({
  id: "example-studio",
  slug: "example-studio",
  displayName: "Example Studio",
  kind: "business",
  instructions: "Use the example project's conventions.",
  policy: {
    allowedCapabilities: ["cc.items.read", "cc.runs.start"],
    autoRunRiskLevels: ["low", "reversible"],
  },
  connectionIds: [],
  repositories: [
    {
      id: "sample-mobile-app",
      displayName: "Sample Mobile App",
      aliases: ["legacy sample app"],
    },
  ],
  aliases: ["sample works"],
  lifecycle: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

it("selects deterministic tier candidates between policy and classifier", () => {
  const providers = [
    provider({ providerId: "codex", modelIds: ["terra", "sol"], defaultModelId: "sol" }),
    provider({ providerId: "claude", modelIds: ["sonnet"], defaultModelId: "sonnet" }),
  ];
  const tier = resolveProviderModelSelection({
    tierCandidates: [
      decodeCandidate({ candidateId: "economy-codex", providerId: "codex", modelId: "terra" }),
    ],
    classifier: decodeSelection({ providerId: "claude", modelId: "sonnet" }),
    providers,
  });
  assert.strictEqual(tier.providerId, "codex");
  assert.strictEqual(tier.modelId, "terra");
  assert.strictEqual(tier.providerSource, "tier-policy");
  assert.strictEqual(tier.modelSource, "tier-policy");
  assert.strictEqual(tier.candidateId, "economy-codex");
  assert.deepStrictEqual(tier.reasons, []);

  const fallback = resolveProviderModelSelection({
    tierCandidates: [
      decodeCandidate({ candidateId: "missing", providerId: "codex", modelId: "unknown" }),
    ],
    classifier: decodeSelection({ providerId: "claude", modelId: "sonnet" }),
    providers,
  });
  assert.strictEqual(fallback.providerId, "claude");
  assert.strictEqual(fallback.providerSource, "classifier");
});

const demoGarden = decodeSpace({
  id: "demo-garden",
  slug: "demo-garden",
  displayName: "Demo Garden",
  kind: "personal",
  instructions: "Keep examples generic.",
  policy: {
    allowedCapabilities: ["cc.items.read"],
    autoRunRiskLevels: ["low"],
  },
  connectionIds: [],
  repositories: [],
  aliases: ["garden sample"],
  lifecycle: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

function provider(input: {
  readonly providerId: string;
  readonly healthy?: boolean;
  readonly priority?: number;
  readonly modelIds?: ReadonlyArray<string>;
  readonly defaultModelId?: string;
  readonly capabilities?: ReadonlyArray<string>;
}) {
  return decodeProvider({
    providerId: input.providerId,
    healthy: input.healthy ?? true,
    priority: input.priority ?? 100,
    modelIds: input.modelIds ?? [`${input.providerId}-default`],
    defaultModelId: input.defaultModelId ?? `${input.providerId}-default`,
    capabilities: input.capabilities ?? ["cc.runs.start"],
  });
}

it("normalizes and resolves space, repository, and legacy aliases", () => {
  assert.strictEqual(normalizeSpaceAlias("  Legacy_Sample-App.git "), "legacy sample app");

  const bySpaceAlias = resolveSpaceAlias("SAMPLE-WORKS", [sampleStudio, demoGarden]);
  assert.strictEqual(bySpaceAlias._tag, "Resolved");
  if (bySpaceAlias._tag === "Resolved") {
    assert.strictEqual(bySpaceAlias.spaceId, "example-studio");
    assert.strictEqual(bySpaceAlias.matchedBy, "alias");
  }

  const byRepository = resolveSpaceAlias("sample mobile app", [sampleStudio, demoGarden]);
  assert.strictEqual(byRepository._tag, "Resolved");
  if (byRepository._tag === "Resolved") {
    assert.strictEqual(byRepository.spaceId, "example-studio");
    assert.strictEqual(byRepository.matchedBy, "repository-id");
  }

  const byLegacyAlias = resolveSpaceAlias("legacy-sample-app", [sampleStudio, demoGarden]);
  assert.strictEqual(byLegacyAlias._tag, "Resolved");
  if (byLegacyAlias._tag === "Resolved") {
    assert.strictEqual(byLegacyAlias.spaceId, "example-studio");
    assert.strictEqual(byLegacyAlias.matchedBy, "repository-alias");
  }
});

it("reports ambiguous aliases in stable id order", () => {
  const secondSpace = decodeSpace({
    ...demoGarden,
    id: "another-example",
    slug: "another-example",
    displayName: "Another Example",
    aliases: ["shared sample"],
  });
  const firstSpace = decodeSpace({
    ...sampleStudio,
    aliases: ["shared sample"],
  });

  const resolution = resolveSpaceAlias("shared_sample", [firstSpace, secondSpace]);
  assert.strictEqual(resolution._tag, "Ambiguous");
  if (resolution._tag === "Ambiguous") {
    assert.strictEqual(resolution.normalizedQuery, "shared sample");
    assert.deepStrictEqual(resolution.candidateSpaceIds.map(String), [
      "another-example",
      "example-studio",
    ]);
  }
});

it("gives explicit selections precedence over policy and classifier selections", () => {
  const input = decodeRouteInput({
    command: {
      commandId: "command-explicit",
      text: "Work on the sample repository",
      spaceId: "explicit-space",
      repositoryId: "explicit-repository",
      projectId: "explicit-project",
      providerId: "provider-explicit",
      modelId: "model-explicit",
    },
    policy: {
      spaceId: "policy-space",
      repositoryId: "policy-repository",
      projectId: "policy-project",
      providerId: "provider-policy",
      modelId: "model-policy",
    },
    classifier: {
      intent: "repository",
      actionKind: "worktree.edit",
      capabilities: ["cc.runs.start"],
      spaceId: "classifier-space",
      repositoryId: "classifier-repository",
      projectId: "classifier-project",
      providerId: "provider-classifier",
      modelId: "model-classifier",
    },
    providers: [
      provider({
        providerId: "provider-explicit",
        modelIds: ["model-explicit"],
        defaultModelId: "model-explicit",
      }),
      provider({
        providerId: "provider-policy",
        modelIds: ["model-policy"],
        defaultModelId: "model-policy",
      }),
      provider({
        providerId: "provider-classifier",
        modelIds: ["model-classifier"],
        defaultModelId: "model-classifier",
      }),
    ],
  });

  const route = resolveRoute(input);
  assert.strictEqual(route.status, "ready");
  assert.strictEqual(route.spaceId, "explicit-space");
  assert.strictEqual(route.repositoryId, "explicit-repository");
  assert.strictEqual(route.projectId, "explicit-project");
  assert.strictEqual(route.providerId, "provider-explicit");
  assert.strictEqual(route.modelId, "model-explicit");
  assert.deepStrictEqual(route.sources, {
    space: "explicit",
    repository: "explicit",
    project: "explicit",
    provider: "explicit",
    model: "explicit",
  });
});

it("uses classifier routing when a policy provider is unhealthy", () => {
  const input = decodeRouteInput({
    command: { commandId: "command-classifier", text: "Review the sample" },
    policy: { providerId: "provider-policy" },
    classifier: {
      intent: "conversation",
      actionKind: "read",
      capabilities: ["cc.items.read"],
      providerId: "provider-classifier",
    },
    providers: [
      provider({
        providerId: "provider-policy",
        healthy: false,
        capabilities: ["cc.items.read"],
      }),
      provider({ providerId: "provider-classifier", capabilities: ["cc.items.read"] }),
    ],
  });

  const route = resolveRoute(input);
  assert.strictEqual(route.providerId, "provider-classifier");
  assert.strictEqual(route.sources.provider, "classifier");
  assert.strictEqual(route.sources.model, "provider-default");
  assert.strictEqual(route.status, "ready");
});

it("chooses the first compatible fallback by priority and id", () => {
  const input = decodeRouteInput({
    command: { commandId: "command-fallback", text: "Start a sample run" },
    classifier: {
      intent: "conversation",
      actionKind: "read",
      capabilities: ["cc.runs.start"],
    },
    providers: [
      provider({ providerId: "provider-later", priority: 20 }),
      provider({ providerId: "provider-first-b", priority: 10 }),
      provider({ providerId: "provider-first-a", priority: 10 }),
    ],
  });

  const route = resolveRoute(input);
  assert.strictEqual(route.providerId, "provider-first-a");
  assert.strictEqual(route.sources.provider, "fallback");
  assert.strictEqual(route.status, "ready");
});

it("blocks an unavailable explicit provider rather than silently falling back", () => {
  const input = decodeRouteInput({
    command: {
      commandId: "command-blocked",
      text: "Use my selected provider",
      providerId: "provider-selected",
    },
    classifier: {
      intent: "conversation",
      actionKind: "read",
      capabilities: ["cc.runs.start"],
    },
    providers: [provider({ providerId: "provider-fallback", priority: 1 })],
  });

  const route = resolveRoute(input);
  assert.strictEqual(route.status, "blocked");
  assert.strictEqual(route.providerId, "provider-selected");
  assert.strictEqual(route.sources.provider, "explicit");
  assert.deepStrictEqual(route.reasons, ["Explicit provider is unavailable"]);
});

it("marks external actions as approval-required", () => {
  const input = decodeRouteInput({
    command: { commandId: "command-approval", text: "Publish the sample" },
    classifier: {
      intent: "repository",
      actionKind: "git.push",
      capabilities: ["cc.runs.start"],
    },
    providers: [provider({ providerId: "provider-a" })],
  });

  const route = resolveRoute(input);
  assert.strictEqual(route.status, "approval-required");
  assert.strictEqual(route.risk, "approval-required");
  assert.strictEqual(route.approvalRequired, true);
});
