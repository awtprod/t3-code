import { AutomationId, SpaceId } from "@command-center/core";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { CommandCenterResponsibilityStatus, EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { ResponsibilitiesScreen } from "../command-center/responsibilities/ResponsibilitiesScreen";
import {
  withResponsibilityDetailReceipt,
  withResponsibilityReceipt,
} from "../command-center/responsibilities/ResponsibilitiesScreen.logic";
import { SidebarInset } from "../components/ui/sidebar";
import { commandCenterEnvironment } from "../state/commandCenter";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";

function commandError(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim()) return cause.message;
  if (typeof cause === "string" && cause.trim()) return cause;
  return "The Responsibility control could not be saved.";
}

function ResponsibilitiesRouteView() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const environmentId: EnvironmentId | null =
    primaryEnvironmentId ??
    environments.find((environment) => environment.connection.phase === "connected")
      ?.environmentId ??
    null;
  const [spaceId, setSpaceId] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [controlReceipt, setControlReceipt] = useState<CommandCenterResponsibilityStatus | null>(
    null,
  );
  const actionInFlight = useRef(false);
  const bootstrapQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : commandCenterEnvironment.bootstrap({ environmentId, input: {} }),
  );
  const listQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : commandCenterEnvironment.responsibilities({
          environmentId,
          input: { ...(spaceId ? { spaceId: SpaceId.make(spaceId) } : {}), limit: 100 },
        }),
  );
  const responsibilities = useMemo(
    () => withResponsibilityReceipt(listQuery.data?.responsibilities ?? [], controlReceipt),
    [controlReceipt, listQuery.data?.responsibilities],
  );
  const resolvedSelectedId = useMemo(
    () =>
      responsibilities.find((item) => item.automationId === selectedId)?.automationId ??
      responsibilities[0]?.automationId ??
      null,
    [responsibilities, selectedId],
  );
  const selected = responsibilities.find((item) => item.automationId === resolvedSelectedId);
  const detailQuery = useEnvironmentQuery(
    environmentId === null || selected === undefined
      ? null
      : commandCenterEnvironment.responsibility({
          environmentId,
          input: {
            spaceId: SpaceId.make(selected.spaceId),
            automationId: AutomationId.make(selected.automationId),
            historyLimit: 25,
          },
        }),
  );
  const detail = withResponsibilityDetailReceipt(detailQuery.data, controlReceipt);
  const pause = useAtomCommand(commandCenterEnvironment.pauseResponsibility, {
    reportFailure: false,
  });
  const resume = useAtomCommand(commandCenterEnvironment.resumeResponsibility, {
    reportFailure: false,
  });
  useEffect(() => {
    setActionError(null);
  }, [resolvedSelectedId, spaceId]);
  useEffect(() => {
    setControlReceipt(null);
  }, [environmentId, spaceId]);

  const refresh = () => {
    setActionError(null);
    bootstrapQuery.refresh();
    listQuery.refresh();
    detailQuery.refresh();
  };

  const setPaused = async (paused: boolean, reason: string) => {
    if (environmentId === null || selected === undefined || actionInFlight.current) return;
    actionInFlight.current = true;
    setActionPending(true);
    setActionError(null);
    try {
      const input = {
        spaceId: SpaceId.make(selected.spaceId),
        automationId: AutomationId.make(selected.automationId),
        expectedVersion: detail?.pauseVersion ?? selected.pauseVersion,
        ...(reason ? { reason } : {}),
      };
      const result = await (paused ? pause : resume)({ environmentId, input });
      if (result._tag !== "Success") {
        setActionError(commandError(squashAtomCommandFailure(result)));
        listQuery.refresh();
        detailQuery.refresh();
        return;
      }
      setControlReceipt(result.value);
      listQuery.refresh();
      detailQuery.refresh();
    } catch (cause) {
      setActionError(commandError(cause));
    } finally {
      actionInFlight.current = false;
      setActionPending(false);
    }
  };

  return (
    <SidebarInset className="h-full min-h-0 overflow-auto">
      <ResponsibilitiesScreen
        actionError={actionError}
        actionPending={actionPending}
        detail={detail}
        detailError={detailQuery.error}
        detailLoading={detailQuery.isPending}
        error={
          environmentId === null
            ? "Connect to an environment to view Responsibilities."
            : listQuery.error
        }
        loading={listQuery.isPending}
        onPauseChange={setPaused}
        onRefresh={refresh}
        onSelect={(id) => {
          setSelectedId(id);
          setActionError(null);
        }}
        onSpaceChange={(id) => {
          setSpaceId(id);
          setSelectedId(null);
        }}
        responsibilities={responsibilities}
        selectedId={resolvedSelectedId}
        spaceId={spaceId}
        spaces={bootstrapQuery.data?.spaces ?? []}
      />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/responsibilities")({
  component: ResponsibilitiesRouteView,
});
