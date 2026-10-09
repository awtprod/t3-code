// @effect-diagnostics preferSchemaOverJson:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../../config.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import {
  YOUTUBE_UPLOAD_SCOPE,
  YOUTUBE_ANALYTICS_SCOPE,
  YOUTUBE_READ_SCOPE,
  type FetchLike,
} from "./YouTubeOAuth.ts";
import { makeLayer, YOUTUBE_CONNECTION_SECRET, YouTubeTokenStore } from "./YouTubeTokenStore.ts";

const T0 = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-09-27T00:00:00.000Z"));
const ENV = {
  COMMAND_CENTER_YOUTUBE_OAUTH_CLIENT_ID: "yt-client.apps.googleusercontent.com",
  COMMAND_CENTER_YOUTUBE_OAUTH_CLIENT_SECRET: "yt-client-secret",
};
const idToken = (claims: Record<string, unknown>) =>
  ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");

interface GoogleCall {
  readonly url: string;
  readonly form: URLSearchParams;
}

const google = (route: (call: GoogleCall) => { status: number; body: unknown }) => {
  const calls: GoogleCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const call = { url: String(input), form: new URLSearchParams(String(init?.body ?? "")) };
    calls.push(call);
    const { status, body } = route(call);
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, fetchImpl };
};

let accessCounter = 0;
const okGoogle = (options: { readonly refresh?: "ok" | "invalid_grant" } = {}) =>
  google((call) => {
    if (call.url.endsWith("/revoke")) return { status: 200, body: {} };
    if (call.form.get("grant_type") === "authorization_code") {
      return {
        status: 200,
        body: {
          access_token: "ya29.initial",
          expires_in: 3600,
          refresh_token: "1//refresh-token",
          scope: `${YOUTUBE_UPLOAD_SCOPE} openid https://www.googleapis.com/auth/userinfo.email`,
          id_token: idToken({ email: "andrew@example.com" }),
        },
      };
    }
    if (options.refresh === "invalid_grant") {
      return { status: 400, body: { error: "invalid_grant" } };
    }
    accessCounter += 1;
    return {
      status: 200,
      body: { access_token: `ya29.refreshed-${accessCounter}`, expires_in: 3600 },
    };
  });

const storeLayer = (fetchImpl: FetchLike, env: Record<string, string> = ENV) =>
  makeLayer({ fetchImpl, env }).pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(
      ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "command-center-youtube-token-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const storedJson = Effect.gen(function* () {
  const bytes = yield* (yield* ServerSecretStore.ServerSecretStore).get(YOUTUBE_CONNECTION_SECRET);
  return Option.map(bytes, (value) => JSON.parse(new TextDecoder().decode(value)));
});

const callbackFor = (authUrl: string, overrides: Record<string, string> = {}) => {
  const state = new URL(authUrl).searchParams.get("state") ?? "";
  const callback = new URL("http://127.0.0.1/oauth2/callback");
  for (const [key, value] of Object.entries({ state, code: "4/auth-code", ...overrides })) {
    callback.searchParams.set(key, value);
  }
  return callback.toString();
};

const connect = Effect.gen(function* () {
  const store = yield* YouTubeTokenStore;
  const begun = yield* store.begin;
  return yield* begun.complete(callbackFor(begun.authUrl));
});

describe("YouTubeTokenStore", () => {
  it.effect("connects via the pasted callback and persists only the refresh token", () => {
    const { calls, fetchImpl } = okGoogle();
    return Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const connection = yield* connect;
      expect(connection).toEqual({
        provider: "youtube",
        state: "connected",
        setupMode: "oauth-redirect",
        accountLabel: "andrew@example.com",
        lastRefreshedAt: DateTime.formatIso(DateTime.makeUnsafe(T0)),
        analytics: {
          state: "needs-consent",
          detail: "Reconnect YouTube to grant Analytics and YouTube read access.",
        },
      });
      expect(JSON.stringify(connection)).not.toMatch(/ya29|1\/\/refresh/u);

      const codeCall = calls.find((call) => call.form.get("grant_type") === "authorization_code");
      expect(codeCall?.form.get("code")).toBe("4/auth-code");
      expect(codeCall?.form.get("code_verifier")?.length).toBeGreaterThanOrEqual(43);

      const stored = Option.getOrThrow(yield* storedJson);
      expect(stored).toMatchObject({
        version: 1,
        refreshToken: "1//refresh-token",
        clientId: ENV.COMMAND_CENTER_YOUTUBE_OAUTH_CLIENT_ID,
        email: "andrew@example.com",
      });
      expect(JSON.stringify(stored)).not.toContain("ya29");

      // The access token from the exchange is cached in memory; no refresh call yet.
      expect(yield* (yield* YouTubeTokenStore).accessToken).toBe("ya29.initial");
      expect(calls).toHaveLength(1);
    }).pipe(Effect.provide(storeLayer(fetchImpl)));
  });

  it.effect("rejects a callback from another setup attempt without calling Google", () => {
    const { calls, fetchImpl } = okGoogle();
    return Effect.gen(function* () {
      const store = yield* YouTubeTokenStore;
      const begun = yield* store.begin;
      const error = yield* begun
        .complete(callbackFor(begun.authUrl, { state: "someone-elses-state" }))
        .pipe(Effect.flip);
      expect(error.reason).toBe("validation");
      expect(calls).toHaveLength(0);
      expect(Option.isNone(yield* storedJson)).toBe(true);
    }).pipe(Effect.provide(storeLayer(fetchImpl)));
  });

  it.effect("refreshes the access token lazily once it nears expiry", () => {
    const { calls, fetchImpl } = okGoogle();
    return Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      yield* connect;
      const store = yield* YouTubeTokenStore;
      yield* TestClock.setTime(T0 + 30 * 60_000);
      expect(yield* store.accessToken).toBe("ya29.initial");

      yield* TestClock.setTime(T0 + 59 * 60_000);
      const refreshed = yield* store.accessToken;
      expect(refreshed).toMatch(/^ya29\.refreshed-/u);
      expect(calls.at(-1)?.form.get("grant_type")).toBe("refresh_token");
      expect(calls.at(-1)?.form.get("refresh_token")).toBe("1//refresh-token");
      expect(yield* store.accessToken).toBe(refreshed);

      // A 401 mid-upload invalidates the cache and forces the next read to refresh.
      yield* store.invalidateAccessToken;
      expect(yield* store.accessToken).not.toBe(refreshed);
    }).pipe(Effect.provide(storeLayer(fetchImpl)));
  });

  it.effect("keeps Analytics consent and health separate from publishing", () => {
    const { fetchImpl } = okGoogle();
    return Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      yield* connect;
      const store = yield* YouTubeTokenStore;
      expect((yield* store.analyticsAccessToken.pipe(Effect.flip)).message).toContain("Reconnect");
      expect(yield* store.accessToken).toBe("ya29.initial");
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      const saved = Option.getOrThrow(yield* storedJson) as Record<string, unknown>;
      yield* secretStore.set(
        YOUTUBE_CONNECTION_SECRET,
        new TextEncoder().encode(
          JSON.stringify({
            ...saved,
            scope: `${YOUTUBE_UPLOAD_SCOPE} ${YOUTUBE_ANALYTICS_SCOPE} ${YOUTUBE_READ_SCOPE}`,
          }),
        ),
      );
      expect(yield* store.analyticsAccessToken).toMatch(/^ya29\.refreshed-/u);
      yield* store.recordAnalyticsCheck("YouTube Analytics returned HTTP 403.");
      expect(yield* store.summary).toMatchObject({
        state: "connected",
        analytics: { state: "error" },
      });
      yield* store.recordAnalyticsCheck();
      expect(yield* store.summary).toMatchObject({
        state: "connected",
        analytics: { state: "verified" },
      });
    }).pipe(Effect.provide(storeLayer(fetchImpl)));
  });

  it.effect("records a revoked refresh token on the settings row", () => {
    const { fetchImpl } = okGoogle({ refresh: "invalid_grant" });
    return Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      yield* connect;
      const store = yield* YouTubeTokenStore;
      yield* store.invalidateAccessToken;
      const error = yield* store.accessToken.pipe(Effect.flip);
      expect(error.message).toContain("Connect YouTube again");
      const summary = yield* store.summary;
      expect(summary.state).toBe("connected");
      expect(summary.detail).toContain("Connect YouTube again");
    }).pipe(Effect.provide(storeLayer(fetchImpl)));
  });

  it.effect("records the upload channel and disconnects by revoking and deleting", () => {
    const { calls, fetchImpl } = okGoogle();
    return Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      yield* connect;
      const store = yield* YouTubeTokenStore;
      yield* store.recordChannel({ channelId: "UC123", channelTitle: "Clips Channel" });
      expect(yield* store.summary).toMatchObject({
        accountId: "UC123",
        accountLabel: "Clips Channel",
      });

      expect(yield* store.disconnect).toEqual({
        provider: "youtube",
        state: "disconnected",
        setupMode: "oauth-redirect",
      });
      const revoke = calls.find((call) => call.url.endsWith("/revoke"));
      expect(revoke?.form.get("token")).toBe("1//refresh-token");
      expect(Option.isNone(yield* storedJson)).toBe(true);
      expect((yield* store.accessToken.pipe(Effect.flip)).message).toContain("not connected");
    }).pipe(Effect.provide(storeLayer(fetchImpl)));
  });

  it.effect("reads the OAuth client from the stored client JSON when env is unset", () => {
    const { fetchImpl } = okGoogle();
    return Effect.gen(function* () {
      const store = yield* YouTubeTokenStore;
      expect((yield* store.summary).state).toBe("unavailable");
      yield* (yield* ServerSecretStore.ServerSecretStore).set(
        "command-center-youtube-oauth-client",
        new TextEncoder().encode(
          JSON.stringify({ installed: { client_id: "json-client", client_secret: "json-secret" } }),
        ),
      );
      expect((yield* store.summary).state).toBe("disconnected");
      const begun = yield* store.begin;
      expect(new URL(begun.authUrl).searchParams.get("client_id")).toBe("json-client");
    }).pipe(Effect.provide(storeLayer(fetchImpl, {})));
  });
});
