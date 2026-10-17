import {
  ChatAttachmentId,
  type ChatImageAttachment,
  type MessageId,
  PersistChatAttachmentsError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  attachmentRelativePath,
  chatAttachmentStableKey,
  createDeterministicAttachmentId,
} from "./attachmentStore.ts";
import * as ServerConfig from "./config.ts";
import { parseBase64DataUrl } from "./imageMime.ts";

/** An image a client (or a Command Center Run) sends inline as a data URL. */
export interface InlineImageAttachment {
  readonly type: "image";
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly dataUrl: string;
}

/**
 * Writes inline images into the thread's attachment store and returns their
 * persisted references. The one implementation behind the WS
 * `assets.persistChatAttachments` RPC and Command Center Run launches.
 *
 * Each payload must be a base64 data URL whose MIME type and decoded size
 * match the declared ones. Ids are deterministic per thread, message, index
 * and bytes, so a retried persist rewrites the same file.
 */
export const persistInlineImageAttachments = Effect.fn("attachments.persistInlineImages")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly attachments: ReadonlyArray<InlineImageAttachment>;
  }) {
    if (input.attachments.length === 0) return [] as ReadonlyArray<ChatImageAttachment>;
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* Effect.forEach(
      input.attachments.map((attachment, index) => ({ attachment, index })),
      Effect.fn("attachments.persistInlineImage")(function* ({ attachment, index }) {
        const parsed = parseBase64DataUrl(attachment.dataUrl);
        if (parsed === null || parsed.mimeType !== attachment.mimeType.toLowerCase()) {
          return yield* new PersistChatAttachmentsError({
            message: `Attachment ${attachment.name} has an invalid image payload.`,
          });
        }
        const bytes = yield* Effect.fromResult(Base64.decode(parsed.base64)).pipe(
          Effect.mapError(
            (cause) =>
              new PersistChatAttachmentsError({
                message: `Attachment ${attachment.name} is not valid base64.`,
                cause,
              }),
          ),
        );
        if (bytes.byteLength !== attachment.sizeBytes) {
          return yield* new PersistChatAttachmentsError({
            message: `Attachment ${attachment.name} size does not match its payload.`,
          });
        }
        const rawId = createDeterministicAttachmentId(
          input.threadId,
          chatAttachmentStableKey(input.messageId, index, bytes),
        );
        if (rawId === null) {
          return yield* new PersistChatAttachmentsError({
            message: "Could not allocate an attachment identifier.",
          });
        }
        const persisted: ChatImageAttachment = {
          type: "image",
          id: ChatAttachmentId.make(rawId),
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
        };
        const relativePath = attachmentRelativePath(persisted);
        if (relativePath === null) {
          return yield* new PersistChatAttachmentsError({
            message: `Could not place attachment ${attachment.name}.`,
          });
        }
        yield* fileSystem.writeFile(path.join(config.attachmentsDir, relativePath), bytes).pipe(
          Effect.mapError(
            (cause) =>
              new PersistChatAttachmentsError({
                message: `Could not persist attachment ${attachment.name}.`,
                cause,
              }),
          ),
        );
        return persisted;
      }),
      { concurrency: 2 },
    );
  },
);
