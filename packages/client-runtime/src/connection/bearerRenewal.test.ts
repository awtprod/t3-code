import { AuthBearerSessionRenewalWindowMs, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import { remoteHttpClientLayer } from "../rpc/http.ts";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import {
  BEARER_RENEWAL_RETRY_DELAY,
  bearerRenewalDecision,
  readSessionTokenExpiry,
  run,
} from "./bearerRenewal.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  BearerConnectionTarget,
  type SupervisorConnectionState,
} from "./model.ts";
import * as EnvironmentRegistry from "./registry.ts";
import * as ConnectionWakeups from "./wakeups.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const ENVIRONMENT_ID = EnvironmentId.make("environment-remote");
const HTTP_BASE_URL = "https://remote.example.test";

const sessionToken = (expMs: number, label = "token") =>
  `${Encoding.encodeBase64Url(JSON.stringify({ v: 1, kind: "session", exp: expMs }))}.${label}`;

const CONNECTED: SupervisorConnectionState = {
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  phase: "connected",
};
const CONNECTING: SupervisorConnectionState = {
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  phase: "connecting",
};

type FetchCall = { readonly url: string; readonly authorization: string | null };

const makeHarness = Effect.fn("test.bearerRenewal.makeHarness")(function* (input: {
  readonly connectionId?: string;
  readonly token: string;
  readonly respond: (call: FetchCall) => Promise<Response>;
}) {
  const connectionId = input.connectionId ?? "remote-connection";
  const target = new BearerConnectionTarget({
    environmentId: ENVIRONMENT_ID,
    label: "Remote environment",
    connectionId,
  });
  const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
    new Map([[ENVIRONMENT_ID, { target, profile: Option.none(), enabled: true }]]),
  );
  const state = yield* SubscriptionRef.make<SupervisorConnectionState>(CONNECTING);
  // `savedToken` is this window's view; `persistedToken` is what storage holds,
  // which another window may change. A refreshing read copies it over.
  const savedToken = yield* Ref.make(input.token);
  const persistedToken = yield* Ref.make(input.token);
  const refreshes = yield* Ref.make(0);
  const replacements = yield* Ref.make<ReadonlyArray<string>>([]);
  const calls: Array<FetchCall> = [];
  const wakeups = yield* Queue.unbounded<ConnectionWakeups.ConnectionWakeup>();

  const registry = EnvironmentRegistry.EnvironmentRegistry.of({
    entries,
    networkStatus: yield* SubscriptionRef.make<"unknown" | "offline" | "online">("online"),
    start: Effect.void,
    register: () => Effect.die("unused"),
    registerPlatform: () => Effect.die("unused"),
    reconcilePlatform: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
    removeRelayEnvironments: () => Effect.die("unused"),
    retryNow: () => Effect.void,
    savedBearerCredential: (environmentId, options) =>
      (options?.refresh === true
        ? Ref.update(refreshes, (count) => count + 1).pipe(
            Effect.andThen(Ref.get(persistedToken)),
            Effect.flatMap((token) => Ref.set(savedToken, token)),
          )
        : Effect.void
      ).pipe(
        Effect.andThen(Ref.get(savedToken)),
        Effect.map((token) =>
          environmentId === ENVIRONMENT_ID
            ? Option.some({ environmentId, connectionId, httpBaseUrl: HTTP_BASE_URL, token })
            : Option.none(),
        ),
      ),
    replaceBearerCredential: (replacement) =>
      Effect.gen(function* () {
        if ((yield* Ref.get(savedToken)) !== replacement.previousToken) return false;
        yield* Ref.set(savedToken, replacement.token);
        yield* Ref.set(persistedToken, replacement.token);
        yield* Ref.update(replacements, (current) => [...current, replacement.token]);
        return true;
      }),
    setEnabled: () => Effect.die("unused"),
    setCompatibility: () => Effect.die("unused"),
    state: () => SubscriptionRef.get(state),
    stateChanges: () =>
      Stream.concat(Stream.fromEffect(SubscriptionRef.get(state)), SubscriptionRef.changes(state)),
    run: () => Effect.die("unused"),
    runStream: () => Stream.die("unused"),
    followStream: () => Stream.die("unused"),
  });

  const fetchFn = ((request: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call = { url: String(request), authorization: headers.get("authorization") };
    calls.push(call);
    return input.respond(call);
  }) satisfies typeof fetch;

  const start = run().pipe(
    Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
    Effect.provideService(
      ConnectionWakeups.ConnectionWakeups,
      ConnectionWakeups.ConnectionWakeups.of({ changes: Stream.fromQueue(wakeups) }),
    ),
    Effect.provide(remoteHttpClientLayer(fetchFn)),
    Effect.forkScoped,
  );

  return { start, state, savedToken, persistedToken, refreshes, replacements, calls, wakeups };
});

/** Lets forked fibers and the fake fetch promises run without moving the clock. */
const settle = Effect.gen(function* () {
  for (let index = 0; index < 20; index++) {
    // The fake fetch resolves on the macrotask queue, outside the test clock.
    // @effect-diagnostics-next-line globalTimers:off
    yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    yield* Effect.yieldNow;
  }
});

const isoAt = (epochMs: number) => DateTime.formatIso(DateTime.makeUnsafe(epochMs));

const renewedResponse = (token: string, expiresAtMs: number) =>
  Promise.resolve(
    Response.json({
      renewed: true,
      access_token: token,
      token_type: "Bearer",
      expires_in: 30 * 24 * 60 * 60,
      expiresAt: isoAt(expiresAtMs),
      scope: "orchestration:read",
    }),
  );

describe("bearer session renewal policy", () => {
  it("reads the expiry claim tolerantly", () => {
    expect(readSessionTokenExpiry(sessionToken(1234))).toBe(1234);
    expect(readSessionTokenExpiry("opaque-token")).toBeNull();
    expect(readSessionTokenExpiry(".signature")).toBeNull();
    expect(readSessionTokenExpiry("not-base64!.signature")).toBeNull();
    expect(
      readSessionTokenExpiry(`${Encoding.encodeBase64Url('{"exp":"soon"}')}.signature`),
    ).toBeNull();
  });

  it("renews only inside the window and leaves expired tokens alone", () => {
    const nowMs = 100 * DAY_MS;
    expect(bearerRenewalDecision({ expiresAtMs: nowMs + 20 * DAY_MS, nowMs })).toBe("not-due");
    expect(
      bearerRenewalDecision({ expiresAtMs: nowMs + AuthBearerSessionRenewalWindowMs, nowMs }),
    ).toBe("renew");
    expect(bearerRenewalDecision({ expiresAtMs: nowMs + DAY_MS, nowMs })).toBe("renew");
    expect(bearerRenewalDecision({ expiresAtMs: nowMs, nowMs })).toBe("expired");
    expect(bearerRenewalDecision({ expiresAtMs: null, nowMs })).toBe("renew");
  });
});

describe("bearer session renewal", () => {
  it.effect("renews after a successful connect and persists the successor once", () =>
    Effect.gen(function* () {
      const oldToken = sessionToken(5 * DAY_MS, "old");
      const newToken = sessionToken(35 * DAY_MS, "new");
      const harness = yield* makeHarness({
        token: oldToken,
        respond: () => renewedResponse(newToken, 35 * DAY_MS),
      });
      yield* harness.start;
      yield* settle;
      expect(harness.calls).toHaveLength(0);

      yield* SubscriptionRef.set(harness.state, CONNECTED);
      yield* settle;

      expect(harness.calls).toEqual([
        {
          url: `${HTTP_BASE_URL}/api/auth/session/renew`,
          authorization: `Bearer ${oldToken}`,
        },
      ]);
      expect(yield* Ref.get(harness.savedToken)).toBe(newToken);
      expect(yield* Ref.get(harness.replacements)).toEqual([newToken]);

      // Reconnecting with the renewed token does not renew again.
      yield* SubscriptionRef.set(harness.state, CONNECTING);
      yield* SubscriptionRef.set(harness.state, CONNECTED);
      yield* Queue.offer(harness.wakeups, "application-active");
      yield* settle;
      expect(harness.calls).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("does not call the server while the token is outside the window", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        token: sessionToken(25 * DAY_MS),
        respond: () => Promise.reject(new Error("unexpected renewal")),
      });
      yield* SubscriptionRef.set(harness.state, CONNECTED);
      yield* harness.start;
      yield* settle;
      yield* Queue.offer(harness.wakeups, "application-active");
      yield* TestClock.adjust(Duration.hours(2));
      yield* settle;

      expect(harness.calls).toHaveLength(0);
    }).pipe(Effect.scoped),
  );

  it.effect("renews on the periodic check once the window opens", () =>
    Effect.gen(function* () {
      const newToken = sessionToken(60 * DAY_MS, "new");
      const harness = yield* makeHarness({
        token: sessionToken(12 * DAY_MS, "old"),
        respond: () => renewedResponse(newToken, 60 * DAY_MS),
      });
      yield* SubscriptionRef.set(harness.state, CONNECTED);
      yield* harness.start;
      yield* settle;
      expect(harness.calls).toHaveLength(0);

      yield* TestClock.adjust(Duration.millis(2 * DAY_MS + 60 * 60 * 1000));
      yield* settle;

      expect(harness.calls).toHaveLength(1);
      expect(yield* Ref.get(harness.savedToken)).toBe(newToken);
    }).pipe(Effect.scoped),
  );

  it.effect("skips desktop-local secondaries", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        connectionId: "local:wsl",
        token: sessionToken(DAY_MS),
        respond: () => Promise.reject(new Error("unexpected renewal")),
      });
      yield* harness.start;
      yield* SubscriptionRef.set(harness.state, CONNECTED);
      yield* settle;

      expect(harness.calls).toHaveLength(0);
    }).pipe(Effect.scoped),
  );

  it.effect("logs failures, keeps the saved token, and retries after the delay", () =>
    Effect.gen(function* () {
      const oldToken = sessionToken(5 * DAY_MS, "old");
      const newToken = sessionToken(35 * DAY_MS, "new");
      let fail = true;
      const harness = yield* makeHarness({
        token: oldToken,
        respond: () =>
          fail
            ? Promise.reject(new TypeError("network down"))
            : renewedResponse(newToken, 35 * DAY_MS),
      });
      yield* harness.start;
      yield* SubscriptionRef.set(harness.state, CONNECTED);
      yield* settle;
      expect(harness.calls).toHaveLength(1);
      expect(yield* Ref.get(harness.savedToken)).toBe(oldToken);

      yield* Queue.offer(harness.wakeups, "application-active");
      yield* settle;
      expect(harness.calls).toHaveLength(1);

      fail = false;
      yield* TestClock.adjust(BEARER_RENEWAL_RETRY_DELAY);
      yield* Queue.offer(harness.wakeups, "application-active");
      yield* settle;
      expect(harness.calls).toHaveLength(2);
      expect(yield* Ref.get(harness.savedToken)).toBe(newToken);
    }).pipe(Effect.scoped),
  );

  it.effect("remembers the server's expiry for tokens it cannot read", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        token: "opaque-token",
        respond: () =>
          Promise.resolve(Response.json({ renewed: false, expiresAt: isoAt(25 * DAY_MS) })),
      });
      yield* harness.start;
      yield* SubscriptionRef.set(harness.state, CONNECTED);
      yield* settle;
      yield* Queue.offer(harness.wakeups, "application-active");
      yield* settle;

      expect(harness.calls).toHaveLength(1);
      expect(yield* Ref.get(harness.replacements)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("runs a single renewal per connection at a time", () =>
    Effect.gen(function* () {
      const oldToken = sessionToken(5 * DAY_MS, "old");
      const newToken = sessionToken(35 * DAY_MS, "new");
      let release: (() => void) | undefined;
      const harness = yield* makeHarness({
        token: oldToken,
        respond: () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }).then(() => renewedResponse(newToken, 35 * DAY_MS)),
      });
      yield* harness.start;
      yield* SubscriptionRef.set(harness.state, CONNECTED);
      yield* settle;
      yield* Queue.offer(harness.wakeups, "application-active");
      yield* Queue.offer(harness.wakeups, "application-active-reconnect");
      yield* settle;
      expect(harness.calls).toHaveLength(1);

      release?.();
      yield* settle;
      expect(yield* Ref.get(harness.replacements)).toEqual([newToken]);
    }).pipe(Effect.scoped),
  );

  it.effect("picks up another window's renewal after the server declines a second one", () =>
    Effect.gen(function* () {
      const oldToken = sessionToken(5 * DAY_MS, "old");
      const winnerToken = sessionToken(35 * DAY_MS, "winner");
      const harness = yield* makeHarness({
        token: oldToken,
        respond: () =>
          Promise.resolve(
            Response.json({
              renewed: false,
              expiresAt: isoAt(5 * DAY_MS),
              reason: "already_renewed",
            }),
          ),
      });
      // The other window renewed first and saved its token.
      yield* Ref.set(harness.persistedToken, winnerToken);
      yield* harness.start;
      yield* SubscriptionRef.set(harness.state, CONNECTED);
      yield* settle;

      expect(harness.calls).toHaveLength(1);
      expect(yield* Ref.get(harness.replacements)).toEqual([]);
      expect(yield* Ref.get(harness.savedToken)).toBe(winnerToken);

      yield* Queue.offer(harness.wakeups, "application-active");
      yield* TestClock.adjust(Duration.hours(2));
      yield* settle;
      expect(harness.calls).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("never resends a declined token and adopts a renewal saved later", () =>
    Effect.gen(function* () {
      const oldToken = sessionToken(5 * DAY_MS, "old");
      const winnerToken = sessionToken(35 * DAY_MS, "winner");
      const harness = yield* makeHarness({
        token: oldToken,
        respond: () =>
          Promise.resolve(
            Response.json({
              renewed: false,
              expiresAt: isoAt(5 * DAY_MS),
              reason: "already_renewed",
            }),
          ),
      });
      yield* harness.start;
      yield* SubscriptionRef.set(harness.state, CONNECTED);
      yield* settle;
      expect(harness.calls).toHaveLength(1);
      expect(yield* Ref.get(harness.savedToken)).toBe(oldToken);

      // Still declined: later checks only re-read storage.
      yield* Queue.offer(harness.wakeups, "application-active");
      yield* settle;
      expect(harness.calls).toHaveLength(1);

      // The winning window's write lands; the next check adopts it.
      yield* Ref.set(harness.persistedToken, winnerToken);
      yield* Queue.offer(harness.wakeups, "application-active");
      yield* settle;
      expect(yield* Ref.get(harness.savedToken)).toBe(winnerToken);
      expect(harness.calls).toHaveLength(1);
      expect(yield* Ref.get(harness.replacements)).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
