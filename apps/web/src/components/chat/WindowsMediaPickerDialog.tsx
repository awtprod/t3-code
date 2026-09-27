import type {
  CommandCenterWindowsMediaEntry,
  CommandCenterWindowsMediaListResult,
  CommandCenterWindowsMediaRootsResult,
  EnvironmentId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  ArrowUpIcon,
  FileIcon,
  FilmIcon,
  FolderIcon,
  HardDriveIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { commandCenterEnvironment } from "~/state/commandCenter";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import {
  formatWindowsMediaMtime,
  formatWindowsMediaSize,
  visibleWindowsMediaEntries,
  windowsMediaUpLocation,
  windowsPathBreadcrumbs,
  type WindowsMediaPickerLocation,
} from "./windowsMediaPicker.logic";

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "Could not reach the Windows machine.";
}

export type LoadState<T> =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly value: T };

export interface WindowsMediaPickerViewProps {
  readonly location: WindowsMediaPickerLocation;
  readonly roots: LoadState<CommandCenterWindowsMediaRootsResult>;
  readonly listing: LoadState<CommandCenterWindowsMediaListResult>;
  readonly showAllFiles: boolean;
  readonly onShowAllFilesChange: (value: boolean) => void;
  readonly onNavigate: (location: WindowsMediaPickerLocation) => void;
  readonly onRetry: () => void;
  readonly onPick: (entry: CommandCenterWindowsMediaEntry, host: string) => void;
}

/** Stateless body of the picker so it can render without a live server. */
export function WindowsMediaPickerView(props: WindowsMediaPickerViewProps) {
  const { location, roots, listing, showAllFiles } = props;
  const host =
    listing.status === "ready"
      ? listing.value.host
      : roots.status === "ready"
        ? roots.value.host
        : null;
  const active = location.kind === "roots" ? roots : listing;
  const listingValue = listing.status === "ready" ? listing.value : null;
  const entries = useMemo(
    () => (listingValue ? visibleWindowsMediaEntries(listingValue.entries, showAllFiles) : []),
    [listingValue, showAllFiles],
  );
  const hiddenCount = listingValue ? listingValue.entries.length - entries.length : 0;
  const crumbs = location.kind === "folder" ? windowsPathBreadcrumbs(location.path) : [];

  return (
    <div className="flex min-h-72 flex-col gap-3" data-testid="windows-media-picker">
      <div className="flex min-w-0 items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Up one folder"
          disabled={location.kind === "roots"}
          onClick={() => props.onNavigate(windowsMediaUpLocation(listingValue))}
        >
          <ArrowUpIcon />
        </Button>
        <nav
          aria-label="Folder path"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-sm"
        >
          <button
            type="button"
            className="shrink-0 rounded px-1 text-secondary-label hover:text-foreground hover:underline"
            onClick={() => props.onNavigate({ kind: "roots" })}
          >
            {host ?? "Windows"}
          </button>
          {crumbs.map((crumb, index) => (
            <span key={crumb.path} className="flex shrink-0 items-center gap-1">
              <span className="text-secondary-label">/</span>
              <button
                type="button"
                className={
                  index === crumbs.length - 1
                    ? "rounded px-1 font-medium"
                    : "rounded px-1 text-secondary-label hover:text-foreground hover:underline"
                }
                aria-current={index === crumbs.length - 1 ? "page" : undefined}
                onClick={() => props.onNavigate({ kind: "folder", path: crumb.path })}
              >
                {crumb.label}
              </button>
            </span>
          ))}
        </nav>
        <label className="flex shrink-0 items-center gap-2 text-xs text-secondary-label">
          <Switch
            checked={showAllFiles}
            onCheckedChange={(checked) => props.onShowAllFilesChange(checked)}
            aria-label="Show all files"
          />
          All files
        </label>
      </div>

      <div className="min-h-56 rounded-lg border">
        {active.status === "loading" || active.status === "idle" ? (
          <div className="flex h-56 items-center justify-center gap-2 text-sm text-secondary-label">
            <Spinner /> Loading…
          </div>
        ) : active.status === "error" ? (
          <div
            role="alert"
            className="flex h-56 flex-col items-center justify-center gap-3 px-6 text-center text-sm"
          >
            <span className="text-destructive-foreground">{active.message}</span>
            <Button type="button" variant="outline" size="sm" onClick={props.onRetry}>
              <RefreshCwIcon /> Retry
            </Button>
          </div>
        ) : location.kind === "roots" && roots.status === "ready" ? (
          roots.value.roots.length === 0 ? (
            <div className="flex h-56 items-center justify-center text-sm text-secondary-label">
              No drives available on {roots.value.host}.
            </div>
          ) : (
            <ul className="divide-y">
              {roots.value.roots.map((root) => (
                <li key={root.path}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                    onClick={() => props.onNavigate({ kind: "folder", path: root.path })}
                  >
                    <HardDriveIcon className="size-4 shrink-0 text-secondary-label" />
                    <span className="min-w-0 flex-1 truncate">{root.label}</span>
                    <span className="shrink-0 text-xs text-secondary-label">{root.path}</span>
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : listingValue ? (
          <>
            {entries.length === 0 ? (
              <div className="flex h-56 items-center justify-center px-6 text-center text-sm text-secondary-label">
                {hiddenCount > 0
                  ? `No videos here. ${hiddenCount} other ${hiddenCount === 1 ? "file" : "files"} hidden.`
                  : "This folder is empty."}
              </div>
            ) : (
              <ul className="max-h-[50vh] divide-y overflow-y-auto">
                {entries.map((entry) => (
                  <li key={entry.path}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                      title={entry.path}
                      onClick={() =>
                        entry.isDir
                          ? props.onNavigate({ kind: "folder", path: entry.path })
                          : props.onPick(entry, listingValue.host)
                      }
                    >
                      {entry.isDir ? (
                        <FolderIcon className="size-4 shrink-0 text-secondary-label" />
                      ) : entry.kind === "video" ? (
                        <FilmIcon className="size-4 shrink-0 text-secondary-label" />
                      ) : (
                        <FileIcon className="size-4 shrink-0 text-secondary-label" />
                      )}
                      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                      <span className="w-20 shrink-0 text-right text-xs tabular-nums text-secondary-label">
                        {entry.isDir ? "" : formatWindowsMediaSize(entry.sizeBytes)}
                      </span>
                      <span className="hidden w-36 shrink-0 text-right text-xs tabular-nums text-secondary-label sm:block">
                        {formatWindowsMediaMtime(entry.mtime)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {listingValue.truncated ? (
              <div className="border-t px-3 py-2 text-xs text-secondary-label">
                This folder has more entries than can be listed. Open a subfolder to narrow it down.
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

export interface WindowsMediaPickerDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly onPick: (entry: CommandCenterWindowsMediaEntry, host: string) => void;
}

export function WindowsMediaPickerDialog(props: WindowsMediaPickerDialogProps) {
  const { open, environmentId, onOpenChange, onPick } = props;
  const listRoots = useAtomCommand(commandCenterEnvironment.windowsMediaRoots, {
    reportFailure: false,
  });
  const listFolder = useAtomCommand(commandCenterEnvironment.windowsMediaList, {
    reportFailure: false,
  });
  const [location, setLocation] = useState<WindowsMediaPickerLocation>({ kind: "roots" });
  const [roots, setRoots] = useState<LoadState<CommandCenterWindowsMediaRootsResult>>({
    status: "idle",
  });
  const [listing, setListing] = useState<LoadState<CommandCenterWindowsMediaListResult>>({
    status: "idle",
  });
  const [showAllFiles, setShowAllFiles] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  // Each open starts at the drive list.
  useEffect(() => {
    if (open) {
      setLocation({ kind: "roots" });
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    if (location.kind === "roots") {
      setRoots({ status: "loading" });
      void listRoots({ environmentId, input: {} }).then((result) => {
        if (cancelled || isAtomCommandInterrupted(result)) return;
        setRoots(
          result._tag === "Success"
            ? { status: "ready", value: result.value }
            : { status: "error", message: failureMessage(result) },
        );
      });
    } else {
      setListing({ status: "loading" });
      void listFolder({ environmentId, input: { path: location.path } }).then((result) => {
        if (cancelled || isAtomCommandInterrupted(result)) return;
        setListing(
          result._tag === "Success"
            ? { status: "ready", value: result.value }
            : { status: "error", message: failureMessage(result) },
        );
      });
    }
    return () => {
      cancelled = true;
    };
  }, [open, location, environmentId, listRoots, listFolder, reloadToken]);

  const handlePick = useCallback(
    (entry: CommandCenterWindowsMediaEntry, host: string) => {
      onPick(entry, host);
      onOpenChange(false);
    },
    [onOpenChange, onPick],
  );

  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Browse Windows media</DialogTitle>
          <DialogDescription>
            Pick a file on the Windows machine. It is referenced by path, not uploaded.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <WindowsMediaPickerView
            location={location}
            roots={roots}
            listing={listing}
            showAllFiles={showAllFiles}
            onShowAllFilesChange={setShowAllFiles}
            onNavigate={setLocation}
            onRetry={() => setReloadToken((token) => token + 1)}
            onPick={handlePick}
          />
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
