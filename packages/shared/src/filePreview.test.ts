import { describe, expect, it } from "vite-plus/test";

import {
  isWorkspaceBrowserPreviewPath,
  isWorkspaceImagePreviewPath,
  isWorkspacePreviewEntryPath,
  isWorkspaceVideoPreviewPath,
  workspaceVideoPreviewMimeType,
} from "./filePreview.ts";

describe("workspace file previews", () => {
  it.each(["report.html", "report.HTM", "document.pdf?download=1"])(
    "recognizes browser preview path %s",
    (path) => {
      expect(isWorkspaceBrowserPreviewPath(path)).toBe(true);
      expect(isWorkspacePreviewEntryPath(path)).toBe(true);
    },
  );

  it.each([
    "icon.png",
    "photo.JPEG",
    "animation.gif",
    "vector.svg#mark",
    "texture.webp",
    "image.avif",
  ])("recognizes image preview path %s", (path) => {
    expect(isWorkspaceImagePreviewPath(path)).toBe(true);
    expect(isWorkspacePreviewEntryPath(path)).toBe(true);
  });

  it.each(["README.md", "src/index.ts", "image.png.ts", "png"])(
    "rejects non-preview path %s",
    (path) => {
      expect(isWorkspacePreviewEntryPath(path)).toBe(false);
    },
  );

  it.each([
    ["clip.mp4", "video/mp4"],
    ["renders/final.MOV", "video/quicktime"],
    ["a.webm?v=2", "video/webm"],
    ["b.m4v", "video/mp4"],
    ["c.ogv", "video/ogg"],
  ])("recognizes video preview path %s", (path, mimeType) => {
    expect(isWorkspaceVideoPreviewPath(path)).toBe(true);
    expect(workspaceVideoPreviewMimeType(path)).toBe(mimeType);
    // Videos stay out of the generic preview-entry set (file search, panel).
    expect(isWorkspacePreviewEntryPath(path)).toBe(false);
  });

  it.each(["clip.mp4.txt", "clip.mkv", "mp4", "notes.md"])("rejects non-video path %s", (path) => {
    expect(isWorkspaceVideoPreviewPath(path)).toBe(false);
    expect(workspaceVideoPreviewMimeType(path)).toBeNull();
  });
});
