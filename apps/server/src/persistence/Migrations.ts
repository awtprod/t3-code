/**
 * Migration runner with an inline loader.
 *
 * Uses Migrator.make with fromRecord to define migrations inline.
 * All migrations are statically imported - no dynamic file system loading.
 *
 * `runMigrations` is called by the SQLite persistence layer at startup, so the
 * schema is always up to date before the application starts.
 */

import * as Migrator from "effect/sql/Migrator";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Import all migrations statically
import Migration0001 from "./Migrations/001_OrchestrationEvents.ts";
import Migration0002 from "./Migrations/002_OrchestrationCommandReceipts.ts";
import Migration0003 from "./Migrations/003_CheckpointDiffBlobs.ts";
import Migration0004 from "./Migrations/004_ProviderSessionRuntime.ts";
import Migration0005 from "./Migrations/005_Projections.ts";
import Migration0006 from "./Migrations/006_ProjectionThreadSessionRuntimeModeColumns.ts";
import Migration0007 from "./Migrations/007_ProjectionThreadMessageAttachments.ts";
import Migration0008 from "./Migrations/008_ProjectionThreadActivitySequence.ts";
import Migration0009 from "./Migrations/009_ProviderSessionRuntimeMode.ts";
import Migration0010 from "./Migrations/010_ProjectionThreadsRuntimeMode.ts";
import Migration0011 from "./Migrations/011_OrchestrationThreadCreatedRuntimeMode.ts";
import Migration0012 from "./Migrations/012_ProjectionThreadsInteractionMode.ts";
import Migration0013 from "./Migrations/013_ProjectionThreadProposedPlans.ts";
import Migration0014 from "./Migrations/014_ProjectionThreadProposedPlanImplementation.ts";
import Migration0015 from "./Migrations/015_ProjectionTurnsSourceProposedPlan.ts";
import Migration0016 from "./Migrations/016_CanonicalizeModelSelections.ts";
import Migration0017 from "./Migrations/017_ProjectionThreadsArchivedAt.ts";
import Migration0018 from "./Migrations/018_ProjectionThreadsArchivedAtIndex.ts";
import Migration0019 from "./Migrations/019_ProjectionSnapshotLookupIndexes.ts";
import Migration0020 from "./Migrations/020_AuthAccessManagement.ts";
import Migration0021 from "./Migrations/021_AuthSessionClientMetadata.ts";
import Migration0022 from "./Migrations/022_AuthSessionLastConnectedAt.ts";
import Migration0023 from "./Migrations/023_ProjectionThreadShellSummary.ts";
import Migration0024 from "./Migrations/024_BackfillProjectionThreadShellSummary.ts";
import Migration0025 from "./Migrations/025_CleanupInvalidProjectionPendingApprovals.ts";
import Migration0026 from "./Migrations/026_CanonicalizeModelSelectionOptions.ts";
import Migration0027 from "./Migrations/027_ProviderSessionRuntimeInstanceId.ts";
import Migration0028 from "./Migrations/028_ProjectionThreadSessionInstanceId.ts";
import Migration0029 from "./Migrations/029_ProjectionThreadDetailOrderingIndexes.ts";
import Migration0030 from "./Migrations/030_ProjectionThreadShellArchiveIndexes.ts";
import Migration0031 from "./Migrations/031_AuthAuthorizationScopes.ts";
import Migration0032 from "./Migrations/032_AuthPairingProofKeyThumbprint.ts";
import Migration0033 from "./Migrations/033_CommandCenterCore.ts";
import Migration0034 from "./Migrations/034_CommandCenterAutomationRuntime.ts";
import Migration0035 from "./Migrations/035_CommandCenterMemorySearchIndex.ts";
import Migration0036 from "./Migrations/036_CommandCenterMigrationImports.ts";
import Migration0037 from "./Migrations/037_CommandCenterAutomationScheduleCursors.ts";
import Migration0038 from "./Migrations/038_CommandCenterAuditChainHead.ts";
import Migration0039 from "./Migrations/039_CommandCenterRunExecutionAuthorization.ts";
import Migration0040 from "./Migrations/040_CommandCenterAuditHashVersion.ts";
import Migration0041 from "./Migrations/041_CommandCenterScopedShellPolicyDigest.ts";
import Migration0042 from "./Migrations/042_CommandCenterMemorySearchGeneration.ts";
import Migration0043 from "./Migrations/043_ProjectionTurnRequestSequence.ts";
import Migration0044 from "./Migrations/044_ProjectionPendingTurnStartModelSelection.ts";
import Migration0045 from "./Migrations/045_ProjectionPendingTurnStartInterruptRequested.ts";
import Migration0046 from "./Migrations/046_ProjectionThreadSessionGeneration.ts";
import Migration0047 from "./Migrations/047_ProjectionPendingTurnStartMultiSlot.ts";
import Migration0048 from "./Migrations/048_ProviderTurnSendClaims.ts";
import Migration0049 from "./Migrations/049_ProjectionThreadActivityCorrelation.ts";
import Migration0050 from "./Migrations/050_ProjectionThreadsSettled.ts";
import Migration0051 from "./Migrations/051_ProjectionThreadsSnoozed.ts";
import Migration0052 from "./Migrations/052_ProjectionThreadTitleRegeneration.ts";
import Migration0053 from "./Migrations/053_ProjectionTurnUsage.ts";
import Migration0054 from "./Migrations/054_TokenEfficiencyRouting.ts";
import Migration0055 from "./Migrations/055_ProjectionThreadsPinned.ts";
import Migration0056 from "./Migrations/056_ProjectionTurnsKeysetIndex.ts";
import Migration0061 from "./Migrations/061_ProjectionThreadsPinOrderKey.ts";
import Migration0062 from "./Migrations/062_ProjectionProjectsDefaultThreadEnvMode.ts";
import Migration0063 from "./Migrations/063_ProjectionProjectFaviconPath.ts";
import Migration0064 from "./Migrations/064_ProjectionThreadSandbox.ts";
import Migration0065 from "./Migrations/065_AuthSessionClientConnection.ts";
import Migration0066 from "./Migrations/066_ProjectionThreadLinkedPullRequest.ts";
import Migration0067 from "./Migrations/067_ProjectionThreadsUnsettledAt.ts";
import Migration0068 from "./Migrations/068_ProviderRestartRecovery.ts";
import Migration0069 from "./Migrations/069_WebPushSubscriptions.ts";
import Migration0070 from "./Migrations/070_CommandCenterInbox.ts";
import Migration0071 from "./Migrations/071_CommandCenterSprintPlans.ts";
import Migration0072 from "./Migrations/072_CommandCenterResponsibilities.ts";
import Migration0073 from "./Migrations/073_CommandCenterObservations.ts";
import Migration0074 from "./Migrations/074_CommandCenterSprintPlanAdjustments.ts";
import Migration0075 from "./Migrations/075_CommandCenterDigest.ts";
import Migration0076 from "./Migrations/076_CommandCenterRepositorySignals.ts";
import Migration0077 from "./Migrations/077_CommandCenterInboxGmailDrafts.ts";
import Migration0078 from "./Migrations/078_InstagramReelReceipts.ts";
import Migration0079 from "./Migrations/079_CommandCenterSpaceAgent.ts";
import Migration0080 from "./Migrations/080_CommandCenterSpaceActivity.ts";
import Migration0081 from "./Migrations/081_CommandCenterSpaceAgentState.ts";
import Migration0082 from "./Migrations/082_CommandCenterSpaceAgentReplies.ts";
// Upstream-added migrations (T3 Code upstream 044-054), renumbered to 083-093
// so they append after the fork's highest migration (082). See
// docs/operations/upstream-sync.md.
import Migration0083 from "./Migrations/083_ClearAutomaticProjectModelDefaults.ts";
import Migration0084 from "./Migrations/084_ProjectionProjectsAutoPull.ts";
import Migration0085 from "./Migrations/085_RepairAutomaticSettlementTimestamps.ts";
import Migration0086 from "./Migrations/086_ProjectionProjectIcon.ts";
import Migration0087 from "./Migrations/087_ProjectionThreadBranchPullRequest.ts";
import Migration0088 from "./Migrations/088_ProjectionThreadsActiveOrderKey.ts";
import Migration0089 from "./Migrations/089_ProjectionThreadPullRequests.ts";
import Migration0090 from "./Migrations/090_ProjectionThreadMessageContext.ts";
import Migration0091 from "./Migrations/091_ProjectionThreadTitleState.ts";
import Migration0092 from "./Migrations/092_PullRequestFilesViewed.ts";
import Migration0093 from "./Migrations/093_ProjectionThreadsAutoSettleDisabledAt.ts";
import Migration0094 from "./Migrations/094_AuthSessionRenewalLineage.ts";
// Upstream orchestration V2 migrations (T3 Code upstream 055-062), renumbered
// to 095-102 so they append after the fork's highest migration (094). The
// OrchestrationV2/* modules are composed inside 095 and carry no id of their
// own. See docs/operations/upstream-sync.md.
import Migration0095 from "./Migrations/095_OrchestrationV2.ts";
import Migration0096 from "./Migrations/096_RemoveRedundantProjectionIndexes.ts";
import Migration0097 from "./Migrations/097_ScheduledTaskWebhooks.ts";
import Migration0098 from "./Migrations/098_WebhookRelayDeliveries.ts";
import Migration0099 from "./Migrations/099_McpAppModelContext.ts";
import Migration0100 from "./Migrations/100_ThreadSnapshotWindowIndexes.ts";
import Migration0101 from "./Migrations/101_PullRequestReviewGuides.ts";
import Migration0102 from "./Migrations/102_ThreadFailureLookupIndex.ts";

/**
 * Migration loader with all migrations defined inline.
 *
 * Key format: "{id}_{name}" where:
 * - id: numeric migration ID (determines execution order)
 * - name: descriptive name for the migration
 *
 * Uses Migrator.fromRecord which parses the key format and
 * returns migrations sorted by ID.
 */
export const migrationEntries = [
  [1, "OrchestrationEvents", Migration0001],
  [2, "OrchestrationCommandReceipts", Migration0002],
  [3, "CheckpointDiffBlobs", Migration0003],
  [4, "ProviderSessionRuntime", Migration0004],
  [5, "Projections", Migration0005],
  [6, "ProjectionThreadSessionRuntimeModeColumns", Migration0006],
  [7, "ProjectionThreadMessageAttachments", Migration0007],
  [8, "ProjectionThreadActivitySequence", Migration0008],
  [9, "ProviderSessionRuntimeMode", Migration0009],
  [10, "ProjectionThreadsRuntimeMode", Migration0010],
  [11, "OrchestrationThreadCreatedRuntimeMode", Migration0011],
  [12, "ProjectionThreadsInteractionMode", Migration0012],
  [13, "ProjectionThreadProposedPlans", Migration0013],
  [14, "ProjectionThreadProposedPlanImplementation", Migration0014],
  [15, "ProjectionTurnsSourceProposedPlan", Migration0015],
  [16, "CanonicalizeModelSelections", Migration0016],
  [17, "ProjectionThreadsArchivedAt", Migration0017],
  [18, "ProjectionThreadsArchivedAtIndex", Migration0018],
  [19, "ProjectionSnapshotLookupIndexes", Migration0019],
  [20, "AuthAccessManagement", Migration0020],
  [21, "AuthSessionClientMetadata", Migration0021],
  [22, "AuthSessionLastConnectedAt", Migration0022],
  [23, "ProjectionThreadShellSummary", Migration0023],
  [24, "BackfillProjectionThreadShellSummary", Migration0024],
  [25, "CleanupInvalidProjectionPendingApprovals", Migration0025],
  [26, "CanonicalizeModelSelectionOptions", Migration0026],
  [27, "ProviderSessionRuntimeInstanceId", Migration0027],
  [28, "ProjectionThreadSessionInstanceId", Migration0028],
  [29, "ProjectionThreadDetailOrderingIndexes", Migration0029],
  [30, "ProjectionThreadShellArchiveIndexes", Migration0030],
  [31, "AuthAuthorizationScopes", Migration0031],
  [32, "AuthPairingProofKeyThumbprint", Migration0032],
  [33, "CommandCenterCore", Migration0033],
  [34, "CommandCenterAutomationRuntime", Migration0034],
  [35, "CommandCenterMemorySearchIndex", Migration0035],
  [36, "CommandCenterMigrationImports", Migration0036],
  [37, "CommandCenterAutomationScheduleCursors", Migration0037],
  [38, "CommandCenterAuditChainHead", Migration0038],
  [39, "CommandCenterRunExecutionAuthorization", Migration0039],
  [40, "CommandCenterAuditHashVersion", Migration0040],
  [41, "CommandCenterScopedShellPolicyDigest", Migration0041],
  [42, "CommandCenterMemorySearchGeneration", Migration0042],
  [43, "ProjectionTurnRequestSequence", Migration0043],
  [44, "ProjectionPendingTurnStartModelSelection", Migration0044],
  [45, "ProjectionPendingTurnStartInterruptRequested", Migration0045],
  [46, "ProjectionThreadSessionGeneration", Migration0046],
  [47, "ProjectionPendingTurnStartMultiSlot", Migration0047],
  [48, "ProviderTurnSendClaims", Migration0048],
  [49, "ProjectionThreadActivityCorrelation", Migration0049],
  [50, "ProjectionThreadsSettled", Migration0050],
  [51, "ProjectionThreadsSnoozed", Migration0051],
  [52, "ProjectionThreadTitleRegeneration", Migration0052],
  [53, "ProjectionTurnUsage", Migration0053],
  [54, "TokenEfficiencyRouting", Migration0054],
  [55, "ProjectionThreadsPinned", Migration0055],
  [56, "ProjectionTurnsKeysetIndex", Migration0056],
  [61, "ProjectionThreadsPinOrderKey", Migration0061],
  [62, "ProjectionProjectsDefaultThreadEnvMode", Migration0062],
  [63, "ProjectionProjectFaviconPath", Migration0063],
  [64, "ProjectionThreadSandbox", Migration0064],
  [65, "AuthSessionClientConnection", Migration0065],
  [66, "ProjectionThreadLinkedPullRequest", Migration0066],
  [67, "ProjectionThreadsUnsettledAt", Migration0067],
  [68, "ProviderRestartRecovery", Migration0068],
  [69, "WebPushSubscriptions", Migration0069],
  [70, "CommandCenterInbox", Migration0070],
  [71, "CommandCenterSprintPlans", Migration0071],
  [72, "CommandCenterResponsibilities", Migration0072],
  [73, "CommandCenterObservations", Migration0073],
  [74, "CommandCenterSprintPlanAdjustments", Migration0074],
  [75, "CommandCenterDigest", Migration0075],
  [76, "CommandCenterRepositorySignals", Migration0076],
  [77, "CommandCenterInboxGmailDrafts", Migration0077],
  [78, "InstagramReelReceipts", Migration0078],
  [79, "CommandCenterSpaceAgent", Migration0079],
  [80, "CommandCenterSpaceActivity", Migration0080],
  [81, "CommandCenterSpaceAgentState", Migration0081],
  [82, "CommandCenterSpaceAgentReplies", Migration0082],
  // Upstream-added migrations (T3 Code upstream 044-054) renumbered to 083-093,
  // appended after the fork's 082, preserving upstream's relative order
  // (044->83 ... 054->93).
  [83, "ClearAutomaticProjectModelDefaults", Migration0083],
  [84, "ProjectionProjectsAutoPull", Migration0084],
  [85, "RepairAutomaticSettlementTimestamps", Migration0085],
  [86, "ProjectionProjectIcon", Migration0086],
  [87, "ProjectionThreadBranchPullRequest", Migration0087],
  [88, "ProjectionThreadsActiveOrderKey", Migration0088],
  [89, "ProjectionThreadPullRequests", Migration0089],
  [90, "ProjectionThreadMessageContext", Migration0090],
  [91, "ProjectionThreadTitleState", Migration0091],
  [92, "PullRequestFilesViewed", Migration0092],
  [93, "ProjectionThreadsAutoSettleDisabledAt", Migration0093],
  [94, "AuthSessionRenewalLineage", Migration0094],
  // Upstream orchestration V2 (upstream 055-062) renumbered to 095-102,
  // preserving upstream's relative order (055->95 ... 062->102). Preserve
  // 95's schema: future V2 schema changes need new migrations.
  [95, "OrchestrationV2", Migration0095],
  [96, "RemoveRedundantProjectionIndexes", Migration0096],
  [97, "ScheduledTaskWebhooks", Migration0097],
  [98, "WebhookRelayDeliveries", Migration0098],
  [99, "McpAppModelContext", Migration0099],
  [100, "ThreadSnapshotWindowIndexes", Migration0100],
  [101, "PullRequestReviewGuides", Migration0101],
  [102, "ThreadFailureLookupIndex", Migration0102],
] as const;

export const migrationManifest = migrationEntries.map(([id, name]) => [id, name] as const);

const makeMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      migrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

// V2's schema migrations start at 95 (upstream 55) after the fork's legacy
// schema migrations.
const FIRST_V2_MIGRATION_ID = 95;

/**
 * Fail before migrating when the migrator would skip one of V2's own
 * migrations. It skips every id up to the highest recorded one, whatever name
 * was recorded, so a database that took a V2 id for another migration would
 * start without V2's schema and fail on first use. Earlier ids keep the
 * warning below: databases with a site-local migration there still work.
 */
const assertV2MigrationsCanRun = Effect.fn("assertV2MigrationsCanRun")(function* (
  throughId?: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return;
  const recorded = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`SELECT migration_id, name FROM effect_sql_migrations`;
  const latestRecordedId = Math.max(0, ...recorded.map((row) => row.migration_id));
  const recordedNames = new Map(recorded.map((row) => [row.migration_id, row.name]));
  const skipped = migrationEntries.flatMap(([id, name]) => {
    if (
      id < FIRST_V2_MIGRATION_ID ||
      id > latestRecordedId ||
      (throughId !== undefined && id > throughId)
    )
      return [];
    const recordedName = recordedNames.get(id);
    if (recordedName === name) return [];
    return [`${id}_${name} (recorded: ${recordedName ?? "nothing"})`];
  });
  if (skipped.length === 0) return;
  return yield* new Migrator.MigrationError({
    kind: "BadState",
    message: `This database's migration history would skip required schema migrations: ${skipped.join(", ")}. The migrator skips every id up to the highest recorded id (${latestRecordedId}), regardless of name. It was probably written by a different build. Start the build that wrote it, or report this migration history so an upgrade path can be added.`,
  });
});

/**
 * Migrator run function - no schema dumping needed
 * Uses the base Migrator.make without platform dependencies
 */
const run = Migrator.make({});

/**
 * IDs that are intentionally absent from the registry. The upstream sync
 * (#37) renumbered 57-60 to 61-64; databases that ran the old numbering still
 * record 57-60 as applied, so those IDs must never be reused.
 */
export const RETIRED_MIGRATION_IDS: ReadonlyArray<number> = [57, 58, 59, 60];

/**
 * Problems with the order of registered migration IDs.
 *
 * The Migrator runs only IDs above the highest applied one, so the registry
 * must be strictly increasing and gap-free apart from retired IDs. A gap means
 * a lower-numbered migration from another branch has not landed yet: merging
 * the higher one first would skip the lower one forever on every database that
 * upgrades in between (see `assertNoSkippedMigrations`).
 */
const missingRange = (start: number, end: number, before: number): string =>
  start === end
    ? `migration ${start} is missing before ${before}`
    : `migrations ${start}-${end} are missing before ${before}`;

export const findMigrationSequenceViolations = (
  registeredIds: ReadonlyArray<number>,
  retiredIds: ReadonlyArray<number> = RETIRED_MIGRATION_IDS,
): ReadonlyArray<string> => {
  const violations: Array<string> = [];
  const invalid = registeredIds.filter((id) => !Number.isSafeInteger(id) || id < 1);
  if (invalid.length > 0) {
    return invalid.map((id) => `migration ID ${String(id)} is not a positive integer`);
  }
  const retired = new Set(retiredIds);
  for (let index = 1; index < registeredIds.length; index++) {
    const previous = registeredIds[index - 1]!;
    const current = registeredIds[index]!;
    if (current <= previous) {
      violations.push(`migration ${current} is registered after ${previous}`);
    }
  }
  for (const id of registeredIds) {
    if (retired.has(id)) violations.push(`migration ${id} reuses a retired ID`);
  }
  // Gaps are judged on the sorted IDs so an out-of-order entry is reported
  // once (above), not again as "missing". Each gap is split only at retired
  // IDs inside it, so the work is bounded by the registry and retired list,
  // never by the size of a gap (a typo'd huge ID is reported immediately).
  const sorted = [...new Set(registeredIds)].toSorted((left, right) => left - right);
  const retiredSorted = [...retired].toSorted((left, right) => left - right);
  let expected = 1;
  for (const id of sorted) {
    let start = expected;
    for (const skipped of retiredSorted) {
      if (skipped < start) continue;
      if (skipped >= id) break;
      if (skipped > start) violations.push(missingRange(start, skipped - 1, id));
      start = skipped + 1;
    }
    if (start < id) violations.push(missingRange(start, id - 1, id));
    expected = id + 1;
  }
  return violations;
};

/** Table the effect Migrator records applied migrations in (its default). */
export const MIGRATIONS_TABLE = "effect_sql_migrations";

/**
 * Registered migration IDs that the Migrator would silently never run.
 *
 * The Migrator only runs registered migrations whose ID is greater than the
 * highest applied ID. A migration registered with a lower ID after a higher
 * one was already applied (e.g. two branches numbered ahead of each other and
 * merged/deployed out of order) is therefore skipped forever. Gaps in the
 * registry are irrelevant: only registered-but-unapplied IDs below the highest
 * applied ID are returned.
 */
export const findSkippedMigrationIds = (
  registeredIds: ReadonlyArray<number>,
  appliedIds: ReadonlyArray<number>,
): ReadonlyArray<number> => {
  if (appliedIds.length === 0) return [];
  const applied = new Set(appliedIds);
  const maxApplied = Math.max(...appliedIds);
  return registeredIds.filter((id) => id < maxApplied && !applied.has(id)).sort((a, b) => a - b);
};

/**
 * Fail before running migrations if any registered migration would be skipped
 * because a higher-numbered migration is already recorded as applied.
 */
export const assertNoSkippedMigrations = Effect.fn("assertNoSkippedMigrations")(function* (
  registeredIds: ReadonlyArray<number>,
) {
  const sql = yield* SqlClient.SqlClient;
  const fail = (cause: unknown) =>
    new Migrator.MigrationError({
      kind: "BadState",
      message: `Failed to read applied migrations from ${MIGRATIONS_TABLE}`,
      cause,
    });
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${MIGRATIONS_TABLE}
  `.pipe(Effect.mapError(fail));
  if (tables.length === 0) return;
  const rows = yield* sql<{ readonly migration_id: number }>`
    SELECT migration_id FROM ${sql(MIGRATIONS_TABLE)}
  `.withoutTransform.pipe(Effect.mapError(fail));
  const appliedIds = rows.map((row) => Number(row.migration_id));
  const skipped = findSkippedMigrationIds(registeredIds, appliedIds);
  if (skipped.length === 0) return;
  const maxApplied = Math.max(...appliedIds);
  return yield* new Migrator.MigrationError({
    kind: "BadState",
    message:
      `Refusing to start: registered migration(s) ${skipped.join(", ")} have not been applied, ` +
      `but migration ${maxApplied} (a higher ID) already has been. The migrator only runs IDs ` +
      `above the latest applied one, so these would be skipped forever. They were most likely ` +
      `registered after a higher-numbered migration was already applied to this database ` +
      `(out-of-order merge or deploy). Renumber them above ${maxApplied} or apply them manually.`,
  });
});

export interface RunMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
}

/**
 * Run all pending migrations.
 *
 * Creates the migrations tracking table (effect_sql_migrations) if it doesn't exist,
 * then runs any migrations with ID greater than the latest recorded migration.
 *
 * Returns array of [id, name] tuples for migrations that were run.
 *
 * @returns Effect containing array of executed migrations
 */
export const runMigrations = Effect.fn("runMigrations")(function* ({
  toMigrationInclusive,
}: RunMigrationsOptions = {}) {
  if (toMigrationInclusive === undefined || toMigrationInclusive >= FIRST_V2_MIGRATION_ID) {
    yield* assertV2MigrationsCanRun(toMigrationInclusive);
  }
  yield* assertNoSkippedMigrations(
    migrationEntries
      .map(([id]) => id)
      .filter((id) => toMigrationInclusive === undefined || id <= toMigrationInclusive),
  );
  const executedMigrations = yield* run({ loader: makeMigrationLoader(toMigrationInclusive) });
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Database schema is current")
    : Effect.log("Migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));

  // The migrator keys on migration_id: a database that recorded a different
  // migration under a shared id (local or fork builds) keeps that id and
  // silently skips this build's migration at it. Surface the divergence so the
  // skipped schema change is diagnosable.
  const sql = yield* SqlClient.SqlClient;
  const recorded = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`SELECT migration_id, name FROM effect_sql_migrations`;
  const manifestNames = new Map<number, string>(migrationEntries.map(([id, name]) => [id, name]));
  const divergent = recorded.flatMap((row) => {
    const expected = manifestNames.get(row.migration_id);
    if (expected === undefined) {
      return [`${row.migration_id}:${row.name} (unknown to this build)`];
    }
    return expected === row.name
      ? []
      : [`${row.migration_id}:${row.name} (this build: ${expected})`];
  });
  if (divergent.length > 0) {
    yield* Effect.logWarning(
      "Database migration history diverges from this build; recorded migration ids are skipped, not reconciled by name.",
    ).pipe(Effect.annotateLogs({ divergent }));
  }
  return executedMigrations;
});
