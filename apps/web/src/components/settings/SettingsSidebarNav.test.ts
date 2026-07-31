import { describe, expect, it } from "vite-plus/test";

import { SETTINGS_NAV_ITEMS } from "./SettingsSidebarNav";

describe("SETTINGS_NAV_ITEMS", () => {
  it("includes the databases settings section alongside developer integrations", () => {
    const sourceControlIndex = SETTINGS_NAV_ITEMS.findIndex(
      (item) => item.to === "/settings/source-control",
    );
    const databasesIndex = SETTINGS_NAV_ITEMS.findIndex(
      (item) => item.to === "/settings/databases",
    );
    const connectionsIndex = SETTINGS_NAV_ITEMS.findIndex(
      (item) => item.to === "/settings/connections",
    );

    expect(SETTINGS_NAV_ITEMS[databasesIndex]?.label).toBe("Databases");
    expect(databasesIndex).toBe(sourceControlIndex + 1);
    expect(connectionsIndex).toBe(databasesIndex + 1);
  });
});
