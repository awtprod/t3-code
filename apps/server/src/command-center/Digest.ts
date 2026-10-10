import { isValidAutomationTimeZone } from "@t3tools/shared/automationSchedule";
import {
  CommandCenterDigestPreferences,
  CommandCenterDigestSnapshot,
  CommandCenterDigestItem,
  type CommandCenterDigestPreferences as DigestPreferencesType,
  type CommandCenterDigestSnapshot as DigestSnapshotType,
  type CommandCenterDigestPreferencesUpdateInput,
  type CommandCenterDigestQueryResult,
  CommandCenterError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeCrypto from "node:crypto";

import { canonicalJson } from "./automation/Digest.ts";
import { digestPeriod, isDigestQuietHour } from "./DigestPeriod.ts";

const MAX_DIGEST_ITEMS = 100;
const decodePreferences = Schema.decodeUnknownEffect(CommandCenterDigestPreferences);
const decodeSnapshot = Schema.decodeUnknownEffect(CommandCenterDigestSnapshot);
const decodeStoredItems = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(CommandCenterDigestItem)),
);
const decodeItems = Schema.decodeUnknownEffect(Schema.Array(CommandCenterDigestItem));
const encodeStoredItems = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(CommandCenterDigestItem)),
);
const isCommandCenterError = Schema.is(CommandCenterError);
const failure = (
  reason: "validation" | "config" | "conflict" | "not_found" | "persistence",
  message: string,
) => new CommandCenterError({ reason, message });

interface PreferenceRow {
  readonly timezone: string;
  readonly quietStart: string | null;
  readonly quietEnd: string | null;
  readonly version: number;
}
interface SnapshotRow {
  readonly id: string;
  readonly recipientSubject: string;
  readonly localDate: string;
  readonly timezone: string;
  readonly periodStartAt: string;
  readonly periodEndAt: string;
  readonly generatedAt: string;
  readonly contentDigest: string;
  readonly itemsJson: string;
  readonly supersedesId: string | null;
  readonly viewedAt: string | null;
}
interface ItemRow {
  readonly spaceId: string;
  readonly itemId: string;
  readonly revisionId: string | null;
  readonly itemVersion: number;
  readonly title: string;
  readonly kind: "decision" | "approval" | "alert" | "task" | "idea";
  readonly status: "captured" | "ready" | "in_progress" | "waiting" | "review";
  readonly updatedAt: string;
  readonly totalCount: number;
}

export interface DigestDependencies {
  readonly now: Effect.Effect<string>;
}

export interface DigestShape {
  readonly query: (input: {
    readonly recipientSubject: string;
    readonly configTimezone: string | null;
  }) => Effect.Effect<CommandCenterDigestQueryResult, CommandCenterError>;
  readonly updatePreferences: (input: {
    readonly recipientSubject: string;
    readonly configTimezone: string | null;
    readonly preferences: CommandCenterDigestPreferencesUpdateInput;
  }) => Effect.Effect<DigestPreferencesType, CommandCenterError>;
  readonly markViewed: (input: {
    readonly recipientSubject: string;
    readonly snapshotId: string;
  }) => Effect.Effect<DigestSnapshotType, CommandCenterError>;
}

export class CommandCenterDigest extends Context.Service<CommandCenterDigest, DigestShape>()(
  "@awtprod/command-center/command-center/Digest/CommandCenterDigest",
) {}

export const make = Effect.fn("CommandCenterDigest.make")(function* (
  dependencies: DigestDependencies,
) {
  const sql = yield* SqlClient.SqlClient;

  const preferencesFor = Effect.fn("CommandCenterDigest.preferencesFor")(function* (
    recipientSubject: string,
    configTimezone: string | null,
  ) {
    if (!recipientSubject || recipientSubject.length > 200) {
      return yield* failure("validation", "The digest recipient identity is invalid.");
    }
    const rows = yield* sql<PreferenceRow>`
      SELECT timezone, quiet_start AS "quietStart", quiet_end AS "quietEnd", version
      FROM command_center_digest_preferences WHERE recipient_subject = ${recipientSubject}
      LIMIT 1
    `;
    const stored = rows[0];
    if (stored !== undefined) {
      if (!isValidAutomationTimeZone(stored.timezone)) {
        return yield* failure("persistence", "Stored digest time zone is invalid.");
      }
      return yield* decodePreferences({ ...stored, source: "personal" }).pipe(
        Effect.mapError(() => failure("persistence", "Stored digest preferences are invalid.")),
      );
    }
    if (configTimezone === null || !isValidAutomationTimeZone(configTimezone)) {
      return yield* failure("config", "Configure a valid Command Center time zone to use digests.");
    }
    return yield* decodePreferences({
      timezone: configTimezone,
      quietStart: null,
      quietEnd: null,
      version: 0,
      source: "command-center-config",
    }).pipe(Effect.mapError(() => failure("config", "The configured time zone is invalid.")));
  });

  const snapshotFromRow = Effect.fn("CommandCenterDigest.snapshotFromRow")(function* (
    row: SnapshotRow,
  ) {
    const items = yield* decodeStoredItems(row.itemsJson).pipe(
      Effect.mapError(() => failure("persistence", "Stored digest items are invalid.")),
    );
    return yield* decodeSnapshot({ ...row, items }).pipe(
      Effect.mapError(() => failure("persistence", "Stored digest snapshot is invalid.")),
    );
  });

  const latestSnapshot = Effect.fn("CommandCenterDigest.latestSnapshot")(function* (
    recipientSubject: string,
    periodStartAt: string,
    periodEndAt: string,
  ) {
    const rows = yield* sql<SnapshotRow>`
      SELECT id, recipient_subject AS "recipientSubject", local_date AS "localDate",
        timezone, period_start_at AS "periodStartAt", period_end_at AS "periodEndAt",
        generated_at AS "generatedAt", content_digest AS "contentDigest",
        items_json AS "itemsJson", supersedes_id AS "supersedesId", viewed_at AS "viewedAt"
      FROM command_center_digest_snapshots
      WHERE recipient_subject = ${recipientSubject}
        AND period_start_at = ${periodStartAt} AND period_end_at = ${periodEndAt}
      ORDER BY generated_at DESC, id DESC LIMIT 1
    `;
    return rows[0] === undefined ? null : yield* snapshotFromRow(rows[0]);
  });

  const query = Effect.fn("CommandCenterDigest.query")(
    function* (input: {
      readonly recipientSubject: string;
      readonly configTimezone: string | null;
    }) {
      const now = yield* dependencies.now;
      const preferences = yield* preferencesFor(input.recipientSubject, input.configTimezone);
      const period = digestPeriod(now, preferences.timezone);
      const rows = yield* sql<ItemRow>`
        SELECT inbox.space_id AS "spaceId", inbox.item_id AS "itemId",
          inbox.current_revision_id AS "revisionId", inbox.version AS "itemVersion",
          item.title, item.kind, item.status, inbox.updated_at AS "updatedAt",
          COUNT(*) OVER () AS "totalCount"
        FROM command_center_inbox_state inbox
        JOIN command_center_items item ON item.id = inbox.item_id AND item.space_id = inbox.space_id
        JOIN command_center_spaces space ON space.id = inbox.space_id AND space.lifecycle = 'active'
        WHERE inbox.updated_at >= ${period.startAt} AND inbox.updated_at < ${period.endAt}
          AND inbox.updated_at <= ${now}
          AND item.status NOT IN ('done', 'canceled')
          AND (inbox.lifecycle = 'open'
            OR (inbox.lifecycle = 'snoozed' AND inbox.snoozed_until <= ${now}))
          AND (item.kind IN ('decision', 'approval', 'alert') OR item.status IN ('review', 'waiting'))
        ORDER BY inbox.space_id, inbox.item_id
        LIMIT ${MAX_DIGEST_ITEMS}
      `;
      // A busy day keeps the digest usable: show the first page in stable Space/item order and
      // report how many actionable changes exist in total.
      const totalCount = Number(rows[0]?.totalCount ?? 0);
      const items = yield* decodeItems(
        rows.map(({ totalCount: _totalCount, ...row }) => ({
          ...row,
          title: row.title.slice(0, 500),
        })),
      ).pipe(Effect.mapError(() => failure("persistence", "An actionable Inbox item is invalid.")));
      const latest = yield* latestSnapshot(input.recipientSubject, period.startAt, period.endAt);
      const contentDigest = `sha256:${NodeCrypto.createHash("sha256")
        .update(
          canonicalJson({
            startAt: period.startAt,
            endAt: period.endAt,
            items: items.map((item) => [
              item.spaceId,
              item.itemId,
              item.revisionId,
              item.itemVersion,
              item.status,
            ]),
          }),
        )
        .digest("hex")}`;
      const quiet = isDigestQuietHour(
        now,
        preferences.timezone,
        preferences.quietStart,
        preferences.quietEnd,
      );
      let snapshot = latest?.contentDigest === contentDigest ? latest : null;
      if (items.length > 0 && !quiet && snapshot === null) {
        snapshot = yield* sql.withTransaction(
          Effect.gen(function* () {
            const existing = yield* sql<SnapshotRow>`
            SELECT id, recipient_subject AS "recipientSubject", local_date AS "localDate",
              timezone, period_start_at AS "periodStartAt", period_end_at AS "periodEndAt",
              generated_at AS "generatedAt", content_digest AS "contentDigest",
              items_json AS "itemsJson", supersedes_id AS "supersedesId", viewed_at AS "viewedAt"
            FROM command_center_digest_snapshots
            WHERE recipient_subject = ${input.recipientSubject}
              AND period_start_at = ${period.startAt} AND period_end_at = ${period.endAt}
              AND content_digest = ${contentDigest}
            LIMIT 1
          `;
            if (existing[0]) return yield* snapshotFromRow(existing[0]);
            const id = NodeCrypto.randomUUID();
            const candidate = yield* decodeSnapshot({
              id,
              recipientSubject: input.recipientSubject,
              localDate: period.localDate,
              timezone: preferences.timezone,
              periodStartAt: period.startAt,
              periodEndAt: period.endAt,
              generatedAt: now,
              contentDigest,
              supersedesId: latest?.id ?? null,
              viewedAt: null,
              items,
            }).pipe(
              Effect.mapError(() =>
                failure("persistence", "Digest snapshot could not be encoded."),
              ),
            );
            yield* sql`
            INSERT INTO command_center_digest_snapshots (
              id, recipient_subject, local_date, timezone, period_start_at, period_end_at,
              generated_at, content_digest, items_json, supersedes_id
            ) VALUES (
              ${candidate.id}, ${candidate.recipientSubject}, ${candidate.localDate},
              ${candidate.timezone}, ${candidate.periodStartAt}, ${candidate.periodEndAt},
              ${candidate.generatedAt}, ${candidate.contentDigest}, ${encodeStoredItems(candidate.items)},
              ${candidate.supersedesId}
            )
          `;
            return candidate;
          }),
        );
      }
      return {
        recipientSubject: input.recipientSubject,
        preferences,
        period: { localDate: period.localDate, startAt: period.startAt, endAt: period.endAt },
        snapshot,
        totalCount,
        truncated: totalCount > items.length,
        notification: quiet
          ? "quiet-hours"
          : snapshot === null
            ? "empty"
            : snapshot.viewedAt
              ? "seen"
              : "available",
      } satisfies CommandCenterDigestQueryResult;
    },
    Effect.mapError((cause) =>
      isCommandCenterError(cause) ? cause : failure("persistence", "Could not load the digest."),
    ),
  );

  const updatePreferences = Effect.fn("CommandCenterDigest.updatePreferences")(
    function* (input: {
      readonly recipientSubject: string;
      readonly configTimezone: string | null;
      readonly preferences: CommandCenterDigestPreferencesUpdateInput;
    }) {
      const previous = yield* preferencesFor(input.recipientSubject, input.configTimezone);
      const next = input.preferences;
      if (!isValidAutomationTimeZone(next.timezone))
        return yield* failure("validation", "Use a valid IANA time zone.");
      if (
        (next.quietStart === null) !== (next.quietEnd === null) ||
        (next.quietStart === next.quietEnd && next.quietStart !== null)
      ) {
        return yield* failure("validation", "Quiet hours need two distinct times or must be off.");
      }
      if (previous.version !== next.expectedVersion)
        return yield* failure("conflict", "Digest preferences changed; reload before saving.");
      const now = yield* dependencies.now;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          if (previous.version === 0) {
            const inserted = yield* sql<{ readonly version: number }>`
            INSERT INTO command_center_digest_preferences (
              recipient_subject, timezone, quiet_start, quiet_end, version, updated_at
            ) VALUES (${input.recipientSubject}, ${next.timezone}, ${next.quietStart}, ${next.quietEnd}, 1, ${now})
            ON CONFLICT(recipient_subject) DO NOTHING RETURNING version
          `;
            if (inserted.length === 0)
              return yield* failure(
                "conflict",
                "Digest preferences changed; reload before saving.",
              );
          } else {
            const changed = yield* sql<{ readonly version: number }>`
            UPDATE command_center_digest_preferences SET timezone = ${next.timezone},
              quiet_start = ${next.quietStart}, quiet_end = ${next.quietEnd},
              version = version + 1, updated_at = ${now}
            WHERE recipient_subject = ${input.recipientSubject} AND version = ${next.expectedVersion}
            RETURNING version
          `;
            if (changed.length === 0)
              return yield* failure(
                "conflict",
                "Digest preferences changed; reload before saving.",
              );
          }
          return yield* preferencesFor(input.recipientSubject, input.configTimezone);
        }),
      );
    },
    Effect.mapError((cause) =>
      isCommandCenterError(cause)
        ? cause
        : failure("persistence", "Could not save digest preferences."),
    ),
  );

  const markViewed = Effect.fn("CommandCenterDigest.markViewed")(
    function* (input: { readonly recipientSubject: string; readonly snapshotId: string }) {
      const now = yield* dependencies.now;
      const rows = yield* sql<SnapshotRow>`
        UPDATE command_center_digest_snapshots SET viewed_at = COALESCE(viewed_at, ${now})
        WHERE id = ${input.snapshotId} AND recipient_subject = ${input.recipientSubject}
        RETURNING id, recipient_subject AS "recipientSubject", local_date AS "localDate",
          timezone, period_start_at AS "periodStartAt", period_end_at AS "periodEndAt",
          generated_at AS "generatedAt", content_digest AS "contentDigest",
          items_json AS "itemsJson", supersedes_id AS "supersedesId", viewed_at AS "viewedAt"
      `;
      const row = rows[0];
      if (!row)
        return yield* failure("not_found", "The digest snapshot was not found for this identity.");
      return yield* snapshotFromRow(row);
    },
    Effect.mapError((cause) =>
      isCommandCenterError(cause) ? cause : failure("persistence", "Could not mark digest viewed."),
    ),
  );

  return CommandCenterDigest.of({ query, updatePreferences, markViewed });
});

const layer = (dependencies: DigestDependencies) =>
  Layer.effect(CommandCenterDigest, make(dependencies));
export const liveLayer = layer({ now: Effect.map(DateTime.now, DateTime.formatIso) });
