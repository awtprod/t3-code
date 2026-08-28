import type { CapabilityName } from "./domain.ts";
import type { ProviderAvailability } from "./routing.ts";

const ROUTER_ONLY_MODEL_IDS = new Set(["gpt-5.6-sol", "claude-fable-5"]);

export function isRouterOnlyModel(modelId: string | null | undefined): boolean {
  return modelId !== null && modelId !== undefined && ROUTER_ONLY_MODEL_IDS.has(modelId);
}

export const ROUTER_ONLY_CHILD_MODEL_ERROR =
  "Router-only models cannot be selected for child Runs; choose a non-router worker model.";

/**
 * Every capability a router thread may hold. Routers inspect state and start
 * child Runs; direct mutation capabilities never enter their MCP scope, so an
 * unknown or future capability fails closed by omission from this list.
 */
const ROUTER_READ_CAPABILITIES: ReadonlySet<CapabilityName> = new Set<CapabilityName>([
  "cc.items.read",
  "cc.memory.read",
  "cc.automations.read",
  "cc.connections.google.read",
  "cc.connections.google.gmail.read",
  "cc.connections.google.calendar.read",
  "cc.connections.google.drive.read",
  "cc.sales.read",
]);

/** The routed capabilities a router thread keeps: its reads plus `cc.runs.start`. */
export function routerCapabilityScope(
  routed: ReadonlyArray<CapabilityName>,
): Array<CapabilityName> {
  return [
    ...routed.filter((capability) => ROUTER_READ_CAPABILITIES.has(capability)),
    "cc.runs.start",
  ];
}

export function workerProviderAvailability(
  providers: ReadonlyArray<ProviderAvailability>,
): ReadonlyArray<ProviderAvailability> {
  return providers.flatMap((provider) => {
    const modelIds = provider.modelIds.filter((modelId) => !isRouterOnlyModel(modelId));
    if (modelIds.length === 0) return [];
    return [
      {
        ...provider,
        modelIds,
        defaultModelId: modelIds.includes(provider.defaultModelId)
          ? provider.defaultModelId
          : modelIds[0]!,
      },
    ];
  });
}
