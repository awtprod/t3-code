import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { resolveUserDataPath } from "./DesktopUserData.ts";

const LEGACY_NAMES = ["t3code", "T3 Code (Alpha)", "Command Center (Alpha)"] as const;

it.effect("identifies a failed legacy probe and preserves its cause", () => {
  const legacyPath = "/profiles/t3code";
  const cause = PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method: "exists",
    pathOrDescriptor: legacyPath,
  });
  return Effect.gen(function* () {
    const error = yield* resolveUserDataPath({
      appDataDirectory: "/profiles",
      userDataDirName: "command-center",
      legacyUserDataDirNames: LEGACY_NAMES,
    }).pipe(Effect.flip);
    assert.equal(error.operation, "inspect");
    assert.equal(error.resourcePath, legacyPath);
    assert.equal(error.category, "PermissionDenied");
    assert.strictEqual(error.cause, cause);
  }).pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: () => Effect.fail(cause),
      }),
    ),
    Effect.provide(NodeServices.layer),
  );
});

it.effect("uses the current profile when no legacy profile exists", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cc-profile-" });
    const resolved = yield* resolveUserDataPath({
      appDataDirectory: directory,
      userDataDirName: "command-center",
      legacyUserDataDirNames: LEGACY_NAMES,
    });
    assert.equal(resolved, path.join(directory, "command-center"));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(LEGACY_NAMES)("reuses the existing %s profile in place", (legacyName) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cc-profile-" });
    yield* fs.makeDirectory(path.join(directory, legacyName), { recursive: true });
    const resolved = yield* resolveUserDataPath({
      appDataDirectory: directory,
      userDataDirName: "command-center",
      legacyUserDataDirNames: LEGACY_NAMES,
    });
    assert.equal(resolved, path.join(directory, legacyName));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
