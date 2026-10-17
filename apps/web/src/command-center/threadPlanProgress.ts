import type { CommandCenterThreadPlanProgress, EnvironmentId, ThreadId } from "@t3tools/contracts";

import { commandCenterEnvironment } from "~/state/commandCenter";
import { useEnvironmentQuery } from "~/state/query";

/**
 * The current plan step (and n/m) of a working thread, from the Command
 * Center plan-progress subscription. Subscribes only while `enabled`, so only
 * working rows hold a subscription; `null` when there is no active todo list
 * or the environment does not serve it.
 */
export function useThreadPlanProgress(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly enabled: boolean;
}): CommandCenterThreadPlanProgress | null {
  const query = useEnvironmentQuery(
    input.enabled
      ? commandCenterEnvironment.threadPlanProgress({
          environmentId: input.environmentId,
          input: { threadIds: [input.threadId] },
        })
      : null,
  );
  return query.data?.[input.threadId] ?? null;
}
