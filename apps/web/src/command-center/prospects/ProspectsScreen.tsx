import type { Item, Space } from "@command-center/core";
import { RefreshCwIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

import {
  prospectActionForStatus,
  prospectActionLabel,
  prospectItemsForTab,
  PROSPECT_TABS,
  type ProspectAction,
  type ProspectTab,
} from "./ProspectsScreen.logic";

export function ProspectsScreen({
  space,
  spaces,
  items,
  isLoading,
  error,
  bootstrapError,
  submittingItemId,
  showLimitWarning,
  onSpaceChange,
  onRefresh,
  onAction,
}: {
  readonly space: Space | undefined;
  readonly spaces: readonly Space[];
  readonly items: readonly Item[];
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly bootstrapError: boolean;
  readonly submittingItemId: string | undefined;
  readonly showLimitWarning: boolean;
  readonly onSpaceChange: (spaceId: string) => void;
  readonly onRefresh: () => void;
  readonly onAction: (item: Item, action: ProspectAction) => void;
}) {
  const [tab, setTab] = useState<ProspectTab>("review");
  const prospects = useMemo(() => prospectItemsForTab(items, tab), [items, tab]);
  const tabCounts = useMemo(
    () => new Map(PROSPECT_TABS.map(({ id }) => [id, prospectItemsForTab(items, id).length])),
    [items],
  );
  const isSaving = submittingItemId !== undefined;

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 pt-14 pb-12 sm:px-6 sm:pt-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-medium text-muted-foreground">Prospector</p>
          <h1 className="text-2xl font-semibold tracking-tight">Prospects</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Review decisions are saved in Command Center. They do not change Prospector
            qualification.
          </p>
        </div>
        <Button className="self-start" disabled={isLoading} onClick={onRefresh} variant="outline">
          <RefreshCwIcon /> Refresh
        </Button>
      </header>

      <label className="flex max-w-sm flex-col gap-1.5 text-sm font-medium">
        Space
        <select
          aria-label="Prospects Space"
          className="min-h-11 rounded-[var(--control-radius)] border border-input bg-background px-3 text-base shadow-xs/5 sm:min-h-8 sm:text-sm"
          onChange={(event) => onSpaceChange(event.target.value)}
          value={space?.id ?? ""}
        >
          <option disabled value="">
            Select a Space
          </option>
          {spaces.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.displayName}
            </option>
          ))}
        </select>
      </label>

      {error !== null && (space !== undefined || bootstrapError) ? (
        <StateCard>
          <p>{error}</p>
          <Button className="mt-3" onClick={onRefresh} variant="outline">
            Try again
          </Button>
        </StateCard>
      ) : space === undefined ? (
        <StateCard>Choose a Space to view its prospect decisions.</StateCard>
      ) : isLoading ? (
        <StateCard>Loading prospects…</StateCard>
      ) : (
        <>
          <div aria-label="Prospect filters" className="flex flex-wrap gap-2" role="tablist">
            {PROSPECT_TABS.map(({ id, label }) => (
              <Button
                aria-selected={tab === id}
                key={id}
                onClick={() => setTab(id)}
                role="tab"
                size="sm"
                variant={tab === id ? "default" : "outline"}
              >
                {label} ({tabCounts.get(id) ?? 0})
              </Button>
            ))}
          </div>
          {showLimitWarning ? (
            <p className="text-sm text-muted-foreground">
              Showing the latest 100 items in this Space. Older items may not be shown.
            </p>
          ) : null}
          {isSaving ? (
            <p className="text-sm text-muted-foreground" role="status">
              Saving decision…
            </p>
          ) : null}
          {prospects.length === 0 ? (
            <StateCard>No prospect decisions are in this view yet.</StateCard>
          ) : (
            <div className="flex flex-col gap-3">
              {prospects.map((item) => (
                <ProspectCard
                  item={item}
                  isSubmitting={isSaving}
                  key={item.id}
                  onAction={onAction}
                />
              ))}
            </div>
          )}
        </>
      )}
    </main>
  );
}

function StateCard({ children }: { readonly children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
      {children}
    </section>
  );
}

function ProspectCard({
  item,
  isSubmitting,
  onAction,
}: {
  readonly item: Item;
  readonly isSubmitting: boolean;
  readonly onAction: (item: Item, action: ProspectAction) => void;
}) {
  const reverseAction = prospectActionForStatus(item.status);
  const active = item.status !== "done" && item.status !== "canceled" && item.status !== "waiting";
  return (
    <article className="rounded-xl border border-border bg-card p-4 shadow-xs/5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {item.status.replace("_", " ")}
          </p>
          <h2 className="mt-1 text-base font-semibold">{item.title}</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          {active ? (
            <>
              <ActionButton
                action="shortlist"
                disabled={isSubmitting}
                item={item}
                onAction={onAction}
              />
              <ActionButton action="pass" disabled={isSubmitting} item={item} onAction={onAction} />
              <ActionButton
                action="snooze"
                disabled={isSubmitting}
                item={item}
                onAction={onAction}
              />
            </>
          ) : reverseAction !== undefined ? (
            <ActionButton
              action={reverseAction}
              disabled={isSubmitting}
              item={item}
              onAction={onAction}
            />
          ) : null}
        </div>
      </div>
      {item.description ? (
        <ChatMarkdown className="mt-4" cwd={undefined} text={item.description} />
      ) : null}
      <p className="mt-4 text-xs text-muted-foreground">
        Review decisions are saved in Command Center.
      </p>
    </article>
  );
}

function ActionButton({
  action,
  disabled,
  item,
  onAction,
}: {
  readonly action: ProspectAction;
  readonly disabled: boolean;
  readonly item: Item;
  readonly onAction: (item: Item, action: ProspectAction) => void;
}) {
  return (
    <Button
      className={cn("min-h-11 text-sm sm:min-h-8", action === "pass" && "text-destructive")}
      disabled={disabled}
      onClick={() => onAction(item, action)}
      size="sm"
      variant={action === "shortlist" ? "default" : "outline"}
    >
      {prospectActionLabel(action)}
    </Button>
  );
}
