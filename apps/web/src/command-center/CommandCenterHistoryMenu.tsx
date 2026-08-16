import { MessageSquareIcon, PlusIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { ScrollArea } from "~/components/ui/scroll-area";
import { cn } from "~/lib/utils";

import type { CommandCenterAgentKind, CommandCenterConversation } from "./types";

export const AGENT_KIND_CHIP_LABEL: Record<CommandCenterAgentKind, string> = {
  assistant: "Assistant",
  automation: "Automation",
  coding: "Coding",
};

export const AGENT_KIND_CHIP_CLASS: Record<CommandCenterAgentKind, string> = {
  assistant: "bg-info/10 text-info",
  automation: "bg-warning/10 text-warning",
  coding: "bg-muted text-muted-foreground",
};

const STATUS_DOT_CLASS = {
  failed: "bg-destructive",
  idle: "bg-muted-foreground/40",
  queued: "bg-muted-foreground/40",
  running: "bg-info",
  waiting: "bg-warning",
} as const;

export function CommandCenterHistoryMenu({
  activeConversationId,
  conversations,
  onNewConversation,
  onSelectConversation,
}: {
  readonly activeConversationId?: string | undefined;
  readonly conversations: readonly CommandCenterConversation[];
  readonly onNewConversation?: (() => void) | undefined;
  readonly onSelectConversation?: ((conversationId: string) => void) | undefined;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button aria-label="Open recent Command Center conversations" size="sm" variant="ghost" />
        }
      >
        <MessageSquareIcon className="size-3.5" />
        <span className="hidden sm:inline">History</span>
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-80 max-w-[calc(100vw-2rem)] p-0">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <div className="min-w-0 flex-1 text-xs font-medium">Recent commands</div>
          <Button onClick={onNewConversation} size="xs" variant="ghost">
            <PlusIcon className="size-3.5" />
            New
          </Button>
        </div>
        <ScrollArea className="max-h-80" scrollFade>
          <div className="p-1.5">
            {conversations.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                Recent Command Center runs will appear here.
              </p>
            ) : (
              conversations.map((conversation) => (
                <button
                  className={cn(
                    "flex w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-accent",
                    conversation.id === activeConversationId && "bg-accent",
                  )}
                  key={conversation.id}
                  onClick={() => onSelectConversation?.(conversation.id)}
                  type="button"
                >
                  <span
                    className={cn(
                      "mt-1.5 size-1.5 shrink-0 rounded-full",
                      STATUS_DOT_CLASS[conversation.status ?? "idle"],
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-xs font-medium">{conversation.title}</span>
                      <span
                        className={cn(
                          "shrink-0 rounded-sm px-1 py-px text-[0.5625rem] font-medium uppercase tracking-wide",
                          AGENT_KIND_CHIP_CLASS[conversation.agentKind],
                        )}
                      >
                        {AGENT_KIND_CHIP_LABEL[conversation.agentKind]}
                      </span>
                    </span>
                    {conversation.preview ? (
                      <span className="mt-0.5 block truncate text-[0.6875rem] text-muted-foreground">
                        {conversation.preview}
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-[0.625rem] text-muted-foreground/70">
                    {conversation.updatedAtLabel}
                  </span>
                </button>
              ))
            )}
          </div>
        </ScrollArea>
      </PopoverPopup>
    </Popover>
  );
}
