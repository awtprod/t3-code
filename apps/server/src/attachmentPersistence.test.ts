import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { MessageId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { persistInlineImageAttachments } from "./attachmentPersistence.ts";
import { attachmentRelativePath } from "./attachmentStore.ts";
import * as ServerConfig from "./config.ts";

// A 1x1 transparent PNG.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const pngBytes = Buffer.from(PNG_BASE64, "base64");
const image = {
  type: "image" as const,
  name: "pixel.png",
  mimeType: "image/png",
  sizeBytes: pngBytes.byteLength,
  dataUrl: `data:image/png;base64,${PNG_BASE64}`,
};
const target = { threadId: ThreadId.make("thread-attachments"), messageId: MessageId.make("m-1") };

const layer = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3code-attachment-persistence-test-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(layer)("persistInlineImageAttachments", (it) => {
  it.effect("writes each image once under a deterministic id", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const first = yield* persistInlineImageAttachments({ ...target, attachments: [image] });
      const again = yield* persistInlineImageAttachments({ ...target, attachments: [image] });
      assert.equal(first.length, 1);
      assert.deepEqual(again, first);
      const stored = yield* fileSystem.readFile(
        path.join(config.attachmentsDir, attachmentRelativePath(first[0]!)!),
      );
      assert.deepEqual(Buffer.from(stored), pngBytes);
      assert.deepEqual(yield* persistInlineImageAttachments({ ...target, attachments: [] }), []);
    }),
  );

  it.effect("rejects a payload whose type or size does not match its declaration", () =>
    Effect.gen(function* () {
      const wrongType = yield* persistInlineImageAttachments({
        ...target,
        attachments: [{ ...image, mimeType: "image/jpeg" }],
      }).pipe(Effect.flip);
      assert.equal(wrongType._tag, "PersistChatAttachmentsError");
      assert.include(wrongType.message, "invalid image payload");
      const wrongSize = yield* persistInlineImageAttachments({
        ...target,
        attachments: [{ ...image, sizeBytes: image.sizeBytes + 1 }],
      }).pipe(Effect.flip);
      assert.include(wrongSize.message, "size does not match");
    }),
  );
});
