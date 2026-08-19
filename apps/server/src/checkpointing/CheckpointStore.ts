/**
 * CheckpointStore - Repository interface for filesystem-backed workspace checkpoints.
 *
 * Owns hidden Git-ref checkpoint capture/restore and diff computation for a
 * workspace thread timeline. It does not store user-facing checkpoint metadata
 * and does not coordinate provider conversation rollback.
 *
 * The live adapter resolves the active VCS driver once per checkpoint operation
 * and delegates to the driver's optional checkpoint capability.
 *
 * Uses Effect `Context.Service` for dependency injection and exposes typed
 * domain errors for checkpoint storage operations.
 *
 * @module CheckpointStore
 */
import {
  VcsProcessExitError,
  VcsUnsupportedOperationError,
  type CheckpointRef,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { CheckpointStoreError } from "./Errors.ts";
import type { VcsCheckpointOps } from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { SandboxRuntimeManager } from "../sandbox/SandboxRuntimeManager.ts";

export type CheckpointExecutionTarget =
  | { readonly kind: "legacy-host" }
  | { readonly kind: "unavailable"; readonly threadId: ThreadId; readonly detail: string }
  | {
      readonly kind: "sandbox";
      readonly threadId: ThreadId;
      readonly runtime: "docker" | "podman";
    };

export function checkpointExecutionTargetForThread(thread: {
  readonly id: ThreadId;
  readonly sandbox?:
    | {
        readonly runtime?: "docker" | "podman" | "microvm" | undefined;
        readonly lifecycle?: string;
      }
    | null
    | undefined;
}): CheckpointExecutionTarget {
  if (
    thread.sandbox?.lifecycle === "ready" &&
    (thread.sandbox.runtime === "docker" || thread.sandbox.runtime === "podman")
  ) {
    return {
      kind: "sandbox",
      threadId: thread.id,
      runtime: thread.sandbox.runtime,
    };
  }
  if (thread.sandbox != null) {
    return {
      kind: "unavailable",
      threadId: thread.id,
      detail: `Sandbox checkpoint target is ${thread.sandbox.lifecycle ?? "unknown"}/${thread.sandbox.runtime ?? "unknown"}.`,
    };
  }
  return { kind: "legacy-host" };
}

type TargetedInput = { readonly target?: CheckpointExecutionTarget };
const SANDBOX_WORKSPACE_CWD = "/workspace/repo";

export interface CaptureCheckpointInput extends TargetedInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
}

export interface RestoreCheckpointInput extends TargetedInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  readonly fallbackToHead?: boolean;
}

export interface DiffCheckpointsInput extends TargetedInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly fallbackFromToHead?: boolean;
  readonly ignoreWhitespace: boolean;
}

export interface DeleteCheckpointRefsInput extends TargetedInput {
  readonly cwd: string;
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

/** Service tag for checkpoint persistence and restore operations. */
export class CheckpointStore extends Context.Service<
  CheckpointStore,
  {
    /** Check whether cwd is inside a Git worktree. */
    readonly isGitRepository: (cwd: string) => Effect.Effect<boolean, CheckpointStoreError>;

    /**
     * Capture a checkpoint commit and store it at the provided checkpoint ref.
     *
     * Uses an isolated temporary Git index and writes a hidden ref.
     */
    readonly captureCheckpoint: (
      input: CaptureCheckpointInput,
    ) => Effect.Effect<void, CheckpointStoreError>;

    /** Check whether a checkpoint ref exists. */
    readonly hasCheckpointRef: (
      input: Omit<RestoreCheckpointInput, "fallbackToHead">,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    /**
     * Restore workspace and staging state to a checkpoint.
     *
     * Optionally falls back to current `HEAD` when the checkpoint ref is missing.
     */
    readonly restoreCheckpoint: (
      input: RestoreCheckpointInput,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    /**
     * Compute a patch diff between two checkpoint refs.
     *
     * Can optionally treat a missing "from" ref as `HEAD`.
     */
    readonly diffCheckpoints: (
      input: DiffCheckpointsInput,
    ) => Effect.Effect<string, CheckpointStoreError>;

    /**
     * Delete the provided checkpoint refs.
     *
     * Best-effort delete: missing refs are tolerated.
     */
    readonly deleteCheckpointRefs: (
      input: DeleteCheckpointRefsInput,
    ) => Effect.Effect<void, CheckpointStoreError>;
  }
>()("@awtprod/command-center/checkpointing/CheckpointStore") {}

export const make = Effect.gen(function* () {
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const sandboxRuntime = yield* SandboxRuntimeManager;
  const randomUUID = (yield* Crypto.Crypto).randomUUIDv4;

  const sandboxGit = Effect.fn("CheckpointStore.sandboxGit")(function* (
    target: Extract<CheckpointExecutionTarget, { kind: "sandbox" }>,
    _cwd: string,
    args: ReadonlyArray<string>,
    options?: { readonly env?: Readonly<Record<string, string>>; readonly allowNonZero?: boolean },
  ) {
    const cwd = SANDBOX_WORKSPACE_CWD;
    if (sandboxRuntime.exec === undefined) {
      return yield* new VcsProcessExitError({
        operation: "CheckpointStore.sandboxGit",
        command: "git",
        cwd,
        exitCode: 1,
        detail: "Sandbox command execution is unavailable.",
      });
    }
    const result = yield* sandboxRuntime
      .exec(target.runtime, target.threadId, {
        executable: "git",
        args,
        cwd,
        ...(options?.env === undefined ? {} : { env: options.env }),
        // Without this the backend throws on any non-zero exit and the
        // `allowNonZero` branch below is unreachable -- so a `rev-parse` probe
        // for an absent ref failed the turn instead of answering "no".
        ...(options?.allowNonZero === true ? { allowNonZeroExit: true } : {}),
        timeoutMs: 30_000,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new VcsProcessExitError({
              operation: "CheckpointStore.sandboxGit",
              command: "git",
              cwd,
              exitCode: 1,
              detail: cause.message,
            }),
        ),
      );
    if (result.exitCode !== 0 && options?.allowNonZero !== true) {
      return yield* new VcsProcessExitError({
        operation: "CheckpointStore.sandboxGit",
        command: "git",
        cwd,
        exitCode: result.exitCode,
        detail: result.stderr.trim() || `git ${args[0] ?? "command"} failed`,
      });
    }
    return result;
  });

  const resolveSandboxCommit = (
    target: Extract<CheckpointExecutionTarget, { kind: "sandbox" }>,
    cwd: string,
    ref: string,
  ) =>
    sandboxGit(target, cwd, ["rev-parse", "--verify", `${ref}^{commit}`], {
      allowNonZero: true,
    }).pipe(Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() || null : null)));

  const sandboxCapture = Effect.fn("CheckpointStore.sandboxCapture")(function* (
    target: Extract<CheckpointExecutionTarget, { kind: "sandbox" }>,
    input: CaptureCheckpointInput,
  ) {
    const gitDir = (yield* sandboxGit(target, SANDBOX_WORKSPACE_CWD, [
      "rev-parse",
      "--git-common-dir",
    ])).stdout.trim();
    const uuid = yield* randomUUID.pipe(
      Effect.mapError(
        (cause) =>
          new VcsProcessExitError({
            operation: "CheckpointStore.captureCheckpoint",
            command: "git",
            cwd: SANDBOX_WORKSPACE_CWD,
            exitCode: 1,
            detail: cause.message,
          }),
      ),
    );
    const index = `${gitDir.startsWith("/") ? gitDir : `${SANDBOX_WORKSPACE_CWD}/${gitDir}`}/t3-checkpoint-index-${uuid}`;
    const env = {
      GIT_INDEX_FILE: index,
      GIT_AUTHOR_NAME: "Command Center",
      GIT_AUTHOR_EMAIL: "command-center@example.com",
      GIT_COMMITTER_NAME: "Command Center",
      GIT_COMMITTER_EMAIL: "command-center@example.com",
    };
    yield* Effect.gen(function* () {
      const head = yield* resolveSandboxCommit(target, input.cwd, "HEAD");
      if (head !== null) yield* sandboxGit(target, input.cwd, ["read-tree", "HEAD"], { env });
      yield* sandboxGit(target, input.cwd, ["add", "-A", "--", "."], { env });
      const tree = (yield* sandboxGit(target, input.cwd, ["write-tree"], { env })).stdout.trim();
      const commit = (yield* sandboxGit(
        target,
        input.cwd,
        ["commit-tree", tree, "-m", `t3 checkpoint ref=${input.checkpointRef}`],
        { env },
      )).stdout.trim();
      yield* sandboxGit(target, input.cwd, ["update-ref", input.checkpointRef, commit]);
    }).pipe(
      Effect.ensuring(
        sandboxRuntime.exec!(target.runtime, target.threadId, {
          executable: "rm",
          args: ["-f", "--", index],
          cwd: SANDBOX_WORKSPACE_CWD,
          timeoutMs: 5_000,
        }).pipe(Effect.ignore),
      ),
    );
  });

  const resolveCheckpoints = Effect.fn("CheckpointStore.resolveCheckpoints")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* vcsRegistry.resolve({ cwd });
    if (!handle.driver.checkpoints) {
      return yield* new VcsUnsupportedOperationError({
        operation,
        kind: handle.kind,
        detail: `${handle.kind} driver does not implement checkpoint operations.`,
      });
    }
    return handle.driver.checkpoints satisfies VcsCheckpointOps;
  });

  const rejectUnavailable = (target: CheckpointExecutionTarget | undefined, cwd: string) =>
    target?.kind === "unavailable"
      ? Effect.fail(
          new VcsProcessExitError({
            operation: "CheckpointStore.resolveTarget",
            command: "git",
            cwd,
            exitCode: 1,
            detail: target.detail,
          }),
        )
      : Effect.void;

  const isGitRepository: CheckpointStore["Service"]["isGitRepository"] = (cwd) =>
    vcsRegistry
      .detect({ cwd, requestedKind: "git" })
      .pipe(Effect.map((repository) => repository !== null));

  const captureCheckpoint: CheckpointStore["Service"]["captureCheckpoint"] = Effect.fn(
    "captureCheckpoint",
  )(function* (input) {
    yield* rejectUnavailable(input.target, input.cwd);
    if (input.target?.kind === "sandbox") return yield* sandboxCapture(input.target, input);
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.captureCheckpoint", input.cwd);
    return yield* checkpoints.captureCheckpoint(input);
  });

  const hasCheckpointRef: CheckpointStore["Service"]["hasCheckpointRef"] = Effect.fn(
    "hasCheckpointRef",
  )(function* (input) {
    yield* rejectUnavailable(input.target, input.cwd);
    if (input.target?.kind === "sandbox") {
      return (yield* resolveSandboxCommit(input.target, input.cwd, input.checkpointRef)) !== null;
    }
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.hasCheckpointRef", input.cwd);
    return yield* checkpoints.hasCheckpointRef(input);
  });

  const restoreCheckpoint: CheckpointStore["Service"]["restoreCheckpoint"] = Effect.fn(
    "restoreCheckpoint",
  )(function* (input) {
    yield* rejectUnavailable(input.target, input.cwd);
    if (input.target?.kind === "sandbox") {
      let commit = yield* resolveSandboxCommit(input.target, input.cwd, input.checkpointRef);
      if (commit === null && input.fallbackToHead === true)
        commit = yield* resolveSandboxCommit(input.target, input.cwd, "HEAD");
      if (commit === null) return false;
      yield* sandboxGit(input.target, input.cwd, [
        "restore",
        "--source",
        commit,
        "--worktree",
        "--staged",
        "--",
        ".",
      ]);
      yield* sandboxGit(input.target, input.cwd, ["clean", "-fd", "--", "."]);
      if ((yield* resolveSandboxCommit(input.target, input.cwd, "HEAD")) !== null)
        yield* sandboxGit(input.target, input.cwd, ["reset", "--quiet", "--", "."]);
      return true;
    }
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.restoreCheckpoint", input.cwd);
    return yield* checkpoints.restoreCheckpoint(input);
  });

  const diffCheckpoints: CheckpointStore["Service"]["diffCheckpoints"] = Effect.fn(
    "diffCheckpoints",
  )(function* (input) {
    yield* rejectUnavailable(input.target, input.cwd);
    if (input.target?.kind === "sandbox") {
      let from: string = input.fromCheckpointRef;
      if (
        input.fallbackFromToHead === true &&
        (yield* resolveSandboxCommit(input.target, input.cwd, from)) === null
      ) {
        const head = yield* resolveSandboxCommit(input.target, input.cwd, "HEAD");
        if (head === null)
          return yield* new VcsProcessExitError({
            operation: "CheckpointStore.diffCheckpoints",
            command: "git diff",
            cwd: input.cwd,
            exitCode: 1,
            detail: "Checkpoint ref is unavailable for diff operation.",
          });
        from = head;
      }
      const result = yield* sandboxGit(
        input.target,
        input.cwd,
        [
          "diff",
          "--patch",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
          `${from}^{commit}`,
          `${input.toCheckpointRef}^{commit}`,
        ],
        { allowNonZero: true },
      );
      if (result.exitCode !== 0)
        return yield* new VcsProcessExitError({
          operation: "CheckpointStore.diffCheckpoints",
          command: "git diff",
          cwd: input.cwd,
          exitCode: result.exitCode,
          detail: result.stderr.trim() || "Checkpoint ref is unavailable for diff operation.",
        });
      return result.stdout;
    }
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.diffCheckpoints", input.cwd);
    return yield* checkpoints.diffCheckpoints(input);
  });

  const deleteCheckpointRefs: CheckpointStore["Service"]["deleteCheckpointRefs"] = Effect.fn(
    "deleteCheckpointRefs",
  )(function* (input) {
    yield* rejectUnavailable(input.target, input.cwd);
    if (input.target?.kind === "sandbox") {
      const target = input.target;
      yield* Effect.forEach(
        input.checkpointRefs,
        (ref) => sandboxGit(target, input.cwd, ["update-ref", "-d", ref], { allowNonZero: true }),
        { discard: true },
      );
      return;
    }
    const checkpoints = yield* resolveCheckpoints(
      "CheckpointStore.deleteCheckpointRefs",
      input.cwd,
    );
    return yield* checkpoints.deleteCheckpointRefs(input);
  });

  return CheckpointStore.of({
    isGitRepository,
    captureCheckpoint,
    hasCheckpointRef,
    restoreCheckpoint,
    diffCheckpoints,
    deleteCheckpointRefs,
  });
});

export const layer = Layer.effect(CheckpointStore, make);
