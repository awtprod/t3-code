import { SpaceId } from "@command-center/core";
import type {
  CommandCenterSpaceActivityEntry,
  CommandCenterSpaceAgentSummary,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { ActivityIcon, ExternalLinkIcon, PauseIcon, PlayIcon, ZapIcon } from "lucide-react";
import { memo, useCallback, useState } from "react";

import { Button } from "../../components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../../components/ui/popover";
import { commandCenterEnvironment } from "../../state/commandCenter";
import { useEnvironmentQuery } from "../../state/query";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  SPACE_AGENT_ACTIVITY_LIMIT,
  spaceAgentLastWakeLabel,
  spaceIdFromSpaceAgentThreadId,
} from "./SpaceAgent.logic";
import { useSpaceAgentActions, useSpaceAgentList } from "./useSpaceAgents";

export function SpaceAgentActivityList(props: {
  readonly entries: ReadonlyArray<CommandCenterSpaceActivityEntry> | null;
  readonly error: string | null;
}) {
  if (props.error !== null) {
    return <p className="px-2 py-3 text-xs text-destructive-foreground">{props.error}</p>;
  }
  if (props.entries === null) {
    return <p className="px-2 py-3 text-xs text-muted-foreground">Loading activity…</p>;
  }
  if (props.entries.length === 0) {
    return (
      <p className="px-2 py-3 text-xs text-muted-foreground">No activity in this Space yet.</p>
    );
  }
  return (
    <ul className="flex flex-col" data-testid="space-agent-activity-list">
      {props.entries.map((entry) => (
        <li
          key={`${entry.sourceKind}:${entry.sourceId}:${entry.occurredAt}`}
          className="flex min-w-0 flex-col gap-0.5 rounded-md px-2 py-1.5 hover:bg-accent/50"
        >
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
              {entry.title}
            </span>
            <span className="shrink-0 text-[10px] text-muted-foreground/70 tabular-nums">
              {formatRelativeTimeLabel(entry.occurredAt)}
            </span>
          </div>
          <div className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
            <span className="shrink-0 capitalize">{entry.status}</span>
            {entry.url ? (
              <a
                href={entry.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-w-0 items-center gap-0.5 truncate text-primary hover:underline"
              >
                <ExternalLinkIcon className="size-3 shrink-0" />
                <span className="truncate">
                  {entry.url.replace(/^https:\/\/github\.com\//, "")}
                </span>
              </a>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

export interface SpaceAgentThreadControlsViewProps {
  readonly agent: CommandCenterSpaceAgentSummary;
  readonly pending: boolean;
  readonly activityOpen: boolean;
  readonly onActivityOpenChange: (open: boolean) => void;
  readonly activity: ReadonlyArray<CommandCenterSpaceActivityEntry> | null;
  readonly activityError: string | null;
  readonly onTogglePaused: () => void;
  readonly onWake: () => void;
}

export function SpaceAgentThreadControlsView(props: SpaceAgentThreadControlsViewProps) {
  const { agent } = props;
  return (
    <div className="flex shrink-0 items-center gap-1.5" data-testid="space-agent-thread-controls">
      <span className="hidden text-[11px] text-muted-foreground @3xl/header-actions:inline">
        {agent.paused ? "Paused · " : ""}
        {spaceAgentLastWakeLabel(agent)}
      </span>
      <Popover open={props.activityOpen} onOpenChange={props.onActivityOpenChange}>
        <PopoverTrigger
          render={
            <Button
              size="xs"
              variant="outline"
              aria-label="Space activity"
              data-toolbar-control=""
            />
          }
        >
          <ActivityIcon />
          <span className="sr-only @3xl/header-actions:not-sr-only">Activity</span>
          {agent.pendingEvents > 0 ? (
            <span className="rounded-sm bg-primary/12 px-1 text-[10px] text-primary tabular-nums">
              {agent.pendingEvents}
            </span>
          ) : null}
        </PopoverTrigger>
        <PopoverPopup side="bottom" align="end" className="w-96" padding="none">
          <div className="p-1">
            <div className="flex items-baseline justify-between gap-2 px-2 pt-1 pb-1.5">
              <span className="text-xs font-medium">{agent.displayName} activity</span>
              <span className="text-[10px] text-muted-foreground">
                {agent.wakesToday} wakes today
              </span>
            </div>
            <div className="max-h-96 overflow-y-auto">
              <SpaceAgentActivityList entries={props.activity} error={props.activityError} />
            </div>
          </div>
        </PopoverPopup>
      </Popover>
      <Button
        size="xs"
        variant="outline"
        disabled={props.pending}
        onClick={props.onTogglePaused}
        aria-label={agent.paused ? "Resume automatic wakes" : "Pause automatic wakes"}
        data-toolbar-control=""
      >
        {agent.paused ? <PlayIcon /> : <PauseIcon />}
        <span className="sr-only @3xl/header-actions:not-sr-only">
          {agent.paused ? "Resume" : "Pause"}
        </span>
      </Button>
      <Button
        size="xs"
        variant="outline"
        disabled={props.pending}
        onClick={props.onWake}
        aria-label="Wake the agent now"
        data-toolbar-control=""
      >
        <ZapIcon />
        <span className="sr-only @3xl/header-actions:not-sr-only">Wake now</span>
      </Button>
    </div>
  );
}

/** Header controls for a Space agent thread; renders nothing for other threads. */
export const SpaceAgentThreadControls = memo(function SpaceAgentThreadControls(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const spaceId = spaceIdFromSpaceAgentThreadId(props.threadId);
  const { environmentId, agents, refresh } = useSpaceAgentList();
  const agent = agents.find((candidate) => candidate.spaceId === spaceId) ?? null;
  const [activityOpen, setActivityOpen] = useState(false);
  const activityQuery = useEnvironmentQuery(
    environmentId === null || spaceId === null || !activityOpen
      ? null
      : commandCenterEnvironment.spaceAgentActivity({
          environmentId,
          input: { spaceId: SpaceId.make(spaceId), limit: SPACE_AGENT_ACTIVITY_LIMIT },
        }),
  );
  const refreshActivity = activityQuery.refresh;
  const onSettled = useCallback(() => {
    refresh();
    refreshActivity();
  }, [refresh, refreshActivity]);
  const { wake, setPaused, pendingSpaceId } = useSpaceAgentActions({ environmentId, onSettled });
  const onActivityOpenChange = useCallback(
    (open: boolean) => {
      setActivityOpen(open);
      if (open) refreshActivity();
    },
    [refreshActivity],
  );

  // Agents live on the primary environment; elsewhere the id is just a name.
  if (agent === null || environmentId !== props.environmentId) return null;
  return (
    <SpaceAgentThreadControlsView
      agent={agent}
      pending={pendingSpaceId === agent.spaceId}
      activityOpen={activityOpen}
      onActivityOpenChange={onActivityOpenChange}
      activity={activityQuery.data?.entries ?? null}
      activityError={activityQuery.error}
      onTogglePaused={() => void setPaused(agent.spaceId, !agent.paused)}
      onWake={() => void wake(agent.spaceId)}
    />
  );
});
