// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Standalone offline migration utility.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import type { ImportManifestEntry, MigrationManifest } from "./migration.ts";

export interface ImportMigrationBundleOptions {
  readonly bundlePath: string;
  readonly targetDatabasePath: string;
  readonly backupPath?: string | undefined;
  readonly spaceMapPath?: string | undefined;
  readonly defaultSpaceId?: string | undefined;
  readonly apply?: boolean | undefined;
  readonly confirmTargetOffline?: boolean | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface ImportMigrationBundleResult {
  readonly applied: boolean;
  readonly duplicate: boolean;
  readonly planId: string;
  readonly manifestSha256: string;
  readonly targetQuickCheck: "ok";
  readonly archiveArtifactCount: number;
  readonly untrustedMemoryCount: number;
  readonly disabledAutomationCount: number;
  readonly unresolvedSpaceCount: number;
  readonly targetBackupSha256: string | null;
}

interface ArchiveRecord {
  readonly schemaVersion: 1;
  readonly recordType: "archive-artifact";
  readonly artifactKind: string;
  readonly legacyId: unknown;
  readonly title: string;
  readonly summary: string;
  readonly fields: Record<string, unknown>;
  readonly provenance: MigrationProvenance;
}

interface MemoryRecord {
  readonly schemaVersion: 1;
  readonly recordType: "untrusted-memory-index";
  readonly trust: "untrusted-archive";
  readonly content: string;
  readonly capturedAt: string | null;
  readonly source: Record<string, unknown>;
  readonly provenance: MigrationProvenance;
}

interface AutomationRecord {
  readonly schemaVersion: 1;
  readonly recordType: "disabled-automation";
  readonly enabled: false;
  readonly definition: Record<string, unknown>;
  readonly provenance: Record<string, unknown>;
}

interface MigrationProvenance {
  readonly sourceRowSha256: string;
  readonly sourceLabel?: {
    readonly original?: string | null;
    readonly resolved?: string | null;
  };
  readonly [key: string]: unknown;
}

interface SpaceRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly aliasesJson: string;
}

interface LoadedBundle {
  readonly manifest: MigrationManifest;
  readonly manifestSha256: string;
  readonly archives: readonly ArchiveRecord[];
  readonly memories: readonly MemoryRecord[];
  readonly automations: readonly AutomationRecord[];
}

interface ResolvedArchive {
  readonly record: ArchiveRecord;
  readonly spaceId: string | null;
}

interface ResolvedMemory {
  readonly record: MemoryRecord;
  readonly spaceId: string | null;
}

const REQUIRED_TABLES = [
  "command_center_artifacts",
  "command_center_audit_events",
  "command_center_import_receipts",
  "command_center_memories",
  "command_center_spaces",
] as const;

export async function importMigrationBundle(
  options: ImportMigrationBundleOptions,
): Promise<ImportMigrationBundleResult> {
  const bundlePath = await requireRealDirectory(options.bundlePath, "migration bundle");
  const targetDatabasePath = await requireRealFile(options.targetDatabasePath, "target database");
  const backupPath =
    options.backupPath === undefined
      ? undefined
      : requireSafeAbsentPath(options.backupPath, "target backup");
  const spaceMapPath =
    options.spaceMapPath === undefined
      ? undefined
      : await requireRealFile(options.spaceMapPath, "Space map");
  if (backupPath === targetDatabasePath) {
    throw new Error("The target database and rollback backup must be different files.");
  }
  if (options.apply === true && options.confirmTargetOffline !== true) {
    throw new Error("Apply requires --confirm-target-offline after the target service is stopped.");
  }
  if (options.apply === true && backupPath === undefined) {
    throw new Error("Apply requires an explicit absent --backup path.");
  }

  const bundle = await loadBundle(bundlePath);
  const database = new NodeSqlite.DatabaseSync(targetDatabasePath, {
    timeout: 10_000,
    defensive: true,
  });
  try {
    database.exec("PRAGMA foreign_keys = ON");
    assertTargetDatabase(database);
    const targetQuickCheck = quickCheck(database);
    const existingReceipt = database
      .prepare(
        "SELECT manifest_sha256 AS manifestSha256, target_backup_sha256 AS targetBackupSha256 FROM command_center_import_receipts WHERE plan_id = ?",
      )
      .get(bundle.manifest.planId) as
      | { readonly manifestSha256: string; readonly targetBackupSha256: string }
      | undefined;
    if (existingReceipt !== undefined) {
      if (existingReceipt.manifestSha256 !== bundle.manifestSha256) {
        throw new Error("The migration plan ID already exists with a different manifest digest.");
      }
      return resultFor({
        bundle,
        applied: false,
        duplicate: true,
        targetQuickCheck,
        unresolvedSpaceCount: 0,
        targetBackupSha256: existingReceipt.targetBackupSha256,
      });
    }

    const spaces = loadSpaces(database);
    const configuredSpaceMap = await loadSpaceMap(spaceMapPath, spaces);
    const resolver = makeSpaceResolver(spaces, configuredSpaceMap, options.defaultSpaceId);
    const resolvedArchives = bundle.archives.map((record) => ({
      record,
      spaceId: resolver(record.provenance),
    }));
    const resolvedMemories = bundle.memories.map((record) => ({
      record,
      spaceId: resolver(record.provenance),
    }));
    const unresolvedSpaceCount = [...resolvedArchives, ...resolvedMemories].filter(
      (entry) => entry.spaceId === null,
    ).length;

    if (options.apply !== true) {
      return resultFor({
        bundle,
        applied: false,
        duplicate: false,
        targetQuickCheck,
        unresolvedSpaceCount,
        targetBackupSha256: null,
      });
    }
    if (unresolvedSpaceCount > 0) {
      throw new Error(
        `${unresolvedSpaceCount} staged record(s) do not resolve to a target Space; provide --space-map or --default-space.`,
      );
    }

    await NodeSqlite.backup(database, backupPath as string);
    await NodeFSP.chmod(backupPath as string, 0o600);
    const targetBackupSha256 = await hashFile(backupPath as string);
    database.exec("PRAGMA locking_mode = EXCLUSIVE");
    database.exec("BEGIN EXCLUSIVE");
    try {
      const appliedAt = (options.now ?? (() => new Date()))().toISOString();
      importArchives(
        database,
        resolvedArchives as readonly Required<ResolvedArchive>[],
        bundle,
        appliedAt,
      );
      importMemories(
        database,
        resolvedMemories as readonly Required<ResolvedMemory>[],
        bundle,
        appliedAt,
      );
      appendImportAudit(database, bundle, targetBackupSha256, appliedAt);
      database
        .prepare(
          `INSERT INTO command_center_import_receipts (
            plan_id, manifest_sha256, archive_artifact_count, untrusted_memory_count,
            disabled_automation_count, target_backup_sha256, applied_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          bundle.manifest.planId,
          bundle.manifestSha256,
          bundle.archives.length,
          bundle.memories.length,
          bundle.automations.length,
          targetBackupSha256,
          appliedAt,
        );
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original failure; the offline target backup remains available.
      }
      throw error;
    }

    return resultFor({
      bundle,
      applied: true,
      duplicate: false,
      targetQuickCheck,
      unresolvedSpaceCount: 0,
      targetBackupSha256,
    });
  } finally {
    database.close();
  }
}

function resultFor(input: {
  readonly bundle: LoadedBundle;
  readonly applied: boolean;
  readonly duplicate: boolean;
  readonly targetQuickCheck: "ok";
  readonly unresolvedSpaceCount: number;
  readonly targetBackupSha256: string | null;
}): ImportMigrationBundleResult {
  return {
    applied: input.applied,
    duplicate: input.duplicate,
    planId: input.bundle.manifest.planId,
    manifestSha256: input.bundle.manifestSha256,
    targetQuickCheck: input.targetQuickCheck,
    archiveArtifactCount: input.bundle.archives.length,
    untrustedMemoryCount: input.bundle.memories.length,
    disabledAutomationCount: input.bundle.automations.length,
    unresolvedSpaceCount: input.unresolvedSpaceCount,
    targetBackupSha256: input.targetBackupSha256,
  };
}

async function loadBundle(bundlePath: string): Promise<LoadedBundle> {
  const manifestPath = resolveInside(bundlePath, "manifest.json");
  const manifestBytes = await NodeFSP.readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as MigrationManifest;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.mode !== "applied-to-staging-bundle" ||
    manifest.backup?.status !== "completed" ||
    manifest.imports?.status !== "completed" ||
    !manifest.planId
  ) {
    throw new Error("The migration manifest is incomplete or unsupported.");
  }
  const entries = new Map(manifest.imports.entries.map((entry) => [entry.kind, entry]));
  const archives = await readImportFile<ArchiveRecord>(
    bundlePath,
    requireImportEntry(entries, "archive-artifacts"),
    "archive-artifact",
  );
  const memories = await readImportFile<MemoryRecord>(
    bundlePath,
    requireImportEntry(entries, "untrusted-memory"),
    "untrusted-memory-index",
  );
  const automations = await readImportFile<AutomationRecord>(
    bundlePath,
    requireImportEntry(entries, "disabled-automations"),
    "disabled-automation",
  );
  for (const record of automations) {
    if (record.enabled !== false || record.definition.enabled !== false) {
      throw new Error("Staged automation definitions must remain disabled for adapter review.");
    }
  }
  return {
    manifest,
    manifestSha256: sha256Bytes(manifestBytes),
    archives,
    memories,
    automations,
  };
}

function requireImportEntry(
  entries: ReadonlyMap<string, ImportManifestEntry>,
  kind: ImportManifestEntry["kind"],
): ImportManifestEntry {
  const entry = entries.get(kind);
  if (entry === undefined || entry.sha256 === null) {
    throw new Error(`The migration manifest is missing a completed ${kind} import entry.`);
  }
  return entry;
}

async function readImportFile<T extends { readonly recordType: string }>(
  bundlePath: string,
  entry: ImportManifestEntry,
  expectedRecordType: T["recordType"],
): Promise<readonly T[]> {
  if (!isSafeRelativePath(entry.relativePath)) {
    throw new Error("Migration import paths must remain inside the bundle.");
  }
  const path = resolveInside(bundlePath, entry.relativePath);
  await requireRealFile(path, `${entry.kind} import`);
  const bytes = await NodeFSP.readFile(path);
  if (sha256Bytes(bytes) !== entry.sha256) {
    throw new Error(`The ${entry.kind} import digest does not match the manifest.`);
  }
  const lines = bytes.toString("utf8").split("\n").filter(Boolean);
  if (lines.length !== entry.recordCount) {
    throw new Error(`The ${entry.kind} import count does not match the manifest.`);
  }
  return lines.map((line, index) => {
    if (Buffer.byteLength(line, "utf8") > 2 * 1024 * 1024) {
      throw new Error(
        `The ${entry.kind} import contains an oversized record at line ${index + 1}.`,
      );
    }
    const parsed = JSON.parse(line) as T;
    if (parsed.recordType !== expectedRecordType) {
      throw new Error(`The ${entry.kind} import has an invalid record at line ${index + 1}.`);
    }
    return parsed;
  });
}

function assertTargetDatabase(database: NodeSqlite.DatabaseSync): void {
  const rows = database
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'command_center_%'")
    .all() as Array<{ readonly name: string }>;
  const names = new Set(rows.map((row) => row.name));
  const missing = REQUIRED_TABLES.filter((table) => !names.has(table));
  if (missing.length > 0) {
    throw new Error(`The target database is not fully migrated; missing ${missing.join(", ")}.`);
  }
}

function quickCheck(database: NodeSqlite.DatabaseSync): "ok" {
  const values = database
    .prepare("PRAGMA quick_check")
    .all()
    .flatMap((row) => Object.values(row as Record<string, unknown>).map(String));
  if (values.length === 0 || values.some((value) => value !== "ok")) {
    throw new Error("The target database failed SQLite quick_check.");
  }
  return "ok";
}

function loadSpaces(database: NodeSqlite.DatabaseSync): readonly SpaceRow[] {
  const spaces = database
    .prepare(
      `SELECT id, slug, name, aliases_json AS aliasesJson
       FROM command_center_spaces WHERE lifecycle = 'active'`,
    )
    .all() as unknown as SpaceRow[];
  if (spaces.length === 0) throw new Error("The target database has no active Spaces.");
  return spaces;
}

async function loadSpaceMap(
  path: string | undefined,
  spaces: readonly SpaceRow[],
): Promise<ReadonlyMap<string, string>> {
  if (path === undefined) return new Map();
  const parsed = JSON.parse(await NodeFSP.readFile(path, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("The Space map must be a JSON object.");
  const source = isRecord(parsed.spaces) ? parsed.spaces : parsed;
  const validSpaceIds = new Set(spaces.map((space) => space.id));
  const values = new Map<string, string>();
  for (const [label, spaceId] of Object.entries(source)) {
    if (typeof spaceId !== "string" || !validSpaceIds.has(spaceId)) {
      throw new Error("Every Space map target must be an active target Space ID.");
    }
    values.set(normalizeLabel(label), spaceId);
  }
  return values;
}

function makeSpaceResolver(
  spaces: readonly SpaceRow[],
  configured: ReadonlyMap<string, string>,
  defaultSpaceId: string | undefined,
): (provenance: MigrationProvenance) => string | null {
  const byLabel = new Map<string, string>();
  for (const space of spaces) {
    for (const label of [space.id, space.slug, space.name, ...parseAliases(space.aliasesJson)]) {
      byLabel.set(normalizeLabel(label), space.id);
    }
  }
  if (defaultSpaceId !== undefined && !spaces.some((space) => space.id === defaultSpaceId)) {
    throw new Error("The default Space must be an active target Space ID.");
  }
  return (provenance) => {
    const label = provenance.sourceLabel?.resolved ?? provenance.sourceLabel?.original;
    if (typeof label === "string" && label.trim()) {
      const normalized = normalizeLabel(label);
      return configured.get(normalized) ?? byLabel.get(normalized) ?? defaultSpaceId ?? null;
    }
    return defaultSpaceId ?? null;
  };
}

function importArchives(
  database: NodeSqlite.DatabaseSync,
  entries: readonly Required<ResolvedArchive>[],
  bundle: LoadedBundle,
  appliedAt: string,
): void {
  const insert = database.prepare(
    `INSERT INTO command_center_artifacts (
      id, space_id, kind, title, uri, content_digest, provenance_json, metadata_json, created_at
    ) VALUES (?, ?, 'archive', ?, ?, ?, ?, ?, ?)`,
  );
  for (const { record, spaceId } of entries) {
    const sourceDigest = requireSourceDigest(record.provenance);
    const id = `legacy_artifact_${sourceDigest.slice(0, 32)}`;
    const contentDigest = sha256Text(
      stableStringify({
        summary: record.summary,
        fields: record.fields,
      }),
    );
    insert.run(
      id,
      spaceId,
      record.title || "Untitled archived work",
      `cc-artifact://archive/${id}`,
      contentDigest,
      JSON.stringify({
        ...record.provenance,
        trust: "untrusted-archive",
        readOnly: true,
        migrationPlanId: bundle.manifest.planId,
      }),
      JSON.stringify({
        artifactKind: record.artifactKind,
        legacyId: record.legacyId,
        summary: record.summary,
        fields: record.fields,
      }),
      preferredTimestamp(record.fields, appliedAt),
    );
  }
}

function importMemories(
  database: NodeSqlite.DatabaseSync,
  entries: readonly Required<ResolvedMemory>[],
  bundle: LoadedBundle,
  appliedAt: string,
): void {
  const insert = database.prepare(
    `INSERT INTO command_center_memories (
      id, space_id, repository_ref, scope, kind, content, status, confidence,
      provenance_json, created_at, updated_at
    ) VALUES (?, ?, NULL, 'space', 'archive', ?, 'archive', 0, ?, ?, ?)`,
  );
  for (const { record, spaceId } of entries) {
    const sourceDigest = requireSourceDigest(record.provenance);
    const id = `legacy_memory_${sourceDigest.slice(0, 32)}`;
    const timestamp = validTimestamp(record.capturedAt) ?? appliedAt;
    insert.run(
      id,
      spaceId,
      record.content,
      JSON.stringify({
        ...record.provenance,
        source: record.source,
        trust: "untrusted-archive",
        readOnly: true,
        migrationPlanId: bundle.manifest.planId,
      }),
      timestamp,
      timestamp,
    );
  }
}

function appendImportAudit(
  database: NodeSqlite.DatabaseSync,
  bundle: LoadedBundle,
  targetBackupSha256: string,
  occurredAt: string,
): void {
  const predecessor = database
    .prepare(
      "SELECT event_hash AS eventHash FROM command_center_audit_events ORDER BY sequence DESC LIMIT 1",
    )
    .get() as { readonly eventHash: string } | undefined;
  const previousHash = predecessor?.eventHash ?? null;
  const payload = {
    planId: bundle.manifest.planId,
    manifestSha256: bundle.manifestSha256,
    archiveArtifactCount: bundle.archives.length,
    untrustedMemoryCount: bundle.memories.length,
    disabledAutomationCount: bundle.automations.length,
    targetBackupSha256,
  };
  const actorKind = "migration";
  const action = "cc.migration.import";
  const eventId = `migration-import-${bundle.manifest.planId}`;
  const hashVersion = 2;
  const eventHash = sha256Text(
    JSON.stringify({
      hashVersion,
      eventId,
      previousHash,
      actorKind,
      action,
      payload,
      occurredAt,
    }),
  );
  database
    .prepare(
      `INSERT INTO command_center_audit_events (
        event_id, hash_version, previous_hash, event_hash, actor_kind, action,
        payload_json, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      eventId,
      hashVersion,
      previousHash,
      eventHash,
      actorKind,
      action,
      JSON.stringify(payload),
      occurredAt,
    );
}

function requireSourceDigest(provenance: MigrationProvenance): string {
  if (!/^[a-f0-9]{64}$/u.test(provenance.sourceRowSha256)) {
    throw new Error("A staged record is missing its source-row digest.");
  }
  return provenance.sourceRowSha256;
}

function preferredTimestamp(fields: Record<string, unknown>, fallback: string): string {
  for (const key of ["createdAt", "updatedAt", "completedAt"]) {
    const timestamp = validTimestamp(fields[key]);
    if (timestamp !== null) return timestamp;
  }
  return fallback;
}

function validTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || Number.isNaN(Date.parse(value))) return null;
  return value;
}

function parseAliases(value: string): readonly string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed)
    ? parsed.filter((alias): alias is string => typeof alias === "string")
    : [];
}

function normalizeLabel(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
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

async function requireRealDirectory(value: string, label: string): Promise<string> {
  const path = requireAbsolutePath(value, label);
  const stat = await NodeFSP.lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`The ${label} must be a real directory.`);
  }
  return path;
}

async function requireRealFile(value: string, label: string): Promise<string> {
  const path = requireAbsolutePath(value, label);
  const stat = await NodeFSP.lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`The ${label} must be a real regular file.`);
  }
  return path;
}

function requireSafeAbsentPath(value: string, label: string): string {
  const path = requireAbsolutePath(value, label);
  if (NodePath.parse(path).root === path) throw new Error(`The ${label} must not be a root path.`);
  if (NodeFS.existsSync(path)) throw new Error(`The ${label} path must not already exist.`);
  return path;
}

function requireAbsolutePath(value: string, label: string): string {
  if (!value || !NodePath.isAbsolute(value)) {
    throw new Error(`The ${label} path must be explicit and absolute.`);
  }
  return NodePath.normalize(value);
}

function resolveInside(root: string, relativePath: string): string {
  const resolved = NodePath.resolve(root, relativePath);
  const relative = NodePath.relative(root, resolved);
  if (relative === "" || relative === ".." || relative.startsWith(`..${NodePath.sep}`)) {
    throw new Error("Migration import paths must remain inside the bundle.");
  }
  return resolved;
}

function isSafeRelativePath(value: string): boolean {
  return value.length > 0 && !NodePath.isAbsolute(value) && !value.split(/[\\/]/u).includes("..");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
