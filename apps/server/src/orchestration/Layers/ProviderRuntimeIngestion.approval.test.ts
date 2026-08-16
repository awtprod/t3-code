import {
  EventId,
  ProviderDriverKind,
  RuntimeRequestId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runtimeEventToActivities } from "./ProviderRuntimeIngestion.ts";

describe("runtimeEventToActivities approval details", () => {
  it("preserves complete multiline command details", () => {
    const detail = `bun run release -- ${"long-argument ".repeat(20)}\nsecond line`;
    const event = {
      type: "request.opened",
      eventId: EventId.make("evt-request-opened"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-07-18T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      requestId: RuntimeRequestId.make("approval-1"),
      payload: {
        requestType: "command_execution_approval",
        detail,
      },
    } satisfies ProviderRuntimeEvent;

    const [activity] = runtimeEventToActivities(event);

    expect(activity?.kind).toBe("approval.requested");
    expect((activity?.payload as Record<string, unknown> | undefined)?.detail).toBe(detail);
  });

  it("gives a sandbox permission request an answerable request kind", () => {
    const event = {
      type: "request.opened",
      eventId: EventId.make("evt-permissions-opened"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-07-18T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      requestId: RuntimeRequestId.make("approval-perm-1"),
      payload: {
        requestType: "permissions_approval",
        detail: "read: /workspace/src",
      },
    } satisfies ProviderRuntimeEvent;

    const [activity] = runtimeEventToActivities(event);
    const payload = activity?.payload as Record<string, unknown> | undefined;

    expect(activity?.kind).toBe("approval.requested");
    // Without a requestKind the web and mobile approval folds never render a
    // prompt, while the server still opens a pending row — the thread parks
    // with no way to answer it.
    expect(payload?.requestKind).toBe("file-change");
    expect(activity?.summary).toBe("Sandbox permission approval requested");
    expect(payload?.detail).toBe("read: /workspace/src");
  });
});
