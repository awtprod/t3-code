// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ThreadId, type VcsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import { describe, expect } from "vite-plus/test";

import { checkpointRefForThreadTurn } from "./Utils.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ServerConfig from "../config.ts";
import {
  SandboxRuntimeManager,
  type SandboxRuntimeManagerShape,
} from "../sandbox/SandboxRuntimeManager.ts";
import type { SandboxExecInput } from "../sandbox/types.ts";

const ServerConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-checkpoint-store-test-",
});
const VcsProcessTestLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const VcsDriverTestLayer = VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcessTestLayer));
const CheckpointStoreTestLayer = CheckpointStore.layer.pipe(
  Layer.provideMerge(VcsDriverTestLayer),
  Layer.provideMerge(
    Layer.succeed(SandboxRuntimeManager, {} as unknown as SandboxRuntimeManagerShape),
  ),
  Layer.provideMerge(NodeServices.layer),
);
const TestLayer = CheckpointStoreTestLayer.pipe(
  Layer.provideMerge(VcsProcessTestLayer),
  Layer.provideMerge(VcsDriverTestLayer),
  Layer.provideMerge(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);

function makeTmpDir(
  prefix = "checkpoint-store-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });
}

function writeTextFile(
  filePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(filePath, contents);
  });
}

function git(
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, VcsError, VcsProcess.VcsProcess> {
  return Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    const result = yield* process.run({
      operation: "CheckpointStore.test.git",
      command: "git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });
}

function initRepoWithCommit(
  cwd: string,
): Effect.Effect<
  void,
  VcsError | PlatformError.PlatformError,
  VcsProcess.VcsProcess | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    yield* git(cwd, ["init"]);
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeTextFile(NodePath.join(cwd, "README.md"), "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
  });
}

function buildLargeText(lineCount = 5_000): string {
  return Array.from({ length: lineCount }, (_, index) => `line ${String(index).padStart(5, "0")}`)
    .join("\n")
    .concat("\n");
}

it.layer(TestLayer)("CheckpointStore.layer", (it) => {
  describe("isGitRepository", () => {
    it.effect("returns false when no Git repository is detected", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const checkpointStore = yield* CheckpointStore.CheckpointStore;

        expect(yield* checkpointStore.isGitRepository(tmp)).toBe(false);
      }),
    );

    it.effect("returns true when a Git repository is detected", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;

        expect(yield* checkpointStore.isGitRepository(tmp)).toBe(true);
      }),
    );
  });

  describe("diffCheckpoints", () => {
    it.effect("returns full oversized checkpoint diffs without truncation", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* writeTextFile(NodePath.join(tmp, "README.md"), buildLargeText());
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: true,
        });

        expect(diff).toContain("diff --git");
        expect(diff).not.toContain("[truncated]");
        expect(diff).toContain("+line 04999");
      }),
    );

    it.effect("can hide indentation churn when changes wrap existing lines", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-whitespace");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        const componentPath = NodePath.join(tmp, "Component.tsx");
        yield* writeTextFile(
          componentPath,
          [
            "export function View() {",
            "  return (",
            "    <section>",
            "      <h1>Title</h1>",
            "      <p>Body</p>",
            "    </section>",
            "  );",
            "}",
            "",
          ].join("\n"),
        );
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* writeTextFile(
          componentPath,
          [
            "export function View() {",
            "  return (",
            "    <section>",
            "      {isReady ? (",
            "        <div>",
            "          <h1>Title</h1>",
            "          <p>Body</p>",
            "        </div>",
            "      ) : null}",
            "    </section>",
            "  );",
            "}",
            "",
          ].join("\n"),
        );
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });

        const normalDiff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: false,
        });
        const whitespaceIgnoredDiff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: true,
        });

        expect(normalDiff).toContain("diff --git");
        expect(normalDiff).toContain("-      <h1>Title</h1>");
        expect(normalDiff).toContain("+          <h1>Title</h1>");
        expect(whitespaceIgnoredDiff).toContain("diff --git");
        expect(whitespaceIgnoredDiff).toContain("+      {isReady ? (");
        expect(whitespaceIgnoredDiff).toContain("+        <div>");
        expect(whitespaceIgnoredDiff).not.toContain("-      <h1>Title</h1>");
        expect(whitespaceIgnoredDiff).not.toContain("+          <h1>Title</h1>");
      }),
    );
  });
});

describe("sandbox checkpoint boundary", () => {
  it("fails closed for non-ready and unsupported sandbox targets", () => {
    const threadId = ThreadId.make("sandbox-unavailable-thread");
    expect(
      CheckpointStore.checkpointExecutionTargetForThread({
        id: threadId,
        sandbox: { lifecycle: "ready", runtime: "microvm" },
      }),
    ).toMatchObject({ kind: "unavailable", threadId });
    expect(
      CheckpointStore.checkpointExecutionTargetForThread({
        id: threadId,
        sandbox: { lifecycle: "provisioning", runtime: "docker" },
      }),
    ).toMatchObject({ kind: "unavailable", threadId });
  });

  it.effect("captures and diffs through sandbox exec without addressing host VCS", () => {
    const calls: Array<{ runtime: string; threadId: string; input: SandboxExecInput }> = [];
    const manager = {
      exec: (runtime: "docker" | "podman", threadId: string, input: SandboxExecInput) => {
        return Effect.sync(() => {
          calls.push({ runtime, threadId, input });
          const subcommand = input.args?.[0];
          const stdout =
            subcommand === "write-tree"
              ? "tree123\n"
              : subcommand === "commit-tree"
                ? "commit123\n"
                : subcommand === "diff"
                  ? "diff --git a/file b/file\n"
                  : subcommand === "rev-parse" && input.args?.[1] === "--git-common-dir"
                    ? ".git\n"
                    : "abc123\n";
          return { exitCode: 0, stdout, stderr: "" };
        });
      },
    } as unknown as SandboxRuntimeManagerShape;
    const hostRegistry = VcsDriverRegistry.VcsDriverRegistry.of({
      get: () => Effect.die("host VCS must not be used"),
      detect: () => Effect.die("host filesystem must not be detected"),
      resolve: () => Effect.die("host filesystem must not be resolved"),
    });
    const layer = CheckpointStore.layer.pipe(
      Layer.provide(Layer.succeed(VcsDriverRegistry.VcsDriverRegistry, hostRegistry)),
      Layer.provide(Layer.succeed(SandboxRuntimeManager, manager)),
      Layer.provide(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const store = yield* CheckpointStore.CheckpointStore;
      const threadId = ThreadId.make("sandbox-checkpoint-thread");
      const from = checkpointRefForThreadTurn(threadId, 0);
      const to = checkpointRefForThreadTurn(threadId, 1);
      yield* store.captureCheckpoint({
        cwd: "/tmp/host-worktree-that-must-not-enter-the-sandbox",
        checkpointRef: to,
        target: { kind: "sandbox", threadId, runtime: "podman" },
      });
      const diff = yield* store.diffCheckpoints({
        cwd: "/tmp/host-worktree-that-must-not-enter-the-sandbox",
        fromCheckpointRef: from,
        toCheckpointRef: to,
        ignoreWhitespace: false,
        target: { kind: "sandbox", threadId, runtime: "podman" },
      });

      expect(diff).toContain("diff --git");
      expect(calls.every((call) => call.runtime === "podman" && call.threadId === threadId)).toBe(
        true,
      );
      expect(calls.every((call) => call.input.cwd === "/workspace/repo")).toBe(true);
      expect(
        calls
          .flatMap((call) => [call.input.cwd ?? "", ...(call.input.args ?? [])])
          .some((value) => value.includes("host-worktree-that-must-not-enter-the-sandbox")),
      ).toBe(false);
      const indexPaths = calls
        .flatMap((call) => Object.values(call.input.env ?? {}))
        .filter((value) => value.includes("t3-checkpoint-index-"));
      expect(indexPaths.length).toBeGreaterThan(0);
      expect(
        indexPaths.every((value) => /^\/workspace\/repo\/\.git\/t3-checkpoint-index-/.test(value)),
      ).toBe(true);
      expect(calls.map((call) => call.input.args?.[0])).toEqual([
        "rev-parse",
        "rev-parse",
        "read-tree",
        "add",
        "write-tree",
        "commit-tree",
        "update-ref",
        "-f",
        "diff",
      ]);
    }).pipe(Effect.provide(layer));
  });
});
