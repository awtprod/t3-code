import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopConnectionCatalogStore from "../../app/DesktopConnectionCatalogStore.ts";
import * as DesktopLocalEnvironmentAuth from "../../backend/DesktopLocalEnvironmentAuth.ts";
import { clearConnectionCatalog, setConnectionCatalog } from "./connectionCatalog.ts";

describe("connection catalog IPC", () => {
  it.effect("drops the cached remote primary bearer after every catalog write", () => {
    const events: Array<string> = [];
    const layer = Layer.mergeAll(
      Layer.mock(DesktopConnectionCatalogStore.DesktopConnectionCatalogStore, {
        get: Effect.succeed(Option.none()),
        set: (catalog) =>
          Effect.sync(() => {
            events.push(`set:${catalog}`);
            return true;
          }),
        clear: Effect.sync(() => {
          events.push("clear");
        }),
      }),
      Layer.mock(DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth, {
        invalidateSavedRemoteToken: Effect.sync(() => {
          events.push("invalidate");
        }),
      }),
    );
    return Effect.gen(function* () {
      assert.isTrue(yield* setConnectionCatalog.handler("{}"));
      yield* clearConnectionCatalog.handler(undefined);
      assert.deepEqual(events, ["set:{}", "invalidate", "clear", "invalidate"]);
    }).pipe(Effect.provide(layer));
  });
});
