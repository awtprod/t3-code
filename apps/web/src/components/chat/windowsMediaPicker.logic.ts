import type {
  ChatWindowsFileAttachment,
  CommandCenterWindowsMediaEntry,
  CommandCenterWindowsMediaListResult,
} from "@t3tools/contracts";

/** Picker view state: either the drive/root list or one listed folder. */
export type WindowsMediaPickerLocation =
  | { readonly kind: "roots" }
  | { readonly kind: "folder"; readonly path: string };

export interface WindowsMediaBreadcrumb {
  readonly label: string;
  readonly path: string;
}

/**
 * Splits an absolute Windows path into clickable crumbs: the drive root first,
 * then one crumb per folder. UNC paths keep server plus share as their first
 * crumb.
 */
export function windowsPathBreadcrumbs(path: string): WindowsMediaBreadcrumb[] {
  const trimmed = path.replace(/[\\/]+$/, "");
  const normalized = trimmed.replace(/\//g, "\\");
  if (normalized.startsWith("\\\\")) {
    const parts = normalized.slice(2).split("\\").filter(Boolean);
    if (parts.length < 2) {
      return [{ label: normalized, path: normalized }];
    }
    const rootPath = `\\\\${parts[0]}\\${parts[1]}`;
    const crumbs: WindowsMediaBreadcrumb[] = [{ label: rootPath, path: rootPath }];
    let current = rootPath;
    for (const part of parts.slice(2)) {
      current = `${current}\\${part}`;
      crumbs.push({ label: part, path: current });
    }
    return crumbs;
  }
  const parts = normalized.split("\\").filter(Boolean);
  if (parts.length === 0) {
    return [];
  }
  const drive = `${parts[0]}\\`;
  const crumbs: WindowsMediaBreadcrumb[] = [{ label: drive, path: drive }];
  let current = parts[0]!;
  for (const part of parts.slice(1)) {
    current = `${current}\\${part}`;
    crumbs.push({ label: part, path: current });
  }
  return crumbs;
}

/** Where "Up" goes: the server-reported parent, or back to the roots list. */
export function windowsMediaUpLocation(
  listing: Pick<CommandCenterWindowsMediaListResult, "parent"> | null,
): WindowsMediaPickerLocation {
  return listing?.parent ? { kind: "folder", path: listing.parent } : { kind: "roots" };
}

/**
 * Entries to show. Folders always show (so the user can navigate); files are
 * limited to videos unless `showAllFiles`. Folders first, then name order.
 */
export function visibleWindowsMediaEntries(
  entries: ReadonlyArray<CommandCenterWindowsMediaEntry>,
  showAllFiles: boolean,
): CommandCenterWindowsMediaEntry[] {
  return entries
    .filter((entry) => entry.isDir || showAllFiles || entry.kind === "video")
    .toSorted((left, right) => {
      if (left.isDir !== right.isDir) return left.isDir ? -1 : 1;
      return left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true });
    });
}

/** Builds the draft reference for a picked file. No bytes, no upload. */
export function windowsFileAttachmentFromEntry(input: {
  readonly id: string;
  readonly host: string;
  readonly entry: CommandCenterWindowsMediaEntry;
}): ChatWindowsFileAttachment {
  return {
    type: "windows-file",
    id: input.id,
    name: input.entry.name,
    mimeType: input.entry.mimeType || "application/octet-stream",
    sizeBytes: Math.max(0, Math.trunc(input.entry.sizeBytes)),
    host: input.host,
    path: input.entry.path,
  };
}

/**
 * Maps picked draft references onto the outgoing turn attachments. Strips any
 * extra client-side fields so only the contract shape rides on the wire.
 */
export function windowsFileTurnAttachments(
  files: ReadonlyArray<ChatWindowsFileAttachment>,
): ChatWindowsFileAttachment[] {
  return files.map((file) => ({
    type: "windows-file",
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    host: file.host,
    path: file.path,
  }));
}

export function formatWindowsMediaSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = sizeBytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function formatWindowsMediaMtime(mtime: string | null): string {
  if (!mtime) return "";
  const date = new Date(mtime);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
