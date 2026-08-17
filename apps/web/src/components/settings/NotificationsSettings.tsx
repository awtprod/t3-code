import { isElectron } from "~/env";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { WebPushNotificationsRow } from "./WebPushNotificationsRow";

// Desktop gets native OS notifications (own preferences, permission owned by
// the OS); web gets Web Push (its own preferences live per-browser in
// localStorage + relay registration, unchanged from apps/web/src/cloud/webPush.ts
// — not folded into ClientSettings here, since that storage is already
// shipped and tested). The sidebar highlight and chime work on both and share
// one sound preference.
export function NotificationsSettingsPanel() {
  const settings = useClientSettings();
  const updateSettings = useUpdateClientSettings();
  const desktopNotificationsDisabled = isElectron && !settings.desktopNotificationsEnabled;

  return (
    <SettingsPageContainer>
      <SettingsSection title="Notifications">
        {isElectron ? (
          <SettingsRow
            {...searchableSetting("notifications-desktop")}
            description="Notify this device when agents need approval or input, or when work finishes. Suppressed while you're looking at that thread."
            control={
              <Switch
                checked={settings.desktopNotificationsEnabled}
                onCheckedChange={(checked) =>
                  updateSettings({ desktopNotificationsEnabled: Boolean(checked) })
                }
                aria-label="Enable desktop notifications"
              />
            }
          />
        ) : (
          <WebPushNotificationsRow />
        )}
        {isElectron ? (
          <>
            <SettingsRow
              {...searchableSetting("notification-approval")}
              description="The agent is blocked until you approve an action."
              control={
                <Switch
                  checked={settings.desktopNotifyOnApproval}
                  disabled={desktopNotificationsDisabled}
                  onCheckedChange={(checked) =>
                    updateSettings({ desktopNotifyOnApproval: Boolean(checked) })
                  }
                  aria-label="Notify on approval needed"
                />
              }
            />
            <SettingsRow
              {...searchableSetting("notification-input")}
              description="The agent is waiting on you for input."
              control={
                <Switch
                  checked={settings.desktopNotifyOnInput}
                  disabled={desktopNotificationsDisabled}
                  onCheckedChange={(checked) =>
                    updateSettings({ desktopNotifyOnInput: Boolean(checked) })
                  }
                  aria-label="Notify on input needed"
                />
              }
            />
            <SettingsRow
              {...searchableSetting("notification-completed")}
              description="The agent finished its turn."
              control={
                <Switch
                  checked={settings.desktopNotifyOnCompletion}
                  disabled={desktopNotificationsDisabled}
                  onCheckedChange={(checked) =>
                    updateSettings({ desktopNotifyOnCompletion: Boolean(checked) })
                  }
                  aria-label="Notify on completion"
                />
              }
            />
            <SettingsRow
              {...searchableSetting("notification-failed")}
              description="The agent stopped with an error."
              control={
                <Switch
                  checked={settings.desktopNotifyOnFailure}
                  disabled={desktopNotificationsDisabled}
                  onCheckedChange={(checked) =>
                    updateSettings({ desktopNotifyOnFailure: Boolean(checked) })
                  }
                  aria-label="Notify on failure"
                />
              }
            />
          </>
        ) : null}
        <SettingsRow
          {...searchableSetting("notification-sound")}
          description="Play a short in-app chime when an agent needs you and the window isn't focused. Works even when a push or desktop banner is suppressed."
          control={
            <Switch
              checked={settings.notificationSoundEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ notificationSoundEnabled: Boolean(checked) })
              }
              aria-label="Play notification sound"
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
