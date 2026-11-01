import { useEffect, useRef } from "react";

const MAX_TRACKED_WORKSPACE_RESOURCES = 128;

export function workspaceMutationRefreshToken(
  resourceKey: string,
  mutationId: string | null,
): string | null {
  return mutationId === null ? null : `${resourceKey}\u0000${mutationId}`;
}

export function useWorkspaceMutationRefresh(input: {
  readonly enabled?: boolean;
  readonly mutationId: string | null;
  readonly refresh: () => void;
  readonly resourceKey: string;
}): void {
  const { enabled = true, mutationId, refresh, resourceKey } = input;
  const handledMutationsByResourceRef = useRef(new Map<string, string>());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refetches the resource once per new workspace mutation token
  useEffect(() => {
    if (!enabled || mutationId === null) return;
    if (handledMutationsByResourceRef.current.get(resourceKey) === mutationId) return;
    if (
      !handledMutationsByResourceRef.current.has(resourceKey) &&
      handledMutationsByResourceRef.current.size >= MAX_TRACKED_WORKSPACE_RESOURCES
    ) {
      const oldestResource = handledMutationsByResourceRef.current.keys().next().value;
      if (oldestResource !== undefined)
        handledMutationsByResourceRef.current.delete(oldestResource);
    }
    handledMutationsByResourceRef.current.set(resourceKey, mutationId);
    refresh();
  }, [enabled, mutationId, refresh, resourceKey]);
}
