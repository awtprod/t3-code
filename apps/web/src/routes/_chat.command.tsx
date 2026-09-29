import { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { CommandCenterHome } from "../command-center/CommandCenterHome";

export interface CommandSearch {
  readonly environment?: string;
  readonly run?: string;
}

export const Route = createFileRoute("/_chat/command")({
  validateSearch: (raw: Record<string, unknown>): CommandSearch => ({
    ...(typeof raw.environment === "string" && raw.environment.trim().length > 0
      ? { environment: raw.environment.trim().slice(0, 200) }
      : {}),
    ...(typeof raw.run === "string" && raw.run.trim().length > 0
      ? { run: raw.run.trim().slice(0, 200) }
      : {}),
  }),
  component: CommandRouteView,
});

function CommandRouteView() {
  const search = Route.useSearch();
  return (
    <CommandCenterHome
      initialEnvironmentId={
        search.environment === undefined ? undefined : EnvironmentId.make(search.environment)
      }
      initialRunId={search.run}
    />
  );
}
