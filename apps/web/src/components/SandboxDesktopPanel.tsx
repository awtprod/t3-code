/*
 * The desktop-stream iframe below intentionally combines allow-scripts and
 * allow-same-origin: it renders an interactive remote-desktop viewer served
 * by our own AuthenticatedPreviewRouter behind a short-lived, thread-scoped
 * signed ticket, and needs both flags to run its viewer client and keep its
 * own storage/session state. A sandbox restrictive enough to remove either
 * flag would break the viewer outright. This file contains exactly one
 * iframe.
 */
/* oxlint-disable react/iframe-missing-sandbox */
import type { SandboxState } from "@t3tools/contracts";
import { Download, Expand, MonitorUp, Pause, Play, RefreshCw, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

export interface SandboxDesktopPanelProps {
  sandbox: SandboxState | null;
  busy?: boolean;
  onProvision: () => Promise<{ readonly _tag?: string }>;
  onTakeover: () => Promise<{ readonly _tag?: string }>;
  onResume: (leaseId?: string) => Promise<{ readonly _tag?: string }>;
  onStop: () => Promise<{ readonly _tag?: string }>;
  onExport: () => Promise<{ readonly _tag?: string }>;
  onReconnect: () => void;
  onRequestViewerUrl: () => Promise<string>;
}

const titleCase = (value: string) => value.replaceAll("-", " ");

/** Thread desktop controls. Closing/unmounting this view intentionally never resumes a lease. */
export function SandboxDesktopPanel(props: SandboxDesktopPanelProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [reconnectGeneration, setReconnectGeneration] = useState(0);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const [viewerBusy, setViewerBusy] = useState(false);
  const sandbox = props.sandbox;
  const humanController = sandbox?.controller.kind === "human" ? sandbox.controller : null;
  const desktopReady = sandbox?.desktop.status === "ready";
  /**
   * Headless deployments (`T3_SANDBOX_DESKTOP=disabled`) run a sandbox with no
   * desktop at all. The lifecycle controls below stay live -- they act on the
   * sandbox, not the desktop -- but the viewer would only ever 409.
   */
  const desktopUnavailable = sandbox !== null && sandbox.desktop.status === "unavailable";

  const fullscreen = () => void frameRef.current?.requestFullscreen();
  const requestViewer = async () => {
    if (!desktopReady || viewerBusy) return;
    setViewerBusy(true);
    setActionError(null);
    try {
      setViewerUrl(await props.onRequestViewerUrl());
      setReconnectGeneration((current) => current + 1);
    } catch (cause) {
      setViewerUrl(null);
      setActionError(
        cause instanceof Error ? cause.message : "Could not connect to the desktop viewer.",
      );
    } finally {
      setViewerBusy(false);
    }
  };
  const reconnect = () => {
    void requestViewer();
    props.onReconnect();
  };
  useEffect(() => {
    setViewerUrl(null);
    if (desktopReady) void requestViewer();
    // A new desktop session always requires a fresh one-time ticket.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktopReady, sandbox?.desktop.sessionId]);
  const busy = props.busy === true || actionBusy;
  const runAction = async (action: () => Promise<{ readonly _tag?: string }>) => {
    if (busy) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const result = await action();
      if (result._tag === "Failure")
        setActionError("The sandbox action failed. Refresh and try again.");
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "The sandbox action failed.");
    } finally {
      setActionBusy(false);
    }
  };

  return (
    <section className="flex h-full min-h-0 flex-col bg-background" aria-label="Thread desktop">
      <header className="flex min-h-11 items-center gap-2 border-b px-3">
        <MonitorUp className="size-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {desktopUnavailable ? "Isolated sandbox" : "Isolated desktop"}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {sandbox === null
              ? "Starts automatically on first use"
              : `${titleCase(sandbox.lifecycle)} · ${sandbox.branch.branchName}`}
          </div>
        </div>
        {desktopReady ? (
          <>
            <Button size="icon" variant="ghost" aria-label="Reconnect desktop" onClick={reconnect}>
              <RefreshCw />
            </Button>
            <Button size="icon" variant="ghost" aria-label="Enter fullscreen" onClick={fullscreen}>
              <Expand />
            </Button>
          </>
        ) : null}
        {sandbox === null ? (
          <Button size="sm" disabled={busy} onClick={() => void runAction(props.onProvision)}>
            Start
          </Button>
        ) : humanController ? (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void runAction(() => props.onResume(humanController.leaseId))}
          >
            <Play /> Resume agent
          </Button>
        ) : sandbox.lifecycle === "ready" && !desktopUnavailable ? (
          <Button size="sm" disabled={busy} onClick={() => void runAction(props.onTakeover)}>
            <Pause /> Take control
          </Button>
        ) : null}
        {sandbox && !["stopped", "expired", "deleted"].includes(sandbox.lifecycle) ? (
          <Button
            size="icon"
            variant="ghost"
            disabled={busy || humanController !== null}
            aria-label="Stop sandbox"
            onClick={() => void runAction(props.onStop)}
          >
            <Square />
          </Button>
        ) : null}
        {sandbox ? (
          <Button
            size="icon"
            variant="ghost"
            disabled={busy}
            aria-label="Export sandbox branch"
            onClick={() => void runAction(props.onExport)}
          >
            <Download />
          </Button>
        ) : null}
      </header>

      {humanController ? (
        <div
          role="status"
          className="border-b bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
        >
          You control this desktop. Agent commands remain paused until you explicitly resume.
        </div>
      ) : null}
      {actionError ? (
        <div role="alert" className="border-b bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {actionError}
        </div>
      ) : null}

      <div className={cn("min-h-0 flex-1", desktopUnavailable ? "bg-muted/30" : "bg-black")}>
        {desktopReady && viewerUrl ? (
          <iframe
            ref={frameRef}
            key={`${sandbox.desktop.sessionId}:${reconnectGeneration}`}
            title="Thread desktop stream"
            src={viewerUrl}
            className="h-full w-full border-0"
            sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock"
            referrerPolicy="same-origin"
            allow="fullscreen; clipboard-read; clipboard-write"
          />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {desktopUnavailable
              ? "This deployment runs sandboxes headless. The controls above still stop and export this sandbox."
              : viewerBusy
                ? "Connecting to desktop…"
                : (sandbox?.desktop.failure ??
                  (sandbox?.desktop.status === "starting"
                    ? "Desktop is starting…"
                    : "The desktop stream is not ready."))}
          </div>
        )}
      </div>

      {sandbox ? (
        <footer className="grid grid-cols-2 gap-x-4 gap-y-1 border-t px-3 py-2 text-xs text-muted-foreground sm:grid-cols-4">
          <span>CPU {sandbox.usage ? `${sandbox.usage.cpuPercent.toFixed(1)}%` : "—"}</span>
          <span>
            Memory{" "}
            {sandbox.usage
              ? `${Math.round(sandbox.usage.memoryBytes / 1_048_576)} MiB / ${Math.round(sandbox.limits.memoryBytes / 1_073_741_824)} GiB`
              : `— / ${Math.round(sandbox.limits.memoryBytes / 1_073_741_824)} GiB`}
          </span>
          <span>
            Disk {sandbox.usage ? `${Math.round(sandbox.usage.diskBytes / 1_048_576)} MiB` : "—"}
          </span>
          <span>
            Services {sandbox.services.filter((service) => service.status === "healthy").length}/
            {sandbox.services.length}
          </span>
        </footer>
      ) : null}
    </section>
  );
}
