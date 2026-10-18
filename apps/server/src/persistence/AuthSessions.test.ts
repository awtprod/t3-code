import { AuthSessionId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as AuthSessions from "./AuthSessions.ts";
import { layerMemory as SqlitePersistenceMemory } from "./Sqlite.ts";

const issuedAt = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const renewedAt = DateTime.makeUnsafe("2026-07-12T00:00:00.000Z");
const expiresAt = DateTime.makeUnsafe("2026-07-20T00:00:00.000Z");
const renewedExpiresAt = DateTime.makeUnsafe("2026-08-11T00:00:00.000Z");

const layer = AuthSessions.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));

const session = (
  sessionId: string,
  overrides?: Partial<AuthSessions.CreateAuthSessionInput>,
): AuthSessions.CreateAuthSessionInput => ({
  sessionId: AuthSessionId.make(sessionId),
  subject: "one-time-token",
  scopes: ["orchestration:read"],
  method: "bearer-access-token",
  client: {
    label: "Remote laptop",
    ipAddress: null,
    userAgent: null,
    deviceType: "desktop",
    os: null,
    browser: null,
  },
  issuedAt,
  expiresAt,
  ...overrides,
});

const successor = (sessionId: string) =>
  session(sessionId, { issuedAt: renewedAt, expiresAt: renewedExpiresAt });

describe("AuthSessionRepository renewal lineage", () => {
  it.effect("records exactly one successor when renewals race", () =>
    Effect.gen(function* () {
      const sessions = yield* AuthSessions.AuthSessionRepository;
      yield* sessions.create(session("original"));

      const results = yield* Effect.all(
        ["successor-a", "successor-b", "successor-c"].map((sessionId) =>
          sessions.createRenewal({
            previousSessionId: AuthSessionId.make("original"),
            session: successor(sessionId),
          }),
        ),
        { concurrency: "unbounded" },
      );

      assert.deepStrictEqual(
        results.filter((stored) => stored),
        [true],
      );
      const lineage = yield* sessions.listLineage({ sessionId: AuthSessionId.make("original") });
      assert.strictEqual(lineage.length, 2);
      assert.strictEqual(lineage[0]?.sessionId, "original");
      assert.isNotNull(lineage[0]?.renewedAt);
      assert.strictEqual(lineage[1]?.renewedFromSessionId, "original");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("does not renew revoked or expired sessions", () =>
    Effect.gen(function* () {
      const sessions = yield* AuthSessions.AuthSessionRepository;
      yield* sessions.create(session("revoked"));
      yield* sessions.create(session("expired", { expiresAt: renewedAt }));
      yield* sessions.revoke({ sessionId: AuthSessionId.make("revoked"), revokedAt: issuedAt });

      for (const previous of ["revoked", "expired"]) {
        const stored = yield* sessions.createRenewal({
          previousSessionId: AuthSessionId.make(previous),
          session: successor(`${previous}-successor`),
        });
        assert.isFalse(stored);
        assert.isTrue(
          (yield* sessions.getById({ sessionId: AuthSessionId.make(`${previous}-successor`) }))
            ._tag === "None",
        );
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("revokes the whole chain from any member and spares it for revoke-others", () =>
    Effect.gen(function* () {
      const sessions = yield* AuthSessions.AuthSessionRepository;
      const id = AuthSessionId.make;
      yield* sessions.create(session("root"));
      yield* sessions.create(session("bystander"));
      assert.isTrue(
        yield* sessions.createRenewal({ previousSessionId: id("root"), session: successor("mid") }),
      );
      assert.isTrue(
        yield* sessions.createRenewal({
          previousSessionId: id("mid"),
          session: session("leaf", {
            issuedAt: DateTime.makeUnsafe("2026-08-02T00:00:00.000Z"),
            expiresAt: DateTime.makeUnsafe("2026-09-10T00:00:00.000Z"),
          }),
        }),
      );

      assert.deepStrictEqual(
        (yield* sessions.listLineage({ sessionId: id("mid") })).map((row) => row.sessionId),
        ["root", "mid", "leaf"],
      );
      assert.deepStrictEqual(
        yield* sessions.revokeAllExcept({ currentSessionId: id("leaf"), revokedAt: renewedAt }),
        [id("bystander")],
      );
      const revoked = yield* sessions.revoke({ sessionId: id("mid"), revokedAt: renewedAt });
      assert.deepStrictEqual([...revoked].sort(), ["leaf", "mid", "root"]);
      assert.deepStrictEqual(
        yield* sessions.revoke({ sessionId: id("leaf"), revokedAt: renewedAt }),
        [],
      );
    }).pipe(Effect.provide(layer)),
  );
});
