import * as NodeCrypto from "node:crypto";
import {
  AuthCommandCenterApproveScope,
  AuthCommandCenterOperateScope,
  AuthCommandCenterReadScope,
  CommandCenterError,
  InstagramReelBinding,
  InstagramReelReceipt,
  InstagramReelAccount,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { AuthenticatedSession } from "../../../auth/EnvironmentAuth.ts";
import { canonicalJson } from "../../automation/Digest.ts";
import { isInstagramPublishingEnabled } from "./config.ts";

export interface ReelApi {
  create: (binding: InstagramReelBinding, url: string, signal: AbortSignal) => Promise<unknown>;
  status: (id: string, signal: AbortSignal) => Promise<unknown>;
  publish: (binding: InstagramReelBinding, id: string, signal: AbortSignal) => Promise<unknown>;
  permalink: (id: string, signal: AbortSignal) => Promise<unknown>;
  recent: (binding: InstagramReelBinding, signal: AbortSignal) => Promise<unknown>;
}
export interface InstagramPublishPorts {
  /** Nonmutating account snapshot; API retains the private credential. */
  readonly account: Effect.Effect<
    { id: string; revision: number; api: ReelApi },
    CommandCenterError
  >;
  readonly inspect: (binding: InstagramReelBinding) => Effect.Effect<void, CommandCenterError>;
  /** Must prove immutable hosting and HTTPS reachability; URL stays in memory only. */
  readonly host: (binding: InstagramReelBinding) => Effect.Effect<string, CommandCenterError>;
}
const fail = (message: string) => new CommandCenterError({ reason: "validation", message });
const persistence = () =>
  new CommandCenterError({
    reason: "persistence",
    message: "Instagram receipt persistence failed.",
  });
const hash = (value: Schema.Json) =>
  NodeCrypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
export const bindingDigest = (binding: InstagramReelBinding) =>
  hash(["instagram-reel-v1", binding]);
/** One permanent account/asset/due identity, independent of caption, window and approval. */
export const logicalIdentity = (b: InstagramReelBinding) =>
  hash(["instagram-reel-v1", b.accountId, b.sha256, b.dueUtc]);
const IdResponse = Schema.Struct({ id: Schema.String.check(Schema.isPattern(/^[0-9]{5,30}$/)) });
const StatusResponse = Schema.Struct({
  ...IdResponse.fields,
  status_code: Schema.Literals(["IN_PROGRESS", "FINISHED", "PUBLISHED", "ERROR", "EXPIRED"]),
});
const RecentResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      ...IdResponse.fields,
      caption: Schema.optional(Schema.String),
      timestamp: Schema.optional(Schema.String),
    }),
  ).check(Schema.isMaxLength(25)),
  paging: Schema.optional(
    Schema.Struct({
      next: Schema.optional(Schema.String),
      previous: Schema.optional(Schema.String),
      cursors: Schema.optional(
        Schema.Struct({
          before: Schema.optional(Schema.String),
          after: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
});
const decodeAccount = Schema.decodeUnknownEffect(InstagramReelAccount);
const decodeBinding = Schema.decodeUnknownEffect(InstagramReelBinding);
const decodeScopes = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const isCommandCenterError = Schema.is(CommandCenterError);
const encodeReceipt = Schema.encodeSync(Schema.fromJsonString(InstagramReelReceipt));
const decodeReceipt = Schema.decodeUnknownEffect(Schema.fromJsonString(InstagramReelReceipt));
const StoredRow = Schema.Struct({
  receipt_json: Schema.String.check(Schema.isMaxLength(32768)),
  state: Schema.String,
  lease_owner: Schema.NullOr(Schema.String),
  lease_generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  lease_until: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
const decodeRow = Schema.decodeUnknownEffect(StoredRow);
type Row = typeof StoredRow.Type;
const AuthRow = Schema.Struct({
  subject: Schema.String,
  scopes: Schema.String.check(Schema.isMaxLength(8192)),
  expires_at: Schema.String,
  revoked_at: Schema.NullOr(Schema.String),
});
const decodeAuthRow = Schema.decodeUnknownEffect(AuthRow);
const LEASE_MS = 60_000;

export class InstagramPublish extends Context.Service<
  InstagramPublish,
  {
    account: (
      session: AuthenticatedSession,
    ) => Effect.Effect<typeof InstagramReelAccount.Type, CommandCenterError>;
    request: (
      binding: InstagramReelBinding,
      session: AuthenticatedSession,
    ) => Effect.Effect<InstagramReelReceipt, CommandCenterError>;
    query: (
      id: string,
      session: AuthenticatedSession,
    ) => Effect.Effect<InstagramReelReceipt, CommandCenterError>;
    approve: (
      id: string,
      digest: string,
      session: AuthenticatedSession,
    ) => Effect.Effect<InstagramReelReceipt, CommandCenterError>;
    cancel: (
      id: string,
      session: AuthenticatedSession,
    ) => Effect.Effect<InstagramReelReceipt, CommandCenterError>;
    tick: Effect.Effect<void, CommandCenterError>;
  }
>()("@awtprod/command-center/command-center/publish/instagram/InstagramPublish") {}

export const make = Effect.fn("InstagramPublish.make")(function* (ports: InstagramPublishPorts) {
  const sql = yield* SqlClient.SqlClient;
  const getRow = Effect.fn("InstagramPublish.getRow")(function* (id: string) {
    const rows =
      yield* sql<Row>`SELECT receipt_json, state, lease_owner, lease_generation, lease_until FROM command_center_instagram_reels WHERE id = ${id}`.pipe(
        Effect.mapError(persistence),
      );
    if (!rows[0]) return yield* fail("Instagram action not found.");
    const row = yield* decodeRow(rows[0]).pipe(Effect.mapError(persistence));
    const receipt = yield* decodeReceipt(row.receipt_json).pipe(Effect.mapError(persistence));
    if (
      receipt.id !== id ||
      receipt.state !== row.state ||
      receipt.digest !== bindingDigest(receipt.binding) ||
      id !== logicalIdentity(receipt.binding)
    )
      return yield* fail("Stored Instagram binding changed.");
    return { ...row, receipt };
  });
  const authority = Effect.fn("InstagramPublish.authority")(function* (
    sessionId: string,
    actor: string,
    scope: AuthEnvironmentScope,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* sql<{
      subject: string;
      scopes: string;
      expires_at: string;
      revoked_at: string | null;
    }>`SELECT subject, scopes, expires_at, revoked_at FROM auth_sessions WHERE session_id = ${sessionId}`.pipe(
      Effect.mapError(persistence),
    );
    const row = rows[0]
      ? yield* decodeAuthRow(rows[0]).pipe(Effect.mapError(persistence))
      : undefined;
    if (
      !row ||
      row.subject !== actor ||
      row.revoked_at !== null ||
      !Number.isFinite(Date.parse(row.expires_at)) ||
      Date.parse(row.expires_at) <= now
    )
      return yield* fail("Approval authority is expired or revoked.");
    const scopes = yield* decodeScopes(row.scopes).pipe(Effect.mapError(persistence));
    if (!scopes.includes(scope))
      return yield* fail("Required Instagram authority scope is absent.");
    return Date.parse(row.expires_at);
  });
  const authorize = (session: AuthenticatedSession, scope: AuthEnvironmentScope) =>
    session.scopes.includes(scope)
      ? authority(session.sessionId, session.subject, scope)
      : Effect.fail(fail("Unauthorized Instagram action."));
  const checkAccount = Effect.fn("InstagramPublish.checkAccount")(function* (
    b: InstagramReelBinding,
  ) {
    const account = yield* ports.account;
    if (account.id !== b.accountId || account.revision !== b.accountRevision)
      return yield* fail("Approved Instagram account changed.");
    return account.api;
  });
  const inspect = Effect.fn("InstagramPublish.inspect")(function* (b: InstagramReelBinding) {
    yield* ports.inspect(b);
    return yield* checkAccount(b);
  });
  const account = Effect.fn("InstagramPublish.account")(function* (session: AuthenticatedSession) {
    yield* authorize(session, AuthCommandCenterReadScope);
    const snapshot = yield* ports.account;
    return yield* decodeAccount({
      accountId: snapshot.id,
      accountRevision: snapshot.revision,
    }).pipe(Effect.mapError(() => fail("Malformed connected account metadata.")));
  });
  const request = Effect.fn("InstagramPublish.request")(function* (
    input: InstagramReelBinding,
    session: AuthenticatedSession,
  ) {
    yield* authorize(session, AuthCommandCenterOperateScope);
    const b = yield* decodeBinding(input).pipe(
      Effect.mapError(() => fail("Malformed Reel binding.")),
    );
    const now = yield* Clock.currentTimeMillis;
    const due = Date.parse(b.dueUtc);
    if (
      !Number.isFinite(due) ||
      DateTime.formatIso(DateTime.makeUnsafe(due)) !== b.dueUtc ||
      due <= now ||
      due > now + 7 * 86400000 ||
      !b.caption.isWellFormed() ||
      Buffer.byteLength(b.caption, "utf8") > 8800
    )
      return yield* fail("Reel due UTC must be canonical and within the next seven days.");
    yield* inspect(b);
    yield* authorize(session, AuthCommandCenterOperateScope);
    const admittedAt = yield* Clock.currentTimeMillis;
    if (due <= admittedAt) return yield* fail("Due UTC passed during asset inspection.");
    const receipt: InstagramReelReceipt = {
      id: logicalIdentity(b),
      digest: bindingDigest(b),
      binding: b,
      state: "requested",
      approvalId: null,
      actor: null,
      approvalSessionId: null,
      approvalExpiresAt: null,
      approvedAt: null,
      canceledAt: null,
      createIntentAt: null,
      containerId: null,
      publishIntentAt: null,
      mediaId: null,
      publishedAt: null,
      permalink: null,
      readAttempts: 0,
      updatedAt: admittedAt,
      detail: null,
    };
    yield* sql`INSERT INTO command_center_instagram_reels(id, receipt_json, state, due_ms) VALUES (${receipt.id}, ${encodeReceipt(receipt)}, 'requested', ${due}) ON CONFLICT(id) DO NOTHING`.pipe(
      Effect.mapError(persistence),
    );
    const stored = (yield* getRow(receipt.id)).receipt;
    if (stored.digest !== receipt.digest)
      return yield* fail(
        "Logical publish identity permanently binds a different version. Cancellation does not permit replacement.",
      );
    return stored;
  });
  const query = Effect.fn("InstagramPublish.query")(function* (
    id: string,
    session: AuthenticatedSession,
  ) {
    yield* authorize(session, AuthCommandCenterReadScope);
    return (yield* getRow(id)).receipt;
  });
  const approve = Effect.fn("InstagramPublish.approve")(function* (
    id: string,
    digest: string,
    session: AuthenticatedSession,
  ) {
    const expires = yield* authorize(session, AuthCommandCenterApproveScope);
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const { receipt } = yield* getRow(id);
          const now = yield* Clock.currentTimeMillis;
          if (digest !== receipt.digest || Date.parse(receipt.binding.dueUtc) <= now)
            return yield* fail("Approval binding changed or due time passed.");
          if (expires <= Date.parse(receipt.binding.dueUtc) + receipt.binding.lateWindowMs)
            return yield* fail("Approval session must remain valid through the late cutoff.");
          if (receipt.state === "approved") return receipt;
          if (receipt.state !== "requested")
            return yield* fail("This action cannot be approved again.");
          yield* inspect(receipt.binding);
          const stillExpires = yield* authorize(session, AuthCommandCenterApproveScope);
          const approvedAt = yield* Clock.currentTimeMillis;
          if (
            Date.parse(receipt.binding.dueUtc) <= approvedAt ||
            Math.min(expires, stillExpires) <=
              Date.parse(receipt.binding.dueUtc) + receipt.binding.lateWindowMs
          )
            return yield* fail("Approval expired or due UTC passed during inspection.");
          const next: InstagramReelReceipt = {
            ...receipt,
            state: "approved",
            approvalId: NodeCrypto.randomUUID(),
            actor: session.subject,
            approvalSessionId: session.sessionId,
            approvalExpiresAt: Math.min(expires, stillExpires),
            approvedAt,
            updatedAt: approvedAt,
          };
          yield* sql`UPDATE command_center_instagram_reels SET state = 'approved', receipt_json = ${encodeReceipt(next)} WHERE id = ${id} AND state = 'requested'`.pipe(
            Effect.mapError(persistence),
          );
          return next;
        }),
      )
      .pipe(Effect.mapError((e) => (isCommandCenterError(e) ? e : persistence())));
  });
  const cancel = Effect.fn("InstagramPublish.cancel")(function* (
    id: string,
    session: AuthenticatedSession,
  ) {
    yield* authorize(session, AuthCommandCenterApproveScope);
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const { receipt } = yield* getRow(id);
          if (receipt.state === "published" || receipt.canceledAt !== null) return receipt;
          const now = yield* Clock.currentTimeMillis;
          const state =
            receipt.state === "creating" ||
            receipt.state === "publishing" ||
            receipt.state === "uncertain"
              ? "uncertain"
              : "canceled";
          const next: InstagramReelReceipt = {
            ...receipt,
            state,
            canceledAt: now,
            updatedAt: now,
            detail:
              state === "uncertain"
                ? "Canceled while an external outcome may be unknown; read-only reconciliation required."
                : "Approval revoked; action canceled.",
          };
          yield* sql`UPDATE command_center_instagram_reels SET state = ${state}, receipt_json = ${encodeReceipt(next)}, lease_generation = lease_generation + 1, lease_owner = NULL, lease_until = 0 WHERE id = ${id}`.pipe(
            Effect.mapError(persistence),
          );
          return next;
        }),
      )
      .pipe(Effect.mapError((e) => (isCommandCenterError(e) ? e : persistence())));
  });
  const drive = Effect.fn("InstagramPublish.drive")(function* (id: string) {
    const now = yield* Clock.currentTimeMillis;
    const owner = NodeCrypto.randomUUID();
    const claims =
      yield* sql<Row>`UPDATE command_center_instagram_reels SET lease_owner = ${owner}, lease_generation = lease_generation + 1, lease_until = ${now + LEASE_MS} WHERE id = ${id} AND due_ms <= ${now} AND lease_until <= ${now} AND state IN ('approved','creating','processing','ready','publishing','uncertain','published') RETURNING receipt_json, state, lease_owner, lease_generation, lease_until`.pipe(
        Effect.mapError(persistence),
      );
    if (!claims[0]) return;
    const claim = yield* decodeRow(claims[0]).pipe(Effect.mapError(persistence));
    let receipt = (yield* getRow(id)).receipt;
    const write = Effect.fn("InstagramPublish.fencedWrite")(function* (
      patch: Partial<InstagramReelReceipt>,
    ) {
      const at = yield* Clock.currentTimeMillis;
      const next = { ...receipt, ...patch, updatedAt: at };
      const result = yield* sql<{
        id: string;
      }>`UPDATE command_center_instagram_reels SET receipt_json = ${encodeReceipt(next)}, state = ${next.state} WHERE id = ${id} AND lease_owner = ${owner} AND lease_generation = ${claim.lease_generation} AND lease_until > ${at} RETURNING id`.pipe(
        Effect.mapError(persistence),
      );
      if (!result.length)
        return yield* fail("Instagram claim lost; external outcomes must be reconciled read-only.");
      receipt = next;
    });
    const guard = Effect.fn("InstagramPublish.guard")(function* () {
      if (!isInstagramPublishingEnabled()) return yield* fail("Instagram publishing is disabled.");
      if (
        !receipt.approvalId ||
        !receipt.actor ||
        !receipt.approvalSessionId ||
        receipt.approvalExpiresAt === null
      )
        return yield* fail("Approval is absent.");
      // File inspection can take time: finish it before sampling authority, claim and clock.
      const api = yield* inspect(receipt.binding);
      const authorityExpires = yield* authority(
        receipt.approvalSessionId,
        receipt.actor,
        AuthCommandCenterApproveScope,
      );
      const current = yield* getRow(id);
      const at = yield* Clock.currentTimeMillis;
      if (!isInstagramPublishingEnabled()) return yield* fail("Instagram publishing is disabled.");
      if (
        current.lease_owner !== owner ||
        current.lease_generation !== claim.lease_generation ||
        current.lease_until <= at
      )
        return yield* fail("Instagram claim lost.");
      if (
        current.receipt.digest !== receipt.digest ||
        current.receipt.approvalId !== receipt.approvalId ||
        current.receipt.canceledAt !== null ||
        at >= receipt.approvalExpiresAt ||
        at >= authorityExpires
      )
        return yield* fail("Approval changed, expired or revoked.");
      if (
        at < Date.parse(receipt.binding.dueUtc) ||
        at >= Date.parse(receipt.binding.dueUtc) + receipt.binding.lateWindowMs
      )
        return yield* fail("Outside the approved publication window.");
      return api;
    });
    const call = <A>(operation: (signal: AbortSignal) => Promise<A>) =>
      Effect.tryPromise({
        try: operation,
        catch: () => fail("Instagram response failed; no POST retry is permitted."),
      }).pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError(() =>
          fail("Instagram response failed or timed out; no POST retry is permitted."),
        ),
      );
    const decode = <A, I>(schema: Schema.Codec<A, I>, value: unknown) =>
      Schema.decodeUnknownEffect(schema)(value).pipe(
        Effect.mapError(() =>
          fail("Malformed Instagram response; outcome requires reconciliation."),
        ),
      );
    const recoveryAccount = () =>
      checkAccount(receipt.binding).pipe(
        Effect.mapError(() =>
          fail("Read-only recovery held: approved account unavailable or connection changed."),
        ),
      );
    const work = Effect.gen(function* () {
      // Recovered intent means the send may already have happened. Never send again.
      if (receipt.state === "creating" || receipt.state === "publishing")
        yield* write({
          state: "uncertain",
          detail: "Interrupted external intent; no automatic retry.",
        });
      if (receipt.state === "uncertain") {
        if (!receipt.containerId || receipt.readAttempts >= 3) return;
        const api = yield* recoveryAccount();
        yield* write({ readAttempts: receipt.readAttempts + 1 });
        const status = yield* decode(
          StatusResponse,
          yield* call((s) => api.status(receipt.containerId!, s)),
        );
        if (status.id !== receipt.containerId) return yield* fail("Container identity mismatch.");
        if (status.status_code === "PUBLISHED") {
          // Caption/time never establish container->media identity, even for a single match.
          yield* decode(RecentResponse, yield* call((s) => api.recent(receipt.binding, s)));
          yield* write({
            detail:
              "Container PUBLISHED; media identity unavailable. Human reconciliation required. Never retry publish.",
          });
        }
        return;
      }
      if (receipt.state === "published") {
        if (receipt.mediaId && !receipt.permalink && receipt.readAttempts < 3) {
          const api = yield* recoveryAccount();
          yield* write({ readAttempts: receipt.readAttempts + 1 });
          const result = yield* decode(
            Schema.Struct({ permalink: Schema.String }),
            yield* call((s) => api.permalink(receipt.mediaId!, s)),
          );
          const url = yield* Effect.try({
            try: () => new URL(result.permalink),
            catch: () => fail("Invalid Instagram permalink."),
          });
          if (
            url.protocol !== "https:" ||
            !["www.instagram.com", "instagram.com"].includes(url.hostname) ||
            url.username ||
            url.password
          )
            return yield* fail("Invalid Instagram permalink.");
          yield* write({ permalink: url.toString(), detail: null });
        }
        return;
      }
      if (receipt.state === "approved") {
        yield* guard();
        const url = yield* ports.host(receipt.binding);
        yield* guard();
        yield* write({ state: "creating", createIntentAt: yield* Clock.currentTimeMillis });
        const api = yield* guard();
        const created = yield* decode(
          IdResponse,
          yield* call((s) => api.create(receipt.binding, url, s)),
        );
        yield* write({ state: "processing", containerId: created.id });
      }
      if (receipt.state === "processing" || receipt.state === "ready") {
        const api = yield* guard();
        const status = yield* decode(
          StatusResponse,
          yield* call((s) => api.status(receipt.containerId!, s)),
        );
        if (status.id !== receipt.containerId) return yield* fail("Container identity mismatch.");
        if (status.status_code === "IN_PROGRESS") return;
        if (status.status_code === "ERROR" || status.status_code === "EXPIRED")
          return yield* fail("Instagram container errored or expired.");
        if (status.status_code === "PUBLISHED") {
          yield* write({
            state: "uncertain",
            detail: "Container already published; media identity requires human reconciliation.",
          });
          return;
        }
        yield* write({ state: "ready" });
        yield* guard();
        yield* write({ state: "publishing", publishIntentAt: yield* Clock.currentTimeMillis });
        const publishApi = yield* guard();
        const published = yield* decode(
          IdResponse,
          yield* call((s) => publishApi.publish(receipt.binding, receipt.containerId!, s)),
        );
        yield* write({
          state: "published",
          mediaId: published.id,
          publishedAt: yield* Clock.currentTimeMillis,
          detail: null,
        });
      }
    });
    yield* work.pipe(
      Effect.catch((error) =>
        write({
          state:
            receipt.state === "creating" ||
            receipt.state === "publishing" ||
            receipt.state === "uncertain"
              ? "uncertain"
              : receipt.state === "published"
                ? "published"
                : "error",
          detail: error.message,
        }),
      ),
      Effect.onInterrupt(() =>
        Effect.gen(function* () {
          // A receipt may already have committed while this fiber was interrupted.
          // Preserve that durable response rather than overwrite it from cached intent.
          receipt = (yield* getRow(id)).receipt;
          yield* write({
            state:
              receipt.state === "creating" || receipt.state === "publishing"
                ? "uncertain"
                : receipt.state,
            detail:
              receipt.state === "published"
                ? receipt.detail
                : "Worker interrupted; any persisted external intent must be reconciled.",
          });
        }).pipe(
          Effect.catch((e) =>
            Effect.logWarning("instagram-reel.interrupted-receipt", { message: e.message }),
          ),
        ),
      ),
      Effect.ensuring(
        sql`UPDATE command_center_instagram_reels SET lease_owner = NULL, lease_until = 0 WHERE id = ${id} AND lease_owner = ${owner} AND lease_generation = ${claim.lease_generation}`.pipe(
          Effect.mapError(persistence),
          Effect.asVoid,
          Effect.catch((e) =>
            Effect.logWarning("instagram-reel.release-claim", { message: e.message }),
          ),
        ),
      ),
    );
  });
  const tick = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* sql<{
      id: string;
    }>`SELECT id FROM command_center_instagram_reels WHERE due_ms <= ${now} AND lease_until <= ${now} AND state IN ('approved','creating','processing','ready','publishing','uncertain','published') AND NOT (state = 'published' AND json_extract(receipt_json, '$.permalink') IS NOT NULL) AND NOT (state IN ('published','uncertain') AND json_extract(receipt_json, '$.readAttempts') >= 3) AND NOT (state = 'uncertain' AND json_extract(receipt_json, '$.containerId') IS NULL) ORDER BY CASE WHEN state IN ('approved','creating','processing','ready','publishing') THEN 0 ELSE 1 END, due_ms LIMIT 25`.pipe(
      Effect.mapError(persistence),
    );
    yield* Effect.forEach(rows, (r) => drive(r.id), { discard: true });
  });
  return InstagramPublish.of({ account, request, query, approve, cancel, tick });
});

/** Server owns the scoped loop; websocket disconnect cannot cancel an active publication. */
export const runnerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* InstagramPublish;
    yield* Effect.forkScoped(
      service.tick.pipe(
        Effect.catch((e) => Effect.logWarning("instagram-reel.tick", { message: e.message })),
        Effect.repeat(Schedule.spaced("5 seconds")),
      ),
    );
  }),
);
