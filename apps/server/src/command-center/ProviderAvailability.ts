import * as NodeProcess from "node:process";
import {
  CAPABILITY_NAMES,
  ModelId,
  ProviderId,
  type ProviderAvailability,
} from "@command-center/core";
import { isProviderAvailable, type ServerProvider } from "@t3tools/contracts";

/**
 * Command Center provider turns require an isolation boundary that has been
 * verified independently from ordinary T3 project sessions. Kimi enters the
 * candidate set only on Linux; its adapter then runs the executable, version,
 * Bubblewrap, workspace, and private-home probes before starting the turn.
 */
export type ProviderAvailabilityPurpose = "command-center-automation" | "interactive-routing";

export function providerAvailability(
  providers: ReadonlyArray<ServerProvider>,
  purpose: ProviderAvailabilityPurpose,
): ReadonlyArray<ProviderAvailability> {
  return providers.flatMap((provider, priority) => {
    if (
      purpose === "command-center-automation" &&
      provider.driver !== "codex" &&
      !(
        provider.driver === "kimi" &&
        NodeProcess.platform === "linux" &&
        provider.capabilities?.commandCenterAutomation === true
      )
    )
      return [];
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

export function commandCenterProviderAvailability(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ProviderAvailability> {
  return providerAvailability(providers, "command-center-automation");
}
