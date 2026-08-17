import { useAuth } from "@clerk/react";
import { useState } from "react";

import {
  disableWebPushNotifications,
  enableWebPushNotifications,
  readWebPushRegistration,
  webPushSupport,
} from "~/cloud/webPush";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsRow } from "./settingsLayout";

// Per-browser T3 Connect notification opt-in: agent activity (approvals,
// input requests, completions, failures) arrives as Web Push through the
// relay, mirroring the mobile app's notifications. Renders nothing when the
// deployment has no T3 Connect config or the runtime cannot do push at all;
// iOS-needs-install gets a hint row instead of silence.
export function WebPushNotificationsRow() {
  const { isSignedIn } = useAuth();
  const support = webPushSupport();
  const [enabled, setEnabled] = useState(() => readWebPushRegistration() !== null);
  const [isUpdating, setIsUpdating] = useState(false);

  if (!support.supported) {
    if (support.reason === "ios-needs-install") {
      return (
        <SettingsRow
          title="Browser notifications"
          description="Add this app to your home screen (Share → Add to Home Screen) to receive agent activity notifications on iOS."
        />
      );
    }
    return null;
  }

  const disabledReason = !isSignedIn
    ? "Sign in to T3 Connect to receive notifications in this browser."
    : null;

  const updateEnabled = async (next: boolean) => {
    setIsUpdating(true);
    if (next) {
      const result = await enableWebPushNotifications();
      if (result.ok) {
        setEnabled(true);
        toastManager.add({
          type: "success",
          title: "Browser notifications enabled",
          description: "Agent activity from your linked environments will notify this browser.",
        });
      } else {
        toastManager.add({
          type: "error",
          title: "Could not enable notifications",
          description:
            result.reason === "permission-denied"
              ? "Notification permission was denied. Allow notifications for this site in your browser settings."
              : result.reason === "not-signed-in"
                ? "Sign in to T3 Connect first."
                : "Something went wrong while registering this browser.",
        });
      }
    } else {
      await disableWebPushNotifications();
      setEnabled(false);
      toastManager.add({
        type: "success",
        title: "Browser notifications disabled",
        description: "This browser will no longer receive agent activity notifications.",
      });
    }
    setIsUpdating(false);
  };

  const control = (
    <Switch
      aria-label="Enable browser notifications"
      checked={enabled}
      disabled={isUpdating || disabledReason !== null}
      onCheckedChange={(next) => void updateEnabled(next)}
    />
  );

  return (
    <SettingsRow
      title="Browser notifications"
      description="Notify this browser when agents need approval or input, or when work finishes. Uses T3 Connect."
      control={
        disabledReason ? (
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex">{control}</span>} />
            <TooltipPopup side="top">{disabledReason}</TooltipPopup>
          </Tooltip>
        ) : (
          control
        )
      }
    />
  );
}
