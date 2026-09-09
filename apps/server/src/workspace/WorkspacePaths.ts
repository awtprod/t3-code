/**
 * WorkspacePaths - Effect service contract for workspace path handling.
 *
 * Owns normalization and validation of workspace roots plus safe resolution of
 * workspace-root-relative paths.
 *
 * @module WorkspacePaths
 */
import * as NodeOS from "node:os";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as VcsProcess from "../vcs/VcsProcess.ts";

/** The probe is a liveness check, not real work; it must not hang a create. */
const PROBE_TIMEOUT_MS = 10_000;

export class WorkspaceRootNotExistsError extends Schema.TaggedErrorClass<WorkspaceRootNotExistsError>()(
  "WorkspaceRootNotExistsError",
  {
    workspaceRoot: Schema.String,
    normalizedWorkspaceRoot: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace root does not exist: ${this.normalizedWorkspaceRoot}`;
  }
}

export class WorkspaceRootCreateFailedError extends Schema.TaggedErrorClass<WorkspaceRootCreateFailedError>()(
  "WorkspaceRootCreateFailedError",
  {
    workspaceRoot: Schema.String,
    normalizedWorkspaceRoot: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to create workspace root: ${this.normalizedWorkspaceRoot}`;
  }
}

export class WorkspaceRootStatFailedError extends Schema.TaggedErrorClass<WorkspaceRootStatFailedError>()(
  "WorkspaceRootStatFailedError",
  {
    workspaceRoot: Schema.String,
    normalizedWorkspaceRoot: Schema.String,
    phase: Schema.Literals(["validate-existing", "verify-created"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to stat workspace root '${this.normalizedWorkspaceRoot}' during '${this.phase}'.`;
  }
}

export class WorkspaceRootNotDirectoryError extends Schema.TaggedErrorClass<WorkspaceRootNotDirectoryError>()(
  "WorkspaceRootNotDirectoryError",
  {
    workspaceRoot: Schema.String,
    normalizedWorkspaceRoot: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace root is not a directory: ${this.normalizedWorkspaceRoot}`;
  }
}

export class WorkspacePathOutsideRootError extends Schema.TaggedErrorClass<WorkspacePathOutsideRootError>()(
  "WorkspacePathOutsideRootError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file path must be relative to the project root: ${this.relativePath}`;
  }
}

/**
 * The directory exists, but this server process cannot actually work inside it.
 *
 * Raised while a workspace root is being *chosen* so the operator learns the
 * directory is unusable at the point of the mistake, rather than hours later
 * when a provider turn dies with an opaque "Git status failed".
 *
 * The uids are carried on the error because the dominant cause is a repository
 * created by a human under their own account while the server runs as a
 * dedicated service account; the two numbers are what make that diagnosable.
 */
export class WorkspaceRootUnusableError extends Schema.TaggedErrorClass<WorkspaceRootUnusableError>()(
  "WorkspaceRootUnusableError",
  {
    workspaceRoot: Schema.String,
    normalizedWorkspaceRoot: Schema.String,
    reason: Schema.Literals(["not-readable", "git-untrusted"]),
    detail: Schema.String,
    serverUid: Schema.NullOr(Schema.Number),
    ownerUid: Schema.NullOr(Schema.Number),
  },
) {
  override get message(): string {
    const ownership =
      this.serverUid === null || this.ownerUid === null || this.serverUid === this.ownerUid
        ? ""
        : ` This server runs as uid ${this.serverUid} but the directory is owned by uid ${this.ownerUid}.`;
    return `Workspace root is not usable by this server: ${this.normalizedWorkspaceRoot}.${ownership} ${this.detail}`;
  }
}

export const WorkspacePathsError = Schema.Union([
  WorkspaceRootNotExistsError,
  WorkspaceRootCreateFailedError,
  WorkspaceRootStatFailedError,
  WorkspaceRootNotDirectoryError,
  WorkspaceRootUnusableError,
  WorkspacePathOutsideRootError,
]);
export type WorkspacePathsError = typeof WorkspacePathsError.Type;

/** Service tag for workspace path normalization and resolution. */
export class WorkspacePaths extends Context.Service<
  WorkspacePaths,
  {
    /**
     * Normalize a user-provided workspace root and verify it exists as a directory.
     *
     * With `verifyUsable`, additionally prove this process can actually work in
     * the directory before accepting it. That probe spawns Git, so it is opt-in:
     * interactive directory browsing runs this function on every keystroke and
     * must stay a bare `stat`. Enable it on the paths that *commit* to a
     * workspace root (project create / update), where one subprocess is cheap
     * relative to being wrong.
     */
    readonly normalizeWorkspaceRoot: (
      workspaceRoot: string,
      options?: { readonly createIfMissing?: boolean; readonly verifyUsable?: boolean },
    ) => Effect.Effect<
      string,
      | WorkspaceRootNotExistsError
      | WorkspaceRootCreateFailedError
      | WorkspaceRootStatFailedError
      | WorkspaceRootNotDirectoryError
      | WorkspaceRootUnusableError
    >;
    /**
     * Resolve a relative path within a validated workspace root.
     *
     * Rejects absolute paths and traversal attempts outside the workspace root.
     */
    readonly resolveRelativePathWithinRoot: (input: {
      workspaceRoot: string;
      relativePath: string;
    }) => Effect.Effect<
      { absolutePath: string; relativePath: string },
      WorkspacePathOutsideRootError
    >;
  }
>()("@awtprod/command-center/workspace/WorkspacePaths") {}

function toPosixRelativePath(input: string): string {
  return input.replaceAll("\\", "/");
}

function expandHomePath(input: string, path: Path.Path): string {
  if (input === "~") {
    return NodeOS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(NodeOS.homedir(), input.slice(2));
  }
  return input;
}

/**
 * Recognize Git's refusal to operate on a directory it does not trust.
 *
 * Git reports this on stderr and exits non-zero; there is no machine-readable
 * code for it, so the wording is the only signal available. Both the modern
 * ("detected dubious ownership") and older ("unsafe repository") phrasings are
 * matched.
 */
function isGitOwnershipRefusal(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes("detected dubious ownership") ||
    normalized.includes("unsafe repository") ||
    normalized.includes("safe.directory")
  );
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsProcess = yield* VcsProcess.VcsProcess;

  const statWorkspaceRoot = Effect.fn("WorkspacePaths.statWorkspaceRoot")(function* (
    workspaceRoot: string,
    normalizedWorkspaceRoot: string,
    phase: WorkspaceRootStatFailedError["phase"],
  ) {
    return yield* fileSystem.stat(normalizedWorkspaceRoot).pipe(
      Effect.matchEffect({
        onFailure: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(null)
            : Effect.fail(
                new WorkspaceRootStatFailedError({
                  workspaceRoot,
                  normalizedWorkspaceRoot,
                  phase,
                  cause,
                }),
              ),
        onSuccess: Effect.succeed,
      }),
    );
  });

  /**
   * Prove this process can actually work in `normalizedWorkspaceRoot`.
   *
   * Cheaper filesystem-only checks are unsound, which is why this spawns Git:
   *
   *   - Comparing the directory's owner against our uid gives false positives.
   *     The Git process boundary trusts this exact workspace for the command,
   *     so an ACL-accessible repo works despite the uid mismatch.
   *   - Checking read access to `.git/*` gives false negatives. Git refuses
   *     untrusted directories even when every file in them is readable.
   *
   * Only Git can answer the question Git will be asked, so ask it — under the
   * same hardened arguments and environment the VCS driver uses, or the probe
   * would be measuring a different command than the one that later runs.
   *
   * A non-repository is deliberately *accepted*: an empty directory is a valid
   * place to start a project. This rejects only unusable directories.
   */
  const verifyWorkspaceRootUsable = Effect.fn("WorkspacePaths.verifyWorkspaceRootUsable")(
    function* (workspaceRoot: string, normalizedWorkspaceRoot: string) {
      const [serverUid, ownerUid] = yield* Effect.all([
        Effect.sync(() => (typeof process.getuid === "function" ? process.getuid() : null)),
        fileSystem.stat(normalizedWorkspaceRoot).pipe(
          Effect.map((info) => Option.getOrNull(info.uid)),
          Effect.orElseSucceed(() => null),
        ),
      ]);

      const failUnusable = (reason: WorkspaceRootUnusableError["reason"], detail: string) =>
        new WorkspaceRootUnusableError({
          workspaceRoot,
          normalizedWorkspaceRoot,
          reason,
          detail,
          serverUid,
          ownerUid,
        });

      // Listing the directory proves we can both traverse and read it. Git
      // would fail here too, but with a far less specific message.
      yield* fileSystem
        .readDirectory(normalizedWorkspaceRoot)
        .pipe(
          Effect.mapError((cause) =>
            failUnusable(
              "not-readable",
              `The directory cannot be read by this process (${cause.reason._tag}).`,
            ),
          ),
        );

      const probe = yield* vcsProcess
        .run({
          operation: "WorkspacePaths.verifyUsable.status",
          command: "git",
          args: ["status", "--porcelain=v2", "--branch"],
          cwd: normalizedWorkspaceRoot,
          allowNonZeroExit: true,
          timeoutMs: PROBE_TIMEOUT_MS,
        })
        .pipe(
          // A probe that cannot run is not evidence the directory is bad; the
          // real command will surface any genuine problem with full context.
          Effect.catchCause(() => Effect.succeed(null)),
        );

      if (probe !== null && probe.exitCode !== 0 && isGitOwnershipRefusal(probe.stderr)) {
        return yield* failUnusable(
          "git-untrusted",
          "Git still refuses to operate here after the server trusted this exact workspace " +
            "for the command. Check that the selected path is the repository root and is " +
            "accessible to the account this server runs as.",
        );
      }
    },
  );

  const normalizeWorkspaceRoot: WorkspacePaths["Service"]["normalizeWorkspaceRoot"] = Effect.fn(
    "WorkspacePaths.normalizeWorkspaceRoot",
  )(function* (workspaceRoot, options) {
    const normalizedWorkspaceRoot = path.resolve(expandHomePath(workspaceRoot.trim(), path));
    let workspaceStat = yield* statWorkspaceRoot(
      workspaceRoot,
      normalizedWorkspaceRoot,
      "validate-existing",
    );
    if (!workspaceStat && options?.createIfMissing) {
      yield* fileSystem.makeDirectory(normalizedWorkspaceRoot, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceRootCreateFailedError({
              workspaceRoot,
              normalizedWorkspaceRoot,
              cause,
            }),
        ),
      );
      workspaceStat = yield* statWorkspaceRoot(
        workspaceRoot,
        normalizedWorkspaceRoot,
        "verify-created",
      );
    }
    if (!workspaceStat) {
      return yield* new WorkspaceRootNotExistsError({
        workspaceRoot,
        normalizedWorkspaceRoot,
      });
    }
    if (workspaceStat.type !== "Directory") {
      return yield* new WorkspaceRootNotDirectoryError({
        workspaceRoot,
        normalizedWorkspaceRoot,
      });
    }
    if (options?.verifyUsable) {
      yield* verifyWorkspaceRootUsable(workspaceRoot, normalizedWorkspaceRoot);
    }
    return normalizedWorkspaceRoot;
  });

  const resolveRelativePathWithinRoot: WorkspacePaths["Service"]["resolveRelativePathWithinRoot"] =
    Effect.fn("WorkspacePaths.resolveRelativePathWithinRoot")(function* (input) {
      const normalizedInputPath = input.relativePath.trim();
      if (path.isAbsolute(normalizedInputPath)) {
        return yield* new WorkspacePathOutsideRootError({
          workspaceRoot: input.workspaceRoot,
          relativePath: input.relativePath,
        });
      }

      const absolutePath = path.resolve(input.workspaceRoot, normalizedInputPath);
      const relativeToRoot = toPosixRelativePath(path.relative(input.workspaceRoot, absolutePath));
      if (
        relativeToRoot.length === 0 ||
        relativeToRoot === "." ||
        relativeToRoot.startsWith("../") ||
        relativeToRoot === ".." ||
        path.isAbsolute(relativeToRoot)
      ) {
        return yield* new WorkspacePathOutsideRootError({
          workspaceRoot: input.workspaceRoot,
          relativePath: input.relativePath,
        });
      }

      return {
        absolutePath,
        relativePath: relativeToRoot,
      };
    });

  return WorkspacePaths.of({ normalizeWorkspaceRoot, resolveRelativePathWithinRoot });
});

/**
 * `VcsProcess` is provided internally rather than required from callers: every
 * existing call site already supplies the Node platform services it needs, and
 * leaving the dependency optional would let the probe silently degrade to a
 * no-op — reintroducing exactly the quiet failure this check exists to remove.
 */
export const layer = Layer.effect(WorkspacePaths, make).pipe(Layer.provide(VcsProcess.layer));
