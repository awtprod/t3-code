import { isElectron } from "~/env";
import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { WebPushNotificationsRow } from "./WebPushNotificationsRow";

// Desktop uses native OS notifications; web uses Web Push, whose per-browser preferences stay
// in apps/web/src/cloud/webPush.ts storage. The sidebar highlight and chime share one sound setting.
export function NotificationsSettingsPanel() {
  const settings = useClientSettings();
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
                  updateClientSettings({ desktopNotificationsEnabled: Boolean(checked) })
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
                    updateClientSettings({ desktopNotifyOnApproval: Boolean(checked) })
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
                    updateClientSettings({ desktopNotifyOnInput: Boolean(checked) })
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
                    updateClientSettings({ desktopNotifyOnCompletion: Boolean(checked) })
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
                    updateClientSettings({ desktopNotifyOnFailure: Boolean(checked) })
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
                updateClientSettings({ notificationSoundEnabled: Boolean(checked) })
              }
              aria-label="Play notification sound"
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
