import { useEffect, useEffectEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { projectThreadAwarenessV2, type AgentAwarenessPhase } from "@t3tools/shared/agentAwareness";
import { isUnattendedThread } from "@command-center/core";

import { isElectron } from "~/env";
import { getClientSettings } from "~/hooks/useSettings";
import { useActiveThreadRefFromRoute } from "~/hooks/useActiveThreadRef";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentThreadShells } from "~/state/threads";
import { readProjects, readThreadShells } from "~/state/entities";
import { agentNotificationKind, type AgentNotificationKind } from "./agentNotificationKind";
import { notificationBody } from "./notificationCopy";
import { playAlertChime } from "./alertChime";
import {
  clearThreadAlert,
  markThreadAlert,
  markThreadAlertsFocused,
  pruneExpiredThreadAlerts,
  readThreadAlerts,
  subscribeThreadAlerts,
  THREAD_ALERT_FOCUSED_TTL_MS,
  THREAD_ALERT_MAX_TTL_MS,
} from "./threadAlertStore";

function projectTitleKey(input: { readonly environmentId: string; readonly projectId: string }) {
  return `${input.environmentId}:${input.projectId}`;
}

function buildProjectTitleMap(
  projects: ReturnType<typeof readProjects>,
): ReadonlyMap<string, string> {
  const titles = new Map<string, string>();
  for (const project of projects) {
    titles.set(
      projectTitleKey({ environmentId: project.environmentId, projectId: project.id }),
      project.title,
    );
  }
  return titles;
}

function sameThread(left: ScopedThreadRef, right: ScopedThreadRef): boolean {
  return left.environmentId === right.environmentId && left.threadId === right.threadId;
}

function isNotificationKindEnabled(
  kind: AgentNotificationKind,
  settings: ReturnType<typeof getClientSettings>,
): boolean {
  switch (kind) {
    case "approval-needed":
      return settings.desktopNotifyOnApproval;
    case "input-needed":
      return settings.desktopNotifyOnInput;
    case "completed":
      return settings.desktopNotifyOnCompletion;
    case "failed":
      return settings.desktopNotifyOnFailure;
  }
}

/**
 * Mounted once: native OS banners on desktop, plus the sidebar highlight and chime, which survive
 * OS Do Not Disturb (it swallows the banner undetectably). One phase-transition detector feeds all
 * three so a thread's completion is classified exactly once per batch.
 */
export function AgentActivityNotifications() {
  const navigate = useNavigate();
  const activeThreadRef = useActiveThreadRefFromRoute();
  // An effect event, so the atom subscription reads the current route without re-subscribing.
  const isRoutedThread = useEffectEvent(
    (threadRef: ScopedThreadRef) =>
      activeThreadRef !== null && sameThread(activeThreadRef, threadRef),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to thread shell updates to raise native banners, alert highlights and the chime on phase transitions.
  useEffect(() => {
    // threadKey -> last observed phase. A miss means "never observed" (first
    // mount, newly created thread, or the environment just connected), which
    // agentNotificationKind treats as non-notifiable — so app launch never
    // replays a backlog of past activity.
    const previousPhases = new Map<string, AgentAwarenessPhase>();

    const reconcile = (threads: ReadonlyArray<EnvironmentThreadShell>) => {
      const settings = getClientSettings();
      const windowFocused = document.hasFocus();
      const projectTitles = buildProjectTitleMap(readProjects());
      const showNotification = window.desktopBridge?.showNotification;
      const nowMs = Date.now();
      let playedChimeThisBatch = false;

      for (const thread of threads) {
        const awareness = projectThreadAwarenessV2({
          environmentId: thread.environmentId,
          project: { title: projectTitles.get(projectTitleKey(thread)) ?? "" },
          thread: thread.source,
        });
        if (awareness === null) continue;

        const threadKey = `${thread.environmentId}:${thread.id}`;
        const previous = previousPhases.get(threadKey) ?? null;
        previousPhases.set(threadKey, awareness.phase);

        const kind = agentNotificationKind(previous, awareness.phase);
        if (kind === null) continue;
        // Nobody watches an unattended thread: only its approval and input requests alert.
        if (isUnattendedThread(thread.source) && (kind === "completed" || kind === "failed")) {
          continue;
        }

        const threadRef: ScopedThreadRef = {
          environmentId: thread.environmentId,
          threadId: thread.id,
        };
        const isActiveThread = windowFocused && isRoutedThread(threadRef);

        if (kind === "completed" || kind === "failed") {
          // Marked before attempting the native banner: the highlight is
          // what survives Do Not Disturb, so it must not depend on the
          // banner's success.
          markThreadAlert(threadRef, kind, { nowMs, windowFocused });
          if (!isActiveThread) {
            playedChimeThisBatch = true;
          }
        }

        if (
          isElectron &&
          settings.desktopNotificationsEnabled &&
          isNotificationKindEnabled(kind, settings) &&
          !isActiveThread &&
          typeof showNotification === "function"
        ) {
          void showNotification({
            kind,
            title: thread.title,
            body: notificationBody({
              headline: awareness.headline,
              projectTitle: awareness.projectTitle,
            }),
            silent: !settings.notificationSoundEnabled,
            threadRef,
          }).catch(() => undefined);
        }
      }

      if (playedChimeThisBatch && settings.notificationSoundEnabled) {
        playAlertChime();
      }
    };

    // Seed from the current shells before subscribing: everything already
    // loaded is recorded without firing, so a launch never replays a backlog.
    reconcile(readThreadShells());

    return appAtomRegistry.subscribe(environmentThreadShells.threadShellsAtom, reconcile);
  }, []);

  // Opening a thread is the user seeing it, so the highlight has done its job.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the alert store's highlight when the router lands on a thread; navigation happens outside this component.
  useEffect(() => {
    if (activeThreadRef === null) return;
    clearThreadAlert(activeThreadRef);
  }, [activeThreadRef]);

  // Highlights fade shortly after the window has focus and never outlive the hard ceiling. One timer
  // drives both, and only while something is highlighted.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the alert prune timer and window focus listeners in step with the alert store while mounted.
  useEffect(() => {
    const isFocused = () => document.hasFocus();
    let timeoutId: number | null = null;

    const cancelPending = () => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    const scheduleNextPrune = () => {
      cancelPending();
      const alerts = readThreadAlerts();
      const deadlines: number[] = [];
      const nowMs = Date.now();

      for (const alert of Object.values(alerts)) {
        deadlines.push(alert.markedAtMs + THREAD_ALERT_MAX_TTL_MS);
        if (alert.focusedAtMs !== null) {
          deadlines.push(alert.focusedAtMs + THREAD_ALERT_FOCUSED_TTL_MS);
        }
      }
      if (deadlines.length === 0) return;

      const nextDeadline = Math.min(...deadlines);
      timeoutId = window.setTimeout(
        () => {
          timeoutId = null;
          pruneExpiredThreadAlerts(Date.now());
          scheduleNextPrune();
        },
        Math.max(0, nextDeadline - nowMs),
      );
    };

    const handleFocusChange = () => {
      if (isFocused()) {
        markThreadAlertsFocused(Date.now());
      }
      pruneExpiredThreadAlerts(Date.now());
      scheduleNextPrune();
    };

    window.addEventListener("focus", handleFocusChange);
    window.addEventListener("blur", scheduleNextPrune);
    document.addEventListener("visibilitychange", handleFocusChange);
    const unsubscribe = subscribeThreadAlerts(handleFocusChange);
    handleFocusChange();

    return () => {
      cancelPending();
      unsubscribe();
      window.removeEventListener("focus", handleFocusChange);
      window.removeEventListener("blur", scheduleNextPrune);
      document.removeEventListener("visibilitychange", handleFocusChange);
    };
  }, []);

  // Focuses the app and opens the thread when a native notification is
  // clicked. Only fires on Electron (the bridge is absent on web).
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the desktop bridge's notification clicks while mounted.
  useEffect(() => {
    const onNotificationActivated = window.desktopBridge?.onNotificationActivated;
    if (typeof onNotificationActivated !== "function") return;

    const unsubscribe = onNotificationActivated(({ threadRef }) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: threadRef.environmentId, threadId: threadRef.threadId },
      });
    });

    return () => unsubscribe?.();
  }, [navigate]);

  return null;
}
