import {
  CAPABILITY_NAMES,
  ModelId,
  ProviderId,
  type ProviderAvailability,
} from "@command-center/core";
import { isProviderAvailable, type ServerProvider } from "@t3tools/contracts";

/**
 * Command Center provider turns require an isolation boundary that has been
 * verified independently from ordinary T3 project sessions. Codex is the only
 * v1 adapter that implements that boundary, so unsupported drivers never enter
 * routing or fallback selection.
 */
export function commandCenterProviderAvailability(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ProviderAvailability> {
  return providers.flatMap((provider, priority) => {
    if (provider.driver !== "codex") return [];
    const modelIds = provider.models.map((model) => ModelId.make(model.slug));
    const defaultModelId = modelIds[0];
    if (defaultModelId === undefined) return [];
    return [
      {
        providerId: ProviderId.make(provider.instanceId),
        healthy:
          provider.enabled &&
          provider.installed &&
          isProviderAvailable(provider) &&
          (provider.status === "ready" || provider.status === "warning"),
        priority,
        modelIds,
        defaultModelId,
        capabilities: CAPABILITY_NAMES,
      },
    ];
  });
}
