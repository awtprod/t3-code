import { createFileRoute } from "@tanstack/react-router";
import { ItemId, SpaceId, type Item } from "@command-center/core";
import { COMMAND_CENTER_WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import {
  createEnvironmentRpcQueryAtomFamily,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ProspectsScreen } from "../command-center/prospects/ProspectsScreen";
import {
  PROSPECT_STATUSES,
  prospectActionStatus,
  prospectUpdateFailureMessage,
  resolveProspectsSpace,
  type ProspectAction,
} from "../command-center/prospects/ProspectsScreen.logic";
import { connectionAtomRuntime } from "../connection/runtime";
import { commandCenterEnvironment } from "../state/commandCenter";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { SidebarInset } from "../components/ui/sidebar";

// The shared command-center atom collection has not yet exposed this existing read RPC.
// Keep this route-local until that collection grows the corresponding reusable query atom.
const prospectsItemsQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:command-center:prospects-items",
  tag: COMMAND_CENTER_WS_METHODS.itemsQuery,
  staleTimeMs: 1_000,
});

function commandErrorMessage(failure: unknown): string {
  const message = failure instanceof Error ? failure.message : String(failure);
  return prospectUpdateFailureMessage(message);
}

function ProspectsRouteView() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const environmentId: EnvironmentId | null =
    primaryEnvironmentId ??
    environments.find((environment) => environment.connection.phase === "connected")
      ?.environmentId ??
    null;
  const [selectedSpaceId, setSelectedSpaceId] = useState<string>();
  const [submittingItemId, setSubmittingItemId] = useState<string>();
  const [actionError, setActionError] = useState<string | null>(null);
  const actionInFlightRef = useRef(false);
  const bootstrapQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : commandCenterEnvironment.bootstrap({ environmentId, input: {} }),
  );
  const space = useMemo(
    () => resolveProspectsSpace(bootstrapQuery.data?.spaces ?? [], selectedSpaceId),
    [bootstrapQuery.data?.spaces, selectedSpaceId],
  );
  const itemsQuery = useEnvironmentQuery(
    environmentId === null || space === undefined
      ? null
      : prospectsItemsQuery({
          environmentId,
          input: { spaceId: SpaceId.make(space.id), statuses: [...PROSPECT_STATUSES], limit: 100 },
        }),
  );
  const updateItem = useAtomCommand(commandCenterEnvironment.updateItem, { reportFailure: false });

  useEffect(() => {
    if (selectedSpaceId === undefined && space !== undefined) setSelectedSpaceId(space.id);
  }, [selectedSpaceId, space]);

  const refresh = useCallback(() => {
    setActionError(null);
    bootstrapQuery.refresh();
    itemsQuery.refresh();
  }, [bootstrapQuery, itemsQuery]);

  const act = useCallback(
    async (item: Item, action: ProspectAction) => {
      if (environmentId === null || actionInFlightRef.current) return;
      actionInFlightRef.current = true;
      setSubmittingItemId(item.id);
      setActionError(null);
      try {
        const result = await updateItem({
          environmentId,
          input: {
            itemId: ItemId.make(item.id),
            spaceId: SpaceId.make(item.spaceId),
            expectedUpdatedAt: item.updatedAt,
            patch: { status: prospectActionStatus(action) },
          },
        });
        if (result._tag !== "Success") {
          setActionError(commandErrorMessage(squashAtomCommandFailure(result)));
          return;
        }
        itemsQuery.refresh();
        bootstrapQuery.refresh();
      } catch (failure) {
        setActionError(commandErrorMessage(failure));
      } finally {
        actionInFlightRef.current = false;
        setSubmittingItemId(undefined);
      }
    },
    [bootstrapQuery, environmentId, itemsQuery, updateItem],
  );

  return (
    <SidebarInset className="h-full min-h-0 overflow-auto bg-background text-foreground">
      <ProspectsScreen
        error={actionError ?? bootstrapQuery.error ?? itemsQuery.error}
        bootstrapError={bootstrapQuery.error !== null}
        isLoading={bootstrapQuery.isPending || (space !== undefined && itemsQuery.isPending)}
        items={itemsQuery.data?.items ?? []}
        onAction={act}
        onRefresh={refresh}
        onSpaceChange={setSelectedSpaceId}
        space={space}
        spaces={bootstrapQuery.data?.spaces ?? []}
        submittingItemId={submittingItemId}
        showLimitWarning={itemsQuery.data?.items.length === 100}
      />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/prospects")({
  component: ProspectsRouteView,
});
