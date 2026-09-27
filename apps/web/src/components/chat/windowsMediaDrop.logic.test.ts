import type { CommandCenterWindowsMediaEntry } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { routeDroppedFiles, splitWindowsPath } from "./windowsMediaDrop.logic";

function entry(name: string, sizeBytes: number): CommandCenterWindowsMediaEntry {
  return {
    name,
    path: `C:\\Media\\${name}`,
    isDir: false,
    sizeBytes,
    mtime: null,
    kind: "video",
    mimeType: "video/mp4",
  };
}

function fileOfSize(name: string, size: number, type: string): File {
  return new File([new Uint8Array(size)], name, { type });
}

function deps(overrides: Partial<Parameters<typeof routeDroppedFiles>[1]> = {}) {
  let n = 0;
  return {
    enabled: true,
    getPathForFile: (file: File) => `C:\\Media\\${file.name}`,
    listFolder: vi.fn(async () => ({ host: "jvl3rp2", entries: [entry("clip.mp4", 4)] })),
    newId: () => `id-${++n}`,
    ...overrides,
  };
}

describe("splitWindowsPath", () => {
  it("splits folder and name, keeping drive roots absolute", () => {
    expect(splitWindowsPath("C:\\Media\\clip.mp4")).toEqual({
      folder: "C:\\Media",
      name: "clip.mp4",
    });
    expect(splitWindowsPath("C:\\clip.mp4")).toEqual({ folder: "C:\\", name: "clip.mp4" });
  });
});

describe("routeDroppedFiles", () => {
  it("uploads everything when the desktop bridge is absent", async () => {
    const d = deps({ enabled: false });
    const clip = fileOfSize("clip.mp4", 4, "video/mp4");
    const result = await routeDroppedFiles([clip], d);
    expect(result).toEqual({ references: [], uploads: [clip] });
    expect(d.listFolder).not.toHaveBeenCalled();
  });

  it("references a verified video by host and path", async () => {
    const d = deps();
    const result = await routeDroppedFiles([fileOfSize("clip.mp4", 4, "video/mp4")], d);
    expect(d.listFolder).toHaveBeenCalledWith("C:\\Media");
    expect(result.uploads).toEqual([]);
    expect(result.references).toEqual([
      {
        type: "windows-file",
        id: "id-1",
        name: "clip.mp4",
        mimeType: "video/mp4",
        sizeBytes: 4,
        host: "jvl3rp2",
        path: "C:\\Media\\clip.mp4",
      },
    ]);
  });

  it("falls back to upload on a size mismatch", async () => {
    const clip = fileOfSize("clip.mp4", 5, "video/mp4");
    expect(await routeDroppedFiles([clip], deps())).toEqual({ references: [], uploads: [clip] });
  });

  it("falls back when the listing fails or there is no local path", async () => {
    const clip = fileOfSize("clip.mp4", 4, "video/mp4");
    expect(await routeDroppedFiles([clip], deps({ listFolder: vi.fn(async () => null) }))).toEqual({
      references: [],
      uploads: [clip],
    });
    expect(
      await routeDroppedFiles(
        [clip],
        deps({ listFolder: vi.fn(async () => Promise.reject(new Error("ssh down"))) }),
      ),
    ).toEqual({ references: [], uploads: [clip] });
    expect(await routeDroppedFiles([clip], deps({ getPathForFile: () => "" }))).toEqual({
      references: [],
      uploads: [clip],
    });
  });

  it("never references non-video files and routes each file independently", async () => {
    const d = deps();
    const notes = fileOfSize("notes.txt", 4, "text/plain");
    const clip = fileOfSize("clip.mp4", 4, "");
    const result = await routeDroppedFiles([notes, clip], d);
    expect(result.uploads).toEqual([notes]);
    expect(result.references.map((r) => r.path)).toEqual(["C:\\Media\\clip.mp4"]);
    expect(d.listFolder).toHaveBeenCalledTimes(1);
  });
});
