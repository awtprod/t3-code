import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import {
  isSettingsWritePersisted,
  mergeEnvironmentSettings,
  resolveEnvironmentIdentificationMode,
} from "./useSettings";

describe("resolveEnvironmentIdentificationMode", () => {
  it("keeps identification hidden until client settings hydrate", () => {
    expect(resolveEnvironmentIdentificationMode({ mode: "artwork", settingsHydrated: false })).toBe(
      "none",
    );
    expect(resolveEnvironmentIdentificationMode({ mode: "pill", settingsHydrated: true })).toBe(
      "pill",
    );
  });
});

describe("mergeEnvironmentSettings", () => {
  it("combines the selected environment's server settings with client preferences", () => {
    const serverSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("codex_remote")]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
        },
      },
    };
    const clientSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      favorites: [
        {
          provider: ProviderInstanceId.make("codex_remote"),
          model: "gpt-5.4",
        },
      ],
    };

    const settings = mergeEnvironmentSettings(serverSettings, clientSettings);

    expect(settings.providerInstances).toBe(serverSettings.providerInstances);
    expect(settings.favorites).toBe(clientSettings.favorites);
  });
});

describe("isSettingsWritePersisted", () => {
  it("treats a successful write as persisted", () => {
    expect(isSettingsWritePersisted(AsyncResult.success(undefined))).toBe(true);
  });

  it("treats an interrupt-only failure as persisted (no false rollback)", () => {
    // A superseded/unmounted write resolves interrupt-only; it must NOT roll
    // back the optimistic value or toast an error — the write already landed or
    // a newer one will report its own outcome.
    const interrupted = AsyncResult.failure(Cause.interrupt(1));
    expect(Cause.hasInterruptsOnly(interrupted.cause)).toBe(true);
    expect(isSettingsWritePersisted(interrupted)).toBe(true);
  });

  it("treats a genuine (non-interrupt) failure as not persisted", () => {
    const failed = AsyncResult.failure(Cause.fail(new Error("server rejected")));
    expect(isSettingsWritePersisted(failed)).toBe(false);
  });
});
