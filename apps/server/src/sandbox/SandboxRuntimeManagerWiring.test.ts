// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { checkpointRefForThreadTurn } from "../checkpointing/Utils.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { CheckpointingLayerLive } from "../server.ts";
import { SandboxRuntimeManager, type SandboxRuntimeManagerShape } from "./SandboxRuntimeManager.ts";
import type { SandboxExecInput } from "./types.ts";

describe("SandboxRuntimeManager wiring", () => {
  it.effect("runs checkpoint git through the manager provided at the composition root", () => {
    // The manager holds its per-thread container records in memory, so every
    // consumer must share one instance. `Layer.provide(SandboxRuntimeManagerLive)`
    // inside the checkpointing layer scoped a second, empty manager to the
    // store, and silently -- the tag is a `Context.Reference` with a default, so
    // an unprovided consumer cannot fail the build. Checkpoints then died with
    // "sandbox for thread <id> is not ready" against a ready, mid-turn sandbox.
    //
    // This builds the real `CheckpointingLayerLive` rather than a replica: a
    // copy of the composition would keep passing after a regression in it.
    const calls: Array<SandboxExecInput> = [];
    const rootManager = {
      exec: (_runtime: "docker" | "podman", _threadId: string, input: SandboxExecInput) =>
        Effect.sync(() => {
          calls.push(input);
          const subcommand = input.args?.[0];
          return {
            exitCode: 0,
            stdout:
              subcommand === "write-tree"
                ? "tree123\n"
                : subcommand === "commit-tree"
                  ? "commit123\n"
                  : subcommand === "rev-parse" && input.args?.[1] === "--git-common-dir"
                    ? ".git\n"
                    : "abc123\n",
            stderr: "",
          };
        }),
    } as unknown as SandboxRuntimeManagerShape;

    const threadId = ThreadId.make("sandbox-wiring-thread");
    return Effect.gen(function* () {
      const store = yield* CheckpointStore.CheckpointStore;
      yield* store.captureCheckpoint({
        cwd: "/workspace/repo",
        checkpointRef: checkpointRefForThreadTurn(threadId, 1),
        target: { kind: "sandbox", threadId, runtime: "podman" },
      });
      expect(calls.length).toBeGreaterThan(0);
    }).pipe(
      Effect.provide(
        CheckpointingLayerLive.pipe(
          // Provided outside the layer under test, exactly as server.ts does it.
          Layer.provide(Layer.succeed(SandboxRuntimeManager, rootManager)),
          Layer.provide(
            Layer.succeed(
              ProjectionSnapshotQuery.ProjectionSnapshotQuery,
              {} as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQueryShape,
            ),
          ),
          Layer.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-sandbox-wiring-test-" }),
          ),
          Layer.provide(VcsProcess.layer),
          Layer.provide(NodeServices.layer),
        ),
      ),
      // A checkpoint failure is a test failure here, so surface it as a defect
      // rather than asserting the error channel away.
      Effect.orDie,
    );
  });
});
