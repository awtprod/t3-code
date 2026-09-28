import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { ItemId, SpaceId } from "@command-center/core";
import { EnvironmentId, type CommandCenterInboxCursor } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { DigestCard } from "../command-center/DigestCard";
import { Button } from "../components/ui/button";
import { SidebarInset } from "../components/ui/sidebar";
import { commandCenterEnvironment } from "../state/commandCenter";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";

const isEnvironmentId = Schema.is(EnvironmentId);
const isSpaceId = Schema.is(SpaceId);
const isItemId = Schema.is(ItemId);

export const Route = createFileRoute("/_chat/inbox")({
  validateSearch: (search: Record<string, unknown>) => ({
    environmentId: isEnvironmentId(search.environmentId) ? search.environmentId : undefined,
    spaceId: isSpaceId(search.spaceId) ? search.spaceId : undefined,
    itemId: isItemId(search.itemId) ? search.itemId : undefined,
  }),
  component: InboxRouteView,
});

function InboxRouteView() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const navigate = useNavigate();
  const { environmentId: requestedEnvironmentId, spaceId, itemId } = Route.useSearch();
  const environmentId = requestedEnvironmentId ?? primaryEnvironmentId;
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  const [cursor, setCursor] = useState<CommandCenterInboxCursor | undefined>();
  const [previousCursors, setPreviousCursors] = useState<
    readonly (CommandCenterInboxCursor | undefined)[]
  >([]);
  const bootstrap = useEnvironmentQuery(
    environmentId === null
      ? null
      : commandCenterEnvironment.bootstrap({ environmentId, input: {} }),
  );
  const inbox = useEnvironmentQuery(
    environmentId === null
      ? null
      : commandCenterEnvironment.inbox({
          environmentId,
          input: { view: "actionable", limit: 100, ...(cursor ? { cursor } : {}) },
        }),
  );
  const detail = useEnvironmentQuery(
    environmentId === null || !spaceId || !itemId
      ? null
      : commandCenterEnvironment.inboxDetail({
          environmentId,
          input: { spaceId, itemId, historyLimit: 50 },
        }),
  );
  const spaceName = (id: SpaceId) =>
    bootstrap.data?.spaces.find((space) => space.id === id)?.displayName ?? id;

  return (
    <SidebarInset className="h-full min-h-0 overflow-auto bg-background text-foreground">
      <main className="mx-auto w-full max-w-6xl space-y-5 px-4 py-6 sm:px-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Inbox</h1>
            <p className="text-sm text-muted-foreground">
              Actionable work across your Spaces{environment ? ` · ${environment.label}` : ""}.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              inbox.refresh();
              detail.refresh();
            }}
          >
            Refresh Inbox
          </Button>
        </header>
        <DigestCard environmentId={environmentId} />
        {requestedEnvironmentId && !environment ? (
          <p role="alert" className="text-sm text-destructive">
            This linked environment is unavailable. Reconnect it to open the item.
          </p>
        ) : null}
        <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(17rem,22rem)_minmax(0,1fr)]">
          <section
            aria-label="Actionable Inbox items"
            className="min-w-0 rounded-xl border border-border bg-card/50 p-3"
          >
            <h2 className="px-2 py-2 text-sm font-semibold">Needs attention</h2>
            {inbox.error ? (
              <p role="alert" className="px-2 text-sm text-destructive">
                {inbox.error}
              </p>
            ) : null}
            {inbox.isPending && !inbox.data ? (
              <p className="px-2 text-sm text-muted-foreground">Loading Inbox…</p>
            ) : null}
            {inbox.data?.items.length === 0 ? (
              <p className="px-2 text-sm text-muted-foreground">Nothing needs attention.</p>
            ) : null}
            <ul className="max-h-[60vh] space-y-1 overflow-y-auto">
              {inbox.data?.items.map(({ item, state }) => (
                <li key={`${state.spaceId}:${state.itemId}`}>
                  <Link
                    className="block rounded-lg px-3 py-2 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                    aria-current={
                      spaceId === state.spaceId && itemId === state.itemId ? "page" : undefined
                    }
                    to="/inbox"
                    search={{
                      environmentId: environmentId ?? undefined,
                      spaceId: state.spaceId,
                      itemId: state.itemId,
                    }}
                  >
                    <span className="block truncate text-sm font-medium">{item.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {spaceName(state.spaceId)} · {item.kind} · {item.status}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            {previousCursors.length > 0 || inbox.data?.nextCursor ? (
              <div className="flex justify-between gap-2 px-2 pt-3">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={previousCursors.length === 0}
                  onClick={() => {
                    const previous = previousCursors.at(-1);
                    setPreviousCursors((current) => current.slice(0, -1));
                    setCursor(previous);
                  }}
                >
                  Previous
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!inbox.data?.nextCursor}
                  onClick={() => {
                    if (!inbox.data?.nextCursor) return;
                    setPreviousCursors((current) => [...current, cursor]);
                    setCursor(inbox.data.nextCursor);
                  }}
                >
                  Next
                </Button>
              </div>
            ) : null}
          </section>
          <section
            aria-label="Selected Inbox item"
            className="min-w-0 rounded-xl border border-border bg-card/50 p-4 sm:p-5"
          >
            {!spaceId || !itemId ? (
              <p className="text-sm text-muted-foreground">
                Select an item to see its exact revision and discussion.
              </p>
            ) : null}
            {detail.isPending && !detail.data ? (
              <p className="text-sm text-muted-foreground">Loading item…</p>
            ) : null}
            {detail.error ? (
              <p role="alert" className="text-sm text-destructive">
                {detail.error}
              </p>
            ) : null}
            {detail.data ? (
              <div className="space-y-5">
                <div>
                  <p className="text-xs text-muted-foreground">
                    {spaceName(detail.data.state.spaceId)} · {detail.data.item.kind}
                  </p>
                  <h2 className="mt-1 text-xl font-semibold">{detail.data.item.title}</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {detail.data.item.status} · {detail.data.state.lifecycle} · version{" "}
                    {detail.data.state.version}
                  </p>
                  {detail.data.item.description ? (
                    <p className="mt-3 whitespace-pre-wrap text-sm">
                      {detail.data.item.description}
                    </p>
                  ) : null}
                </div>
                {detail.data.currentRevision ? (
                  <div className="rounded-lg border border-border p-3">
                    <h3 className="text-sm font-semibold">Accepted revision</h3>
                    <p className="mt-1 whitespace-pre-wrap text-sm">
                      {detail.data.currentRevision.preview.summary}
                    </p>
                    <p className="mt-2 break-all text-xs text-muted-foreground">
                      Revision {detail.data.currentRevision.id}
                    </p>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No accepted revision yet.</p>
                )}
                {detail.data.discussion.length > 0 ? (
                  <div>
                    <h3 className="text-sm font-semibold">Discussion</h3>
                    <ul className="mt-2 space-y-2">
                      {detail.data.discussion.map((entry) => (
                        <li key={entry.id} className="rounded-lg border border-border p-3 text-sm">
                          <p className="whitespace-pre-wrap">{entry.text}</p>
                          <p className="mt-2 text-xs text-muted-foreground">
                            {entry.actor.subject} · {new Date(entry.createdAt).toLocaleString()}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    void navigate({
                      to: "/inbox",
                      search: {
                        environmentId: environmentId ?? undefined,
                        spaceId: undefined,
                        itemId: undefined,
                      },
                    })
                  }
                >
                  Close detail
                </Button>
              </div>
            ) : null}
          </section>
        </div>
      </main>
    </SidebarInset>
  );
}
