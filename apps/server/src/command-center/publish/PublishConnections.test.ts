// @effect-diagnostics preferSchemaOverJson:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import type { FetchLike } from "./instagram/client.ts";
import { makeLayer as instagramTokenStoreLayer } from "./instagram/InstagramTokenStore.ts";
import {
  layerWithoutDependencies,
  PUBLISH_CONNECTION_SESSION_TTL_MINUTES,
  PublishConnections,
} from "./PublishConnections.ts";

const T0 = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-09-27T00:00:00.000Z"));

const fetchImpl: FetchLike = async (input) => {
  const path = new URL(String(input)).pathname;
  if (path.endsWith("/me")) {
    return new Response(JSON.stringify({ user_id: "1784", username: "ccn_clips" }));
  }
  return new Response(JSON.stringify({ access_token: "IGAA-new", expires_in: 5_184_000 }));
};

const testLayer = layerWithoutDependencies.pipe(
  Layer.provide(
    instagramTokenStoreLayer({ fetchImpl, baseUrl: "https://graph.instagram.test/v26.0" }),
  ),
  Layer.provide(ServerSecretStore.layer),
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "command-center-publish-connections-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

describe("PublishConnections", () => {
  it.effect("lists every provider and reports unimplemented ones as unavailable", () =>
    Effect.gen(function* () {
      const connections = yield* (yield* PublishConnections).query;
      expect(connections).toEqual([
        {
          provider: "youtube",
          state: "unavailable",
          setupMode: "oauth-redirect",
          detail: "YouTube publishing is not available in this environment yet.",
        },
        { provider: "instagram", state: "disconnected", setupMode: "paste-token" },
      ]);
      const error = yield* (yield* PublishConnections)
        .begin({ provider: "youtube" })
        .pipe(Effect.flip);
      expect(error.reason).toBe("connector");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("connects Instagram through begin/complete and disconnects through remove", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const publish = yield* PublishConnections;
      const begun = yield* publish.begin({ provider: "instagram" });
      expect(begun).toMatchObject({ provider: "instagram", setupMode: "paste-token" });
      expect(begun.authUrl).toBeUndefined();

      const connected = yield* publish.complete({
        sessionId: begun.sessionId,
        credential: "IGAA-pasted",
      });
      expect(connected).toMatchObject({ state: "connected", accountLabel: "@ccn_clips" });
      expect((yield* publish.query)[1]).toMatchObject({ state: "connected" });

      // A completed session cannot be replayed.
      const replay = yield* publish
        .complete({ sessionId: begun.sessionId, credential: "IGAA-pasted" })
        .pipe(Effect.flip);
      expect(replay.reason).toBe("validation");

      expect(yield* publish.remove({ provider: "instagram" })).toEqual({
        provider: "instagram",
        state: "disconnected",
        setupMode: "paste-token",
      });
      expect((yield* publish.query)[1]).toMatchObject({ state: "disconnected" });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects a setup session after it expires", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const publish = yield* PublishConnections;
      const begun = yield* publish.begin({ provider: "instagram" });
      yield* TestClock.setTime(T0 + PUBLISH_CONNECTION_SESSION_TTL_MINUTES * 60_000);
      const error = yield* publish
        .complete({ sessionId: begun.sessionId, credential: "IGAA-pasted" })
        .pipe(Effect.flip);
      expect(error.message).toContain("expired");
      expect((yield* publish.query)[1]).toMatchObject({ state: "disconnected" });
    }).pipe(Effect.provide(testLayer)),
  );
});
