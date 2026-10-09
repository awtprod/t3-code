import { SpaceId } from "@command-center/core";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useCallback, useMemo, useState } from "react";

import { toastManager } from "../../components/ui/toast";
import { commandCenterEnvironment } from "../../state/commandCenter";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { describeSpaceAgentError, enabledSpaceAgents } from "./SpaceAgent.logic";

/** Space agents live on the primary (Command Center) environment. */
export function useSpaceAgentList() {
  const environmentId = usePrimaryEnvironmentId();
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : commandCenterEnvironment.spaceAgents({ environmentId, input: {} }),
  );
  const agents = useMemo(() => enabledSpaceAgents(query.data?.agents), [query.data?.agents]);
  return { environmentId, agents, error: query.error, refresh: query.refresh };
}

/**
 * Wake and pause with toasts on failure; `onSettled` runs after every
 * attempt so callers can refresh what they show.
 */
export function useSpaceAgentActions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly onSettled: () => void;
}) {
  const { environmentId, onSettled } = input;
  const wakeCommand = useAtomCommand(commandCenterEnvironment.wakeSpaceAgent, {
    reportFailure: false,
  });
  const setPausedCommand = useAtomCommand(commandCenterEnvironment.setSpaceAgentPaused, {
    reportFailure: false,
  });
  const [pendingSpaceId, setPendingSpaceId] = useState<string | null>(null);

  const wake = useCallback(
    async (spaceId: string): Promise<ThreadId | null> => {
      if (environmentId === null || pendingSpaceId !== null) return null;
      setPendingSpaceId(spaceId);
      try {
        const result = await wakeCommand({
          environmentId,
          input: { spaceId: SpaceId.make(spaceId) },
        });
        if (result._tag !== "Success") {
          toastManager.add({
            type: "warning",
            title: "Could not wake the agent",
            description: describeSpaceAgentError(
              squashAtomCommandFailure(result),
              "The wake was not delivered.",
            ),
          });
          return null;
        }
        return result.value.threadId;
      } finally {
        setPendingSpaceId(null);
        onSettled();
      }
    },
    [environmentId, onSettled, pendingSpaceId, wakeCommand],
  );

  const setPaused = useCallback(
    async (spaceId: string, paused: boolean): Promise<void> => {
      if (environmentId === null || pendingSpaceId !== null) return;
      setPendingSpaceId(spaceId);
      try {
        const result = await setPausedCommand({
          environmentId,
          input: { spaceId: SpaceId.make(spaceId), paused },
        });
        if (result._tag !== "Success") {
          toastManager.add({
            type: "error",
            title: paused ? "Could not pause the agent" : "Could not resume the agent",
            description: describeSpaceAgentError(
              squashAtomCommandFailure(result),
              "The change was not saved.",
            ),
          });
        }
      } finally {
        setPendingSpaceId(null);
        onSettled();
      }
    },
    [environmentId, onSettled, pendingSpaceId, setPausedCommand],
  );

  return { wake, setPaused, pendingSpaceId };
}
