// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Standalone host migration utility.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

export const MIGRATION_MANIFEST_VERSION = 1;

export type MigrationDisposition =
  | "import-as-archive"
  | "import-as-untrusted-memory-index"
  | "import-disabled-automation"
  | "skip-operational-history";

export interface SelectiveMigrationOptions {
  readonly stateDatabasePath: string;
  readonly memoryDatabasePath: string;
  readonly targetPath: string;
  readonly automationsPath?: string | undefined;
  readonly aliasMapPath?: string | undefined;
  readonly excludedAutomations?: readonly string[];
  readonly apply?: boolean;
  readonly now?: () => Date;
}

export interface SourceLabelResolution {
  readonly original: string | null;
  readonly resolved: string | null;
  readonly aliasApplied: boolean;
}

export interface TableInventory {
  readonly name: string;
  readonly rowCount: number | null;
  readonly readError?: string;
}

export interface DatabaseInventory {
  readonly kind: "state" | "memory";
  readonly sourcePath: string;
  readonly sizeBytes: number;
  readonly physicalSha256: string;
  readonly quickCheck: {
    readonly status: "ok" | "failed" | "unavailable";
    readonly details: readonly string[];
  };
  readonly tables: readonly TableInventory[];
}

export interface ClassificationEntry {
  readonly source: "state" | "memory" | "automations";
  readonly name: string;
  readonly disposition: MigrationDisposition;
  readonly rowCount: number | null;
  readonly reason: string;
}

export interface MigrationManifest {
  readonly schemaVersion: number;
  readonly planId: string;
  readonly createdAt: string;
  readonly mode: "dry-run" | "applied-to-staging-bundle";
  readonly safety: {
    readonly sourcesOpenedReadOnly: true;
    readonly targetApplicationDatabaseWritten: false;
    readonly servicesStoppedByTool: false;
    readonly applyRequiredForTargetWrites: true;
  };
  readonly target: {
    readonly path: string;
    readonly stateBeforeRun: "absent" | "empty" | "non-empty";
    readonly eligibleForApply: boolean;
  };
  readonly sources: {
    readonly state: DatabaseInventory;
    readonly memory: DatabaseInventory;
    readonly automations: {
      readonly sourcePath: string | null;
      readonly validCount: number;
      readonly excludedCount: number;
      readonly invalidCount: number;
      readonly files: readonly AutomationInventoryEntry[];
    };
    readonly aliasMap: {
      readonly sourcePath: string | null;
      readonly sha256: string | null;
      readonly aliasCount: number;
    };
  };
  readonly classifications: readonly ClassificationEntry[];
  readonly totals: {
    readonly archiveRecords: number;
    readonly untrustedMemoryRecords: number;
    readonly disabledAutomations: number;
    readonly skippedRows: number;
  };
  readonly backup: {
    readonly status: "planned" | "completed";
    readonly entries: readonly BackupManifestEntry[];
  };
  readonly imports: {
    readonly status: "planned" | "completed";
    readonly entries: readonly ImportManifestEntry[];
  };
  readonly cutover: {
    readonly status: "manual-not-started";
    readonly performedByTool: false;
    readonly preconditions: readonly ManifestAction[];
    readonly operatorActions: readonly ManifestAction[];
  };
  readonly rollback: {
    readonly status: "ready-after-operator-validation";
    readonly performedByTool: false;
    readonly triggers: readonly string[];
    readonly steps: readonly ManifestAction[];
  };
  readonly outputFiles: readonly string[];
}

export interface MigrationResult {
  readonly applied: boolean;
  readonly manifest: MigrationManifest;
}

interface ManifestAction {
  readonly id: string;
  readonly description: string;
  readonly automated: false;
}

interface BackupManifestEntry {
  readonly sourceKind: "state" | "memory" | "automation";
  readonly sourcePath: string;
  readonly relativeBackupPath: string;
  readonly sourcePhysicalSha256: string;
  readonly backupSha256: string | null;
}

export interface ImportManifestEntry {
  readonly kind: "archive-artifacts" | "untrusted-memory" | "disabled-automations";
  readonly relativePath: string;
  readonly recordCount: number;
  readonly sha256: string | null;
}

interface AutomationInventoryEntry {
  readonly relativePath: string;
  readonly status: "valid" | "excluded" | "invalid";
  readonly sha256: string;
  readonly reason?: string;
}

interface AutomationCandidate extends AutomationInventoryEntry {
  readonly definition?: Record<string, unknown>;
}

interface AliasConfiguration {
  readonly sourcePath: string | null;
  readonly sha256: string | null;
  readonly values: ReadonlyMap<string, string>;
}

interface PreparedInputs {
  readonly aliases: AliasConfiguration;
  readonly automations: readonly AutomationCandidate[];
  readonly targetState: "absent" | "empty" | "non-empty";
  readonly stateInventory: DatabaseInventory;
  readonly memoryInventory: DatabaseInventory;
}

const ARCHIVE_TABLES: ReadonlyMap<string, string> = new Map([
  ["coding_sessions", "coding-session-summary"],
  ["spec_flows", "spec-flow-summary"],
] as const);

const MEMORY_INDEX_TABLE = "memory_chunks";
const MAX_AUTOMATION_BYTES = 1024 * 1024;
const IMPORT_FILES = {
  archives: "imports/archive-records.jsonl",
  memory: "imports/untrusted-memory-index.jsonl",
  automations: "imports/disabled-automations.jsonl",
} as const;

const ARCHIVE_FIELDS = new Set([
  "id",
  "title",
  "task",
  "request",
  "summary",
  "status",
  "mode",
  "provider",
  "model",
  "branch",
  "base_ref",
  "source_branch",
  "source_commit",
  "work_item_id",
  "coding_session_id",
  "created_at",
  "updated_at",
  "completed_at",
]);

const SOURCE_LABEL_FIELDS = [
  "source_label",
  "sourceLabel",
  "space_id",
  "spaceId",
  "repo_scope",
  "repoScope",
  "repository",
  "repo_path",
  "repoPath",
  "project_id",
  "projectId",
  "project",
  "source",
] as const;

const MEMORY_PROVENANCE_FIELDS = [
  "turn_id",
  "source_kind",
  "source_weight",
  "captured_at",
  "repo_scope",
  "source_agent",
  "transcript_path",
  "heading",
  "source_location",
  "chunker_version",
] as const;

export async function runSelectiveMigration(
  options: SelectiveMigrationOptions,
): Promise<MigrationResult> {
  const normalized = await normalizeOptions(options);
  const prepared = await prepareInputs(normalized);

  if (!normalized.apply) {
    return {
      applied: false,
      manifest: buildManifest({
        options: normalized,
        prepared,
        stateInventory: prepared.stateInventory,
        memoryInventory: prepared.memoryInventory,
        backupStatus: "planned",
        backupHashes: { state: null, memory: null, automations: new Map() },
        importEntries: undefined,
      }),
    };
  }

  assertApplyEligible(prepared);
  await createEmptyTarget(normalized.targetPath);

  const backupDirectory = NodePath.join(normalized.targetPath, "backups");
  const importDirectory = NodePath.join(normalized.targetPath, "imports");
  await NodeFSP.mkdir(backupDirectory, { mode: 0o700 });
  await NodeFSP.mkdir(importDirectory, { mode: 0o700 });

  const stateBackupPath = NodePath.join(backupDirectory, "state.sqlite");
  const memoryBackupPath = NodePath.join(backupDirectory, "memory.sqlite");
  await createSqliteBackup(normalized.stateDatabasePath, stateBackupPath);
  await createSqliteBackup(normalized.memoryDatabasePath, memoryBackupPath);
  const automationBackupHashes = await backupAutomationFiles(
    prepared.automations,
    normalized.automationsPath,
    backupDirectory,
  );

  const [stateInventory, memoryInventory, stateBackupSha256, memoryBackupSha256] =
    await Promise.all([
      inspectDatabase("state", stateBackupPath, normalized.stateDatabasePath),
      inspectDatabase("memory", memoryBackupPath, normalized.memoryDatabasePath),
      hashFile(stateBackupPath),
      hashFile(memoryBackupPath),
    ]);

  assertQuickCheck(stateInventory);
  assertQuickCheck(memoryInventory);

  const archiveImportPath = NodePath.join(normalized.targetPath, IMPORT_FILES.archives);
  const memoryImportPath = NodePath.join(normalized.targetPath, IMPORT_FILES.memory);
  const automationImportPath = NodePath.join(normalized.targetPath, IMPORT_FILES.automations);
  writeArchiveBundle(stateBackupPath, archiveImportPath, prepared.aliases.values);
  writeMemoryBundle(memoryBackupPath, memoryImportPath, prepared.aliases.values);
  writeAutomationBundle(prepared.automations, automationImportPath, prepared.aliases.values);

  const importEntries: readonly ImportManifestEntry[] = await Promise.all([
    describeImport("archive-artifacts", IMPORT_FILES.archives, archiveImportPath),
    describeImport("untrusted-memory", IMPORT_FILES.memory, memoryImportPath),
    describeImport("disabled-automations", IMPORT_FILES.automations, automationImportPath),
  ]);

  const manifest = buildManifest({
    options: normalized,
    prepared,
    stateInventory,
    memoryInventory,
    backupStatus: "completed",
    backupHashes: {
      state: stateBackupSha256,
      memory: memoryBackupSha256,
      automations: automationBackupHashes,
    },
    importEntries,
  });
  writeJsonExclusive(NodePath.join(normalized.targetPath, "manifest.json"), manifest);

  return { applied: true, manifest };
}

async function normalizeOptions(options: SelectiveMigrationOptions): Promise<NormalizedOptions> {
  const stateDatabasePath = requireAbsolutePath(options.stateDatabasePath, "state database");
  const memoryDatabasePath = requireAbsolutePath(options.memoryDatabasePath, "memory database");
  const targetPath = requireSafeTargetPath(options.targetPath);
  const automationsPath = options.automationsPath
    ? requireAbsolutePath(options.automationsPath, "automations directory")
    : undefined;
  const aliasMapPath = options.aliasMapPath
    ? requireAbsolutePath(options.aliasMapPath, "alias map")
    : undefined;

  if (stateDatabasePath === memoryDatabasePath) {
    throw new Error("The state and memory database paths must be different files.");
  }
  if (
    targetPath === NodePath.dirname(stateDatabasePath) ||
    targetPath === NodePath.dirname(memoryDatabasePath)
  ) {
    throw new Error("The target must not be either source database directory.");
  }

  await assertRegularFile(stateDatabasePath, "state database");
  await assertRegularFile(memoryDatabasePath, "memory database");
  if (aliasMapPath) await assertRegularFile(aliasMapPath, "alias map");
  if (automationsPath) await assertDirectory(automationsPath, "automations directory");
  if (automationsPath && isPathWithin(targetPath, automationsPath)) {
    throw new Error("The target must not be inside the source automations directory.");
  }

  return {
    stateDatabasePath,
    memoryDatabasePath,
    targetPath,
    automationsPath,
    aliasMapPath,
    excludedAutomations: normalizeExclusions(options.excludedAutomations ?? []),
    apply: options.apply === true,
    now: options.now ?? (() => new Date()),
  };
}

interface NormalizedOptions {
  readonly stateDatabasePath: string;
  readonly memoryDatabasePath: string;
  readonly targetPath: string;
  readonly automationsPath: string | undefined;
  readonly aliasMapPath: string | undefined;
  readonly excludedAutomations: readonly string[];
  readonly apply: boolean;
  readonly now: () => Date;
}

async function prepareInputs(options: NormalizedOptions): Promise<PreparedInputs> {
  const [aliases, targetState, stateInventory, memoryInventory] = await Promise.all([
    loadAliasConfiguration(options.aliasMapPath),
    inspectTarget(options.targetPath),
    inspectDatabase("state", options.stateDatabasePath, options.stateDatabasePath),
    inspectDatabase("memory", options.memoryDatabasePath, options.memoryDatabasePath),
  ]);
  const automations = await inspectAutomations(
    options.automationsPath,
    new Set(options.excludedAutomations),
  );

  return { aliases, automations, targetState, stateInventory, memoryInventory };
}

function buildManifest(input: {
  readonly options: NormalizedOptions;
  readonly prepared: PreparedInputs;
  readonly stateInventory: DatabaseInventory;
  readonly memoryInventory: DatabaseInventory;
  readonly backupStatus: "planned" | "completed";
  readonly backupHashes: {
    readonly state: string | null;
    readonly memory: string | null;
    readonly automations: ReadonlyMap<string, string>;
  };
  readonly importEntries: readonly ImportManifestEntry[] | undefined;
}): MigrationManifest {
  const classifications = buildClassifications(
    input.stateInventory,
    input.memoryInventory,
    input.prepared.automations,
  );
  const invalidAutomationCount = input.prepared.automations.filter(
    (entry) => entry.status === "invalid",
  ).length;
  const eligibleForApply =
    input.prepared.targetState !== "non-empty" &&
    input.prepared.stateInventory.quickCheck.status === "ok" &&
    input.prepared.memoryInventory.quickCheck.status === "ok" &&
    invalidAutomationCount === 0;
  const createdAt = input.options.now().toISOString();
  const planId = createPlanId({
    stateSha256: input.prepared.stateInventory.physicalSha256,
    stateTables: inventoryPlanFingerprint(input.prepared.stateInventory),
    memorySha256: input.prepared.memoryInventory.physicalSha256,
    memoryTables: inventoryPlanFingerprint(input.prepared.memoryInventory),
    aliasSha256: input.prepared.aliases.sha256,
    automations: input.prepared.automations.map((entry) => ({
      relativePath: entry.relativePath,
      status: entry.status,
      sha256: entry.sha256,
    })),
  });

  return {
    schemaVersion: MIGRATION_MANIFEST_VERSION,
    planId,
    createdAt,
    mode: input.backupStatus === "completed" ? "applied-to-staging-bundle" : "dry-run",
    safety: {
      sourcesOpenedReadOnly: true,
      targetApplicationDatabaseWritten: false,
      servicesStoppedByTool: false,
      applyRequiredForTargetWrites: true,
    },
    target: {
      path: input.options.targetPath,
      stateBeforeRun: input.prepared.targetState,
      eligibleForApply,
    },
    sources: {
      state: mergeSourceMetadataWithSnapshot(input.prepared.stateInventory, input.stateInventory),
      memory: mergeSourceMetadataWithSnapshot(
        input.prepared.memoryInventory,
        input.memoryInventory,
      ),
      automations: {
        sourcePath: input.options.automationsPath ?? null,
        validCount: input.prepared.automations.filter((entry) => entry.status === "valid").length,
        excludedCount: input.prepared.automations.filter((entry) => entry.status === "excluded")
          .length,
        invalidCount: invalidAutomationCount,
        files: input.prepared.automations.map(({ definition: _definition, ...entry }) => entry),
      },
      aliasMap: {
        sourcePath: input.prepared.aliases.sourcePath,
        sha256: input.prepared.aliases.sha256,
        aliasCount: input.prepared.aliases.values.size,
      },
    },
    classifications,
    totals: {
      archiveRecords: sumClassifications(classifications, "import-as-archive"),
      untrustedMemoryRecords: sumClassifications(
        classifications,
        "import-as-untrusted-memory-index",
      ),
      disabledAutomations: sumClassifications(classifications, "import-disabled-automation"),
      skippedRows: sumClassifications(classifications, "skip-operational-history"),
    },
    backup: {
      status: input.backupStatus,
      entries: [
        {
          sourceKind: "state",
          sourcePath: input.options.stateDatabasePath,
          relativeBackupPath: "backups/state.sqlite",
          sourcePhysicalSha256: input.prepared.stateInventory.physicalSha256,
          backupSha256: input.backupHashes.state,
        },
        {
          sourceKind: "memory",
          sourcePath: input.options.memoryDatabasePath,
          relativeBackupPath: "backups/memory.sqlite",
          sourcePhysicalSha256: input.prepared.memoryInventory.physicalSha256,
          backupSha256: input.backupHashes.memory,
        },
        ...input.prepared.automations.map((automation) => ({
          sourceKind: "automation" as const,
          sourcePath: NodePath.join(
            input.options.automationsPath ?? "",
            ...automation.relativePath.split("/"),
          ),
          relativeBackupPath: `backups/automations/${automation.relativePath}`,
          sourcePhysicalSha256: automation.sha256,
          backupSha256: input.backupHashes.automations.get(automation.relativePath) ?? null,
        })),
      ],
    },
    imports: {
      status: input.backupStatus === "completed" ? "completed" : "planned",
      entries: input.importEntries ?? [
        {
          kind: "archive-artifacts",
          relativePath: IMPORT_FILES.archives,
          recordCount: sumClassifications(classifications, "import-as-archive"),
          sha256: null,
        },
        {
          kind: "untrusted-memory",
          relativePath: IMPORT_FILES.memory,
          recordCount: sumClassifications(classifications, "import-as-untrusted-memory-index"),
          sha256: null,
        },
        {
          kind: "disabled-automations",
          relativePath: IMPORT_FILES.automations,
          recordCount: sumClassifications(classifications, "import-disabled-automation"),
          sha256: null,
        },
      ],
    },
    cutover: {
      status: "manual-not-started",
      performedByTool: false,
      preconditions: [
        manualAction(
          "validate-bundle",
          "Validate imported counts, provenance, and target behavior.",
        ),
        manualAction("record-runtime-state", "Record the operator-approved legacy runtime state."),
        manualAction(
          "confirm-rollback",
          "Confirm the backup files and rollback procedure are usable.",
        ),
      ],
      operatorActions: [
        manualAction(
          "quiesce-legacy",
          "Quiesce legacy processes through the approved service manager.",
        ),
        manualAction(
          "activate-target",
          "Activate the replacement runtime using its deployment procedure.",
        ),
        manualAction(
          "verify-target",
          "Verify health, access, routing, and representative read-only flows.",
        ),
      ],
    },
    rollback: {
      status: "ready-after-operator-validation",
      performedByTool: false,
      triggers: [
        "Target health checks fail.",
        "Imported counts or provenance do not match the manifest.",
        "Required access or routing is unavailable.",
      ],
      steps: [
        manualAction(
          "stop-target",
          "Stop the replacement runtime through the approved service manager.",
        ),
        manualAction("restore-runtime-state", "Restore the recorded legacy runtime configuration."),
        manualAction(
          "restore-data-if-needed",
          "Restore database copies only after validating exact paths and checksums.",
        ),
        manualAction("verify-legacy", "Verify legacy health and record the rollback outcome."),
      ],
    },
    outputFiles:
      input.backupStatus === "completed"
        ? [
            "manifest.json",
            "backups/state.sqlite",
            "backups/memory.sqlite",
            ...(input.options.automationsPath ? ["backups/automations/"] : []),
            IMPORT_FILES.archives,
            IMPORT_FILES.memory,
            IMPORT_FILES.automations,
          ]
        : [],
  };
}

function buildClassifications(
  state: DatabaseInventory,
  memory: DatabaseInventory,
  automations: readonly AutomationCandidate[],
): ClassificationEntry[] {
  const entries: ClassificationEntry[] = [];
  for (const table of state.tables) {
    const disposition = ARCHIVE_TABLES.has(table.name)
      ? "import-as-archive"
      : "skip-operational-history";
    entries.push({
      source: "state",
      name: table.name,
      disposition,
      rowCount: table.rowCount,
      reason:
        disposition === "import-as-archive"
          ? "Only summary-safe fields are staged as read-only archive artifacts."
          : "The table is operational history or is outside the selective import allowlist.",
    });
  }
  for (const table of memory.tables) {
    const disposition =
      table.name === MEMORY_INDEX_TABLE
        ? "import-as-untrusted-memory-index"
        : "skip-operational-history";
    entries.push({
      source: "memory",
      name: table.name,
      disposition,
      rowCount: table.rowCount,
      reason:
        disposition === "import-as-untrusted-memory-index"
          ? "Text and source provenance are staged without trusting or reusing derived embeddings."
          : "The table is derived index state, capture state, or outside the selective import allowlist.",
    });
  }
  for (const automation of automations) {
    entries.push({
      source: "automations",
      name: automation.relativePath,
      disposition:
        automation.status === "valid" ? "import-disabled-automation" : "skip-operational-history",
      rowCount: automation.status === "valid" ? 1 : 0,
      reason:
        automation.status === "valid"
          ? "The definition is staged disabled and requires operator review before activation."
          : (automation.reason ?? "The definition was explicitly excluded."),
    });
  }
  return entries;
}

async function inspectDatabase(
  kind: "state" | "memory",
  databasePath: string,
  reportedSourcePath: string,
): Promise<DatabaseInventory> {
  const [metadata, physicalSha256] = await Promise.all([
    NodeFSP.stat(databasePath),
    hashFile(databasePath),
  ]);
  const database = openReadOnlyDatabase(databasePath);
  try {
    const quickCheck = runQuickCheck(database);
    const schemaRows = database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const tables = schemaRows.map(({ name }) => inventoryTable(database, name));
    return {
      kind,
      sourcePath: reportedSourcePath,
      sizeBytes: metadata.size,
      physicalSha256,
      quickCheck,
      tables,
    };
  } finally {
    database.close();
  }
}

function openReadOnlyDatabase(databasePath: string): NodeSqlite.DatabaseSync {
  const database = new NodeSqlite.DatabaseSync(databasePath, {
    readOnly: true,
    timeout: 5_000,
    defensive: true,
  });
  database.exec("PRAGMA query_only = ON");
  return database;
}

function runQuickCheck(database: NodeSqlite.DatabaseSync): DatabaseInventory["quickCheck"] {
  try {
    const rows = database.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
    const details = rows.flatMap((row) => Object.values(row).map(String));
    return {
      status: details.length > 0 && details.every((value) => value === "ok") ? "ok" : "failed",
      details,
    };
  } catch (error) {
    return { status: "unavailable", details: [safeErrorMessage(error)] };
  }
}

function inventoryTable(database: NodeSqlite.DatabaseSync, name: string): TableInventory {
  try {
    const row = database.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)}`).get() as
      | { count: number | bigint }
      | undefined;
    return { name, rowCount: row ? Number(row.count) : 0 };
  } catch (error) {
    return { name, rowCount: null, readError: safeErrorMessage(error) };
  }
}

async function inspectAutomations(
  automationsPath: string | undefined,
  exclusions: ReadonlySet<string>,
): Promise<readonly AutomationCandidate[]> {
  if (!automationsPath) return [];
  const paths = await listJsonFiles(automationsPath);
  return Promise.all(
    paths.map(async (absolutePath) => {
      const relativePath = toPortablePath(NodePath.relative(automationsPath, absolutePath));
      const bytes = await NodeFSP.readFile(absolutePath);
      const sha256 = sha256Bytes(bytes);
      if (exclusions.has(relativePath)) {
        return {
          relativePath,
          status: "excluded" as const,
          sha256,
          reason: "Explicitly excluded by relative path.",
        };
      }
      if (bytes.byteLength > MAX_AUTOMATION_BYTES) {
        return {
          relativePath,
          status: "invalid" as const,
          sha256,
          reason: `Definition exceeds the ${MAX_AUTOMATION_BYTES}-byte safety limit.`,
        };
      }
      try {
        const parsed: unknown = JSON.parse(bytes.toString("utf8"));
        if (!isRecord(parsed)) throw new Error("The JSON root must be an object.");
        return { relativePath, status: "valid" as const, sha256, definition: parsed };
      } catch (error) {
        return {
          relativePath,
          status: "invalid" as const,
          sha256,
          reason: safeErrorMessage(error),
        };
      }
    }),
  );
}

async function listJsonFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await NodeFSP.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const candidate = NodePath.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Automation directory contains a symbolic link: ${candidate}`);
      }
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && entry.name.endsWith(".json")) results.push(candidate);
    }
  }
  await visit(root);
  return results;
}

async function loadAliasConfiguration(
  aliasMapPath: string | undefined,
): Promise<AliasConfiguration> {
  if (!aliasMapPath) return { sourcePath: null, sha256: null, values: new Map() };
  const bytes = await NodeFSP.readFile(aliasMapPath);
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  if (!isRecord(parsed)) throw new Error("Alias map JSON must be an object.");
  const candidate = isRecord(parsed.aliases) ? parsed.aliases : parsed;
  const values = new Map<string, string>();
  for (const [legacyLabel, resolvedLabel] of Object.entries(candidate)) {
    if (typeof resolvedLabel !== "string" || !resolvedLabel.trim()) {
      throw new Error(
        `Alias target for ${JSON.stringify(legacyLabel)} must be a non-empty string.`,
      );
    }
    const normalized = normalizeSourceLabel(legacyLabel);
    if (!normalized) throw new Error("Alias source labels must not be empty.");
    if (values.has(normalized)) {
      throw new Error(`Alias map contains a duplicate normalized label: ${legacyLabel}`);
    }
    values.set(normalized, resolvedLabel.trim());
  }
  return { sourcePath: aliasMapPath, sha256: sha256Bytes(bytes), values };
}

function writeArchiveBundle(
  databasePath: string,
  outputPath: string,
  aliases: ReadonlyMap<string, string>,
): void {
  const database = openReadOnlyDatabase(databasePath);
  const output = openExclusiveOutput(outputPath);
  try {
    for (const [table, artifactKind] of ARCHIVE_TABLES) {
      if (!databaseHasTable(database, table)) continue;
      const statement = database.prepare(`SELECT * FROM ${quoteIdentifier(table)} ORDER BY id`);
      for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
        const selectedFields: Record<string, unknown> = {};
        for (const field of ARCHIVE_FIELDS) {
          if (field in row) selectedFields[toCamelCase(field)] = normalizeSqlValue(row[field]);
        }
        const sourceLabel = findSourceLabel(row);
        writeJsonLine(output, {
          schemaVersion: 1,
          recordType: "archive-artifact",
          artifactKind,
          legacyId: normalizeSqlValue(row.id) ?? null,
          title: firstText(row.title, row.task, row.request) ?? "Untitled archived work",
          summary: firstText(row.summary, row.task, row.request, row.title) ?? "",
          fields: selectedFields,
          provenance: {
            sourceDatabase: "state",
            sourceTable: table,
            sourcePrimaryKey: normalizeSqlValue(row.id) ?? null,
            sourceRowSha256: hashSqlRow(row),
            sourceLabel: resolveSourceLabel(sourceLabel, aliases),
          },
        });
      }
    }
  } finally {
    NodeFS.closeSync(output);
    database.close();
  }
}

function writeMemoryBundle(
  databasePath: string,
  outputPath: string,
  aliases: ReadonlyMap<string, string>,
): void {
  const database = openReadOnlyDatabase(databasePath);
  const output = openExclusiveOutput(outputPath);
  try {
    if (!databaseHasTable(database, MEMORY_INDEX_TABLE)) return;
    const statement = database.prepare(
      `SELECT * FROM ${quoteIdentifier(MEMORY_INDEX_TABLE)} ORDER BY id`,
    );
    for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
      const provenanceFields: Record<string, unknown> = {};
      for (const field of MEMORY_PROVENANCE_FIELDS) {
        if (field in row) provenanceFields[toCamelCase(field)] = normalizeSqlValue(row[field]);
      }
      const sourceLabel = findSourceLabel(row);
      writeJsonLine(output, {
        schemaVersion: 1,
        recordType: "untrusted-memory-index",
        trust: "untrusted-archive",
        content: firstText(row.content) ?? "",
        capturedAt: firstText(row.captured_at),
        source: provenanceFields,
        provenance: {
          sourceDatabase: "memory",
          sourceTable: MEMORY_INDEX_TABLE,
          sourcePrimaryKey: normalizeSqlValue(row.id) ?? null,
          sourceRowSha256: hashSqlRow(row),
          sourceLabel: resolveSourceLabel(sourceLabel, aliases),
        },
      });
    }
  } finally {
    NodeFS.closeSync(output);
    database.close();
  }
}

function writeAutomationBundle(
  automations: readonly AutomationCandidate[],
  outputPath: string,
  aliases: ReadonlyMap<string, string>,
): void {
  const output = openExclusiveOutput(outputPath);
  try {
    for (const automation of automations) {
      if (automation.status !== "valid" || !automation.definition) continue;
      const sourceLabel = findSourceLabel(automation.definition);
      writeJsonLine(output, {
        schemaVersion: 1,
        recordType: "disabled-automation",
        enabled: false,
        disabledReason: "Imported definitions require adapter and policy review before activation.",
        definition: { ...automation.definition, enabled: false },
        provenance: {
          sourceDirectoryEntry: automation.relativePath,
          sourceDefinitionSha256: automation.sha256,
          sourceLabel: resolveSourceLabel(sourceLabel, aliases),
        },
      });
    }
  } finally {
    NodeFS.closeSync(output);
  }
}

function databaseHasTable(database: NodeSqlite.DatabaseSync, table: string): boolean {
  return Boolean(
    database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table),
  );
}

async function createSqliteBackup(sourcePath: string, destinationPath: string): Promise<void> {
  const source = openReadOnlyDatabase(sourcePath);
  try {
    await NodeSqlite.backup(source, destinationPath);
    await NodeFSP.chmod(destinationPath, 0o600);
  } finally {
    source.close();
  }
}

async function backupAutomationFiles(
  automations: readonly AutomationCandidate[],
  sourceRoot: string | undefined,
  backupDirectory: string,
): Promise<ReadonlyMap<string, string>> {
  const hashes = new Map<string, string>();
  if (!sourceRoot || automations.length === 0) return hashes;

  const automationBackupRoot = NodePath.join(backupDirectory, "automations");
  await NodeFSP.mkdir(automationBackupRoot, { mode: 0o700 });
  for (const automation of automations) {
    const pathSegments = automation.relativePath.split("/");
    const sourcePath = NodePath.join(sourceRoot, ...pathSegments);
    const destinationPath = NodePath.join(automationBackupRoot, ...pathSegments);
    await assertRegularFile(sourcePath, "automation definition");
    await NodeFSP.mkdir(NodePath.dirname(destinationPath), { recursive: true, mode: 0o700 });
    await NodeFSP.copyFile(sourcePath, destinationPath, NodeFS.constants.COPYFILE_EXCL);
    await NodeFSP.chmod(destinationPath, 0o600);
    const backupSha256 = await hashFile(destinationPath);
    if (backupSha256 !== automation.sha256) {
      throw new Error(
        `Automation definition changed after inspection; apply refused: ${automation.relativePath}`,
      );
    }
    hashes.set(automation.relativePath, backupSha256);
  }
  return hashes;
}

function mergeSourceMetadataWithSnapshot(
  source: DatabaseInventory,
  snapshot: DatabaseInventory,
): DatabaseInventory {
  return {
    ...source,
    quickCheck: snapshot.quickCheck,
    tables: snapshot.tables,
  };
}

function assertApplyEligible(prepared: PreparedInputs): void {
  if (prepared.targetState === "non-empty") {
    throw new Error("Apply refused: the target directory is not empty.");
  }
  assertQuickCheck(prepared.stateInventory);
  assertQuickCheck(prepared.memoryInventory);
  const invalid = prepared.automations.filter((entry) => entry.status === "invalid");
  if (invalid.length > 0) {
    throw new Error(
      `Apply refused: ${invalid.length} automation definition(s) are invalid; fix or explicitly exclude them.`,
    );
  }
}

function assertQuickCheck(inventory: DatabaseInventory): void {
  if (inventory.quickCheck.status !== "ok") {
    throw new Error(
      `Apply refused: ${inventory.kind} database quick_check status is ${inventory.quickCheck.status}.`,
    );
  }
}

async function createEmptyTarget(targetPath: string): Promise<void> {
  try {
    await NodeFSP.mkdir(targetPath, { mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
  }
  const stat = await NodeFSP.lstat(targetPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(
      "Apply refused: the target must be a real directory, not a file or symbolic link.",
    );
  }
  const entries = await NodeFSP.readdir(targetPath);
  if (entries.length > 0) throw new Error("Apply refused: the target directory became non-empty.");
  await NodeFSP.chmod(targetPath, 0o700);
}

async function inspectTarget(targetPath: string): Promise<"absent" | "empty" | "non-empty"> {
  try {
    const stat = await NodeFSP.lstat(targetPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return "non-empty";
    return (await NodeFSP.readdir(targetPath)).length === 0 ? "empty" : "non-empty";
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "absent";
    throw error;
  }
}

async function assertRegularFile(path: string, label: string): Promise<void> {
  const stat = await NodeFSP.lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`The ${label} must be a real regular file: ${path}`);
  }
}

async function assertDirectory(path: string, label: string): Promise<void> {
  const stat = await NodeFSP.lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`The ${label} must be a real directory: ${path}`);
  }
}

function requireAbsolutePath(value: string, label: string): string {
  if (!value || !NodePath.isAbsolute(value)) {
    throw new Error(`The ${label} path must be explicit and absolute.`);
  }
  return NodePath.normalize(value);
}

function requireSafeTargetPath(value: string): string {
  const normalized = requireAbsolutePath(value, "target");
  if (NodePath.parse(normalized).root === normalized) {
    throw new Error("The target must not be a filesystem root.");
  }
  return normalized;
}

function isPathWithin(candidate: string, root: string): boolean {
  const relative = NodePath.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${NodePath.sep}`) && relative !== "..");
}

function normalizeExclusions(values: readonly string[]): readonly string[] {
  return values.map((value) => {
    const portable = toPortablePath(value.trim());
    if (!portable || NodePath.posix.isAbsolute(portable) || portable.split("/").includes("..")) {
      throw new Error(`Automation exclusions must be safe relative paths: ${value}`);
    }
    return portable;
  });
}

function findSourceLabel(row: Record<string, unknown>): string | null {
  for (const field of SOURCE_LABEL_FIELDS) {
    const value = row[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function resolveSourceLabel(
  sourceLabel: string | null,
  aliases: ReadonlyMap<string, string>,
): SourceLabelResolution {
  if (!sourceLabel) return { original: null, resolved: null, aliasApplied: false };
  const resolved = aliases.get(normalizeSourceLabel(sourceLabel));
  return {
    original: sourceLabel,
    resolved: resolved ?? sourceLabel,
    aliasApplied: resolved !== undefined,
  };
}

function normalizeSourceLabel(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function normalizeSqlValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array)
    return { encoding: "base64", data: Buffer.from(value).toString("base64") };
  return value;
}

function hashSqlRow(row: Record<string, unknown>): string {
  const normalized = Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeSqlValue(value)]),
  );
  return sha256Text(stableStringify(normalized));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function createPlanId(input: Record<string, unknown>): string {
  return `migration_${sha256Text(stableStringify(input)).slice(0, 24)}`;
}

function inventoryPlanFingerprint(
  inventory: DatabaseInventory,
): readonly Record<string, unknown>[] {
  return inventory.tables.map((table) => ({
    name: table.name,
    rowCount: table.rowCount,
    readError: table.readError ?? null,
  }));
}

function openExclusiveOutput(path: string): number {
  return NodeFS.openSync(path, "wx", 0o600);
}

function writeJsonLine(fileDescriptor: number, value: unknown): void {
  NodeFS.writeSync(fileDescriptor, `${JSON.stringify(value)}\n`);
}

function writeJsonExclusive(path: string, value: unknown): void {
  NodeFS.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

async function describeImport(
  kind: ImportManifestEntry["kind"],
  relativePath: string,
  path: string,
): Promise<ImportManifestEntry> {
  const content = await NodeFSP.readFile(path, "utf8");
  const recordCount = content.length === 0 ? 0 : content.split("\n").filter(Boolean).length;
  return { kind, relativePath, recordCount, sha256: sha256Text(content) };
}

async function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = NodeCrypto.createHash("sha256");
    const input = NodeFS.createReadStream(path);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

function sha256Bytes(value: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex");
}

function sha256Text(value: string): string {
  return NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function toPortablePath(value: string): string {
  return value.split(NodePath.sep).join("/");
}

function toCamelCase(value: string): string {
  return value.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function sumClassifications(
  classifications: readonly ClassificationEntry[],
  disposition: MigrationDisposition,
): number {
  return classifications
    .filter((entry) => entry.disposition === disposition)
    .reduce((sum, entry) => sum + (entry.rowCount ?? 0), 0);
}

function manualAction(id: string, description: string): ManifestAction {
  return { id, description, automated: false };
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
