import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { useMemo } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { resolveThreadRouteTarget } from "~/threadRoutes";

/**
 * The scoped ref of the thread a view shows, stable for as long as it shows that thread.
 * Takes the thread object but keys on its ids: the shell changes identity on every update
 * during a run, and effects keyed on this ref must not re-run for that.
 */
export function useActiveThreadRef(
  thread: { readonly environmentId: EnvironmentId; readonly id: ThreadId } | null | undefined,
): ScopedThreadRef | null {
  const environmentId = thread?.environmentId ?? null;
  const threadId = thread?.id ?? null;
  return useMemo(
    () =>
      environmentId !== null && threadId !== null ? scopeThreadRef(environmentId, threadId) : null,
    [environmentId, threadId],
  );
}

// The currently-routed thread, resolved for both a server-backed thread and
// an in-progress draft session (which has no server thread id yet, so its ref
// comes from the draft store instead of the route params).
export function useActiveThreadRefFromRoute(): ScopedThreadRef | null {
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const activeDraftSession = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );

  return useMemo(() => {
    if (routeTarget?.kind === "server") {
      return routeTarget.threadRef;
    }
    if (routeTarget?.kind === "draft" && activeDraftSession) {
      return scopeThreadRef(activeDraftSession.environmentId, activeDraftSession.threadId);
    }
    return null;
  }, [activeDraftSession, routeTarget]);
}
