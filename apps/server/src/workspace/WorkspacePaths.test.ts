import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.fn("makeTempDir")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-project-paths-",
  });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents = "",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

it.layer(TestLayer)("WorkspacePathsLive", (it) => {
  describe("normalizeWorkspaceRoot", () => {
    it.effect("resolves an existing directory", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
        const cwd = yield* makeTempDir();

        const resolved = yield* workspacePaths.normalizeWorkspaceRoot(cwd);

        expect(resolved).toBe(cwd);
      }),
    );

    it.effect("accepts a usable directory when verifyUsable is set", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
        const cwd = yield* makeTempDir();

        const resolved = yield* workspacePaths.normalizeWorkspaceRoot(cwd, {
          verifyUsable: true,
        });

        expect(resolved).toBe(cwd);
      }),
    );

    it.effect("accepts a usable directory that is not a repository", () =>
      Effect.gen(function* () {
        // An empty directory is a legitimate place to start a project, so the
        // probe must reject unusable directories only -- never non-repositories.
        const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
        const cwd = yield* makeTempDir();
        yield* writeTextFile(cwd, "notes.txt", "not a repo");

        const resolved = yield* workspacePaths.normalizeWorkspaceRoot(cwd, {
          verifyUsable: true,
        });

        expect(resolved).toBe(cwd);
      }),
    );

    it.effect("rejects a directory this process cannot read", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* makeTempDir();
        const workspacePaths = yield* WorkspacePaths.make.pipe(
          Effect.provide(VcsProcess.layer),
          Effect.provideService(FileSystem.FileSystem, {
            ...fileSystem,
            readDirectory: (path) =>
              Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "readDirectory",
                  pathOrDescriptor: String(path),
                  description: "Test PermissionDenied readDirectory failure.",
                }),
              ),
          }),
        );

        const error = yield* workspacePaths
          .normalizeWorkspaceRoot(cwd, { verifyUsable: true })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspacePaths.WorkspaceRootUnusableError);
        expect(error).toMatchObject({ reason: "not-readable" });
        expect(error.message).toContain("Workspace root is not usable by this server:");
      }),
    );

    it.effect("skips the probe unless verifyUsable is requested", () =>
      Effect.gen(function* () {
        // Directory browsing calls this on every keystroke, so the default path
        // must never reach the filesystem probe or spawn Git.
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* makeTempDir();
        let readDirectoryCalls = 0;
        const workspacePaths = yield* WorkspacePaths.make.pipe(
          Effect.provide(VcsProcess.layer),
          Effect.provideService(FileSystem.FileSystem, {
            ...fileSystem,
            readDirectory: (path, options) => {
              readDirectoryCalls += 1;
              return fileSystem.readDirectory(path, options);
            },
          }),
        );

        const resolved = yield* workspacePaths.normalizeWorkspaceRoot(cwd);

        expect(resolved).toBe(cwd);
        expect(readDirectoryCalls).toBe(0);
      }),
    );

    it.effect("rejects missing directories", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
        const cwd = yield* makeTempDir();
        const path = yield* Path.Path;

        const error = yield* workspacePaths
          .normalizeWorkspaceRoot(path.join(cwd, "missing"))
          .pipe(Effect.flip);

        expect(error.message).toContain("Workspace root does not exist:");
      }),
    );

    it.effect("creates missing directories when createIfMissing is enabled", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* makeTempDir();
        const path = yield* Path.Path;
        const missingPath = path.join(cwd, "nested", "new-project");

        const resolved = yield* workspacePaths.normalizeWorkspaceRoot(missingPath, {
          createIfMissing: true,
        });
        const stat = yield* fileSystem.stat(resolved);

        expect(resolved).toBe(missingPath);
        expect(stat.type).toBe("Directory");
      }),
    );

    it.effect("rejects file paths", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
        const cwd = yield* makeTempDir();
        const path = yield* Path.Path;
        const filePath = path.join(cwd, "README.md");
        yield* writeTextFile(cwd, "README.md", "# hi\n");

        const error = yield* workspacePaths.normalizeWorkspaceRoot(filePath).pipe(Effect.flip);

        expect(error.message).toContain("Workspace root is not a directory:");
      }),
    );

    it.effect("preserves non-NotFound stat failures while validating the root", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspacePaths = yield* WorkspacePaths.make.pipe(
          Effect.provide(VcsProcess.layer),
          Effect.provideService(FileSystem.FileSystem, {
            ...fileSystem,
            stat: (path) =>
              Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "stat",
                  pathOrDescriptor: String(path),
                  description: "Test PermissionDenied stat failure.",
                }),
              ),
          }),
        );
        const path = yield* Path.Path;
        const workspaceRoot = " ./permission-denied ";
        const normalizedWorkspaceRoot = path.resolve(workspaceRoot.trim());

        const error = yield* workspacePaths.normalizeWorkspaceRoot(workspaceRoot).pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspacePaths.WorkspaceRootStatFailedError);
        expect(error).toMatchObject({
          workspaceRoot,
          normalizedWorkspaceRoot,
          phase: "validate-existing",
        });
      }),
    );

    it.effect("preserves stat failures while verifying a newly created root", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        let statCalls = 0;
        const workspacePaths = yield* WorkspacePaths.make.pipe(
          Effect.provide(VcsProcess.layer),
          Effect.provideService(FileSystem.FileSystem, {
            ...fileSystem,
            stat: (path) => {
              statCalls += 1;
              const reason = statCalls === 1 ? "NotFound" : "PermissionDenied";
              return Effect.fail(
                PlatformError.systemError({
                  _tag: reason,
                  module: "FileSystem",
                  method: "stat",
                  pathOrDescriptor: String(path),
                  description: `Test ${reason} stat failure.`,
                }),
              );
            },
            makeDirectory: () => Effect.void,
          }),
        );
        const path = yield* Path.Path;
        const workspaceRoot = " ./created-then-unreadable ";
        const normalizedWorkspaceRoot = path.resolve(workspaceRoot.trim());

        const error = yield* workspacePaths
          .normalizeWorkspaceRoot(workspaceRoot, { createIfMissing: true })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspacePaths.WorkspaceRootStatFailedError);
        expect(error).toMatchObject({
          workspaceRoot,
          normalizedWorkspaceRoot,
          phase: "verify-created",
        });
      }),
    );
  });

  describe("resolveRelativePathWithinRoot", () => {
    it.effect("resolves relative paths inside the workspace root", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
        const cwd = yield* makeTempDir();
        const path = yield* Path.Path;

        const resolved = yield* workspacePaths.resolveRelativePathWithinRoot({
          workspaceRoot: cwd,
          relativePath: "plans/effect-rpc.md",
        });

        expect(resolved).toEqual({
          absolutePath: path.join(cwd, "plans/effect-rpc.md"),
          relativePath: "plans/effect-rpc.md",
        });
      }),
    );

    it.effect("rejects paths that escape the workspace root", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
        const cwd = yield* makeTempDir();

        const error = yield* workspacePaths
          .resolveRelativePathWithinRoot({
            workspaceRoot: cwd,
            relativePath: "../escape.md",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );
      }),
    );
  });
});
