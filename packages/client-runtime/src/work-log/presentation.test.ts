import { describe, expect, it } from "vite-plus/test";

import { ThreadId } from "@t3tools/contracts";

import {
  resolveVideoClipAsset,
  resolveViewedImageAsset,
  workEntryVideoPath,
  workEntryViewedImagePath,
} from "./presentation.js";

describe("workEntryViewedImagePath", () => {
  const entry = { label: "Read", tone: "tool" } as const;

  it("returns a single image path from supported read entries", () => {
    expect(
      workEntryViewedImagePath({ ...entry, requestKind: "file-read", detail: " assets/a.png " }),
    ).toBe("assets/a.png");
    expect(
      workEntryViewedImagePath({
        ...entry,
        itemType: "dynamic_tool_call",
        toolTitle: "Read file",
        detail: "C:\\workspace\\a.webp",
      }),
    ).toBe("C:\\workspace\\a.webp");
  });

  it("rejects non-image, multi-line, and non-read details", () => {
    expect(
      workEntryViewedImagePath({ ...entry, itemType: "image_view", detail: "a.txt" }),
    ).toBeNull();
    expect(
      workEntryViewedImagePath({ ...entry, itemType: "image_view", detail: "a.png\nb.png" }),
    ).toBeNull();
    expect(workEntryViewedImagePath({ ...entry, detail: "a.png" })).toBeNull();
  });
});

describe("resolveViewedImageAsset", () => {
  const threadId = ThreadId.make("thread-1");

  it("loads t3 attachment paths as attachments", () => {
    const attachmentId =
      "11111111-1111-4111-8111-111111111111-22222222-2222-4222-8222-222222222222";
    expect(
      resolveViewedImageAsset(`/Users/demo/.t3/dev/attachments/${attachmentId}.png`, {
        threadId,
        workspaceRoot: "/workspace",
      }),
    ).toEqual({
      resource: { _tag: "attachment", attachmentId },
      alt: `${attachmentId}.png`,
      srcFragment: "",
    });
  });

  it("keeps workspace files under similarly named directories as workspace files", () => {
    expect(
      resolveViewedImageAsset("/workspace/dev/attachments/logo.png", {
        threadId,
        workspaceRoot: "/workspace",
      }),
    ).toEqual({
      resource: {
        _tag: "workspace-file",
        threadId,
        path: "/workspace/dev/attachments/logo.png",
      },
      alt: "logo.png",
      srcFragment: "",
    });
  });

  it("normalizes workspace image sources", () => {
    expect(
      resolveViewedImageAsset("screens/logo.svg?v=2#mark", {
        threadId,
        workspaceRoot: "/workspace",
      }),
    ).toEqual({
      resource: {
        _tag: "workspace-file",
        threadId,
        path: "/workspace/screens/logo.svg",
      },
      alt: "logo.svg",
      srcFragment: "#mark",
    });
    expect(resolveViewedImageAsset("https://example.com/logo.png", { threadId })).toBeNull();
  });
});

describe("workEntryVideoPath", () => {
  const tool = { label: "Tool", tone: "tool" } as const;

  it("surfaces videos the agent read or changed", () => {
    expect(
      workEntryVideoPath({ ...tool, requestKind: "file-read", detail: " out/clip.mp4 " }),
    ).toBe("out/clip.mp4");
    expect(
      workEntryVideoPath({
        ...tool,
        itemType: "file_change",
        changedFiles: ["notes.md", "renders/a.webm", "renders/b.mov"],
      }),
    ).toBe("renders/b.mov");
  });

  it("surfaces the output of a completed ffmpeg render", () => {
    const render = {
      ...tool,
      itemType: "command_execution",
      toolLifecycleStatus: "completed",
      command: `cd /work && ffmpeg -y -i "raw/take 1.mov" -vf scale=1080:-2 'out/final clip.mp4' 2>&1 | tail -5`,
    } as const;
    expect(workEntryVideoPath(render)).toBe("out/final clip.mp4");
    expect(workEntryVideoPath({ ...render, toolLifecycleStatus: "inProgress" })).toBeNull();
    expect(workEntryVideoPath({ ...render, toolLifecycleStatus: "failed" })).toBeNull();
    expect(workEntryVideoPath({ ...render, command: "ls out/final.mp4 raw/take.mov" })).toBeNull();
  });

  it("ignores non-video and multi-line entries", () => {
    expect(workEntryVideoPath({ ...tool, requestKind: "file-read", detail: "a.png" })).toBeNull();
    expect(
      workEntryVideoPath({ ...tool, requestKind: "file-read", detail: "a.mp4\nb.mp4" }),
    ).toBeNull();
    expect(workEntryVideoPath({ ...tool, detail: "a.mp4" })).toBeNull();
  });
});

describe("resolveVideoClipAsset", () => {
  const threadId = ThreadId.make("thread-1");

  it("resolves workspace clips to workspace-file resources", () => {
    expect(
      resolveVideoClipAsset("out/clip.mp4", { threadId, workspaceRoot: "/workspace" }),
    ).toEqual({
      resource: { _tag: "workspace-file", threadId, path: "/workspace/out/clip.mp4" },
      name: "clip.mp4",
    });
  });

  it("gives attachment clips an inline video mime", () => {
    const attachmentId =
      "11111111-1111-4111-8111-111111111111-22222222-2222-4222-8222-222222222222";
    expect(
      resolveVideoClipAsset(`/var/lib/t3/userdata/attachments/${attachmentId}.webm`, {
        threadId,
      }),
    ).toEqual({
      resource: {
        _tag: "attachment",
        attachmentId,
        fileName: `${attachmentId}.webm`,
        mimeType: "video/webm",
      },
      name: `${attachmentId}.webm`,
    });
  });

  it("rejects non-video and remote sources", () => {
    expect(resolveVideoClipAsset("out/a.png", { threadId, workspaceRoot: "/w" })).toBeNull();
    expect(resolveVideoClipAsset("https://example.com/a.mp4", { threadId })).toBeNull();
  });
});
