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
import { makeLayer as youTubeTokenStoreLayer } from "./youtube/YouTubeTokenStore.ts";
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

const YOUTUBE_CLIENT_ENV = {
  COMMAND_CENTER_YOUTUBE_OAUTH_CLIENT_ID: "yt-client.apps.googleusercontent.com",
  COMMAND_CENTER_YOUTUBE_OAUTH_CLIENT_SECRET: "yt-client-secret",
};

const makeTestLayer = (youtubeEnv: Record<string, string>) =>
  layerWithoutDependencies.pipe(
    Layer.provide(
      Layer.mergeAll(
        instagramTokenStoreLayer({ fetchImpl, baseUrl: "https://graph.instagram.test/v26.0" }),
        youTubeTokenStoreLayer({ fetchImpl, env: youtubeEnv }),
      ),
    ),
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(
      ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "command-center-publish-connections-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const testLayer = makeTestLayer(YOUTUBE_CLIENT_ENV);

describe("PublishConnections", () => {
  it.effect("lists every provider; YouTube is connectable once its OAuth client is set", () =>
    Effect.gen(function* () {
      const publish = yield* PublishConnections;
      expect(yield* publish.query).toEqual([
        { provider: "youtube", state: "disconnected", setupMode: "oauth-redirect" },
        { provider: "instagram", state: "disconnected", setupMode: "paste-token" },
      ]);
      const begun = yield* publish.begin({ provider: "youtube" });
      expect(begun.setupMode).toBe("oauth-redirect");
      const authUrl = new URL(begun.authUrl ?? "");
      expect(authUrl.origin).toBe("https://accounts.google.com");
      expect(authUrl.searchParams.get("client_id")).toBe(
        YOUTUBE_CLIENT_ENV.COMMAND_CENTER_YOUTUBE_OAUTH_CLIENT_ID,
      );
      expect(begun.authUrl).not.toContain("yt-client-secret");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("reports YouTube unavailable until its OAuth client is configured", () =>
    Effect.gen(function* () {
      const publish = yield* PublishConnections;
      const [youtube] = yield* publish.query;
      expect(youtube).toMatchObject({ provider: "youtube", state: "unavailable" });
      expect(youtube?.detail).toContain("COMMAND_CENTER_YOUTUBE_OAUTH_CLIENT_ID");
      const error = yield* publish.begin({ provider: "youtube" }).pipe(Effect.flip);
      expect(error.reason).toBe("connector");
    }).pipe(Effect.provide(makeTestLayer({}))),
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
