import { describe, expect, it } from "vite-plus/test";
import type { ServerProviderModel } from "@t3tools/contracts";

import { deriveProviderModelsForDisplay } from "./ProviderInstanceCard";
import { getProviderMaintenancePresentation } from "./providerStatus";

describe("deriveProviderModelsForDisplay", () => {
  it("uses current config custom models instead of stale live custom rows", () => {
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "server-model",
        name: "Server Model",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "removed-custom",
        name: "Removed Custom",
        isCustom: true,
        capabilities: null,
      },
      {
        slug: "kept-custom",
        name: "Kept Custom",
        isCustom: true,
        capabilities: null,
      },
    ];

    expect(
      deriveProviderModelsForDisplay({
        liveModels,
        customModels: ["kept-custom"],
      }).map((model) => model.slug),
    ).toEqual(["server-model", "kept-custom"]);
  });
});

describe("getProviderMaintenancePresentation", () => {
  it("offers update or reinstall even when the installed version is current", () => {
    expect(
      getProviderMaintenancePresentation({
        status: "current",
        currentVersion: "1.2.3",
        latestVersion: "1.2.3",
        updateCommand: "npm install -g @openai/codex@latest",
        canUpdate: true,
        checkedAt: null,
        message: null,
      }),
    ).toEqual({ updateCommand: "npm install -g @openai/codex@latest" });
  });

  it("withholds maintenance when the installation cannot be updated safely", () => {
    expect(
      getProviderMaintenancePresentation({
        status: "unknown",
        currentVersion: null,
        latestVersion: null,
        updateCommand: null,
        canUpdate: false,
        checkedAt: null,
        message: null,
      }),
    ).toBeNull();
  });
});
