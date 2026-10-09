// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { inspectReelFile } from "./InstagramPublishLive.ts";
import { describe, expect, it, beforeEach, afterEach } from "@effect/vitest";
import {
  AuthSessionId,
  ThreadId,
  CommandCenterError,
  AuthCommandCenterApproveScope,
  AuthCommandCenterOperateScope,
  AuthCommandCenterReadScope,
  type InstagramReelBinding,
  type InstagramReelReceipt,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { migrationManifest, runMigrations } from "../../../persistence/Migrations.ts";
import migration, {
  createInstagramReelTable,
} from "../../../persistence/Migrations/078_InstagramReelReceipts.ts";
import type { AuthenticatedSession } from "../../../auth/EnvironmentAuth.ts";
import {
  make,
  bindingDigest,
  type InstagramPublishPorts,
  type ReelApi,
} from "./InstagramPublish.ts";
import { InstagramClient } from "./client.ts";

const T0 = Date.parse("2026-10-02T21:59:00.000Z");
const DUE = T0 + 60_000;
const scopes = [
  AuthCommandCenterApproveScope,
  AuthCommandCenterOperateScope,
  AuthCommandCenterReadScope,
];
const session: AuthenticatedSession = {
  sessionId: AuthSessionId.make("test-user-session"),
  subject: "andrew-test",
  method: "bearer-access-token",
  scopes,
};
const binding: InstagramReelBinding = {
  version: 1,
  accountId: "17841400000000000",
  accountRevision: 10,
  threadId: ThreadId.make("test-thread"),
  relativePath: "exports/reel.mp4",
  workspaceRoot: "/tmp/test-authorized-project",
  sha256: "a".repeat(64),
  sizeBytes: 100,
  durationMs: 30000,
  caption: "Exact caption 😳\n",
  dueUtc: "2026-10-02T22:00:00.000Z",
  lateWindowMs: 120000,
};
const problem = () => new CommandCenterError({ reason: "validation", message: "Asset changed" });
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE auth_sessions(session_id TEXT PRIMARY KEY, subject TEXT, scopes TEXT, expires_at TEXT, revoked_at TEXT)`;
  yield* sql`INSERT INTO auth_sessions VALUES (${session.sessionId}, ${session.subject}, ${JSON.stringify(scopes)}, '2026-10-03T22:00:00.000Z', NULL)`;
  yield* createInstagramReelTable;
  const calls = { create: 0, publish: 0, status: 0, permalink: 0, recent: 0 };
  const control = {
    accountId: binding.accountId,
    revision: binding.accountRevision,
    assetChanged: false,
    accountUnavailable: null as "disconnected" | "expired" | null,
    status: "FINISHED",
    statusId: "900001",
    createResult: { id: "900001" } as unknown,
    publishResult: { id: "900002" } as unknown,
    failCreate: false,
    failPublish: false,
    failPermalink: false,
    permalinkResult: { permalink: "https://www.instagram.com/reel/test/" } as unknown,
    recent: { data: [] } as unknown,
    beforeCreate: undefined as (() => Promise<void>) | undefined,
    beforePublish: undefined as (() => Promise<void>) | undefined,
    pendingCreate: false,
  };
  const api: ReelApi = {
    create: async (_b, _url, signal) => {
      calls.create++;
      if (control.pendingCreate)
        return new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
        );
      await control.beforeCreate?.();
      if (control.failCreate) throw new Error("Lost create response");
      return control.createResult;
    },
    status: async () => {
      calls.status++;
      return { id: control.statusId, status_code: control.status };
    },
    publish: async () => {
      calls.publish++;
      await control.beforePublish?.();
      if (control.failPublish) throw new Error("Lost publish response");
      return control.publishResult;
    },
    permalink: async () => {
      calls.permalink++;
      if (control.failPermalink) throw new Error("Read failed");
      return control.permalinkResult;
    },
    recent: async () => {
      calls.recent++;
      return control.recent;
    },
  };
  const ports: InstagramPublishPorts = {
    account: Effect.suspend(() =>
      control.accountUnavailable
        ? Effect.fail(
            new CommandCenterError({
              reason: "validation",
              message: `Instagram account ${control.accountUnavailable}.`,
            }),
          )
        : Effect.succeed({ id: control.accountId, revision: control.revision, api }),
    ),
    inspect: () => (control.assetChanged ? Effect.fail(problem()) : Effect.void),
    host: () => Effect.succeed("https://immutable-assets.test/private-capability/reel.mp4"),
  };
  const service = yield* make(ports);
  const admit = Effect.gen(function* () {
    const r = yield* service.request(binding, session);
    return yield* service.approve(r.id, r.digest, session);
  });
  const raw = Effect.fn("test.raw")(function* (id: string) {
    const rows = yield* sql<{
      receipt_json: string;
    }>`SELECT receipt_json FROM command_center_instagram_reels WHERE id = ${id}`;
    return JSON.parse(rows[0]!.receipt_json) as InstagramReelReceipt;
  });
  const patch = Effect.fn("test.patch")(function* (
    id: string,
    changes: Partial<InstagramReelReceipt>,
  ) {
    const next = { ...(yield* raw(id)), ...changes };
    yield* sql`UPDATE command_center_instagram_reels SET receipt_json = ${JSON.stringify(next)}, state = ${next.state}, lease_until = 0 WHERE id = ${id}`;
  });
  return { sql, calls, control, ports, service, admit, raw, patch };
});
const withDb = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layerMemory()));
let previousFlag: string | undefined;
beforeEach(() => {
  previousFlag = process.env.INSTAGRAM_PUBLISHING_ENABLED;
  process.env.INSTAGRAM_PUBLISHING_ENABLED = "true";
});
afterEach(() => {
  if (previousFlag === undefined) delete process.env.INSTAGRAM_PUBLISHING_ENABLED;
  else process.env.INSTAGRAM_PUBLISHING_ENABLED = previousFlag;
});

const test = <E>(
  name: string,
  body: (f: Effect.Success<typeof fixture>) => Effect.Effect<void, E, SqlClient.SqlClient>,
) =>
  it.effect(name, () =>
    withDb(
      Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        const f = yield* fixture;
        yield* body(f);
      }),
    ),
  );

describe("durable Instagram production executor", () => {
  test("concurrent requests, approvals and independent workers produce exactly one create/publish", (f) =>
    Effect.gen(function* () {
      const admissions = yield* Effect.all(
        Array.from({ length: 12 }, () => f.service.request(binding, session)),
        { concurrency: "unbounded" },
      );
      expect(new Set(admissions.map((r) => r.id)).size).toBe(1);
      const approvals = yield* Effect.all(
        admissions.map((r) => f.service.approve(r.id, r.digest, session)),
        { concurrency: "unbounded" },
      );
      expect(new Set(approvals.map((r) => r.approvalId)).size).toBe(1);
      yield* f.service.tick;
      expect(f.calls.create).toBe(0);
      yield* TestClock.setTime(DUE);
      const second = yield* make(f.ports);
      yield* Effect.all([f.service.tick, second.tick, f.service.tick], {
        concurrency: "unbounded",
      });
      yield* second.tick;
      const r = yield* f.raw(admissions[0]!.id);
      expect(f.calls.create).toBe(1);
      expect(f.calls.publish).toBe(1);
      expect(r.state).toBe("published");
      expect(r.binding.caption).toBe(binding.caption);
      expect(r.createIntentAt).toBeGreaterThanOrEqual(DUE);
      expect(r.publishIntentAt).toBeGreaterThanOrEqual(DUE);
      expect(r.permalink).toBe("https://www.instagram.com/reel/test/");
    }));
  for (const flag of [undefined, "false", "TRUE", " true", "1"])
    test(`flag ${String(flag)} prevents every POST`, (f) =>
      Effect.gen(function* () {
        yield* f.admit;
        if (flag === undefined) delete process.env.INSTAGRAM_PUBLISHING_ENABLED;
        else process.env.INSTAGRAM_PUBLISHING_ENABLED = flag;
        yield* TestClock.setTime(DUE);
        yield* f.service.tick;
        expect(f.calls.create + f.calls.publish).toBe(0);
      }));
  for (const changed of [
    "account",
    "revision",
    "asset",
    "approval-expired",
    "session-revoked",
    "scope-removed",
    "late",
    "canceled",
  ])
    test(`${changed} invalidates effect`, (f) =>
      Effect.gen(function* () {
        const r = yield* f.admit;
        if (changed === "account") f.control.accountId = "17841499999999999";
        if (changed === "revision") f.control.revision++;
        if (changed === "asset") f.control.assetChanged = true;
        if (changed === "approval-expired") yield* f.patch(r.id, { approvalExpiresAt: DUE });
        if (changed === "session-revoked")
          yield* f.sql`UPDATE auth_sessions SET revoked_at = '2026-10-02T21:59:30.000Z'`;
        if (changed === "scope-removed") yield* f.sql`UPDATE auth_sessions SET scopes = '[]'`;
        if (changed === "canceled") yield* f.service.cancel(r.id, session);
        yield* TestClock.setTime(changed === "late" ? DUE + binding.lateWindowMs : DUE);
        yield* f.service.tick;
        expect(f.calls.create + f.calls.publish).toBe(0);
      }));
  for (const field of [
    "accountId",
    "sha256",
    "sizeBytes",
    "durationMs",
    "caption",
    "dueUtc",
    "lateWindowMs",
  ] as const)
    test(`changed persisted ${field} cannot execute`, (f) =>
      Effect.gen(function* () {
        const r = yield* f.admit;
        const changed = {
          ...r.binding,
          [field]:
            typeof r.binding[field] === "number"
              ? Number(r.binding[field]) + 1
              : String(r.binding[field]) + "x",
        };
        yield* f.patch(r.id, { binding: changed });
        yield* TestClock.setTime(DUE);
        yield* Effect.result(f.service.tick);
        expect(f.calls.create + f.calls.publish).toBe(0);
      }));
  test("unauthorized and malformed callers cannot request or forge approval", (f) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(f.service.request(binding, { ...session, scopes: [] }));
      expect(result._tag).toBe("Failure");
      const malformed = yield* Effect.result(
        f.service.request({ ...binding, sizeBytes: -1 }, session),
      );
      expect(malformed._tag).toBe("Failure");
      const r = yield* f.service.request(binding, session);
      const forged = yield* Effect.result(f.service.approve(r.id, "b".repeat(64), session));
      expect(forged._tag).toBe("Failure");
      yield* TestClock.setTime(DUE);
      yield* f.service.tick;
      expect(f.calls.create + f.calls.publish).toBe(0);
    }));
  test("logical post identity prevents a second admission with changed window", (f) =>
    Effect.gen(function* () {
      yield* f.admit;
      const changed = yield* Effect.result(
        f.service.request({ ...binding, lateWindowMs: 60000 }, session),
      );
      expect(changed._tag).toBe("Failure");
    }));
  test("changed-caption sequential admission conflicts before and after approval", (f) =>
    Effect.gen(function* () {
      const r = yield* f.service.request(binding, session);
      const changed = { ...binding, caption: "A different full caption" };
      for (const approved of [false, true]) {
        if (approved) yield* f.service.approve(r.id, r.digest, session);
        expect((yield* Effect.result(f.service.request(changed, session)))._tag).toBe("Failure");
        expect(
          (yield* Effect.result(f.service.approve(r.id, bindingDigest(changed), session)))._tag,
        ).toBe("Failure");
      }
      const rows = yield* f.sql`SELECT id FROM command_center_instagram_reels`;
      expect(rows).toHaveLength(1);
      expect((yield* f.service.query(r.id, session)).binding.caption).toBe(binding.caption);
      yield* TestClock.setTime(DUE);
      const restarted = yield* make(f.ports);
      yield* Effect.all([f.service.tick, restarted.tick], { concurrency: "unbounded" });
      yield* restarted.tick;
      expect(f.calls.create).toBe(1);
      expect(f.calls.publish).toBe(1);
    }));
  test("changed-caption concurrent admissions share one logical row and one approved effect", (f) =>
    Effect.gen(function* () {
      const changed = { ...binding, caption: "Concurrent alternative caption" };
      const results = yield* Effect.all(
        Array.from({ length: 12 }, (_, i) =>
          f.service
            .request(i % 2 ? changed : binding, session)
            .pipe(Effect.match({ onFailure: () => null, onSuccess: (r) => r })),
        ),
        { concurrency: "unbounded" },
      );
      const admitted = results.filter((r) => r !== null);
      expect(admitted).toHaveLength(6);
      expect(results.filter((r) => r === null)).toHaveLength(6);
      expect(new Set(admitted.map((r) => r.id)).size).toBe(1);
      expect(yield* f.sql`SELECT id FROM command_center_instagram_reels`).toHaveLength(1);
      yield* Effect.all(
        admitted.map((r) => f.service.approve(r.id, r.digest, session)),
        { concurrency: "unbounded" },
      );
      yield* TestClock.setTime(DUE);
      const second = yield* make(f.ports);
      yield* Effect.all([f.service.tick, second.tick], { concurrency: "unbounded" });
      yield* second.tick;
      expect(f.calls.create).toBe(1);
      expect(f.calls.publish).toBe(1);
    }));
  for (const tombstone of ["canceled", "uncertain"] as const)
    test(`changed-caption ${tombstone} tombstone refuses admission and reapproval across restart`, (f) =>
      Effect.gen(function* () {
        const r = yield* f.admit;
        if (tombstone === "uncertain")
          yield* f.patch(r.id, {
            state: "publishing",
            containerId: "900001",
            publishIntentAt: DUE,
          });
        const canceled = yield* f.service.cancel(r.id, session);
        expect(canceled.state).toBe(tombstone);
        const restarted = yield* make(f.ports);
        const changed = { ...binding, caption: "Replacement must remain forbidden" };
        const reason = yield* restarted.request(changed, session).pipe(
          Effect.match({
            onFailure: (e) => e.message,
            onSuccess: () => "unexpected admission",
          }),
        );
        expect(reason).toContain("Cancellation does not permit replacement");
        expect((yield* restarted.request(binding, session)).state).toBe(tombstone);
        expect((yield* Effect.result(restarted.approve(r.id, r.digest, session)))._tag).toBe(
          "Failure",
        );
        expect(yield* f.sql`SELECT id FROM command_center_instagram_reels`).toHaveLength(1);
        yield* TestClock.setTime(DUE);
        yield* restarted.tick;
        yield* restarted.tick;
        expect(f.calls.create + f.calls.publish).toBe(0);
        expect((yield* f.raw(r.id)).state).toBe(tombstone);
      }));
  test("changed connection revision still conflicts at admission after private snapshot validation", (f) =>
    Effect.gen(function* () {
      const r = yield* f.admit;
      f.control.revision++;
      expect(
        (yield* Effect.result(
          f.service.request({ ...binding, accountRevision: f.control.revision }, session),
        ))._tag,
      ).toBe("Failure");
      expect(yield* f.sql`SELECT id FROM command_center_instagram_reels`).toHaveLength(1);
      expect((yield* f.raw(r.id)).binding.accountRevision).toBe(binding.accountRevision);
      yield* TestClock.setTime(DUE);
      yield* f.service.tick;
      expect(f.calls.create + f.calls.publish).toBe(0);
    }));
  for (const state of ["creating", "publishing"] as const)
    test(`restart from ${state} intent never retries POST`, (f) =>
      Effect.gen(function* () {
        const r = yield* f.admit;
        yield* f.patch(r.id, {
          state,
          createIntentAt: DUE,
          containerId: state === "publishing" ? "900001" : null,
          publishIntentAt: state === "publishing" ? DUE : null,
        });
        yield* TestClock.setTime(DUE);
        const restarted = yield* make(f.ports);
        yield* restarted.tick;
        yield* restarted.tick;
        expect(f.calls.create + f.calls.publish).toBe(0);
        expect((yield* f.raw(r.id)).state).toBe("uncertain");
      }));
  for (const operation of ["create", "publish"] as const)
    test(`lost ${operation} response stays uncertain across restart`, (f) =>
      Effect.gen(function* () {
        const r = yield* f.admit;
        f.control.failCreate = operation === "create";
        f.control.failPublish = operation === "publish";
        yield* TestClock.setTime(DUE);
        yield* f.service.tick;
        const restarted = yield* make(f.ports);
        yield* restarted.tick;
        yield* restarted.tick;
        expect(f.calls.create).toBe(1);
        expect(f.calls.publish).toBe(operation === "publish" ? 1 : 0);
        expect((yield* f.raw(r.id)).state).toBe("uncertain");
      }));
  for (const status of ["ERROR", "EXPIRED", "UNKNOWN", "PUBLISHED"])
    test(`container ${status} cannot authorize a publish`, (f) =>
      Effect.gen(function* () {
        const r = yield* f.admit;
        f.control.status = status;
        yield* TestClock.setTime(DUE);
        yield* f.service.tick;
        yield* f.service.tick;
        expect(f.calls.publish).toBe(0);
        expect((yield* f.raw(r.id)).state).not.toBe("published");
      }));
  test("PUBLISHED uncertain container does bounded read-only reconciliation without guessing media ID", (f) =>
    Effect.gen(function* () {
      const r = yield* f.admit;
      f.control.failPublish = true;
      yield* TestClock.setTime(DUE);
      yield* f.service.tick;
      f.control.status = "PUBLISHED";
      f.control.recent = {
        data: [
          { id: "900002", caption: binding.caption, timestamp: binding.dueUtc },
          { id: "900003", caption: binding.caption, timestamp: binding.dueUtc },
        ],
        paging: { next: "https://graph.instagram.test/next" },
      };
      for (let i = 0; i < 6; i++) yield* f.service.tick;
      expect(f.calls.publish).toBe(1);
      expect(f.calls.recent).toBe(3);
      const receipt = yield* f.raw(r.id);
      expect(receipt.state).toBe("uncertain");
      expect(receipt.mediaId).toBeNull();
      expect(receipt.detail).toContain("Human reconciliation");
    }));
  test("missing permalink retries GET only and remains published", (f) =>
    Effect.gen(function* () {
      const r = yield* f.admit;
      yield* TestClock.setTime(DUE);
      yield* f.service.tick;
      f.control.failPermalink = true;
      yield* f.service.tick;
      expect((yield* f.raw(r.id)).state).toBe("published");
      f.control.failPermalink = false;
      const restarted = yield* make(f.ports);
      yield* restarted.tick;
      expect(f.calls.publish).toBe(1);
      expect(f.calls.permalink).toBe(2);
      expect((yield* f.raw(r.id)).permalink).not.toBeNull();
    }));
  for (const recoveryState of ["uncertain", "published"] as const)
    for (const activeState of ["approved", "processing"] as const)
      test(`due ${activeState} progresses ahead of 25 older ${recoveryState} receipts from a replaced connection`, (f) =>
        Effect.gen(function* () {
          const staleIds: string[] = [];
          for (let i = 0; i < 25; i++) {
            const oldBinding = {
              ...binding,
              dueUtc: DateTime.formatIso(DateTime.makeUnsafe(T0 + (i + 1) * 1000)),
            };
            const old = yield* f.service.request(oldBinding, session);
            yield* f.service.approve(old.id, old.digest, session);
            yield* f.patch(old.id, {
              state: recoveryState,
              createIntentAt: T0,
              containerId: "900001",
              publishIntentAt: T0,
              mediaId: recoveryState === "published" ? "900002" : null,
              publishedAt: recoveryState === "published" ? T0 : null,
            });
            staleIds.push(old.id);
          }
          f.control.revision++;
          const active = yield* f.service.request(
            { ...binding, accountRevision: f.control.revision },
            session,
          );
          yield* f.service.approve(active.id, active.digest, session);
          if (activeState === "processing")
            yield* f.patch(active.id, {
              state: "processing",
              createIntentAt: DUE,
              containerId: "900001",
            });
          yield* TestClock.setTime(DUE);
          yield* f.service.tick;
          expect((yield* f.raw(active.id)).state).toBe("published");
          expect(f.calls).toEqual({
            create: activeState === "approved" ? 1 : 0,
            publish: 1,
            status: 1,
            permalink: 0,
            recent: 0,
          });
          const stale = yield* Effect.forEach(staleIds, (id) => f.raw(id));
          for (const receipt of stale) {
            expect(receipt.state).toBe(recoveryState);
            expect(receipt.readAttempts).toBe(0);
            expect(receipt.permalink).toBeNull();
            expect(receipt.binding.accountRevision).toBe(binding.accountRevision);
          }
          // One active action and 24 guarded recovery attempts fill the bounded batch.
          expect(
            stale.filter((receipt) => receipt.detail?.includes("Read-only recovery held")),
          ).toHaveLength(24);
          expect(stale[24]!.detail).toBeNull();
        }));
  test("new approval rotates past 25 older IN_PROGRESS containers across restart at a frozen clock", (f) =>
    Effect.gen(function* () {
      const olderReceipts: InstagramReelReceipt[] = [];
      for (let i = 0; i < 25; i++) {
        const older = yield* f.service.request(
          {
            ...binding,
            sha256: i.toString(16).padStart(64, "0"),
            dueUtc: DateTime.formatIso(DateTime.makeUnsafe(T0 + 1000)),
          },
          session,
        );
        yield* f.service.approve(older.id, older.digest, session);
        yield* f.patch(older.id, {
          state: "processing",
          createIntentAt: T0 + 1000,
          containerId: "900001",
        });
        olderReceipts.push(yield* f.raw(older.id));
      }
      const current = yield* f.admit;
      expect(new Set([...olderReceipts.map((receipt) => receipt.id), current.id]).size).toBe(26);
      f.control.status = "IN_PROGRESS";
      yield* TestClock.setTime(DUE);
      yield* f.service.tick;
      const firstClaims = yield* f.sql<{
        claims: number;
      }>`SELECT SUM(lease_generation) AS claims FROM command_center_instagram_reels`;
      expect(firstClaims[0]!.claims).toBe(25);
      expect((yield* f.raw(current.id)).state).toBe("approved");
      expect(f.calls).toEqual({ create: 0, publish: 0, status: 25, permalink: 0, recent: 0 });

      const restarted = yield* make(f.ports);
      yield* restarted.tick;
      const secondClaims = yield* f.sql<{
        claims: number;
      }>`SELECT SUM(lease_generation) AS claims FROM command_center_instagram_reels`;
      expect(secondClaims[0]!.claims).toBe(50);
      expect(yield* Clock.currentTimeMillis).toBe(DUE);
      expect(DUE).toBeLessThan(Date.parse(current.binding.dueUtc) + current.binding.lateWindowMs);
      const admitted = yield* f.raw(current.id);
      expect({ state: admitted.state, creates: f.calls.create }).toEqual({
        state: "processing",
        creates: 1,
      });
      expect(admitted.createIntentAt).toBe(DUE);
      expect(admitted.containerId).toBe("900001");
      expect(admitted.readAttempts).toBe(0);
      expect(admitted.detail).toBeNull();
      expect(f.calls).toEqual({ create: 1, publish: 0, status: 50, permalink: 0, recent: 0 });
      for (const original of olderReceipts) {
        expect(original.binding.accountRevision).toBe(f.control.revision);
        expect(DUE).toBeLessThan(
          Date.parse(original.binding.dueUtc) + original.binding.lateWindowMs,
        );
        expect(yield* f.raw(original.id)).toEqual(original);
      }
    }));
  for (const heldState of ["uncertain", "published"] as const)
    for (const recoveryState of ["uncertain", "published"] as const)
      for (const equalDue of heldState === recoveryState ? [false, true] : [false])
        test(`current ${recoveryState} recovery rotates past 25 held ${heldState} receipts with ${equalDue ? "equal" : "older"} due times across restart at a frozen clock`, (f) =>
          Effect.gen(function* () {
            const heldReceipts: InstagramReelReceipt[] = [];
            for (let i = 0; i < 25; i++) {
              const old = yield* f.service.request(
                {
                  ...binding,
                  sha256: i.toString(16).padStart(64, "0"),
                  dueUtc: equalDue
                    ? binding.dueUtc
                    : DateTime.formatIso(DateTime.makeUnsafe(T0 + 1000)),
                },
                session,
              );
              yield* f.service.approve(old.id, old.digest, session);
              yield* f.patch(old.id, {
                state: heldState,
                createIntentAt: T0,
                containerId: "900001",
                publishIntentAt: T0,
                mediaId: heldState === "published" ? "900002" : null,
                publishedAt: heldState === "published" ? T0 : null,
              });
              heldReceipts.push(yield* f.raw(old.id));
            }
            f.control.revision++;
            const current = yield* f.service.request(
              { ...binding, accountRevision: f.control.revision },
              session,
            );
            yield* f.service.approve(current.id, current.digest, session);
            yield* f.patch(current.id, {
              state: recoveryState,
              createIntentAt: T0,
              containerId: "900001",
              publishIntentAt: T0,
              mediaId: recoveryState === "published" ? "900002" : null,
              publishedAt: recoveryState === "published" ? T0 : null,
            });
            f.control.status = "PUBLISHED";
            f.control.recent = {
              data: [{ id: "900002", caption: binding.caption, timestamp: binding.dueUtc }],
            };
            yield* TestClock.setTime(DUE);
            yield* f.service.tick;
            const firstClaims = yield* f.sql<{
              claims: number;
            }>`SELECT SUM(lease_generation) AS claims FROM command_center_instagram_reels`;
            expect(firstClaims[0]!.claims).toBe(25);
            expect(f.calls).toEqual({ create: 0, publish: 0, status: 0, permalink: 0, recent: 0 });
            expect((yield* f.raw(current.id)).readAttempts).toBe(0);
            const restarted = yield* make(f.ports);
            yield* restarted.tick;
            const secondClaims = yield* f.sql<{
              claims: number;
            }>`SELECT SUM(lease_generation) AS claims FROM command_center_instagram_reels`;
            expect(secondClaims[0]!.claims).toBe(50);
            expect(yield* Clock.currentTimeMillis).toBe(DUE);
            expect(f.calls).toEqual({
              create: 0,
              publish: 0,
              status: recoveryState === "uncertain" ? 1 : 0,
              permalink: recoveryState === "published" ? 1 : 0,
              recent: recoveryState === "uncertain" ? 1 : 0,
            });
            const recovered = yield* f.raw(current.id);
            expect(recovered.state).toBe(recoveryState);
            expect(recovered.readAttempts).toBe(1);
            expect(recovered.mediaId).toBe(recoveryState === "published" ? "900002" : null);
            expect(recovered.permalink).toBe(
              recoveryState === "published" ? "https://www.instagram.com/reel/test/" : null,
            );
            if (recoveryState === "uncertain")
              expect(recovered.detail).toContain("Human reconciliation required");
            for (const original of heldReceipts) {
              const held = yield* f.raw(original.id);
              expect(held.detail).toContain("Read-only recovery held");
              expect(held).toEqual({
                ...original,
                updatedAt: DUE,
                detail: held.detail,
              });
              expect(held.readAttempts).toBe(0);
            }
          }));
  for (const state of ["uncertain", "published"] as const) {
    for (const snapshot of [
      "wrong-account",
      "changed-revision",
      "bad-revision",
      "disconnected",
      "expired",
    ] as const)
      test(`recovery ${state} holds ${snapshot} snapshot before any API call or read-budget use`, (f) =>
        Effect.gen(function* () {
          const r = yield* f.admit;
          f.control.failPublish = state === "uncertain";
          yield* TestClock.setTime(DUE);
          yield* f.service.tick;
          expect((yield* f.raw(r.id)).state).toBe(state);
          const before = { ...f.calls };
          const attempts = (yield* f.raw(r.id)).readAttempts;
          // All GET effect boundaries would succeed if the account gate were absent.
          f.control.status = "PUBLISHED";
          if (snapshot === "wrong-account") f.control.accountId = "17841499999999999";
          if (snapshot === "changed-revision") f.control.revision++;
          if (snapshot === "bad-revision") f.control.revision = Number.NaN;
          if (snapshot === "disconnected" || snapshot === "expired")
            f.control.accountUnavailable = snapshot;
          f.control.assetChanged = true;
          yield* f.sql`UPDATE auth_sessions SET revoked_at = '2026-10-02T22:01:00.000Z'`;
          yield* TestClock.setTime(DUE + binding.lateWindowMs + 1);
          const restarted = yield* make(f.ports);
          for (let i = 0; i < 5; i++) yield* restarted.tick;
          const held = yield* f.raw(r.id);
          expect(f.calls).toEqual(before);
          expect(held.state).toBe(state);
          expect(held.readAttempts).toBe(attempts);
          expect(held.mediaId).toBe(state === "published" ? "900002" : null);
          expect(held.permalink).toBeNull();
          expect(held.detail).toContain("Read-only recovery held");
          // A later matching snapshot resumes only GETs without restoring mutation authority.
          f.control.accountId = binding.accountId;
          f.control.revision = binding.accountRevision;
          f.control.accountUnavailable = null;
          yield* restarted.tick;
          const recovered = yield* f.raw(r.id);
          expect(recovered.state).toBe(state);
          expect(recovered.readAttempts).toBe(attempts + 1);
          expect(f.calls.create).toBe(before.create);
          expect(f.calls.publish).toBe(before.publish);
          expect(f.calls.status).toBe(before.status + (state === "uncertain" ? 1 : 0));
          expect(f.calls.recent).toBe(before.recent + (state === "uncertain" ? 1 : 0));
          expect(f.calls.permalink).toBe(before.permalink + (state === "published" ? 1 : 0));
        }));
    test(`matching ${state} recovery stays GET-only without asset, approval or mutation window`, (f) =>
      Effect.gen(function* () {
        const r = yield* f.admit;
        f.control.failPublish = state === "uncertain";
        yield* TestClock.setTime(DUE);
        yield* f.service.tick;
        const before = { ...f.calls };
        yield* f.patch(r.id, { approvalExpiresAt: DUE });
        f.control.assetChanged = true;
        f.control.status = "PUBLISHED";
        f.control.failPermalink = true;
        yield* f.sql`UPDATE auth_sessions SET expires_at = '2026-10-02T22:00:00.000Z', revoked_at = '2026-10-02T22:00:00.000Z'`;
        delete process.env.INSTAGRAM_PUBLISHING_ENABLED;
        yield* TestClock.setTime(DUE + binding.lateWindowMs + 1);
        const restarted = yield* make(f.ports);
        for (let i = 0; i < 6; i++) yield* restarted.tick;
        const receipt = yield* f.raw(r.id);
        expect(receipt.state).toBe(state);
        expect(receipt.readAttempts).toBe(3);
        expect(f.calls.create).toBe(before.create);
        expect(f.calls.publish).toBe(before.publish);
        expect(f.calls.status).toBe(before.status + (state === "uncertain" ? 3 : 0));
        expect(f.calls.recent).toBe(before.recent + (state === "uncertain" ? 3 : 0));
        expect(f.calls.permalink).toBe(before.permalink + (state === "published" ? 3 : 0));
      }));
  }
  test("processing survives restart and stops at late cutoff", (f) =>
    Effect.gen(function* () {
      const r = yield* f.admit;
      f.control.status = "IN_PROGRESS";
      yield* TestClock.setTime(DUE);
      yield* f.service.tick;
      expect((yield* f.raw(r.id)).state).toBe("processing");
      const restarted = yield* make(f.ports);
      yield* restarted.tick;
      yield* TestClock.setTime(DUE + binding.lateWindowMs);
      yield* restarted.tick;
      expect(f.calls.create).toBe(1);
      expect(f.calls.publish).toBe(0);
      expect((yield* f.raw(r.id)).state).toBe("error");
    }));
  test("guards are repeated after create response before publish", (f) =>
    Effect.gen(function* () {
      const r = yield* f.admit;
      f.control.beforeCreate = async () => {
        f.control.revision++;
      };
      yield* TestClock.setTime(DUE);
      yield* f.service.tick;
      expect(f.calls.create).toBe(1);
      expect(f.calls.publish).toBe(0);
      expect((yield* f.raw(r.id)).state).toBe("error");
    }));
  test("lease expiry while create is in flight fences receipt and prevents replay", (f) =>
    Effect.gen(function* () {
      const r = yield* f.admit;
      const sent = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      f.control.beforeCreate = async () => {
        sent.resolve();
        await release.promise;
      };
      yield* TestClock.setTime(DUE);
      const fiber = yield* Effect.forkChild(f.service.tick);
      yield* Effect.promise(() => sent.promise);
      yield* TestClock.adjust("61 seconds");
      const restarted = yield* make(f.ports);
      yield* restarted.tick;
      release.resolve();
      yield* Fiber.await(fiber);
      expect(f.calls.create).toBe(1);
      expect(f.calls.publish).toBe(0);
      expect((yield* f.raw(r.id)).state).toBe("uncertain");
    }));
  test("shutdown interrupts create into uncertain and no new worker retries", (f) =>
    Effect.gen(function* () {
      const r = yield* f.admit;
      f.control.pendingCreate = true;
      yield* TestClock.setTime(DUE);
      const fiber = yield* Effect.forkChild(f.service.tick);
      yield* Effect.yieldNow;
      // Wait on durable intent rather than a wall-clock sleep.
      for (let i = 0; i < 1000 && f.calls.create === 0; i++) yield* Effect.yieldNow;
      expect(f.calls.create).toBe(1);
      yield* Fiber.interrupt(fiber);
      const restarted = yield* make(f.ports);
      yield* restarted.tick;
      expect(f.calls.create).toBe(1);
      expect((yield* f.raw(r.id)).state).toBe("uncertain");
    }));

  for (const phase of ["processing", "published"] as const)
    test(`response before ${phase} save failure never repeats POST`, (f) =>
      Effect.gen(function* () {
        const r = yield* f.admit;
        yield* f.sql.unsafe(
          `CREATE TRIGGER fail_response_save BEFORE UPDATE ON command_center_instagram_reels WHEN NEW.state = '${phase}' BEGIN SELECT RAISE(ABORT, 'simulated receipt save failure'); END`,
        );
        yield* TestClock.setTime(DUE);
        yield* f.service.tick;
        yield* f.sql`DROP TRIGGER fail_response_save`;
        const restarted = yield* make(f.ports);
        yield* restarted.tick;
        yield* restarted.tick;
        expect(f.calls.create).toBe(1);
        expect(f.calls.publish).toBe(phase === "published" ? 1 : 0);
        expect((yield* f.raw(r.id)).state).toBe("uncertain");
      }));
  for (const stage of ["create", "publish"] as const)
    test(`malformed ${stage} response ID cannot be retried`, (f) =>
      Effect.gen(function* () {
        const r = yield* f.admit;
        if (stage === "create") f.control.createResult = { id: "../wrong" };
        else f.control.publishResult = {};
        yield* TestClock.setTime(DUE);
        yield* f.service.tick;
        yield* f.service.tick;
        expect(f.calls.create).toBe(1);
        expect(f.calls.publish).toBe(stage === "publish" ? 1 : 0);
        expect((yield* f.raw(r.id)).state).toBe("uncertain");
      }));
  test("request timeout becomes uncertain with no POST retry", (f) =>
    Effect.gen(function* () {
      const r = yield* f.admit;
      f.control.pendingCreate = true;
      yield* TestClock.setTime(DUE);
      const fiber = yield* Effect.forkChild(f.service.tick);
      for (let i = 0; i < 1000 && f.calls.create === 0; i++) yield* Effect.yieldNow;
      expect(f.calls.create).toBe(1);
      yield* TestClock.adjust("16 seconds");
      yield* Fiber.join(fiber);
      const restarted = yield* make(f.ports);
      yield* restarted.tick;
      expect(f.calls.create).toBe(1);
      expect((yield* f.raw(r.id)).state).toBe("uncertain");
    }));
  test("cancel while publish is in flight fences a successful response and prevents replay", (f) =>
    Effect.gen(function* () {
      const r = yield* f.admit;
      const sent = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      f.control.beforePublish = async () => {
        sent.resolve();
        await release.promise;
      };
      yield* TestClock.setTime(DUE);
      const worker = yield* Effect.forkChild(f.service.tick);
      yield* Effect.promise(() => sent.promise);
      const canceled = yield* f.service.cancel(r.id, session);
      expect(canceled.state).toBe("uncertain");
      release.resolve();
      yield* Fiber.await(worker);
      const restarted = yield* make(f.ports);
      yield* restarted.tick;
      expect(f.calls.publish).toBe(1);
      expect((yield* f.raw(r.id)).canceledAt).not.toBeNull();
    }));
  test("disabled flag after container creation prevents publish", (f) =>
    Effect.gen(function* () {
      yield* f.admit;
      f.control.beforeCreate = async () => {
        process.env.INSTAGRAM_PUBLISHING_ENABLED = "false";
      };
      yield* TestClock.setTime(DUE);
      yield* f.service.tick;
      expect(f.calls.create).toBe(1);
      expect(f.calls.publish).toBe(0);
    }));
  test("failed immutable hosting prerequisite never sends a POST", (f) =>
    Effect.gen(function* () {
      yield* f.admit;
      const blocked = yield* make({ ...f.ports, host: () => Effect.fail(problem()) });
      yield* TestClock.setTime(DUE);
      yield* blocked.tick;
      expect(f.calls.create + f.calls.publish).toBe(0);
    }));

  test("an unexpired exclusive claim prevents every other worker from sending", (f) =>
    Effect.gen(function* () {
      const r = yield* f.admit;
      yield* f.sql`UPDATE command_center_instagram_reels SET lease_owner = 'other-live-owner', lease_generation = 1, lease_until = ${DUE + 60000} WHERE id = ${r.id}`;
      yield* TestClock.setTime(DUE);
      const second = yield* make(f.ports);
      yield* Effect.all([f.service.tick, second.tick], { concurrency: "unbounded" });
      expect(f.calls.create + f.calls.publish).toBe(0);
      yield* TestClock.setTime(DUE + 60001);
      yield* second.tick;
      expect(f.calls.create).toBe(1);
      expect(f.calls.publish).toBe(1);
    }));

  test("inspection crossing the late cutoff invalidates effect before any POST", (f) =>
    Effect.gen(function* () {
      const request = yield* f.service.request({ ...binding, lateWindowMs: 30000 }, session);
      yield* f.service.approve(request.id, request.digest, session);
      const slow = yield* make({ ...f.ports, inspect: () => TestClock.setTime(DUE + 30000) });
      yield* TestClock.setTime(DUE);
      yield* slow.tick;
      expect(f.calls.create + f.calls.publish).toBe(0);
    }));

  test("read-only account metadata is sanitized and authority scoped", (f) =>
    Effect.gen(function* () {
      expect(yield* f.service.account(session)).toEqual({
        accountId: binding.accountId,
        accountRevision: binding.accountRevision,
      });
      expect((yield* Effect.result(f.service.account({ ...session, scopes: [] })))._tag).toBe(
        "Failure",
      );
      expect(f.calls.create + f.calls.publish).toBe(0);
    }));

  test("approval audit records the clock after inspection and durable actor identity", (f) =>
    Effect.gen(function* () {
      const requested = yield* f.service.request(binding, session);
      const inspecting = yield* make({ ...f.ports, inspect: () => TestClock.adjust("1 second") });
      const approved = yield* inspecting.approve(requested.id, requested.digest, session);
      expect(approved.approvedAt).toBe(T0 + 1000);
      expect(approved.updatedAt).toBe(T0 + 1000);
      expect(approved.actor).toBe(session.subject);
      expect(approved.approvalSessionId).toBe(session.sessionId);
      expect(yield* f.raw(requested.id)).toEqual(approved);
    }));
  test("wrong container ID from Graph prevents publish", (f) =>
    Effect.gen(function* () {
      yield* f.admit;
      f.control.statusId = "999999";
      yield* TestClock.setTime(DUE);
      yield* f.service.tick;
      expect(f.calls.publish).toBe(0);
    }));
  test("malformed recent-media and pagination stay uncertain with bounded reads", (f) =>
    Effect.gen(function* () {
      const r = yield* f.admit;
      f.control.failPublish = true;
      yield* TestClock.setTime(DUE);
      yield* f.service.tick;
      f.control.status = "PUBLISHED";
      f.control.recent = { data: [{ id: "invalid" }], paging: { next: 42 } };
      for (let i = 0; i < 4; i++) yield* f.service.tick;
      expect(f.calls.publish).toBe(1);
      expect(f.calls.recent).toBe(3);
      expect((yield* f.raw(r.id)).state).toBe("uncertain");
    }));
  test("malformed permalink remains published and never repeats publish", (f) =>
    Effect.gen(function* () {
      const r = yield* f.admit;
      yield* TestClock.setTime(DUE);
      yield* f.service.tick;
      f.control.permalinkResult = { permalink: "not a URL" };
      for (let i = 0; i < 4; i++) yield* f.service.tick;
      expect(f.calls.publish).toBe(1);
      expect(f.calls.permalink).toBe(3);
      expect((yield* f.raw(r.id)).state).toBe("published");
    }));
  test("Graph body limit cancels an oversized stream without buffering the full response", () =>
    Effect.gen(function* () {
      let canceled = false;
      const client = new InstagramClient({
        accessToken: "private-test-token",
        fetchImpl: async () =>
          new Response(
            new ReadableStream({
              pull: (controller) => controller.enqueue(new Uint8Array(65536)),
              cancel: () => {
                canceled = true;
              },
            }),
          ),
      });
      yield* Effect.promise(async () => {
        await expect(client.getMe()).rejects.toThrow("bounded response deadline");
      });
      expect(canceled).toBe(true);
    }));
  test("direct client kill-switch covers both container and publish routes", () =>
    Effect.gen(function* () {
      let posts = 0;
      const client = new InstagramClient({
        accessToken: "private-test-token",
        fetchImpl: async () => {
          posts++;
          return new Response('{"id":"900001"}');
        },
      });
      delete process.env.INSTAGRAM_PUBLISHING_ENABLED;
      yield* Effect.promise(async () => {
        await expect(
          client.createMediaContainer(binding.accountId, {
            mediaType: "REELS",
            videoUrl: "https://immutable-assets.test/reel.mp4",
          }),
        ).rejects.toThrow("disabled");
        await expect(client.publishMedia(binding.accountId, "900001")).rejects.toThrow("disabled");
      });
      expect(posts).toBe(0);
    }));
});

it.effect("migration 078 refuses to strand reserved 072–077", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE effect_sql_migrations(migration_id INTEGER PRIMARY KEY, name TEXT)`;
      yield* sql`INSERT INTO effect_sql_migrations VALUES (71, 'existing')`;
      expect((yield* Effect.result(migration))._tag).toBe("Failure");
      for (let id = 72; id <= 77; id++)
        yield* sql`INSERT INTO effect_sql_migrations VALUES (${id}, 'reserved-fixture-only')`;
      yield* migration;
      const tables = yield* sql<{
        name: string;
      }>`SELECT name FROM sqlite_master WHERE name = 'command_center_instagram_reels'`;
      expect(tables).toHaveLength(1);
    }),
  ),
);

it.live("advancing real clock records actual effect time after due UTC", () =>
  withDb(
    Effect.gen(function* () {
      const f = yield* fixture;
      const now = yield* Clock.currentTimeMillis;
      const due = Math.ceil((now + 1100) / 1000) * 1000;
      const b = { ...binding, dueUtc: DateTime.formatIso(DateTime.makeUnsafe(due)) };
      // Fixture authority expiry is made relative to the actual clock.
      yield* f.sql`UPDATE auth_sessions SET expires_at = ${DateTime.formatIso(DateTime.makeUnsafe(due + 3600000))}`;
      const r = yield* f.service.request(b, session);
      yield* f.service.approve(r.id, r.digest, session);
      yield* f.service.tick;
      expect(f.calls.create).toBe(0);
      yield* Effect.sleep(due - (yield* Clock.currentTimeMillis) + 20);
      yield* f.service.tick;
      const receipt = yield* f.raw(r.id);
      expect(f.calls.publish).toBe(1);
      expect(receipt.publishIntentAt).toBeGreaterThanOrEqual(due);
      expect(receipt.publishedAt).toBeGreaterThanOrEqual(due);
    }),
  ),
);

it("production streaming asset inspector rejects changed bytes, count, duration and root", async () => {
  const root = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "instagram-immutable-asset-test-"),
  );
  const file = NodePath.join(root, "reel.mp4");
  try {
    const exec = NodeUtil.promisify(NodeChildProcess.execFile);
    await exec(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=16x16:r=10",
        "-t",
        "1",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        file,
      ],
      { timeout: 5000, maxBuffer: 8192 },
    );
    const bytes = await NodeFSP.readFile(file);
    const approved = {
      ...binding,
      relativePath: "reel.mp4",
      workspaceRoot: await NodeFSP.realpath(root),
      sizeBytes: bytes.length,
      durationMs: 1000,
      sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    };
    await inspectReelFile(file, root, approved, AbortSignal.timeout(5000));
    await expect(
      inspectReelFile(
        file,
        root,
        { ...approved, sha256: "0".repeat(64) },
        AbortSignal.timeout(5000),
      ),
    ).rejects.toThrow("hash changed");
    await expect(
      inspectReelFile(
        file,
        root,
        { ...approved, sizeBytes: approved.sizeBytes + 1 },
        AbortSignal.timeout(5000),
      ),
    ).rejects.toThrow("byte count");
    await expect(
      inspectReelFile(file, root, { ...approved, durationMs: 1001 }, AbortSignal.timeout(5000)),
    ).rejects.toThrow("duration");
    await expect(
      inspectReelFile(
        file,
        root,
        { ...approved, workspaceRoot: "/another/project" },
        AbortSignal.timeout(5000),
      ),
    ).rejects.toThrow("workspace binding");
    await NodeFSP.writeFile(file, Buffer.alloc(bytes.length));
    await expect(inspectReelFile(file, root, approved, AbortSignal.timeout(5000))).rejects.toThrow(
      "hash changed",
    );
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

for (const persistedState of ["creating", "publishing", "processing", "published"] as const) {
  it.effect(
    `closed SQLite connection reopens ${persistedState} receipt without duplicate effects`,
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        const root = yield* Effect.acquireRelease(
          Effect.promise(() =>
            NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "instagram-reopen-test-")),
          ),
          (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
        );
        const db = () =>
          NodeSqliteClient.layer({ filename: NodePath.join(root, "receipts.sqlite") });
        const persisted = yield* Effect.gen(function* () {
          const f = yield* fixture;
          const r = yield* f.admit;
          yield* f.patch(r.id, {
            state: persistedState,
            createIntentAt: DUE,
            containerId: persistedState === "creating" ? null : "900001",
            publishIntentAt:
              persistedState === "publishing" || persistedState === "published" ? DUE : null,
            mediaId: persistedState === "published" ? "900002" : null,
            publishedAt: persistedState === "published" ? DUE : null,
          });
          return { id: r.id, ports: f.ports, calls: f.calls };
        }).pipe(Effect.provide(db()));
        yield* TestClock.setTime(DUE);
        yield* Effect.gen(function* () {
          const restarted = yield* make(persisted.ports);
          yield* restarted.tick;
          const receipt = yield* restarted.query(persisted.id, session);
          expect(persisted.calls.create).toBe(0);
          expect(persisted.calls.publish).toBe(persistedState === "processing" ? 1 : 0);
          expect(receipt.state).toBe(
            persistedState === "creating" || persistedState === "publishing"
              ? "uncertain"
              : "published",
          );
        }).pipe(Effect.provide(db()));
      }),
  );
}

for (const state of ["approved", "canceled", "uncertain"] as const) {
  it.effect(
    `closed SQLite reopens ${state} permanent identity and rejects changed-caption admission`,
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        const root = yield* Effect.acquireRelease(
          Effect.promise(() =>
            NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "instagram-caption-reopen-")),
          ),
          (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
        );
        const db = () =>
          NodeSqliteClient.layer({ filename: NodePath.join(root, "receipts.sqlite") });
        const persisted = yield* Effect.gen(function* () {
          const f = yield* fixture;
          const r = yield* f.admit;
          if (state === "canceled") yield* f.service.cancel(r.id, session);
          if (state === "uncertain")
            yield* f.patch(r.id, { state, containerId: "900001", publishIntentAt: DUE });
          return { receipt: r, ports: f.ports, calls: f.calls };
        }).pipe(Effect.provide(db()));
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const restarted = yield* make(persisted.ports);
          const changed = { ...binding, caption: "Caption after DB reopen" };
          expect((yield* Effect.result(restarted.request(changed, session)))._tag).toBe("Failure");
          expect(
            (yield* Effect.result(
              restarted.approve(persisted.receipt.id, bindingDigest(changed), session),
            ))._tag,
          ).toBe("Failure");
          expect(yield* sql`SELECT id FROM command_center_instagram_reels`).toHaveLength(1);
          const receipt = yield* restarted.query(persisted.receipt.id, session);
          expect(receipt.state).toBe(state);
          expect(receipt.binding.caption).toBe(binding.caption);
          if (state !== "approved")
            expect(
              (yield* Effect.result(restarted.approve(receipt.id, receipt.digest, session)))._tag,
            ).toBe("Failure");
          yield* TestClock.setTime(DUE);
          yield* restarted.tick;
          yield* restarted.tick;
          expect(persisted.calls.create).toBe(state === "approved" ? 1 : 0);
          expect(persisted.calls.publish).toBe(state === "approved" ? 1 : 0);
        }).pipe(Effect.provide(db()));
      }),
  );
}

it.effect("real migration loader upgrades 071 through the reserved stack and 078", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 71 });
      expect((yield* Effect.exit(runMigrations()))._tag).toBe("Success");
      const history = yield* sql<{
        maximum: number;
      }>`SELECT MAX(migration_id) AS maximum FROM effect_sql_migrations`;
      // Upstream migrations follow 078, so the loader runs through the last registered one.
      expect(history[0]!.maximum).toBe(migrationManifest.at(-1)![0]);
      const table = yield* sql<{
        name: string;
      }>`SELECT name FROM sqlite_master WHERE name = 'command_center_instagram_reels'`;
      expect(table).toHaveLength(1);
    }),
  ),
);
