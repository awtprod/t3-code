// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { withServerSettingsFileLock } from "./serverSettingsFileLock.ts";

const makeSettingsPath = () => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-settings-lock-"));
  return {
    baseDir,
    settingsPath: NodePath.join(baseDir, "userdata", "settings.json"),
  };
};

it.layer(NodeServices.layer)("settings file lock", (it) => {
  it.effect("serializes independent connections across canonical parent aliases", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { baseDir, settingsPath } = makeSettingsPath();
        const enteredFirst = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const enteredSecond = yield* Deferred.make<void>();

        const first = yield* withServerSettingsFileLock(
          settingsPath,
          Deferred.succeed(enteredFirst, undefined).pipe(
            Effect.andThen(Deferred.await(releaseFirst)),
          ),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(enteredFirst);

        const alias = NodePath.join(baseDir, "userdata-alias");
        NodeFS.symlinkSync(NodePath.dirname(settingsPath), alias, "dir");
        const second = yield* withServerSettingsFileLock(
          NodePath.join(alias, "settings.json"),
          Deferred.succeed(enteredSecond, undefined),
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        assert.isFalse(yield* Deferred.isDone(enteredSecond));

        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Fiber.join(first);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("25 millis");
        yield* Deferred.await(enteredSecond);
        yield* Fiber.join(second);
      }),
    ),
  );

  it.effect("releases ownership after failure and interruption", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { settingsPath } = makeSettingsPath();

        yield* withServerSettingsFileLock(settingsPath, Effect.fail("expected")).pipe(Effect.flip);
        yield* withServerSettingsFileLock(settingsPath, Effect.void);

        const entered = yield* Deferred.make<void>();
        const interrupted = yield* withServerSettingsFileLock(
          settingsPath,
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(interrupted);

        yield* withServerSettingsFileLock(settingsPath, Effect.void);
      }),
    ),
  );
});
