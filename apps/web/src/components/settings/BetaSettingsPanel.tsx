import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function BetaSettingsPanel() {
  const sidebarV2Enabled = useClientSettings((settings) => settings.sidebarV2Enabled);
  const planModeEnabled = useClientSettings((settings) => settings.planModeEnabled);
  const updateSettings = useUpdateClientSettings();

  return (
    <SettingsPageContainer>
      <SettingsSection title="Beta features">
        <SettingsRow
          {...searchableSetting("sidebar-v2")}
          description="One flat thread list in creation order. Active work renders as rich cards; settled threads collapse to compact rows. Settling requires an up-to-date server — on older servers threads simply stay active. Switch back any time."
          control={
            <Switch
              checked={sidebarV2Enabled}
              // Touching the switch pins the choice, so a nightly build that
              // defaults v2 on does not flip it back after the user opts out.
              onCheckedChange={(checked) =>
                updateSettings({
                  sidebarV2Enabled: Boolean(checked),
                  sidebarV2ConfiguredByUser: true,
                })
              }
              aria-label="Enable the sidebar v2 beta"
            />
          }
        />
        <SettingsRow
          {...searchableSetting("restore-plan-mode")}
          description="Legacy feature. Brings back the Build/Plan toggle in the composer along with the /plan and /default commands and the Shift+Tab shortcut. While off, every thread runs in build mode."
          control={
            <Switch
              checked={planModeEnabled}
              onCheckedChange={(checked) => updateSettings({ planModeEnabled: Boolean(checked) })}
              aria-label="Restore plan mode (legacy)"
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
