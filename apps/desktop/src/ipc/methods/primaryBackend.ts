import { DesktopPrimaryBackendState, DesktopPrimaryBackendUpdate } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import { net } from "electron";

import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const LOCAL_EXECUTION_ONCE_SWITCH = DesktopAppSettings.LOCAL_EXECUTION_ONCE_SWITCH;

class DesktopRemoteConnectivityError extends Schema.TaggedErrorClass<DesktopRemoteConnectivityError>()(
  "DesktopRemoteConnectivityError",
  { cause: Schema.Defect() },
) {}

class DesktopPrimaryBackendValidationError extends Schema.TaggedErrorClass<DesktopPrimaryBackendValidationError>()(
  "DesktopPrimaryBackendValidationError",
  { message: Schema.String },
) {}

export function isLocalExecutionOverride(argv: ReadonlyArray<string> = process.argv): boolean {
  return argv.includes(LOCAL_EXECUTION_ONCE_SWITCH);
}

const stateFromSettings = (
  settings: DesktopAppSettings.DesktopSettings,
  restartRequired = false,
  connectivity: DesktopPrimaryBackendState["connectivity"] = "unknown",
): DesktopPrimaryBackendState => ({
  mode: settings.primaryBackendMode,
  remoteHttpBaseUrl: settings.remoteBackendUrl,
  connectivity,
  localExecutionOverride: isLocalExecutionOverride(),
  restartRequired,
});

export const getPrimaryBackendState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_PRIMARY_BACKEND_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopPrimaryBackendState,
  handler: Effect.fn("desktop.ipc.primaryBackend.get")(function* () {
    const settings = yield* DesktopAppSettings.DesktopAppSettings;
    return stateFromSettings(yield* settings.get);
  }),
});

export const setPrimaryBackend = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_PRIMARY_BACKEND_CHANNEL,
  payload: DesktopPrimaryBackendUpdate,
  result: DesktopPrimaryBackendState,
  handler: Effect.fn("desktop.ipc.primaryBackend.set")(function* (input) {
    const settings = yield* DesktopAppSettings.DesktopAppSettings;
    const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
    const previous = yield* settings.get;
    if (
      input.mode === "remote" &&
      DesktopAppSettings.normalizeRemoteBackendUrl(input.remoteHttpBaseUrl) === null
    ) {
      return yield* new DesktopPrimaryBackendValidationError({
        message: "Remote execution requires a valid HTTP or HTTPS backend URL.",
      });
    }
    const change = yield* settings.setPrimaryBackend({
      mode: input.mode,
      ...(input.remoteHttpBaseUrl === undefined
        ? {}
        : { remoteBackendUrl: input.remoteHttpBaseUrl }),
    });
    const state = stateFromSettings(
      change.settings,
      change.changed || previous.primaryBackendMode !== change.settings.primaryBackendMode,
    );
    if (input.restart === true && state.restartRequired) {
      yield* lifecycle.relaunch("primary-backend-change");
    }
    return state;
  }),
});

export const retryRemotePrimary = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RETRY_REMOTE_PRIMARY_CHANNEL,
  payload: Schema.UndefinedOr(Schema.String),
  result: DesktopPrimaryBackendState,
  handler: Effect.fn("desktop.ipc.primaryBackend.retry")(function* (remoteHttpBaseUrl) {
    const settings = yield* DesktopAppSettings.DesktopAppSettings;
    const current = yield* settings.get;
    const endpoint = DesktopAppSettings.normalizeRemoteBackendUrl(
      remoteHttpBaseUrl ?? current.remoteBackendUrl,
    );
    if (endpoint === null) return stateFromSettings(current, false, "unavailable");
    const result = yield* Effect.result(
      Effect.tryPromise({
        try: () => net.fetch(new URL("/.well-known/t3/environment", endpoint).href),
        catch: (cause) => new DesktopRemoteConnectivityError({ cause }),
      }),
    );
    return stateFromSettings(
      current,
      false,
      Result.isSuccess(result) && result.success.ok ? "connected" : "unavailable",
    );
  }),
});

export const startLocalExecutionOnce = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.START_LOCAL_EXECUTION_ONCE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.primaryBackend.startLocalOnce")(function* () {
    const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
    yield* lifecycle.relaunch("local-execution-once", [LOCAL_EXECUTION_ONCE_SWITCH]);
  }),
});
