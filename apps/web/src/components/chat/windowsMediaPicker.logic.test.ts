import { ChatAttachment, type CommandCenterWindowsMediaEntry } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  visibleWindowsMediaEntries,
  windowsFileAttachmentFromEntry,
  windowsFileTurnAttachments,
  windowsMediaUpLocation,
  windowsPathBreadcrumbs,
} from "./windowsMediaPicker.logic";

function entry(
  name: string,
  kind: CommandCenterWindowsMediaEntry["kind"],
  overrides: Partial<CommandCenterWindowsMediaEntry> = {},
): CommandCenterWindowsMediaEntry {
  return {
    name,
    path: `C:\\Media\\${name}`,
    isDir: kind === "dir",
    sizeBytes: kind === "dir" ? 0 : 2048,
    mtime: "2026-09-01T10:00:00Z",
    kind,
    mimeType: kind === "video" ? "video/mp4" : "application/octet-stream",
    ...overrides,
  };
}

describe("windowsPathBreadcrumbs", () => {
  it("splits a drive path into navigable crumbs", () => {
    expect(windowsPathBreadcrumbs("C:\\Media\\Clips\\")).toEqual([
      { label: "C:\\", path: "C:\\" },
      { label: "Media", path: "C:\\Media" },
      { label: "Clips", path: "C:\\Media\\Clips" },
    ]);
  });

  it("keeps a UNC server\\share as the first crumb", () => {
    expect(windowsPathBreadcrumbs("\\\\nas\\media\\Clips")).toEqual([
      { label: "\\\\nas\\media", path: "\\\\nas\\media" },
      { label: "Clips", path: "\\\\nas\\media\\Clips" },
    ]);
  });
});

describe("windowsMediaUpLocation", () => {
  it("goes to the parent folder, or back to roots at a drive root", () => {
    expect(windowsMediaUpLocation({ parent: "C:\\Media" })).toEqual({
      kind: "folder",
      path: "C:\\Media",
    });
    expect(windowsMediaUpLocation({ parent: null })).toEqual({ kind: "roots" });
    expect(windowsMediaUpLocation(null)).toEqual({ kind: "roots" });
  });
});

describe("visibleWindowsMediaEntries", () => {
  const entries = [
    entry("b.mp4", "video"),
    entry("notes.txt", "other"),
    entry("Zeta", "dir"),
    entry("a.mov", "video"),
    entry("alpha", "dir"),
  ];

  it("shows folders plus videos only by default, folders first", () => {
    expect(visibleWindowsMediaEntries(entries, false).map((e) => e.name)).toEqual([
      "alpha",
      "Zeta",
      "a.mov",
      "b.mp4",
    ]);
  });

  it("shows every file with the all-files toggle", () => {
    expect(visibleWindowsMediaEntries(entries, true).map((e) => e.name)).toEqual([
      "alpha",
      "Zeta",
      "a.mov",
      "b.mp4",
      "notes.txt",
    ]);
  });
});

describe("draft -> turn mapping", () => {
  it("builds a windows-file reference from a picked entry and sends only the contract shape", () => {
    const picked = windowsFileAttachmentFromEntry({
      id: "wf-1",
      host: "jvl3rp2",
      entry: entry("clip.mp4", "video", { sizeBytes: 5_000_000_000 }),
    });
    expect(picked).toEqual({
      type: "windows-file",
      id: "wf-1",
      name: "clip.mp4",
      mimeType: "video/mp4",
      sizeBytes: 5_000_000_000,
      host: "jvl3rp2",
      path: "C:\\Media\\clip.mp4",
    });

    const withExtra = { ...picked, previewUrl: "blob:nope" } as typeof picked;
    const turn = windowsFileTurnAttachments([withExtra]);
    expect(turn).toEqual([picked]);
    expect("previewUrl" in turn[0]!).toBe(false);
    expect("dataUrl" in turn[0]!).toBe(false);
    // The wire shape decodes as the contract's windows-file member.
    expect(Schema.decodeUnknownSync(ChatAttachment)(turn[0])).toEqual(picked);
  });
});
