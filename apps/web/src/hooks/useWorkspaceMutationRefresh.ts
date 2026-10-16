import { useEffect, useRef } from "react";

export function workspaceMutationRefreshToken(
  resourceKey: string,
  mutationId: string | null,
): string | null {
  return mutationId === null ? null : `${resourceKey}\u0000${mutationId}`;
}

/**
 * Refreshes once per mutation and resource. Disabled mutations stay pending,
 * which lets an editable file catch up after its local save finishes.
 */
export function useWorkspaceMutationRefresh(input: {
  readonly enabled?: boolean;
  readonly mutationId: string | null;
  readonly refresh: () => void;
  readonly resourceKey: string;
}): void {
  const { enabled = true, mutationId, refresh, resourceKey } = input;
  const handledMutationsByResourceRef = useRef(new Map<string, string>());

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
