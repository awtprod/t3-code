import { AuthBearerSessionRenewalWindowMs, type EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { renewRemoteBearerSession } from "../authorization/remote.ts";
import * as EnvironmentRegistry from "./registry.ts";
import * as ConnectionWakeups from "./wakeups.ts";

/**
 * Bearer sessions expire 30 days after issue. Paired clients renew theirs from
 * the environment shortly before that so nobody has to re-pair every month.
 *
 * The check is local (the token's `exp` claim) and cheap, so it runs on every
 * successful connect, on app activation, and hourly while connected. The
 * network is only used once a token is inside the server's renewal window.
 */
const BEARER_RENEWAL_CHECK_INTERVAL = Duration.hours(1);
/** How long to leave a connection alone after a renewal attempt failed. */
export const BEARER_RENEWAL_RETRY_DELAY = Duration.minutes(30);

/**
 * Desktop-local secondaries re-mint their token from the bootstrap seed on
 * every launch, so they are never renewed.
 */
const DESKTOP_LOCAL_CONNECTION_ID_PREFIX = "local:";

const decodeSessionTokenExpiry = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ exp: Schema.Finite })),
);

/**
 * Reads the `exp` claim (epoch milliseconds) of a server session token shaped
 * `base64url(JSON claims).signature`. The signature is not checked: the value
 * only decides when to ask the server, which validates the token itself.
 */
export function readSessionTokenExpiry(token: string): number | null {
  const separator = token.indexOf(".");
  if (separator <= 0) {
    return null;
  }
  const claims = Encoding.decodeBase64UrlString(token.slice(0, separator));
  if (Result.isFailure(claims)) {
    return null;
  }
  return Option.match(decodeSessionTokenExpiry(claims.success), {
    onNone: () => null,
    onSome: (decoded) => decoded.exp,
  });
}

/**
 * Failure summary for logs. Request errors can carry the outgoing request, and
 * with it the Authorization header, so only the tag and message are kept.
 */
function describeRenewalFailure(cause: Cause.Cause<unknown>): {
  readonly tag: string;
  readonly message: string;
} {
  const error = Cause.squash(cause);
  if (typeof error === "object" && error !== null) {
    const tag = "_tag" in error && typeof error._tag === "string" ? error._tag : "UnknownError";
    const message =
      "message" in error && typeof error.message === "string" ? error.message : String(tag);
    return { tag, message };
  }
  return { tag: "UnknownError", message: String(error) };
}

export type BearerRenewalDecision = "renew" | "not-due" | "expired";

/**
 * Unknown expiry (an unreadable token) asks the server, which answers cheaply
 * with the real expiry when the session is not due.
 */
export function bearerRenewalDecision(input: {
  readonly expiresAtMs: number | null;
  readonly nowMs: number;
}): BearerRenewalDecision {
  if (input.expiresAtMs === null) {
    return "renew";
  }
  if (input.expiresAtMs <= input.nowMs) {
    return "expired";
  }
  return input.expiresAtMs - input.nowMs <= AuthBearerSessionRenewalWindowMs ? "renew" : "not-due";
}

/**
 * Renews saved bearer credentials while their environments are connected.
 * Runs for the lifetime of the surrounding scope; failures are logged and
 * retried later, never surfaced to the connection.
 */
export const run = Effect.fn("clientRuntime.connection.bearerRenewal.run")(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const wakeups = yield* ConnectionWakeups.ConnectionWakeups;
  const httpClient = yield* HttpClient.HttpClient;
  const inFlight = yield* Ref.make<ReadonlySet<string>>(new Set());
  // Server-reported expiry, by token, for tokens whose claims could not be read.
  const knownExpiry = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  const retryAfter = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  // Tokens the server declined to renew while due: renewal is single use, so
  // another window or device already renewed it (or it is not renewable).
  // They are never sent again; the saved credential is re-read instead.
  const declined = yield* Ref.make<ReadonlySet<string>>(new Set());

  /** Re-reads the saved credential past any cache to pick up another window's renewal. */
  const pickUpRenewedElsewhere = Effect.fn(
    "clientRuntime.connection.bearerRenewal.pickUpRenewedElsewhere",
  )(function* (environmentId: EnvironmentId, declinedToken: string) {
    const fresh = yield* registry.savedBearerCredential(environmentId, { refresh: true });
    if (Option.isSome(fresh) && fresh.value.token !== declinedToken) {
      yield* Effect.logInfo("Using the bearer session renewed by another window.", {
        environmentId,
        connectionId: fresh.value.connectionId,
      });
    }
    return fresh;
  });

  const renewIfDue = Effect.fn("clientRuntime.connection.bearerRenewal.renewIfDue")(function* (
    environmentId: EnvironmentId,
  ) {
    const savedOption = yield* registry.savedBearerCredential(environmentId);
    if (Option.isNone(savedOption)) {
      return;
    }
    let saved = savedOption.value;
    if (saved.connectionId.startsWith(DESKTOP_LOCAL_CONNECTION_ID_PREFIX)) {
      return;
    }
    if ((yield* Ref.get(declined)).has(saved.token)) {
      const fresh = yield* pickUpRenewedElsewhere(environmentId, saved.token);
      if (Option.isNone(fresh) || (yield* Ref.get(declined)).has(fresh.value.token)) {
        return;
      }
      saved = fresh.value;
    }
    const nowMs = yield* Clock.currentTimeMillis;
    const expiresAtMs =
      readSessionTokenExpiry(saved.token) ?? (yield* Ref.get(knownExpiry)).get(saved.token) ?? null;
    if (bearerRenewalDecision({ expiresAtMs, nowMs }) !== "renew") {
      return;
    }
    if (((yield* Ref.get(retryAfter)).get(saved.connectionId) ?? 0) > nowMs) {
      return;
    }
    const claimed = yield* Ref.modify(inFlight, (current) =>
      current.has(saved.connectionId)
        ? ([false, current] as const)
        : ([true, new Set(current).add(saved.connectionId)] as const),
    );
    if (!claimed) {
      return;
    }

    yield* Effect.gen(function* () {
      const result = yield* renewRemoteBearerSession({
        httpBaseUrl: saved.httpBaseUrl,
        bearerToken: saved.token,
      }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
      if (!result.renewed) {
        yield* Ref.update(knownExpiry, (current) =>
          new Map(current).set(saved.token, result.expiresAt.epochMilliseconds),
        );
        const declinedWhileDue =
          result.reason === "already_renewed" ||
          result.reason === "not_renewable" ||
          (result.reason === undefined &&
            bearerRenewalDecision({
              expiresAtMs: result.expiresAt.epochMilliseconds,
              nowMs: yield* Clock.currentTimeMillis,
            }) !== "not-due");
        if (declinedWhileDue) {
          yield* Ref.update(declined, (current) => new Set(current).add(saved.token));
          yield* pickUpRenewedElsewhere(environmentId, saved.token);
        }
        return;
      }
      const replaced = yield* registry.replaceBearerCredential({
        environmentId,
        connectionId: saved.connectionId,
        previousToken: saved.token,
        token: result.access_token,
      });
      yield* Ref.update(knownExpiry, (current) => {
        const next = new Map(current);
        next.delete(saved.token);
        return next;
      });
      yield* replaced
        ? Effect.logInfo("Renewed the saved bearer session.", {
            environmentId,
            connectionId: saved.connectionId,
            expiresAt: result.expiresAt,
          })
        : Effect.logInfo("Discarded a bearer renewal; the saved connection changed meanwhile.", {
            environmentId,
            connectionId: saved.connectionId,
          });
    }).pipe(
      Effect.catchCause((cause) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((failedAtMs) =>
            Ref.update(retryAfter, (current) =>
              new Map(current).set(
                saved.connectionId,
                failedAtMs + Duration.toMillis(BEARER_RENEWAL_RETRY_DELAY),
              ),
            ),
          ),
          Effect.andThen(
            Effect.logWarning("Could not renew the saved bearer session; will retry later.", {
              environmentId,
              connectionId: saved.connectionId,
              failure: describeRenewalFailure(cause),
            }),
          ),
        ),
      ),
      Effect.ensuring(
        Ref.update(inFlight, (current) => {
          const next = new Set(current);
          next.delete(saved.connectionId);
          return next;
        }),
      ),
    );
  });

  const environmentIds = Stream.concat(
    Stream.fromEffect(SubscriptionRef.get(registry.entries)),
    SubscriptionRef.changes(registry.entries),
  ).pipe(
    Stream.map((entries) => [...entries.keys()].sort()),
    Stream.changesWith(
      (left, right) =>
        left.length === right.length && left.every((value, index) => value === right[index]),
    ),
  );

  // Successful connects: each environment's transition into `connected`.
  const connected = environmentIds.pipe(
    Stream.switchMap((ids) =>
      Stream.mergeAll(
        ids.map((environmentId) =>
          registry.stateChanges(environmentId).pipe(
            Stream.map((state) => state.phase === "connected"),
            Stream.changes,
            Stream.filter((isConnected) => isConnected),
            Stream.map(() => environmentId),
            Stream.catchCause(() => Stream.empty),
          ),
        ),
        { concurrency: "unbounded" },
      ),
    ),
  );

  const connectedNow = Effect.gen(function* () {
    const ids = [...(yield* SubscriptionRef.get(registry.entries)).keys()];
    const states = yield* Effect.forEach(ids, (environmentId) =>
      registry.state(environmentId).pipe(
        Effect.map((state) => (state.phase === "connected" ? [environmentId] : [])),
        Effect.orElseSucceed(() => []),
      ),
    );
    return states.flat();
  });

  // Periodic and app-activation sweeps over the connected environments.
  const sweeps = Stream.merge(
    Stream.tick(BEARER_RENEWAL_CHECK_INTERVAL),
    wakeups.changes.pipe(Stream.filter(ConnectionWakeups.isApplicationActiveWakeup)),
  ).pipe(
    Stream.mapEffect(() => connectedNow),
    Stream.flatMap(Stream.fromIterable),
  );

  yield* Stream.merge(connected, sweeps).pipe(
    Stream.runForEach((environmentId) =>
      renewIfDue(environmentId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Bearer session renewal check failed.", {
            environmentId,
            failure: describeRenewalFailure(cause),
          }),
        ),
        Effect.forkScoped,
      ),
    ),
  );
});
