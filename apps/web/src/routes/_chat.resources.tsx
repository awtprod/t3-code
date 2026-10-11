import type { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { PlugZapIcon } from "lucide-react";
import { useMemo } from "react";

import { ResourcesPane } from "../components/resources/ResourcesPane";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";

type ResourcesSearch = {
  environment?: string | undefined;
};

export const Route = createFileRoute("/_chat/resources")({
  validateSearch: (search): ResourcesSearch => ({
    environment: typeof search.environment === "string" ? search.environment : undefined,
  }),
  component: ResourcesRouteView,
});

function ResourcesRouteView() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/resources" });
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
  // Disk pressure is a property of a host, so the pane follows an explicit pick, then the primary
  // environment (the machine this server runs on), then whichever host is reachable.
  const environmentId: EnvironmentId | null =
    environments.find((environment) => environment.environmentId === search.environment)
      ?.environmentId ??
    primaryEnvironmentId ??
    environments.find((environment) => environment.connection.phase === "connected")
      ?.environmentId ??
    null;
  const selectedEnvironment = environments.find(
    (environment) => environment.environmentId === environmentId,
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
            <EmptyTitle>Connect an environment to monitor resources</EmptyTitle>
            <EmptyDescription>
              Resources reads disk, memory, and process usage from a connected host.
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
              {selectedEnvironment?.label ?? search.environment} is {phase}. Resource usage resumes
              when the connection recovers.
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
    <SidebarInset className="h-full min-h-0 overflow-hidden">
      <ResourcesPane
        key={environmentId}
        environmentId={environmentId}
        environmentOptions={environmentOptions}
        onEnvironmentChange={(nextEnvironmentId) =>
          void navigate({ search: { environment: nextEnvironmentId }, replace: true })
        }
      />
    </SidebarInset>
  );
}
