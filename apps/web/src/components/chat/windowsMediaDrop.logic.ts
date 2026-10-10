import type {
  ChatWindowsFileAttachment,
  CommandCenterWindowsMediaListResult,
} from "@t3tools/contracts";

import { videoMimeType } from "../../types";
import { windowsFileAttachmentFromEntry } from "./windowsMediaPicker.logic";

/** Splits an absolute Windows path into its parent folder and file name. */
export function splitWindowsPath(path: string): { folder: string; name: string } | null {
  const normalized = path.replace(/\//g, "\\");
  const index = normalized.lastIndexOf("\\");
  if (index <= 0 || index === normalized.length - 1) return null;
  const name = normalized.slice(index + 1);
  let folder = normalized.slice(0, index);
  // "C:" alone means the drive's current dir; the root is "C:\".
  if (/^[A-Za-z]:$/.test(folder)) folder = `${folder}\\`;
  return { folder, name };
}

/** Whether a local path looks like an absolute Windows path (drive or UNC). */
function isAbsoluteWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/**
 * Confirms the Windows box listing contains the dropped file: same name
 * (case-insensitive, as NTFS is) and same byte size. Returns the reference
 * attachment when verified, null otherwise.
 */
function verifiedWindowsFileReference(input: {
  readonly id: string;
  readonly file: { readonly name: string; readonly size: number };
  readonly localName: string;
  readonly listing: Pick<CommandCenterWindowsMediaListResult, "host" | "entries">;
}): ChatWindowsFileAttachment | null {
  const wanted = input.localName.toLowerCase();
  const entry = input.listing.entries.find(
    (candidate) =>
      !candidate.isDir &&
      candidate.name.toLowerCase() === wanted &&
      candidate.sizeBytes === input.file.size,
  );
  if (!entry) return null;
  return windowsFileAttachmentFromEntry({ id: input.id, host: input.listing.host, entry });
}

export interface DroppedFileRoutingDeps {
  /** True when the desktop bridge exposes `getPathForFile` and the server has windowsMedia. */
  readonly enabled: boolean;
  readonly getPathForFile: (file: File) => string;
  /** Lists a folder on the Windows box; resolves null on any failure. */
  readonly listFolder: (
    path: string,
  ) => Promise<Pick<CommandCenterWindowsMediaListResult, "host" | "entries"> | null>;
  readonly newId: () => string;
}

export interface DroppedFileRouting {
  readonly references: ChatWindowsFileAttachment[];
  readonly uploads: File[];
}

/**
 * Routes dropped/pasted files: videos that exist at the same path and size on
 * the Windows media host become path references; everything else (non-video,
 * no local path, different machine, SSH down, not found) keeps the upload
 * path. Each file is decided independently.
 */
export async function routeDroppedFiles(
  files: ReadonlyArray<File>,
  deps: DroppedFileRoutingDeps,
): Promise<DroppedFileRouting> {
  if (!deps.enabled) return { references: [], uploads: [...files] };
  const decisions = await Promise.all(
    files.map(async (file): Promise<ChatWindowsFileAttachment | null> => {
      if (videoMimeType({ name: file.name, mimeType: file.type }) === null) return null;
      let localPath = "";
      try {
        localPath = deps.getPathForFile(file);
      } catch {
        return null;
      }
      if (!localPath || !isAbsoluteWindowsPath(localPath)) return null;
      const split = splitWindowsPath(localPath);
      if (!split) return null;
      let listing: Awaited<ReturnType<DroppedFileRoutingDeps["listFolder"]>> = null;
      try {
        listing = await deps.listFolder(split.folder);
      } catch {
        return null;
      }
      if (!listing) return null;
      return verifiedWindowsFileReference({
        id: deps.newId(),
        file,
        localName: split.name,
        listing,
      });
    }),
  );
  const references: ChatWindowsFileAttachment[] = [];
  const uploads: File[] = [];
  files.forEach((file, index) => {
    const reference = decisions[index];
    if (reference) references.push(reference);
    else uploads.push(file);
  });
  return { references, uploads };
}
