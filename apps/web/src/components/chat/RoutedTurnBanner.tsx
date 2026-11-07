import type { EfficiencyThreadDelegation, ThreadId } from "@t3tools/contracts";
import { RouteIcon } from "lucide-react";

import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/** Efficiency routing ran the last sent message in a routed child thread. */
export function routedTurnBannerItem({
  delegation,
  onOpenThread,
  onDismiss,
}: {
  readonly delegation: EfficiencyThreadDelegation;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onDismiss: () => void;
}): ComposerBannerStackItem {
  return {
    id: `routed-turn:${delegation.messageId}`,
    variant: "info",
    icon: <RouteIcon />,
    title: `Routed to ${delegation.modelSelection.model} in ${
      delegation.reusedChild ? "its routed thread" : "a new routed thread"
    }`,
    description: "This thread keeps its own model; the routed thread carries the conversation.",
    actions: (
      <Button size="xs" variant="ghost" onClick={() => onOpenThread(delegation.childThreadId)}>
        Open thread
      </Button>
    ),
    dismissLabel: "Dismiss routed turn notice",
    onDismiss,
  };
}
