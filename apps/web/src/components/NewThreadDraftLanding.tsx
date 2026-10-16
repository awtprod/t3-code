import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import { isElectron } from "../env";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import {
  readProject,
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../state/entities";
import { NoProjectsHero } from "./NoProjectsHero";
import { sortScopedProjectsForSidebar } from "./Sidebar.logic";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { RefreshIcon } from "./ui/refresh-icon";
import { SidebarInset } from "./ui/sidebar";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

/**
 * Drops straight into a draft thread for the most recently active project, so
 * the screen is a prompt instead of a dead end. Falls back to an add-project
 * hero when no project exists yet. Command Center mounts it on `/new` (the
 * index route lands on the inbox instead).
 */
export function NewThreadDraftLanding({ pathname }: { readonly pathname: string }) {
  const projects = useProjects();
  const threads = useThreadShells();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const handleNewThread = useNewThreadHandler();
  const router = useRouter();
  // Read at effect time: this page stays mounted while a navigation away from
  // it is still loading, but the router already points at the new location.
  const isStillOnLanding = useEffectEvent(() => router.state.location.pathname === pathname);
  const startingRef = useRef(false);
  const [startState, setStartState] = useState({ failed: false, retryRequest: 0 });

  const mostRecentProject = useMemo(
    () =>
      bootstrapped
        ? (sortScopedProjectsForSidebar(projects, threads, "updated_at")[0] ?? null)
        : null,
    [bootstrapped, projects, threads],
  );

  useEffect(() => {
    // Starting a draft after the user has left would replace the page they picked.
    if (mostRecentProject === null || startingRef.current || !isStillOnLanding()) {
      return;
    }
    const projectRef = scopeProjectRef(mostRecentProject.environmentId, mostRecentProject.id);
    // A project removed since this render is gone from the store; the next
    // render picks another one.
    if (readProject(projectRef) === null) {
      return;
    }
    startingRef.current = true;
    void handleNewThread(projectRef, { replace: true })
      .then((opened) => {
        // The project was removed while its draft started; land on the next one.
        if (opened === null) {
          startingRef.current = false;
          setStartState((state) => ({ ...state, retryRequest: state.retryRequest + 1 }));
        }
      })
      .catch(() => {
        startingRef.current = false;
        setStartState((state) => ({ ...state, failed: true }));
      });
  }, [handleNewThread, mostRecentProject, startState.retryRequest]);

  if (!bootstrapped) {
    return null;
  }
  if (mostRecentProject !== null) {
    return startState.failed ? (
      <DraftStartError
        onRetry={() => {
          setStartState((state) => ({
            failed: false,
            retryRequest: state.retryRequest + 1,
          }));
        }}
      />
    ) : null;
  }
  // First-run routing to the welcome wizard happens in FirstRunGate at the
  // root, before this route ever renders.
  return <NoProjectsHero />;
}

function DraftStartError({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      {isElectron ? <WorkspacePageHeader electron /> : null}
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          <EmptyTitle>Couldn’t start a new thread</EmptyTitle>
          <EmptyDescription>
            The project is still available. Try opening the draft again.
          </EmptyDescription>
          <div className="mt-5 flex justify-center">
            <Button size="sm" onClick={onRetry}>
              <RefreshIcon size="md" />
              Try again
            </Button>
          </div>
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}
