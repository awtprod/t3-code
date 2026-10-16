import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as DesktopPreReadyFileSystem from "./DesktopPreReadyFileSystem.ts";
import * as DesktopUserData from "./DesktopUserData.ts";

const resolveWindowsUserData = (appDataDirectory: string) =>
  DesktopUserData.resolveUserDataPath({
    appDataDirectory,
    userDataDirName: "command-center",
    legacyUserDataDirNames: ["t3code", "T3 Code (Alpha)", "Command Center (Alpha)"],
  }).pipe(Effect.provide(DesktopPreReadyFileSystem.layer));

it.layer(NodeServices.layer)("DesktopPreReadyFileSystem", (it) => {
  it.effect("reuses an existing legacy profile in place", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pre-ready-fs-" });
      yield* fileSystem.makeDirectory(path.join(root, "T3 Code (Alpha)"));
      yield* fileSystem.writeFileString(path.join(root, "T3 Code (Alpha)", "Local State"), "keys");

      const userData = yield* resolveWindowsUserData(root);

      assert.equal(userData, path.join(root, "T3 Code (Alpha)"));
      assert.equal(yield* fileSystem.readFileString(path.join(userData, "Local State")), "keys");
    }),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32" || process.getuid?.() === 0)(
    "fails instead of treating an unreadable profile as missing",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pre-ready-fs-" });
        yield* fileSystem.chmod(root, 0o000);
        yield* Effect.addFinalizer(() => fileSystem.chmod(root, 0o700).pipe(Effect.orDie));

        const exit = yield* Effect.exit(resolveWindowsUserData(root));

        assert.isTrue(Exit.isFailure(exit));
      }),
  );
});
