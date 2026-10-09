import { describe, expect, it } from "vite-plus/test";

import {
  filePreviewKind,
  decodeFilePreviewText,
  FILE_TEXT_PREVIEW_MAX_BYTES,
  hostPreviewMimeTypeFromExtension,
  isWorkspaceAudioPreviewPath,
  isWorkspaceBrowserPreviewPath,
  isWorkspaceImagePreviewPath,
  isWorkspacePreviewEntryPath,
  isWorkspaceVideoPreviewPath,
  mediaKindFromPath,
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
    ["renders/odd#1?.webm", "video/webm"],
    ["b.m4v", "video/mp4"],
    ["c.ogv", "video/ogg"],
  ])("recognizes video preview path %s", (path, mimeType) => {
    expect(isWorkspaceVideoPreviewPath(path)).toBe(true);
    expect(workspaceVideoPreviewMimeType(path)).toBe(mimeType);
    // Videos stay out of the generic preview-entry set (file search, panel).
    expect(isWorkspacePreviewEntryPath(path)).toBe(false);
  });

  // Filesystem paths: `?`/`#` are literal filename characters, never stripped,
  // so client classification matches the exact file the server resolves.
  it("keeps non-browser-playable containers out of the inline video preview set", () => {
    // Upstream classifies .mkv as video; only the inline-playback MIME map excludes it.
    expect(workspaceVideoPreviewMimeType("clip.mkv")).toBeNull();
  });

  it.each(["clip.mp4.txt", "mp4", "notes.md", "a.webm?v=2", "data.mp4#x", "a.mp4?/b"])(
    "rejects non-video path %s",
    (path) => {
      expect(isWorkspaceVideoPreviewPath(path)).toBe(false);
      expect(workspaceVideoPreviewMimeType(path)).toBeNull();
    },
  );

  it("serves audio in place from the host like video and browser documents", () => {
    expect(isWorkspaceAudioPreviewPath("notes/recording.WAV")).toBe(true);
    expect(isWorkspaceAudioPreviewPath("recording.wav.ts")).toBe(false);
    expect(hostPreviewMimeTypeFromExtension(".m4a")).toBe("audio/mp4");
    expect(hostPreviewMimeTypeFromExtension(".mp4")).toBe("video/mp4");
    expect(hostPreviewMimeTypeFromExtension(".txt")).toBeNull();
  });
});

describe("media path parsing", () => {
  it.each([
    ["https://cdn.example/clip.webm?download=1#t=2", "video"],
    ["https://example.com/download?name=recording.mp4", null],
    ["https://example.png", null],
    ["images%2Fresult%2Epng", "image"],
    ["images/result%23v2.png", "image"],
    ["images/result.png%23secret.txt", null],
    ["images/result.png%3Fsecret.txt", null],
    ["/tmp/100%.png", "image"],
  ])("classifies the decoded pathname of %s", (source, kind) => {
    expect(mediaKindFromPath(source)).toBe(kind);
  });

  it.each([
    ["recording.mp4#t=2", "video", false],
    ["recording%2Emp4", "video", false],
    ["recording#take2.mp4", null, true],
    ["recording?take2.mp4", null, true],
  ])("distinguishes authored URLs from literal filenames in %s", (source, kind, literalVideo) => {
    expect(mediaKindFromPath(source)).toBe(kind);
    expect(isWorkspaceVideoPreviewPath(source)).toBe(literalVideo);
  });
});

describe("attachment preview classification", () => {
  it.each([
    ["example.json", "application/octet-stream", "text"],
    ["README.md", "text/plain", "markdown"],
    ["component.tsx", "", "text"],
    ["report.pdf", "application/pdf", "pdf"],
    ["page.HTML", "", "html"],
    ["recording.mp3", "", "audio"],
    ["payload", "application/problem+json", "text"],
    ["archive.zip", "application/zip", "unsupported"],
    ["misleading.json", "application/pdf", "pdf"],
    ["misleading.pdf", "application/zip", "unsupported"],
  ])("classifies %s (%s) as %s", (name, mimeType, expected) => {
    expect(filePreviewKind({ name, mimeType })).toBe(expected);
  });
  it("rejects binary and invalid UTF-8 data", () => {
    expect(() => decodeFilePreviewText(new Uint8Array([65, 0, 66]))).toThrow("binary");
    expect(() => decodeFilePreviewText(new Uint8Array([255]))).toThrow("UTF-8");
  });
  it("does not corrupt a multi-byte character at the preview boundary", () => {
    const bytes = new Uint8Array(FILE_TEXT_PREVIEW_MAX_BYTES + 1).fill(97);
    bytes[FILE_TEXT_PREVIEW_MAX_BYTES - 1] = 0xe2;
    bytes[FILE_TEXT_PREVIEW_MAX_BYTES] = 0x82;
    const preview = decodeFilePreviewText(bytes);
    expect(preview.truncated).toBe(true);
    expect(preview.text.endsWith("�")).toBe(false);
    expect(preview.text.length).toBe(FILE_TEXT_PREVIEW_MAX_BYTES - 1);
  });
});
