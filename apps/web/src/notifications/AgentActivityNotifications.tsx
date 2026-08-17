import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { projectThreadAwareness, type AgentAwarenessPhase } from "@t3tools/shared/agentAwareness";

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
 * Alerts for agent task transitions: the native OS banner on desktop, plus
 * the sidebar highlight and chime that work on both web and desktop and
 * survive OS Do Not Disturb (which silently swallows the banner and its
 * sound with no way for the app to detect it happened).
 *
 * Mounted globally, once. All three effects share one phase-transition
 * detector so a thread's completion is classified exactly once per batch.
 */
export function AgentActivityNotifications() {
  const navigate = useNavigate();
  const activeThreadRef = useActiveThreadRefFromRoute();
  // Mirrored into a ref so the atom subscription below can read the current
  // route without re-subscribing on every navigation.
  const activeThreadRefMirror = useRef(activeThreadRef);
  activeThreadRefMirror.current = activeThreadRef;

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
        const awareness = projectThreadAwareness({
          environmentId: thread.environmentId,
          project: { title: projectTitles.get(projectTitleKey(thread)) ?? "" },
          thread,
        });
        if (awareness === null) continue;

        const threadKey = `${thread.environmentId}:${thread.id}`;
        const previous = previousPhases.get(threadKey) ?? null;
        previousPhases.set(threadKey, awareness.phase);

        const kind = agentNotificationKind(previous, awareness.phase);
        if (kind === null) continue;

        const threadRef: ScopedThreadRef = {
          environmentId: thread.environmentId,
          threadId: thread.id,
        };
        const isActiveThread =
          windowFocused &&
          activeThreadRefMirror.current !== null &&
          sameThread(activeThreadRefMirror.current, threadRef);

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
  useEffect(() => {
    if (activeThreadRef === null) return;
    clearThreadAlert(activeThreadRef);
  }, [activeThreadRef]);

  // Highlights are bounded twice over: they fade shortly after the window
  // has focus (the user is looking, so the signal has landed), and in any
  // case never outlive the hard ceiling. A single timer drives both, rather
  // than one per alert, and only runs while something is actually
  // highlighted.
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
