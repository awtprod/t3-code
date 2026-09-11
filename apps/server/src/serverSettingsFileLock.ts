import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as SqlConnection from "effect/unstable/sql/SqlConnection";

import { makeRuntimeSqliteLayer } from "./persistence/Layers/Sqlite.ts";

const LOCK_ATTEMPTS = 40;
const LOCK_RETRY_DELAY = Duration.millis(25);

export class ServerSettingsFileLockError extends Schema.TaggedErrorClass<ServerSettingsFileLockError>()(
  "ServerSettingsFileLockError",
  {
    settingsPath: Schema.String,
    operation: Schema.Literals(["prepare", "open", "acquire", "commit", "rollback"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not ${this.operation} the settings-file lock for ${this.settingsPath}.`;
  }
}

export class ServerSettingsFileLockBusyError extends Schema.TaggedErrorClass<ServerSettingsFileLockBusyError>()(
  "ServerSettingsFileLockBusyError",
  { settingsPath: Schema.String, attempts: Schema.Number },
) {
  override get message(): string {
    return `Timed out waiting for another settings writer at ${this.settingsPath}.`;
  }
}

const execute = (
  connection: SqlConnection.Connection,
  statement: string,
  settingsPath: string,
  operation: "open" | "acquire" | "commit" | "rollback",
) =>
  connection.executeUnprepared(statement, [], undefined).pipe(
    Effect.asVoid,
    Effect.mapError((cause) => new ServerSettingsFileLockError({ settingsPath, operation, cause })),
  );

const isLockContention = (cause: {
  readonly reason: { readonly _tag: string; readonly cause: unknown };
}) => {
  if (cause.reason._tag === "LockTimeoutError") return true;
  const nativeCause = cause.reason.cause;
  return (
    Predicate.hasProperty(nativeCause, "errcode") &&
    (nativeCause.errcode === 5 || nativeCause.errcode === 6)
  );
};

const acquire = Effect.fn("ServerSettingsFileLock.acquire")(function* (
  connection: SqlConnection.Connection,
  settingsPath: string,
) {
  yield* execute(connection, "PRAGMA busy_timeout = 0", settingsPath, "open");
  for (let attempt = 1; attempt <= LOCK_ATTEMPTS; attempt++) {
    const acquired = yield* connection.executeUnprepared("BEGIN IMMEDIATE", [], undefined).pipe(
      Effect.as(true),
      Effect.catch((cause) =>
        isLockContention(cause)
          ? Effect.succeed(false)
          : Effect.fail(
              new ServerSettingsFileLockError({
                settingsPath,
                operation: "acquire",
                cause,
              }),
            ),
      ),
    );
    if (acquired) return connection;
    if (attempt === LOCK_ATTEMPTS) {
      return yield* new ServerSettingsFileLockBusyError({
        settingsPath,
        attempts: LOCK_ATTEMPTS,
      });
    }
    yield* Effect.sleep(LOCK_RETRY_DELAY).pipe(Effect.interruptible);
  }
  return connection;
});

/**
 * Serializes cooperating settings writers with an adjacent SQLite database.
 * The canonical parent plus basename identifies the directory entry without
 * resolving a supported settings-file symlink. SQLite owns crash-time release;
 * the explicit transaction cleanup covers ordinary failure and interruption.
 */
export const withServerSettingsFileLock = <A, E, R>(
  settingsPath: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<
  A,
  E | ServerSettingsFileLockError | ServerSettingsFileLockBusyError,
  R | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const absolutePath = path.resolve(settingsPath);
    const parent = path.dirname(absolutePath);
    yield* fs
      .makeDirectory(parent, { recursive: true })
      .pipe(
        Effect.mapError(
          (cause) => new ServerSettingsFileLockError({ settingsPath, operation: "prepare", cause }),
        ),
      );
    const canonicalParent = yield* fs
      .realPath(parent)
      .pipe(
        Effect.mapError(
          (cause) => new ServerSettingsFileLockError({ settingsPath, operation: "prepare", cause }),
        ),
      );
    const canonicalSettingsPath = path.join(canonicalParent, path.basename(absolutePath));
    const lockPath = `${canonicalSettingsPath}.lock.sqlite`;

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const connection = yield* sql.reserve.pipe(
          Effect.mapError(
            (cause) => new ServerSettingsFileLockError({ settingsPath, operation: "open", cause }),
          ),
        );
        return yield* Effect.acquireUseRelease(
          acquire(connection, settingsPath),
          () => effect,
          (heldConnection, exit) =>
            execute(
              heldConnection,
              Exit.isSuccess(exit) ? "COMMIT" : "ROLLBACK",
              settingsPath,
              Exit.isSuccess(exit) ? "commit" : "rollback",
            ),
        );
      }).pipe(
        Effect.provide(
          makeRuntimeSqliteLayer({
            filename: lockPath,
            spanAttributes: {
              "db.name": path.basename(lockPath),
              "service.name": "t3-settings-file-lock",
            },
          }),
        ),
      ),
    ).pipe(
      Effect.catchTag(
        "SqlError",
        (cause) => new ServerSettingsFileLockError({ settingsPath, operation: "open", cause }),
      ),
    );
  });
