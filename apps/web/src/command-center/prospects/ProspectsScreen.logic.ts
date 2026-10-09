import type { Item, ItemStatus, Space } from "@command-center/core";

export const PROSPECT_ITEM_PREFIX = "prospect-review:";
export const PROSPECT_STATUSES = [
  "review",
  "captured",
  "ready",
  "in_progress",
  "waiting",
  "done",
  "canceled",
] as const satisfies ReadonlyArray<ItemStatus>;

export type ProspectAction = "shortlist" | "pass" | "snooze" | "return-to-review";
export type ProspectTab = "review" | "snoozed" | "reviewed";

export const PROSPECT_TABS: ReadonlyArray<{ readonly id: ProspectTab; readonly label: string }> = [
  { id: "review", label: "Review" },
  { id: "snoozed", label: "Snoozed" },
  { id: "reviewed", label: "Reviewed" },
];

export function resolveProspectsSpace(
  spaces: readonly Space[],
  selectedSpaceId: string | undefined,
): Space | undefined {
  return (
    spaces.find((space) => space.id === selectedSpaceId) ??
    spaces.find((space) => /prospect/i.test(`${space.displayName} ${space.slug}`))
  );
}

export function isProspectItem(item: Item): boolean {
  return item.kind === "decision" && item.id.startsWith(PROSPECT_ITEM_PREFIX);
}

export function visibleProspectItems(items: readonly Item[]): readonly Item[] {
  return items
    .filter(isProspectItem)
    .filter((item) => PROSPECT_STATUSES.includes(item.status))
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function prospectItemsForTab(items: readonly Item[], tab: ProspectTab): readonly Item[] {
  return visibleProspectItems(items).filter((item) => {
    if (tab === "snoozed") return item.status === "waiting";
    if (tab === "reviewed") return item.status === "done" || item.status === "canceled";
    return item.status !== "waiting" && item.status !== "done" && item.status !== "canceled";
  });
}

export function prospectActionForStatus(status: ItemStatus): ProspectAction | undefined {
  if (status === "done" || status === "canceled" || status === "waiting") return "return-to-review";
  return undefined;
}

export function prospectActionStatus(action: ProspectAction): ItemStatus {
  switch (action) {
    case "shortlist":
      return "done";
    case "pass":
      return "canceled";
    case "snooze":
      return "waiting";
    case "return-to-review":
      return "review";
  }
}

export function prospectActionLabel(action: ProspectAction): string {
  switch (action) {
    case "shortlist":
      return "Shortlist";
    case "pass":
      return "Pass";
    case "snooze":
      return "Snooze";
    case "return-to-review":
      return "Return to review";
  }
}

export function prospectUpdateFailureMessage(message: string): string {
  return /conflict/i.test(message)
    ? "Changed elsewhere; reload and try again."
    : "Could not record this review decision. Try again after refreshing.";
}
