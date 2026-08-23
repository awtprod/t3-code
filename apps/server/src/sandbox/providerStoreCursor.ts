import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProviderSessionDirectoryShape } from "../provider/Services/ProviderSessionDirectory.ts";
import type { SandboxProviderStoreDisposition } from "./types.ts";

/**
 * Reconcile a thread's persisted provider resume cursor with what a provision
 * actually did to the provider's conversation store.
 *
 * Every provisioning entry point routes through here. They used to decide it
 * for themselves and disagreed: one cleared the cursor whenever the store was
 * not restored -- which is also true of a container that SURVIVED and never
 * needed restoring, so a perfectly valid cursor was discarded on re-attach --
 * while the other ignored a failed restore entirely and kept a cursor naming a
 * conversation that no longer existed, failing every following turn with "No
 * conversation found with session ID".
 *
 * Only `unavailable` clears. `preserved` (same container, same provider home)
 * and `restored` (the archive really extracted into a fresh one) both leave the
 * conversation where the cursor points.
 *
 * Best-effort on purpose: if the cursor cannot be cleared the next turn fails
 * exactly the way it does today, so a persistence hiccup here should not also
 * fail the turn that was about to repair the thread.
 */
export const reconcileProviderStoreCursor = (
  directory: ProviderSessionDirectoryShape,
  threadId: ThreadId,
  disposition: SandboxProviderStoreDisposition | undefined,
) =>
  Effect.gen(function* () {
    // Absent means the caller provisioned nothing it can vouch for (an adopted
    // record), which is the same "cannot prove the conversation is there" case
    // as an archive that never arrived.
    if (disposition === "preserved" || disposition === "restored") return;
    const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
    if (binding === undefined || binding.resumeCursor == null) return;
    yield* directory.upsert({ ...binding, resumeCursor: null });
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning(
        "failed to clear the resume cursor for a sandbox with no restored provider store",
        { threadId, cause },
      ),
    ),
  );
