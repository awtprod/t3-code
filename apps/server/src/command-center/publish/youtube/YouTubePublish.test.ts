// @effect-diagnostics preferSchemaOverJson:off nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../../config.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import { YOUTUBE_UPLOAD_SCOPE, type FetchLike } from "./YouTubeOAuth.ts";
import { buildYouTubeVideoMetadata, makeLayer, YouTubePublish } from "./YouTubePublish.ts";
import { makeLayer as tokenStoreLayer, YouTubeTokenStore } from "./YouTubeTokenStore.ts";

const T0 = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-09-27T00:00:00.000Z"));
const ENV = {
  COMMAND_CENTER_YOUTUBE_OAUTH_CLIENT_ID: "yt-client.apps.googleusercontent.com",
  COMMAND_CENTER_YOUTUBE_OAUTH_CLIENT_SECRET: "yt-client-secret",
};

describe("buildYouTubeVideoMetadata", () => {
  it("defaults to private, not made for kids, People & Blogs", () => {
    expect(buildYouTubeVideoMetadata({ filePath: "/x.mp4", title: "  Clip  " }, T0)).toEqual({
      snippet: { title: "Clip", categoryId: "22" },
      status: { privacyStatus: "private", selfDeclaredMadeForKids: false },
    });
  });

  it("adds the #Shorts hint once for Shorts", () => {
    const short = buildYouTubeVideoMetadata(
      { filePath: "/x.mp4", title: "Clip", description: "Bit", short: true },
      T0,
    );
    expect(typeof short !== "string" && short.snippet.description).toBe("Bit\n\n#Shorts");
    const tagged = buildYouTubeVideoMetadata(
      { filePath: "/x.mp4", title: "Clip #shorts", short: true },
      T0,
    );
    expect(typeof tagged !== "string" && tagged.snippet.description).toBeUndefined();
  });

  it("validates titles and scheduled publishing", () => {
    const at = (input: Parameters<typeof buildYouTubeVideoMetadata>[0]) =>
      buildYouTubeVideoMetadata(input, T0);
    expect(at({ filePath: "/x", title: " " })).toContain("title is required");
    expect(at({ filePath: "/x", title: "x".repeat(101) })).toContain("100 characters");
    expect(at({ filePath: "/x", title: "a <b>" })).toContain("< or >");
    expect(
      at({
        filePath: "/x",
        title: "t",
        privacyStatus: "unlisted",
        publishAt: "2026-10-01T00:00:00Z",
      }),
    ).toContain("must be uploaded as private");
    expect(at({ filePath: "/x", title: "t", publishAt: "2026-01-01T00:00:00Z" })).toContain(
      "in the future",
    );
    expect(
      at({ filePath: "/x", title: "t", publishAt: "2026-10-01T12:00:00+02:00" }),
    ).toMatchObject({
      status: { privacyStatus: "private", publishAt: "2026-10-01T10:00:00.000Z" },
    });
  });
});

describe("YouTubePublish", () => {
  it.effect("uploads a local file with a lazily refreshed token and records the channel", () => {
    const calls: Array<{ url: string; method: string }> = [];
    const fetchImpl: FetchLike = async (input, init) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      if (url === "https://oauth2.googleapis.com/token") {
        const form = new URLSearchParams(String(init?.body));
        return new Response(
          JSON.stringify(
            form.get("grant_type") === "authorization_code"
              ? {
                  access_token: "ya29.a",
                  expires_in: 60, // already inside the refresh window
                  refresh_token: "1//r",
                  scope: YOUTUBE_UPLOAD_SCOPE,
                }
              : { access_token: "ya29.b", expires_in: 3600 },
          ),
        );
      }
      if (init?.method === "POST") {
        return new Response(null, { headers: { Location: "https://upload.test/s" } });
      }
      return new Response(
        JSON.stringify({
          id: "vid9",
          snippet: { channelId: "UC9", channelTitle: "Clips" },
          status: { privacyStatus: "private" },
        }),
        { status: 201 },
      );
    };
    const layer = makeLayer({ fetchImpl, sleep: async () => {} }).pipe(
      Layer.provideMerge(tokenStoreLayer({ fetchImpl, env: ENV })),
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provideMerge(
        ServerConfig.ServerConfig.layerTest(process.cwd(), {
          prefix: "command-center-youtube-publish-test-",
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const store = yield* YouTubeTokenStore;
      const begun = yield* store.begin;
      const state = new URL(begun.authUrl).searchParams.get("state") ?? "";
      yield* begun.complete(`http://127.0.0.1/oauth2/callback?state=${state}&code=4%2Fc`);

      const dir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "yt-publish-test-")),
      );
      const filePath = NodePath.join(dir, "clip.mp4");
      yield* Effect.promise(() => NodeFSP.writeFile(filePath, Buffer.alloc(4096, 7)));

      const result = yield* (yield* YouTubePublish).publish({
        filePath,
        title: "My clip",
        short: true,
      });
      expect(result).toEqual({
        videoId: "vid9",
        url: "https://youtu.be/vid9",
        privacyStatus: "private",
        channelId: "UC9",
      });
      expect(calls.filter((call) => call.url.includes("oauth2")).length).toBe(2); // code + refresh
      expect(yield* store.summary).toMatchObject({ accountId: "UC9", accountLabel: "Clips" });
      yield* Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true }));
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails validation before contacting Google", () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      calls.push(String(input));
      return new Response("{}");
    };
    const layer = makeLayer({ fetchImpl }).pipe(
      Layer.provideMerge(tokenStoreLayer({ fetchImpl, env: ENV })),
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provideMerge(
        ServerConfig.ServerConfig.layerTest(process.cwd(), {
          prefix: "command-center-youtube-publish-test-",
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
    );
    return Effect.gen(function* () {
      const error = yield* (yield* YouTubePublish)
        .publish({ filePath: "/nope.mp4", title: "" })
        .pipe(Effect.flip);
      expect(error.reason).toBe("validation");
      const notConnected = yield* (yield* YouTubePublish)
        .publish({ filePath: "/nope.mp4", title: "ok" })
        .pipe(Effect.flip);
      expect(notConnected.message).toContain("not connected");
      expect(calls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });
});
