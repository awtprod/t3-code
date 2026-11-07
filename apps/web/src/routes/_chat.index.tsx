import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { HostedEmptyState } from "../components/HostedEmptyState";
import { commandCenterLandingShortcut } from "../components/sidebar/commandCenterShortcuts";
import {
  useClientSettingsHydrationStatus,
  useCommandCenterSidebarShortcuts,
} from "../hooks/useSettings";
import { useEnvironments } from "../state/environments";

function ChatIndexRouteView() {
  const { authGateState } = Route.useRouteContext();
  const { environments, isReady } = useEnvironments();

  if (authGateState.status === "hosted-static") {
    if (!isReady) return null;
    if (environments.length === 0) return <HostedEmptyState />;
  }

  return <CommandCenterLandingRedirect />;
}

/**
 * Command Center lands on its first visible sidebar shortcut: the inbox when it
 * is shown, otherwise whatever the user kept (New thread by default, where
 * `/new` owns the draft auto-start). Waits for saved settings so a stored
 * choice is not overridden by the default list.
 */
function CommandCenterLandingRedirect() {
  const navigate = useNavigate();
  const shortcuts = useCommandCenterSidebarShortcuts();
  const hydrationStatus = useClientSettingsHydrationStatus();
  const settingsSettled = hydrationStatus === "ready" || hydrationStatus === "failed";
  const landing = commandCenterLandingShortcut(shortcuts).to;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- redirects the index route to the first visible Command Center shortcut once saved settings hydrate
  useEffect(() => {
    if (!settingsSettled) return;
    if (landing === "/inbox") {
      void navigate({ to: "/inbox", search: { tab: "actionable" }, replace: true });
      return;
    }
    void navigate({ to: landing, replace: true });
  }, [landing, navigate, settingsSettled]);
  return null;
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
