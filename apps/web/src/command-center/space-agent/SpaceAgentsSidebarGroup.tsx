import type { CommandCenterSpaceAgentSummary, ThreadId } from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { BotIcon, PauseIcon } from "lucide-react";
import { memo, useCallback } from "react";

import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../../components/ui/sidebar";
import { spaceAgentLastWakeLabel } from "./SpaceAgent.logic";
import { useSpaceAgentActions, useSpaceAgentList } from "./useSpaceAgents";

export interface SpaceAgentsSidebarGroupViewProps {
  readonly agents: ReadonlyArray<CommandCenterSpaceAgentSummary>;
  readonly activeThreadId: string | null;
  readonly pendingSpaceId: string | null;
  readonly onOpen: (threadId: ThreadId) => void;
  readonly onWake: (spaceId: string) => void;
}

/** One pinned row per enabled Space agent; renders nothing when there are none. */
export function SpaceAgentsSidebarGroupView(props: SpaceAgentsSidebarGroupViewProps) {
  if (props.agents.length === 0) return null;
  return (
    <SidebarGroup data-testid="sidebar-space-agents">
      <div
        className="flex h-6 shrink-0 items-center px-2 font-medium text-sidebar-muted-foreground text-xs"
        data-slot="sidebar-group-label"
      >
        Spaces
      </div>
      <SidebarMenu>
        {props.agents.map((agent) => {
          const threadId = agent.threadId;
          const waking = props.pendingSpaceId === agent.spaceId;
          const wakeLabel = spaceAgentLastWakeLabel(agent);
          return (
            <SidebarMenuItem key={agent.spaceId}>
              <SidebarMenuButton
                size="sm"
                isActive={threadId !== null && props.activeThreadId === threadId}
                disabled={threadId === null && waking}
                title={
                  threadId === null
                    ? `${agent.displayName} agent has no thread yet`
                    : `${agent.displayName} agent · ${wakeLabel}`
                }
                onClick={() =>
                  threadId === null ? props.onWake(agent.spaceId) : props.onOpen(threadId)
                }
                data-testid={`sidebar-space-agent-${agent.spaceId}`}
              >
                <BotIcon />
                <span className="min-w-0 flex-1 truncate">{agent.displayName}</span>
                {agent.paused ? (
                  <span
                    className="inline-flex shrink-0 items-center gap-0.5 text-3xs text-warning-foreground"
                    aria-label="Paused"
                  >
                    <PauseIcon className="size-3" />
                    Paused
                  </span>
                ) : null}
                <span className="shrink-0 text-2xs text-muted-foreground/70 tabular-nums">
                  {threadId === null
                    ? waking
                      ? "Waking…"
                      : "Wake now"
                    : agent.lastWakeAt === null
                      ? "—"
                      : wakeLabel.replace(/^Woke /, "")}
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </SidebarGroup>
  );
}

/** The sidebar "Spaces" group, backed by `cc.spaceAgent.list`. */
export const SidebarSpaceAgents = memo(function SidebarSpaceAgents() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { isMobile, setOpenMobile } = useSidebar();
  const { environmentId, agents, refresh } = useSpaceAgentList();
  const { wake, pendingSpaceId } = useSpaceAgentActions({ environmentId, onSettled: refresh });
  const activeThreadId = decodeURIComponent(pathname.split("/").at(-1) ?? "");

  const open = useCallback(
    (threadId: ThreadId) => {
      if (environmentId === null) return;
      if (isMobile) setOpenMobile(false);
      void navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
    },
    [environmentId, isMobile, navigate, setOpenMobile],
  );
  const wakeAndOpen = useCallback(
    (spaceId: string) => {
      void wake(spaceId).then((threadId) => {
        if (threadId !== null) open(threadId);
      });
    },
    [open, wake],
  );

  return (
    <SpaceAgentsSidebarGroupView
      agents={agents}
      activeThreadId={activeThreadId}
      pendingSpaceId={pendingSpaceId}
      onOpen={open}
      onWake={wakeAndOpen}
    />
  );
});
