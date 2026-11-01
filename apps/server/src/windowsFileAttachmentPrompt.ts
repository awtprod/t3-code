import {
  type ChatAttachment,
  ChatWindowsFileAttachment,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { windowsFileAttachmentPathLine } from "./command-center/WindowsMediaConfig.ts";

const isWindowsFileAttachment = Schema.is(ChatWindowsFileAttachment);

/**
 * Appends one prompt line per `windows-file` reference attachment to the provider-bound text. These
 * carry no local bytes, so the stored attachment path adapters append resolves to nothing; the agent
 * gets the Windows path, its host and the exact scp pull command. A line that would push the prompt
 * past the provider input limit is skipped, like any other attachment context.
 */
export function appendWindowsFileAttachmentLines(input: {
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly sshConfigPath: string;
}): string {
  let text = input.text;
  for (const attachment of input.attachments) {
    if (!isWindowsFileAttachment(attachment)) continue;
    const line = windowsFileAttachmentPathLine({
      name: attachment.name,
      host: attachment.host,
      path: attachment.path,
      sshConfigPath: input.sshConfigPath,
    });
    const candidate = text ? `${text}\n\n${line}` : line;
    if (candidate.length <= PROVIDER_SEND_TURN_MAX_INPUT_CHARS) text = candidate;
  }
  return text;
}

/** The attachments a provider adapter receives: everything but Windows file references. */
export function withoutWindowsFileAttachments(
  attachments: ReadonlyArray<ChatAttachment>,
): ReadonlyArray<ChatAttachment> {
  return attachments.some(isWindowsFileAttachment)
    ? attachments.filter((attachment) => !isWindowsFileAttachment(attachment))
    : attachments;
}
