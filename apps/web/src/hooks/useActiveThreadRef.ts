import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { resolveThreadRouteTarget } from "~/threadRoutes";

function toThreadRef(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): ScopedThreadRef | null {
  return environmentId !== null && threadId !== null
    ? scopeThreadRef(environmentId, threadId)
    : null;
}

/** Key by ids: streaming shell identity changes must not retrigger effects. */
export function useActiveThreadRef(
  thread: { readonly environmentId: EnvironmentId; readonly id: ThreadId } | null | undefined,
): ScopedThreadRef | null {
  const environmentId = thread?.environmentId ?? null;
  const threadId = thread?.id ?? null;
  const [ref, setRef] = useState(() => toThreadRef(environmentId, threadId));
  if ((ref?.environmentId ?? null) !== environmentId || (ref?.threadId ?? null) !== threadId) {
    const next = toThreadRef(environmentId, threadId);
    setRef(next);
    return next;
  }
  return ref;
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

  if (routeTarget?.kind === "server") {
    return routeTarget.threadRef;
  }
  if (routeTarget?.kind === "draft" && activeDraftSession) {
    return scopeThreadRef(activeDraftSession.environmentId, activeDraftSession.threadId);
  }
  return null;
}
