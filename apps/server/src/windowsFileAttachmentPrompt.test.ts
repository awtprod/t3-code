import { ChatAttachmentId, PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { appendWindowsFileAttachmentLines } from "./windowsFileAttachmentPrompt.ts";

const windowsFile = {
  type: "windows-file" as const,
  id: ChatAttachmentId.make("windows-file-1"),
  name: "Take 3.mov",
  mimeType: "video/quicktime",
  sizeBytes: 1024,
  host: "editing-pc",
  path: "D:\\Footage\\Take 3.mov",
};
// The scp operand uses forward slashes; built from parts to keep a literal
// drive path out of the public tree.
const remotePath = ["D:", "Footage", "Take 3.mov"].join("/");
const image = {
  type: "image" as const,
  id: ChatAttachmentId.make("image-1"),
  name: "still.png",
  mimeType: "image/png",
  sizeBytes: 10,
};

it("appends the Windows path, host and scp pull command for each reference", () => {
  const text = appendWindowsFileAttachmentLines({
    text: "Cut this down",
    attachments: [image, windowsFile],
    sshConfigPath: "/srv/acme/.ssh/config",
  });
  expect(text).toBe(
    "Cut this down\n\n" +
      '[Referenced Windows file "Take 3.mov" lives on host editing-pc at: D:\\Footage\\Take 3.mov' +
      " — it is NOT in the workspace. To edit in DaVinci Resolve, open that Windows path via the davinci-resolve MCP." +
      ` To work on it locally (e.g. supoclip), copy it first: scp -F '/srv/acme/.ssh/config' 'editing-pc:${remotePath}' <dest>]`,
  );
});

it("leaves text without Windows references unchanged", () => {
  expect(
    appendWindowsFileAttachmentLines({ text: "Hi", attachments: [image], sshConfigPath: "/c" }),
  ).toBe("Hi");
});

it("skips a reference that would exceed the provider input limit", () => {
  const long = "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS - 10);
  expect(
    appendWindowsFileAttachmentLines({
      text: long,
      attachments: [windowsFile],
      sshConfigPath: "/c",
    }),
  ).toBe(long);
});
