import type { OrchestrationThread, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export type SandboxExecutionTarget = {
  readonly kind: "sandbox";
  readonly threadId: ThreadId;
  readonly sandboxId: string;
  readonly runtimeRef: string;
  readonly runtime: "docker" | "podman";
  readonly workspaceCwd: string;
};

export type LegacyHostExecutionTarget = {
  readonly kind: "legacy-host";
  readonly cwd: string;
};

export type ProviderExecutionTarget = SandboxExecutionTarget | LegacyHostExecutionTarget;

export class ThreadSandboxNotReadyError extends Schema.TaggedErrorClass<ThreadSandboxNotReadyError>()(
  "ThreadSandboxNotReadyError",
  { threadId: Schema.String, detail: Schema.String },
) {}

export interface ThreadSandboxRuntimeShape {
  readonly ensureReady: (
    thread: OrchestrationThread,
    legacyCwd: string | undefined,
  ) => Effect.Effect<ProviderExecutionTarget, ThreadSandboxNotReadyError>;
}

const defaultRuntime: ThreadSandboxRuntimeShape = {
  ensureReady: Effect.fn("ThreadSandboxRuntime.ensureReady")(function* (thread, legacyCwd) {
    if (thread.sandbox == null) {
      void legacyCwd;
      return yield* new ThreadSandboxNotReadyError({
        threadId: thread.id,
        detail: "Thread has no isolated sandbox; host execution is denied.",
      });
    }
    if (
      thread.sandbox.lifecycle !== "ready" ||
      thread.sandbox.sandboxId === undefined ||
      thread.sandbox.runtimeRef === undefined ||
      (thread.sandbox.runtime !== "docker" && thread.sandbox.runtime !== "podman")
    ) {
      return yield* new ThreadSandboxNotReadyError({
        threadId: thread.id,
        detail: `Sandbox is ${thread.sandbox.lifecycle}, not ready.`,
      });
    }
    if (thread.sandbox.controller.kind === "human") {
      return yield* new ThreadSandboxNotReadyError({
        threadId: thread.id,
        detail: "Sandbox is controlled by an active human takeover lease.",
      });
    }
    return {
      kind: "sandbox",
      threadId: thread.id,
      sandboxId: thread.sandbox.sandboxId,
      runtimeRef: thread.sandbox.runtimeRef,
      runtime: thread.sandbox.runtime,
      workspaceCwd: "/workspace/repo",
    } as const;
  }),
};

/** Injectable now; server composition can replace this reference with the backend-backed runtime. */
export class ThreadSandboxRuntime extends Context.Reference<ThreadSandboxRuntimeShape>(
  "@awtprod/command-center/sandbox/ThreadSandboxRuntime",
  { defaultValue: () => defaultRuntime },
) {}
