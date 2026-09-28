import type { QueuedThreadMessage } from "./thread-outbox";
import { threadOutboxRevision, updateThreadOutboxMessage } from "./thread-outbox";
import { getComposerDraftSnapshot, sameComposerDraftState } from "./use-composer-drafts";

type PendingTaskEditorWriteResult =
  | {
      readonly status: "complete";
      readonly updated: boolean;
      readonly nextRevision: number;
    }
  | {
      readonly status: "failed";
      readonly error: unknown;
      readonly nextRevision: number;
    };

const pendingWrites = new Map<
  QueuedThreadMessage["messageId"],
  Promise<PendingTaskEditorWriteResult>
>();

/**
 * Captures this editor's outbox revision and any editor save it must follow.
 * The returned promise keeps that predecessor even after its map entry clears.
 */
export function capturePendingTaskEditorWriteBaseline(
  messageId: QueuedThreadMessage["messageId"],
): Promise<number> {
  const capturedRevision = threadOutboxRevision(messageId);
  const predecessor = pendingWrites.get(messageId);
  if (!predecessor) {
    return Promise.resolve(capturedRevision);
  }
  return predecessor.then(
    ({ nextRevision }) => Math.max(capturedRevision, nextRevision),
    () => capturedRevision,
  );
}

/**
 * Saves one dismissed editor after its captured predecessor. A true result
 * means both the outbox write and this editor's draft snapshot still match.
 */
export function flushPendingTaskEditorWrite(input: {
  readonly message: QueuedThreadMessage;
  readonly baseline: Promise<number>;
  readonly draftKey: string;
}): Promise<boolean> {
  const { message } = input;
  const draftSnapshot = getComposerDraftSnapshot(input.draftKey);
  const write = input.baseline.then(
    async (expectedRevision): Promise<PendingTaskEditorWriteResult> => {
      try {
        const updated = await updateThreadOutboxMessage(message, expectedRevision);
        return {
          status: "complete",
          updated,
          nextRevision: expectedRevision + (updated ? 1 : 0),
        };
      } catch (error) {
        // The manager reserves its revision before the durable write so a
        // concurrent cleanup cannot win while persistence is in flight. Keep
        // that monotonic reservation even when the write fails, allowing a
        // later editor save to retry from the handed-off revision.
        return {
          status: "failed",
          error,
          nextRevision: expectedRevision + 1,
        };
      }
    },
  );

  pendingWrites.set(message.messageId, write);
  const removeWrite = (): void => {
    if (pendingWrites.get(message.messageId) === write) {
      pendingWrites.delete(message.messageId);
    }
  };
  void write.then(removeWrite, removeWrite);

  return write.then((result) => {
    if (result.status === "failed") {
      throw result.error;
    }
    return (
      result.updated &&
      sameComposerDraftState(draftSnapshot, getComposerDraftSnapshot(input.draftKey))
    );
  });
}
