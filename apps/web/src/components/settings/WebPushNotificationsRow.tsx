import { useAuth } from "@clerk/react";
import { useEffect, useState } from "react";

import {
  disableWebPushNotifications,
  enableWebPushNotifications,
  fetchLocalWebPushConfig,
  isLocalWebPushMode,
  localDisableToast,
  localEnableResultToast,
  localTestResultToast,
  localWebPushViewModel,
  readWebPushRegistration,
  sendWebPushTestNotification,
  webPushSupport,
  type LocalWebPushConfigState,
} from "~/cloud/webPush";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsRow } from "./settingsLayout";

// Per-browser notification opt-in. Agent activity (approvals, input requests,
// completions, failures) arrives as Web Push. In relay mode (T3 Connect) the
// relay delivers it; in local mode the paired Command Center server delivers it
// directly. Renders nothing when the runtime cannot do push at all;
// iOS-needs-install gets a hint row instead of silence.
//
// Clerk is only mounted in relay builds, so the relay row (which reads the
// sign-in state) and the local row (which never touches Clerk) are separate
// components — the parent picks one, so useAuth is never called without a
// provider.
export function WebPushNotificationsRow() {
  const support = webPushSupport();

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

  return isLocalWebPushMode() ? <LocalWebPushRow /> : <RelayWebPushRow />;
}

// Relay mode (T3 Connect present): unchanged behaviour — notifications require a
// signed-in relay session.
function RelayWebPushRow() {
  const { isSignedIn } = useAuth();
  const [enabled, setEnabled] = useState(() => readWebPushRegistration() !== null);
  const [isUpdating, setIsUpdating] = useState(false);

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

// Local mode (no T3 Connect): the paired server holds its own VAPID key and
// pushes directly. No Clerk sign-in involved; instead we ask the server whether
// it has push configured, and offer a test button once registered.
function LocalWebPushRow() {
  const [enabled, setEnabled] = useState(() => readWebPushRegistration() !== null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [configState, setConfigState] = useState<LocalWebPushConfigState>("loading");

  useEffect(() => {
    let cancelled = false;
    void fetchLocalWebPushConfig()
      .then((config) => {
        if (!cancelled) {
          setConfigState(
            config.configured && config.vapidPublicKey ? "configured" : "not-configured",
          );
        }
      })
      .catch(() => {
        if (!cancelled) {
          setConfigState("unavailable");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const view = localWebPushViewModel({ configState, enabled, isUpdating, isTesting });

  const updateEnabled = async (next: boolean) => {
    setIsUpdating(true);
    if (next) {
      const result = await enableWebPushNotifications();
      setEnabled(result.ok);
      toastManager.add(localEnableResultToast(result));
    } else {
      await disableWebPushNotifications();
      setEnabled(false);
      toastManager.add(localDisableToast);
    }
    setIsUpdating(false);
  };

  const sendTest = async () => {
    setIsTesting(true);
    const outcome = await sendWebPushTestNotification();
    toastManager.add(localTestResultToast(outcome));
    setIsTesting(false);
  };

  return (
    <SettingsRow
      title="Browser notifications"
      description="Notify this browser when agents need approval or input, or when work finishes. Delivered directly by this server."
      status={view.explanation}
      control={
        <>
          <Button
            size="xs"
            variant="outline"
            disabled={view.testButtonDisabled}
            onClick={() => void sendTest()}
          >
            Send test notification
          </Button>
          <Switch
            aria-label="Enable browser notifications"
            checked={enabled}
            disabled={view.toggleDisabled}
            onCheckedChange={(next) => void updateEnabled(next)}
          />
        </>
      }
    />
  );
}
