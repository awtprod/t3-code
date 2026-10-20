import { AuthCommandCenterApproveScope, type EnvironmentId } from "@t3tools/contracts";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { PlugZapIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { CommandCenterEnvironmentCandidate } from "../command-center/CommandCenterExecution.logic";
import { DigestCard } from "../command-center/DigestCard";
import { InboxScreen } from "../command-center/inbox/InboxScreen";
import {
  inboxEnvironmentPreference,
  type InboxSearch,
  resolveInboxEnvironmentId,
  validateInboxSearch,
} from "../command-center/inbox/InboxScreen.logic";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
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
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments, isReady } = useEnvironments();
  const [preferredEnvironmentId, setPreferredEnvironmentId] = useState(() =>
    inboxEnvironmentPreference(undefined),
  );
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
  const environmentCandidates = useMemo<readonly CommandCenterEnvironmentCandidate[]>(
    () =>
      environments.map((environment) => ({
        id: environment.environmentId,
        label: environment.label,
        isPrimary: environment.entry.target._tag === "PrimaryConnectionTarget",
        platformOs: environment.serverConfig?.environment.platform.os ?? "unknown",
        connected: environment.connection.phase === "connected",
      })),
    [environments],
  );
  const resolvedEnvironmentId = resolveInboxEnvironmentId({
    requestedEnvironmentId: search.environment,
    preferredEnvironmentId,
    primaryEnvironmentId,
    environments: environmentCandidates,
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

  const selectEnvironment = useCallback(
    (nextEnvironmentId: EnvironmentId) => {
      inboxEnvironmentPreference(undefined, nextEnvironmentId);
      setPreferredEnvironmentId(nextEnvironmentId);
      updateSearch({ environment: nextEnvironmentId, space: undefined, item: undefined });
    },
    [updateSearch],
  );

  if (!isReady) {
    return (
      <SidebarInset className="h-full min-h-0 overflow-hidden">
        <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
          Loading environments…
        </div>
      </SidebarInset>
    );
  }
  if (environmentId === null) {
    return (
      <SidebarInset className="h-full min-h-0 overflow-hidden">
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
      <SidebarInset className="h-full min-h-0 overflow-hidden">
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
            {environmentOptions.length > 0 ? (
              <label className="mt-4 grid gap-1 text-left text-sm">
                Environment
                <select
                  className="h-9 w-full min-w-0 max-w-56 rounded-lg border border-input bg-background px-3 text-sm"
                  onChange={(event) => selectEnvironment(event.target.value as EnvironmentId)}
                  value={environmentId}
                >
                  {!environmentOptions.some((option) => option.id === environmentId) ? (
                    <option value={environmentId}>{environmentId} — unavailable</option>
                  ) : null}
                  {environmentOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <Button className="mt-4" render={<Link to="/settings/connections" />} size="sm">
              Open Connections
            </Button>
          </EmptyHeader>
        </Empty>
      </SidebarInset>
    );
  }

  return (
    <SidebarInset className="h-full min-h-0 overflow-hidden">
      <InboxEnvironmentRoute
        environmentId={environmentId}
        environmentOptions={environmentOptions}
        search={search}
        onEnvironmentChange={selectEnvironment}
        updateSearch={updateSearch}
      />
    </SidebarInset>
  );
}

function InboxEnvironmentRoute({
  environmentId,
  environmentOptions,
  search,
  onEnvironmentChange,
  updateSearch,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentOptions: ReadonlyArray<{
    readonly id: EnvironmentId;
    readonly label: string;
  }>;
  readonly search: InboxSearch;
  readonly onEnvironmentChange: (environmentId: EnvironmentId) => void;
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
      <InboxScreen
        canApprove={session.data?.scopes?.includes(AuthCommandCenterApproveScope) === true}
        environmentId={environmentId}
        environmentOptions={environmentOptions}
        digest={<DigestCard environmentId={environmentId} key={environmentId} />}
        draftScopeId={draftScopeId}
        itemId={selectedItemId}
        onEnvironmentChange={onEnvironmentChange}
        onItemChange={(item) => updateSearch({ item })}
        onSelectItem={(space, item) => updateSearch({ environment: environmentId, space, item })}
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
