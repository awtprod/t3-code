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
import type { FetchLike } from "./client.ts";
import {
  INSTAGRAM_CONNECTION_SECRET,
  InstagramTokenStore,
  isTokenExpiring,
  makeLayer,
  parseRefreshedToken,
} from "./InstagramTokenStore.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-09-27T00:00:00.000Z"));
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const PASTED = "IGAA-pasted-long-lived-token";
const REFRESHED = "IGAA-refreshed-token";

interface GraphCall {
  readonly path: string;
  readonly query: URLSearchParams;
  readonly authorization: string | undefined;
}

type GraphRoute = (call: GraphCall) => { readonly status: number; readonly body: unknown };

const graph = (route: GraphRoute) => {
  const calls: GraphCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call = {
      path: url.pathname.replace(/^\/v[0-9.]+/u, ""),
      query: url.searchParams,
      authorization: headers.Authorization,
    };
    calls.push(call);
    const { status, body } = route(call);
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, fetchImpl };
};

const okGraph = (options: { readonly refresh?: "ok" | "fail" } = {}) =>
  graph((call) => {
    if (call.path === "/me") {
      return { status: 200, body: { user_id: "17841400000000000", username: "example_clips" } };
    }
    if (call.path === "/refresh_access_token") {
      return options.refresh === "fail"
        ? {
            status: 400,
            body: {
              error: {
                message: `Cannot refresh ${call.query.get("access_token")} yet`,
                type: "OAuthException",
                code: 190,
              },
            },
          }
        : {
            status: 200,
            body: { access_token: REFRESHED, token_type: "bearer", expires_in: 60 * 24 * 60 * 60 },
          };
    }
    return { status: 404, body: {} };
  });

const storeLayer = (fetchImpl: FetchLike) =>
  makeLayer({ fetchImpl, baseUrl: "https://graph.instagram.test/v26.0" }).pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(
      ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "command-center-instagram-token-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const storedJson = Effect.gen(function* () {
  const bytes = yield* (yield* ServerSecretStore.ServerSecretStore).get(
    INSTAGRAM_CONNECTION_SECRET,
  );
  return Option.map(bytes, (value) => JSON.parse(new TextDecoder().decode(value)));
});

describe("InstagramTokenStore", () => {
  it("parses refresh payloads and detects expiring tokens", () => {
    expect(parseRefreshedToken({ access_token: "t", expires_in: 10 }, 1_000)).toEqual({
      accessToken: "t",
      expiresAtMs: 11_000,
    });
    expect(parseRefreshedToken({ access_token: "", expires_in: 10 }, 0)).toBeUndefined();
    expect(parseRefreshedToken({ access_token: "t", expires_in: -1 }, 0)).toBeUndefined();
    expect(parseRefreshedToken(null, 0)).toBeUndefined();
    expect(isTokenExpiring(T0 + 16 * DAY_MS, 15, T0)).toBe(false);
    expect(isTokenExpiring(T0 + 15 * DAY_MS, 15, T0)).toBe(true);
    expect(isTokenExpiring(Number.NaN, 15, T0)).toBe(true);
  });

  it.effect("validates a pasted token via /me, refreshes it, and stores only server-side", () => {
    const { calls, fetchImpl } = okGraph();
    return Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const store = yield* InstagramTokenStore;
      const connection = yield* store.connectFromToken(`  ${PASTED}  `);

      expect(connection).toEqual({
        provider: "instagram",
        state: "connected",
        setupMode: "paste-token",
        accountId: "17841400000000000",
        accountLabel: "@example_clips",
        expiresAt: iso(T0 + 60 * DAY_MS),
        lastRefreshedAt: iso(T0),
      });
      expect(JSON.stringify(connection)).not.toContain("IGAA");

      expect(calls.map((call) => call.path)).toEqual(["/me", "/refresh_access_token"]);
      expect(calls[0]?.authorization).toBe(`Bearer ${PASTED}`);
      expect(calls[1]?.query.get("grant_type")).toBe("ig_refresh_token");
      expect(calls[1]?.query.get("access_token")).toBe(PASTED);

      const stored = yield* storedJson;
      expect(Option.getOrThrow(stored)).toMatchObject({
        version: 1,
        accessToken: REFRESHED,
        igUserId: "17841400000000000",
        username: "example_clips",
        tokenExpiresAtMs: T0 + 60 * DAY_MS,
      });
      expect(Option.getOrThrow(yield* store.activeCredential)).toEqual({
        accessToken: REFRESHED,
        igUserId: "17841400000000000",
        username: "example_clips",
      });
    }).pipe(Effect.provide(storeLayer(fetchImpl)));
  });

  it.effect("assumes a fresh 60-day token when Graph refuses to refresh a new token", () => {
    const { fetchImpl } = okGraph({ refresh: "fail" });
    return Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const store = yield* InstagramTokenStore;
      const connection = yield* store.connectFromToken(PASTED);
      expect(connection.expiresAt).toBe(iso(T0 + 60 * DAY_MS));
      expect(connection.detail).toBeUndefined();
      expect(Option.getOrThrow(yield* storedJson)).toMatchObject({ accessToken: PASTED });
    }).pipe(Effect.provide(storeLayer(fetchImpl)));
  });

  it.effect("rejects an invalid token without storing it or echoing it", () => {
    const { fetchImpl } = graph((call) => ({
      status: 400,
      body: {
        error: {
          message: `Invalid OAuth access token - Cannot parse access token ${call.authorization?.slice(7)}`,
          type: "OAuthException",
          code: 190,
        },
      },
    }));
    return Effect.gen(function* () {
      const store = yield* InstagramTokenStore;
      const error = yield* store.connectFromToken(PASTED).pipe(Effect.flip);
      expect(error.reason).toBe("connector");
      expect(error.message).toContain("Instagram rejected this token");
      expect(error.message).toContain("[REDACTED]");
      expect(error.message).not.toContain(PASTED);
      expect(Option.isNone(yield* storedJson)).toBe(true);

      const blank = yield* store.connectFromToken("has a space").pipe(Effect.flip);
      expect(blank.reason).toBe("validation");
    }).pipe(Effect.provide(storeLayer(fetchImpl)));
  });

  it.effect("lazily refreshes a token within the threshold and skips fresh tokens", () => {
    const { calls, fetchImpl } = okGraph({ refresh: "fail" });
    let refreshSucceeds = false;
    const routed: FetchLike = (input, init) => {
      if (refreshSucceeds) return okGraph().fetchImpl(input, init);
      return fetchImpl(input, init);
    };
    return Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const store = yield* InstagramTokenStore;
      yield* store.connectFromToken(PASTED);
      const callsAfterConnect = calls.length;

      // 30 days in: 30 days left > 15-day threshold, so no Graph call.
      yield* TestClock.setTime(T0 + 30 * DAY_MS);
      expect(yield* store.refreshIfExpiring()).toEqual({
        refreshed: false,
        reason: "not_expiring",
        expiresAtMs: T0 + 60 * DAY_MS,
      });
      expect(calls.length).toBe(callsAfterConnect);

      // 50 days in: 10 days left. Graph refuses -> keep token, record the error for the UI.
      yield* TestClock.setTime(T0 + 50 * DAY_MS);
      const failedSummary = yield* store.summary;
      expect(failedSummary.state).toBe("connected");
      expect(failedSummary.detail).toContain("Instagram token refresh failed");
      expect(failedSummary.detail).not.toContain(PASTED);
      expect(Option.getOrThrow(yield* storedJson)).toMatchObject({ accessToken: PASTED });

      // Graph recovers: the next read refreshes and clears the error.
      refreshSucceeds = true;
      const refreshedSummary = yield* store.summary;
      expect(refreshedSummary.detail).toBeUndefined();
      expect(refreshedSummary.expiresAt).toBe(iso(T0 + 110 * DAY_MS));
      expect(refreshedSummary.lastRefreshedAt).toBe(iso(T0 + 50 * DAY_MS));
      const stored = Option.getOrThrow(yield* storedJson);
      expect(stored).toMatchObject({ accessToken: REFRESHED, lastRefreshedAtMs: T0 + 50 * DAY_MS });
      expect(stored.lastError).toBeUndefined();
    }).pipe(Effect.provide(storeLayer(routed)));
  });

  it.effect("refuses to hand out an expired token and reports it on the summary", () => {
    const { fetchImpl } = okGraph({ refresh: "fail" });
    return Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const store = yield* InstagramTokenStore;
      yield* store.connectFromToken(PASTED);
      yield* TestClock.setTime(T0 + 61 * DAY_MS);
      expect((yield* store.summary).detail).toContain("expired");
      const error = yield* store.activeCredential.pipe(Effect.flip);
      expect(error.message).toContain("expired");
    }).pipe(Effect.provide(storeLayer(fetchImpl)));
  });

  it.effect("disconnect removes the stored credential", () => {
    const { fetchImpl } = okGraph();
    return Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const store = yield* InstagramTokenStore;
      yield* store.connectFromToken(PASTED);
      expect(yield* store.disconnect).toEqual({
        provider: "instagram",
        state: "disconnected",
        setupMode: "paste-token",
      });
      expect(Option.isNone(yield* storedJson)).toBe(true);
      expect((yield* store.summary).state).toBe("disconnected");
      expect(Option.isNone(yield* store.activeCredential)).toBe(true);
      expect(yield* store.refreshIfExpiring()).toEqual({
        refreshed: false,
        reason: "no_connection",
      });
    }).pipe(Effect.provide(storeLayer(fetchImpl)));
  });
});
