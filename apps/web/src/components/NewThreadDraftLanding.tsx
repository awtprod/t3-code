import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { isElectron } from "../env";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { workspaceAreaProps } from "../lib/workspaceFocus";
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
 * Drops straight into a draft thread for the most recently active project, with an
 * add-project hero when none exists. Command Center mounts it on `/new`; the index
 * route lands on the first sidebar shortcut instead.
 */
export function NewThreadDraftLanding({ pathname }: { readonly pathname: string }) {
  const projects = useProjects();
  const threads = useThreadShells();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const handleNewThread = useNewThreadHandler();
  const router = useRouter();
  // Read at effect time; this page can stay mounted while the router is already navigating away.
  const isStillOnLanding = useEffectEvent(() => router.state.location.pathname === pathname);
  const startedAttemptRef = useRef<number | null>(null);
  const [startState, setStartState] = useState({ failed: false, retryRequest: 0 });

  const mostRecentProject =
    sortScopedProjectsForSidebar(projects, threads, "updated_at")[0] ?? null;
  const attempt = startState.retryRequest;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts a draft thread in the most recent project and navigates to it while still on the landing route
  useEffect(() => {
    // Starting a draft after the user has left would replace the page they picked.
    if (
      mostRecentProject === null ||
      startedAttemptRef.current === attempt ||
      !isStillOnLanding()
    ) {
      return;
    }
    const projectRef = scopeProjectRef(mostRecentProject.environmentId, mostRecentProject.id);
    if (readProject(projectRef) === null) {
      return;
    }
    startedAttemptRef.current = attempt;
    void handleNewThread(projectRef, { replace: true })
      .then((opened) => {
        if (opened === null) {
          setStartState((state) => ({ ...state, retryRequest: state.retryRequest + 1 }));
        }
      })
      .catch(() => {
        setStartState((state) => ({ ...state, failed: true }));
      });
  }, [attempt, handleNewThread, mostRecentProject]);

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
  // A pending environment cannot prove the workspace is empty.
  return bootstrapped ? <NoProjectsHero /> : null;
}

function DraftStartError({ onRetry }: { readonly onRetry: () => void }) {
  const contentArea = workspaceAreaProps("home", 1, "Home");
  return (
    <SidebarInset
      {...contentArea}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
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
