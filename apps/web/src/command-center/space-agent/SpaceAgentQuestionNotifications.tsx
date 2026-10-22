import type { CommandCenterSpaceAgentQuestion, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { getClientSettings } from "../../hooks/useSettings";
import { commandCenterEnvironment } from "../../state/commandCenter";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";

/**
 * Rings the desktop when a Space agent asks a question (an Item that needs
 * you). Its wakes are otherwise silent, so this is how the agent reaches you
 * here; phones get the same question as a web push. Mount once, on Electron.
 * Clicking the banner opens the agent's thread.
 */
export function SpaceAgentQuestionNotifications() {
  const environmentId = usePrimaryEnvironmentId();
  const { data: questions } = useEnvironmentQuery(
    environmentId === null
      ? null
      : commandCenterEnvironment.spaceAgentQuestions({ environmentId, input: {} }),
  );
  const notified = useRef<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (environmentId === null || questions === null) return;
    for (const question of questions) {
      if (notified.current.has(question.itemId)) continue;
      notifySpaceAgentQuestion(environmentId, question);
    }
    // The server never replays a question, so only the ones still listed can
    // come round again.
    notified.current = new Set(questions.map((question) => question.itemId));
  }, [environmentId, questions]);

  return null;
}

function notifySpaceAgentQuestion(
  environmentId: EnvironmentId,
  question: CommandCenterSpaceAgentQuestion,
) {
  const settings = getClientSettings();
  const showNotification = window.desktopBridge?.showNotification;
  if (
    !settings.desktopNotificationsEnabled ||
    !settings.desktopNotifyOnInput ||
    typeof showNotification !== "function"
  ) {
    return;
  }
  void showNotification({
    kind: "input-needed",
    title: question.title,
    body: "Needs you: your Space agent has a question",
    silent: !settings.notificationSoundEnabled,
    threadRef: { environmentId, threadId: question.threadId },
  }).catch(() => undefined);
}
