export const WORKSPACE_BROWSER_PREVIEW_EXTENSIONS = [".htm", ".html", ".pdf"] as const;

export const WORKSPACE_IMAGE_PREVIEW_EXTENSIONS = [
  ".avif",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
] as const;

/** Browser-playable video containers the chat can surface as a play tile. */
export const WORKSPACE_VIDEO_PREVIEW_EXTENSIONS = [
  ".m4v",
  ".mov",
  ".mp4",
  ".ogv",
  ".webm",
] as const;

const VIDEO_MIME_TYPE_BY_PREVIEW_EXTENSION: Readonly<Record<string, string>> = {
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".ogv": "video/ogg",
  ".webm": "video/webm",
};

function hasPreviewExtension(path: string, extensions: ReadonlyArray<string>): boolean {
  const pathWithoutQuery = path.split(/[?#]/, 1)[0]?.toLowerCase() ?? "";
  return extensions.some((extension) => pathWithoutQuery.endsWith(extension));
}

export function isWorkspaceBrowserPreviewPath(path: string): boolean {
  return hasPreviewExtension(path, WORKSPACE_BROWSER_PREVIEW_EXTENSIONS);
}

export function isWorkspaceImagePreviewPath(path: string): boolean {
  return hasPreviewExtension(path, WORKSPACE_IMAGE_PREVIEW_EXTENSIONS);
}

export function isWorkspacePreviewEntryPath(path: string): boolean {
  return isWorkspaceBrowserPreviewPath(path) || isWorkspaceImagePreviewPath(path);
}

export function isWorkspaceVideoPreviewPath(path: string): boolean {
  return hasPreviewExtension(path, WORKSPACE_VIDEO_PREVIEW_EXTENSIONS);
}

/** The inline video Content-Type for a workspace video path, or null for non-videos. */
export function workspaceVideoPreviewMimeType(path: string): string | null {
  const pathWithoutQuery = path.split(/[?#]/, 1)[0]?.toLowerCase() ?? "";
  const extension = WORKSPACE_VIDEO_PREVIEW_EXTENSIONS.find((candidate) =>
    pathWithoutQuery.endsWith(candidate),
  );
  return extension === undefined ? null : (VIDEO_MIME_TYPE_BY_PREVIEW_EXTENSION[extension] ?? null);
}
