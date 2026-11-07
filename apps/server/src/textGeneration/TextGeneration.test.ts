import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { ProviderInstanceId, type InternalGenerationUsage } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as TextGeneration from "./TextGeneration.ts";

const makeStubTextGeneration = (
  overrides: Partial<TextGeneration.TextGeneration["Service"]>,
): TextGeneration.TextGeneration["Service"] =>
  TextGeneration.TextGeneration.of({
    generateCommitMessage: () =>
      Effect.die("generateCommitMessage stub not configured for this test"),
    generatePrContent: () => Effect.die("generatePrContent stub not configured for this test"),
    generateBranchName: () => Effect.die("generateBranchName stub not configured for this test"),
    generateThreadTitle: () => Effect.die("generateThreadTitle stub not configured for this test"),
    generateReviewGuide: () => Effect.die("generateReviewGuide stub not configured for this test"),
    generateAutomationSchedule: () =>
      Effect.die("generateAutomationSchedule stub not configured for this test"),
    ...overrides,
  });

const makeStubInstance = (
  instanceId: ProviderInstanceId,
  textGeneration: TextGeneration.TextGeneration["Service"],
): ProviderInstance =>
  ({
    instanceId,
    driverKind: instanceId as unknown as ProviderInstance["driverKind"],
    continuationIdentity: {
      driverKind: instanceId as unknown as ProviderInstance["driverKind"],
      continuationKey: `${instanceId}:test`,
    },
    displayName: undefined,
    enabled: true,
    snapshot: {} as ProviderInstance["snapshot"],
    orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
    textGeneration,
  }) satisfies ProviderInstance;

const makeStubRegistry = (
  instances: ReadonlyArray<ProviderInstance>,
): ProviderInstanceRegistry.ProviderInstanceRegistry["Service"] => {
  const byId = new Map(instances.map((instance) => [instance.instanceId, instance] as const));
  return {
    getInstance: (id) => Effect.succeed(byId.get(id)),
    listInstances: Effect.succeed(instances),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    // Tests never drive changes through this stub; acquire a throwaway
    // subscription on an unused PubSub so the shape is satisfied.
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
      PubSub.subscribe(pubsub),
    ),
  };
};

// Command Center: schedule interpretation and internal-generation usage recording are fork-only.
describe("makeTextGenerationFromRegistry", () => {
  it.effect("routes schedule interpretation and records schedule usage", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex_schedule");
      const usage: InternalGenerationUsage[] = [];
      const instance = makeStubInstance(
        instanceId,
        makeStubTextGeneration({
          generateAutomationSchedule: () =>
            Effect.succeed({ status: "interpreted", expression: "0 9 * * 1-5" }),
        }),
      );
      const tg = TextGeneration.makeTextGenerationFromRegistry(
        makeStubRegistry([instance]),
        (entry) => Effect.sync(() => usage.push(entry)).pipe(Effect.asVoid),
      );

      expect(
        yield* tg.generateAutomationSchedule({
          cwd: process.cwd(),
          text: "weekdays at nine",
          timezone: "UTC",
          modelSelection: createModelSelection(instanceId, "gpt-5"),
        }),
      ).toEqual({ status: "interpreted", expression: "0 9 * * 1-5" });
      expect(usage).toEqual([
        expect.objectContaining({ operation: "schedule", status: "success" }),
      ]);
    }),
  );
});
