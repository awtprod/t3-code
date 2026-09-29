import type { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { PlugZapIcon } from "lucide-react";
import { useCallback, useEffect, useMemo } from "react";

import { DigestCard } from "../command-center/DigestCard";
import { InboxScreen } from "../command-center/inbox/InboxScreen";
import {
  type InboxSearch,
  resolveInboxEnvironmentId,
  validateInboxSearch,
} from "../command-center/inbox/InboxScreen.logic";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { useActiveEnvironmentId } from "../state/entities";
import { commandCenterEnvironment } from "../state/commandCenter";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { useEnvironmentSessionState } from "../state/session";

export const Route = createFileRoute("/_chat/inbox")({
  validateSearch: validateInboxSearch,
  component: InboxRouteView,
});

function InboxRouteView() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/inbox" });
  const activeEnvironmentId = useActiveEnvironmentId();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments, isReady } = useEnvironments();
  const environmentOptions = useMemo(
    () =>
      environments.map((environment) => ({
        id: environment.environmentId,
        label:
          environment.connection.phase === "connected"
            ? environment.label
            : `${environment.label} — ${environment.connection.phase}`,
      })),
    [environments],
  );
  const resolvedEnvironmentId = resolveInboxEnvironmentId({
    requestedEnvironmentId: search.environment,
    activeEnvironmentId,
    primaryEnvironmentId,
    environmentIds: environmentOptions.map((environment) => environment.id),
  });
  const environmentId =
    resolvedEnvironmentId === null ? null : (resolvedEnvironmentId as EnvironmentId);
  const selectedEnvironment = environments.find(
    (environment) => environment.environmentId === environmentId,
  );

  const updateSearch = useCallback(
    (patch: Partial<InboxSearch>, replace = false) => {
      void navigate({
        replace,
        search: (previous: InboxSearch): InboxSearch => {
          const next = { ...previous, ...patch };
          return {
            tab: next.tab ?? "actionable",
            ...(next.environment ? { environment: next.environment } : {}),
            ...(next.space ? { space: next.space } : {}),
            ...(next.item ? { item: next.item } : {}),
          };
        },
      });
    },
    [navigate],
  );

  useEffect(() => {
    if (environmentId !== null && search.environment === undefined) {
      updateSearch({ environment: environmentId }, true);
    }
  }, [environmentId, search.environment, updateSearch]);

  if (!isReady) {
    return (
      <SidebarInset className="h-full min-h-0 overflow-hidden bg-background text-foreground">
        <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
          Loading environments…
        </div>
      </SidebarInset>
    );
  }
  if (environmentId === null) {
    return (
      <SidebarInset className="h-full min-h-0 overflow-hidden bg-background text-foreground">
        <Empty className="flex-1">
          <EmptyHeader className="max-w-md">
            <PlugZapIcon className="mx-auto mb-3 size-8 text-muted-foreground" />
            <EmptyTitle>Connect an environment to open Inbox</EmptyTitle>
            <EmptyDescription>
              Inbox reads durable items from the active Command Center environment.
            </EmptyDescription>
            <Button className="mt-4" render={<Link to="/settings/connections" />} size="sm">
              Open Connections
            </Button>
          </EmptyHeader>
        </Empty>
      </SidebarInset>
    );
  }

  if (selectedEnvironment?.connection.phase !== "connected") {
    const phase = selectedEnvironment?.connection.phase ?? "unavailable";
    const error = selectedEnvironment?.connection.error;
    return (
      <SidebarInset className="h-full min-h-0 overflow-hidden bg-background text-foreground">
        <Empty className="flex-1">
          <EmptyHeader className="max-w-md">
            <PlugZapIcon className="mx-auto mb-3 size-8 text-muted-foreground" />
            <EmptyTitle>
              {phase === "connecting" || phase === "reconnecting"
                ? "Reconnecting to this environment"
                : "This environment is disconnected"}
            </EmptyTitle>
            <EmptyDescription>
              {selectedEnvironment?.label ?? search.environment} is {phase}. This Inbox link keeps
              its environment, Space, and item while the connection recovers.
              {error ? ` ${error}` : ""}
            </EmptyDescription>
            <Button className="mt-4" render={<Link to="/settings/connections" />} size="sm">
              Open Connections
            </Button>
          </EmptyHeader>
        </Empty>
      </SidebarInset>
    );
  }

  return (
    <SidebarInset className="h-full min-h-0 overflow-hidden bg-background text-foreground">
      <InboxEnvironmentRoute
        environmentId={environmentId}
        environmentOptions={environmentOptions}
        search={search}
        updateSearch={updateSearch}
      />
    </SidebarInset>
  );
}

function InboxEnvironmentRoute({
  environmentId,
  environmentOptions,
  search,
  updateSearch,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentOptions: ReadonlyArray<{
    readonly id: EnvironmentId;
    readonly label: string;
  }>;
  readonly search: InboxSearch;
  readonly updateSearch: (patch: Partial<InboxSearch>, replace?: boolean) => void;
}) {
  const bootstrapQuery = useEnvironmentQuery(
    commandCenterEnvironment.bootstrap({ environmentId, input: {} }),
  );
  const session = useEnvironmentSessionState(environmentId);
  const spaces = useMemo(
    () =>
      [...(bootstrapQuery.data?.spaces ?? [])].sort((left, right) =>
        left.displayName.localeCompare(right.displayName),
      ),
    [bootstrapQuery.data?.spaces],
  );
  const selectedSpaceId = spaces.some((space) => space.id === search.space)
    ? search.space
    : undefined;
  const selectedItemId = selectedSpaceId === undefined ? undefined : search.item;
  const draftScopeId = session.data?.authenticated === true ? session.data.draftScopeId : undefined;

  useEffect(() => {
    if (bootstrapQuery.data === null) return;
    if (search.space !== undefined && selectedSpaceId === undefined) {
      updateSearch({ space: undefined, item: undefined }, true);
      return;
    }
    if (search.item !== undefined && selectedSpaceId === undefined) {
      updateSearch({ item: undefined }, true);
    }
  }, [bootstrapQuery.data, search.item, search.space, selectedSpaceId, updateSearch]);

  if (bootstrapQuery.data === null) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        {bootstrapQuery.error === null ? (
          "Loading Inbox…"
        ) : (
          <div>
            <p>{bootstrapQuery.error}</p>
            <Button className="mt-3" onClick={bootstrapQuery.refresh} size="sm" variant="outline">
              Retry
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <div className="max-h-[40vh] shrink-0 overflow-y-auto border-b border-border/60 p-3 sm:p-4">
        <DigestCard environmentId={environmentId} />
      </div>
      <InboxScreen
        environmentId={environmentId}
        environmentOptions={environmentOptions}
        draftScopeId={draftScopeId}
        itemId={selectedItemId}
        onEnvironmentChange={(nextEnvironmentId) =>
          updateSearch({ environment: nextEnvironmentId, space: undefined, item: undefined })
        }
        onItemChange={(item) => updateSearch({ item })}
        onSelectItem={(space, item) => updateSearch({ space, item })}
        onSpaceChange={(space) => updateSearch({ space, item: undefined })}
        onTabChange={(tab) => updateSearch({ tab, item: undefined })}
        runs={bootstrapQuery.data.runs}
        selectedSpaceId={selectedSpaceId}
        spaces={spaces}
        tab={search.tab}
      />
    </div>
  );
}
