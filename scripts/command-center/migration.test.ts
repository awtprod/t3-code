// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Isolated filesystem/SQLite fixtures.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { runSelectiveMigration } from "./migration.ts";
import { importMigrationBundle } from "./importBundle.ts";

const temporaryDirectories: string[] = [];
const FIXED_NOW = new Date("2030-01-02T03:04:05.000Z");

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("runSelectiveMigration", () => {
  it("keeps dry runs read-only and classifies only allowlisted data", async () => {
    const fixture = makeFixture();
    const stateHashBefore = fileHash(fixture.stateDatabasePath);
    const memoryHashBefore = fileHash(fixture.memoryDatabasePath);

    const result = await runSelectiveMigration({
      ...fixture.options,
      now: () => FIXED_NOW,
    });

    expect(result.applied).toBe(false);
    expect(result.manifest.mode).toBe("dry-run");
    expect(result.manifest.outputFiles).toEqual([]);
    expect(NodeFS.existsSync(fixture.targetPath)).toBe(false);
    expect(fileHash(fixture.stateDatabasePath)).toBe(stateHashBefore);
    expect(fileHash(fixture.memoryDatabasePath)).toBe(memoryHashBefore);
    expect(NodeFS.existsSync(`${fixture.stateDatabasePath}-wal`)).toBe(false);
    expect(NodeFS.existsSync(`${fixture.memoryDatabasePath}-wal`)).toBe(false);

    expect(classification(result.manifest, "state", "coding_sessions")).toMatchObject({
      disposition: "import-as-archive",
      rowCount: 1,
    });
    expect(classification(result.manifest, "state", "spec_flows")).toMatchObject({
      disposition: "import-as-archive",
      rowCount: 1,
    });
    expect(classification(result.manifest, "memory", "memory_chunks")).toMatchObject({
      disposition: "import-as-untrusted-memory-index",
      rowCount: 1,
    });
    expect(classification(result.manifest, "state", "jobs")).toMatchObject({
      disposition: "skip-operational-history",
      rowCount: 1,
    });
    expect(classification(result.manifest, "memory", "captured_turns")).toMatchObject({
      disposition: "skip-operational-history",
      rowCount: 1,
    });
  });

  it("changes the plan ID when the automation import selection changes", async () => {
    const fixture = makeFixture();

    const excluded = await runSelectiveMigration({
      ...fixture.options,
      now: () => FIXED_NOW,
    });
    const included = await runSelectiveMigration({
      ...fixture.options,
      excludedAutomations: [],
      now: () => FIXED_NOW,
    });

    expect(excluded.manifest.sources.automations.validCount).toBe(1);
    expect(excluded.manifest.sources.automations.excludedCount).toBe(1);
    expect(included.manifest.sources.automations.validCount).toBe(2);
    expect(included.manifest.sources.automations.excludedCount).toBe(0);
    expect(included.manifest.planId).not.toBe(excluded.manifest.planId);
  });

  it("stages summaries, untrusted memory, and disabled automations with provenance", async () => {
    const fixture = makeFixture();
    const stateHashBefore = fileHash(fixture.stateDatabasePath);
    const memoryHashBefore = fileHash(fixture.memoryDatabasePath);

    const result = await runSelectiveMigration({
      ...fixture.options,
      apply: true,
      now: () => FIXED_NOW,
    });

    expect(result.applied).toBe(true);
    expect(fileHash(fixture.stateDatabasePath)).toBe(stateHashBefore);
    expect(fileHash(fixture.memoryDatabasePath)).toBe(memoryHashBefore);

    const archive = readJsonLines(
      NodePath.join(fixture.targetPath, "imports/archive-records.jsonl"),
    );
    const memory = readJsonLines(
      NodePath.join(fixture.targetPath, "imports/untrusted-memory-index.jsonl"),
    );
    const automations = readJsonLines(
      NodePath.join(fixture.targetPath, "imports/disabled-automations.jsonl"),
    );

    expect(archive).toHaveLength(2);
    expect(memory).toHaveLength(1);
    expect(automations).toHaveLength(1);

    const codingArchive = archive.find(
      (record) => record.artifactKind === "coding-session-summary",
    );
    expect(codingArchive).toBeDefined();
    if (!codingArchive) throw new Error("Expected a coding archive record.");
    expect(provenanceSourceLabel(codingArchive)).toEqual({
      original: "Legacy Workspace",
      resolved: "current-space",
      aliasApplied: true,
    });
    expect(provenanceDigest(codingArchive)).toMatch(/^[a-f0-9]{64}$/);

    const memoryRecord = memory[0];
    if (!memoryRecord) throw new Error("Expected an untrusted memory record.");
    expect(memoryRecord).toMatchObject({
      recordType: "untrusted-memory-index",
      trust: "untrusted-archive",
      content: "Archived context with its source retained.",
    });
    expect(provenanceSourceLabel(memoryRecord)).toEqual({
      original: "Legacy Workspace",
      resolved: "current-space",
      aliasApplied: true,
    });
    expect(asRecord(memoryRecord.source)).toMatchObject({
      sourceKind: "summary",
      sourceAgent: "example-agent",
      transcriptPath: "/private/archive/transcript.jsonl",
      sourceLocation: "turn 2",
    });

    const automationRecord = automations[0];
    if (!automationRecord) throw new Error("Expected a disabled automation record.");
    expect(automationRecord).toMatchObject({
      recordType: "disabled-automation",
      enabled: false,
    });
    expect(asRecord(automationRecord.definition).enabled).toBe(false);
    expect(provenanceSourceLabel(automationRecord)).toEqual({
      original: "Legacy Workspace",
      resolved: "current-space",
      aliasApplied: true,
    });

    const stagedImports = [archive, memory, automations].flat();
    expect(JSON.stringify(stagedImports)).not.toContain("SKIP_OPERATIONAL_SENTINEL");
    expect(JSON.stringify(stagedImports)).not.toContain("EXCLUDED_AUTOMATION_SENTINEL");
  });

  it("writes a backup, cutover, and rollback manifest without performing cutover", async () => {
    const fixture = makeFixture();
    const result = await runSelectiveMigration({
      ...fixture.options,
      apply: true,
      now: () => FIXED_NOW,
    });
    const diskManifest = JSON.parse(
      NodeFS.readFileSync(NodePath.join(fixture.targetPath, "manifest.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(result.manifest.backup.status).toBe("completed");
    expect(result.manifest.backup.entries).toHaveLength(4);
    expect(result.manifest.backup.entries.every((entry) => entry.backupSha256 !== null)).toBe(true);
    expect(result.manifest.imports.status).toBe("completed");
    expect(result.manifest.imports.entries).toHaveLength(3);
    expect(result.manifest.imports.entries.every((entry) => entry.sha256 !== null)).toBe(true);
    expect(result.manifest.cutover).toMatchObject({
      status: "manual-not-started",
      performedByTool: false,
    });
    expect(result.manifest.rollback).toMatchObject({
      status: "ready-after-operator-validation",
      performedByTool: false,
    });
    expect(result.manifest.rollback.steps.length).toBeGreaterThan(0);
    expect(result.manifest.safety).toEqual({
      sourcesOpenedReadOnly: true,
      targetApplicationDatabaseWritten: false,
      servicesStoppedByTool: false,
      applyRequiredForTargetWrites: true,
    });
    expect(diskManifest).toMatchObject({
      schemaVersion: 1,
      mode: "applied-to-staging-bundle",
      createdAt: FIXED_NOW.toISOString(),
    });
    expect(
      NodeFS.statSync(NodePath.join(fixture.targetPath, "backups/state.sqlite")).size,
    ).toBeGreaterThan(0);
    expect(
      NodeFS.statSync(NodePath.join(fixture.targetPath, "backups/memory.sqlite")).size,
    ).toBeGreaterThan(0);
    expect(
      NodeFS.readFileSync(
        NodePath.join(fixture.targetPath, "backups/automations/examples/placeholder.json"),
        "utf8",
      ),
    ).toContain("EXCLUDED_AUTOMATION_SENTINEL");
  });

  it("refuses apply mode when the target is non-empty", async () => {
    const fixture = makeFixture();
    NodeFS.mkdirSync(fixture.targetPath, { recursive: true });
    const markerPath = NodePath.join(fixture.targetPath, "keep.txt");
    NodeFS.writeFileSync(markerPath, "untouched");

    await expect(
      runSelectiveMigration({
        ...fixture.options,
        apply: true,
        now: () => FIXED_NOW,
      }),
    ).rejects.toThrow("target directory is not empty");
    expect(NodeFS.readFileSync(markerPath, "utf8")).toBe("untouched");
    expect(NodeFS.readdirSync(fixture.targetPath)).toEqual(["keep.txt"]);
  });

  it("imports only read-only archives into an offline target and is idempotent", async () => {
    const fixture = makeFixture();
    await runSelectiveMigration({
      ...fixture.options,
      apply: true,
      now: () => FIXED_NOW,
    });
    const targetDatabasePath = NodePath.join(fixture.root, "target.sqlite");
    const rollbackPath = NodePath.join(fixture.root, "target-before-import.sqlite");
    createImportTarget(targetDatabasePath);

    const dryRun = await importMigrationBundle({
      bundlePath: fixture.targetPath,
      targetDatabasePath,
    });
    expect(dryRun).toMatchObject({
      applied: false,
      duplicate: false,
      archiveArtifactCount: 2,
      untrustedMemoryCount: 1,
      disabledAutomationCount: 1,
      unresolvedSpaceCount: 0,
      targetBackupSha256: null,
    });

    const applied = await importMigrationBundle({
      bundlePath: fixture.targetPath,
      targetDatabasePath,
      backupPath: rollbackPath,
      apply: true,
      confirmTargetOffline: true,
      now: () => FIXED_NOW,
    });
    expect(applied).toMatchObject({
      applied: true,
      duplicate: false,
      unresolvedSpaceCount: 0,
    });
    expect(applied.targetBackupSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(NodeFS.existsSync(rollbackPath)).toBe(true);

    const database = new NodeSqlite.DatabaseSync(targetDatabasePath, { readOnly: true });
    try {
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM command_center_artifacts").get(),
      ).toEqual({ count: 2 });
      expect(
        database
          .prepare(
            "SELECT status, kind, confidence FROM command_center_memories ORDER BY id LIMIT 1",
          )
          .get(),
      ).toEqual({ status: "archive", kind: "archive", confidence: 0 });
      expect(
        database
          .prepare("SELECT action, hash_version AS hashVersion FROM command_center_audit_events")
          .get(),
      ).toEqual({ action: "cc.migration.import", hashVersion: 2 });
      expect(
        database
          .prepare("SELECT disabled_automation_count AS count FROM command_center_import_receipts")
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }

    const duplicate = await importMigrationBundle({
      bundlePath: fixture.targetPath,
      targetDatabasePath,
    });
    expect(duplicate).toMatchObject({ applied: false, duplicate: true });
  });

  it("rejects a staged import changed after its manifest was written", async () => {
    const fixture = makeFixture();
    await runSelectiveMigration({ ...fixture.options, apply: true, now: () => FIXED_NOW });
    const targetDatabasePath = NodePath.join(fixture.root, "target.sqlite");
    createImportTarget(targetDatabasePath);
    NodeFS.appendFileSync(
      NodePath.join(fixture.targetPath, "imports", "untrusted-memory-index.jsonl"),
      "{}\n",
    );

    await expect(
      importMigrationBundle({ bundlePath: fixture.targetPath, targetDatabasePath }),
    ).rejects.toThrow("digest does not match");
  });
});

function makeFixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cc-selective-migration-"));
  temporaryDirectories.push(root);
  const stateDatabasePath = NodePath.join(root, "legacy-state.sqlite");
  const memoryDatabasePath = NodePath.join(root, "legacy-memory.sqlite");
  const automationsPath = NodePath.join(root, "legacy-automations");
  const aliasMapPath = NodePath.join(root, "aliases.json");
  const targetPath = NodePath.join(root, "staging-bundle");

  createStateFixture(stateDatabasePath);
  createMemoryFixture(memoryDatabasePath);
  NodeFS.mkdirSync(NodePath.join(automationsPath, "workflows"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(automationsPath, "examples"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(automationsPath, "workflows", "review.json"),
    JSON.stringify({
      id: "weekly-review",
      spaceId: "Legacy Workspace",
      enabled: true,
      trigger: { type: "manual" },
      nodes: [],
      edges: [],
    }),
  );
  NodeFS.writeFileSync(
    NodePath.join(automationsPath, "examples", "placeholder.json"),
    JSON.stringify({ id: "placeholder", note: "EXCLUDED_AUTOMATION_SENTINEL" }),
  );
  NodeFS.writeFileSync(
    aliasMapPath,
    JSON.stringify({ aliases: { "Legacy Workspace": "current-space" } }),
  );

  return {
    root,
    stateDatabasePath,
    memoryDatabasePath,
    automationsPath,
    aliasMapPath,
    targetPath,
    options: {
      stateDatabasePath,
      memoryDatabasePath,
      automationsPath,
      aliasMapPath,
      targetPath,
      excludedAutomations: ["examples/placeholder.json"],
    },
  };
}

function createImportTarget(path: string): void {
  const database = new NodeSqlite.DatabaseSync(path);
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE command_center_spaces (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        aliases_json TEXT NOT NULL DEFAULT '[]',
        lifecycle TEXT NOT NULL
      );
      CREATE TABLE command_center_artifacts (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL REFERENCES command_center_spaces(id),
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        uri TEXT,
        content_digest TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE command_center_memories (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL REFERENCES command_center_spaces(id),
        repository_ref TEXT,
        scope TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        confidence REAL NOT NULL,
        provenance_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE command_center_audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        hash_version INTEGER NOT NULL DEFAULT 1 CHECK (hash_version IN (1, 2)),
        previous_hash TEXT,
        event_hash TEXT NOT NULL UNIQUE,
        actor_kind TEXT NOT NULL,
        action TEXT NOT NULL,
        space_id TEXT,
        run_id TEXT,
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE TABLE command_center_import_receipts (
        plan_id TEXT PRIMARY KEY,
        manifest_sha256 TEXT NOT NULL,
        archive_artifact_count INTEGER NOT NULL,
        untrusted_memory_count INTEGER NOT NULL,
        disabled_automation_count INTEGER NOT NULL,
        target_backup_sha256 TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      INSERT INTO command_center_spaces (id, slug, name, aliases_json, lifecycle)
      VALUES ('current-space', 'current-space', 'Current Space', '[]', 'active');
    `);
  } finally {
    database.close();
  }
}

function createStateFixture(path: string): void {
  const database = new NodeSqlite.DatabaseSync(path);
  database.exec(`
    CREATE TABLE coding_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      task TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      status TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      branch TEXT,
      provider_thread_ref TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE coding_turns (id TEXT PRIMARY KEY, session_id TEXT, prompt TEXT);
    CREATE TABLE spec_flows (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      request TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      status TEXT NOT NULL,
      launch_owner_token TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE jobs (id INTEGER PRIMARY KEY, payload TEXT);
    CREATE TABLE runs (id INTEGER PRIMARY KEY, detail TEXT);
    CREATE TABLE browser_sessions (id TEXT PRIMARY KEY, state TEXT);
    CREATE TABLE approvals (id TEXT PRIMARY KEY, payload TEXT);
  `);
  database
    .prepare("INSERT INTO coding_sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      "session-1",
      "Archived coding task",
      "Create a small generic feature.",
      "Legacy Workspace",
      "completed",
      "example-provider",
      "example-model",
      "feature/example",
      "SKIP_OPERATIONAL_SENTINEL",
      "2029-01-01T00:00:00.000Z",
      "2029-01-02T00:00:00.000Z",
    );
  database
    .prepare("INSERT INTO coding_turns VALUES (?, ?, ?)")
    .run("turn-1", "session-1", "SKIP_OPERATIONAL_SENTINEL");
  database
    .prepare("INSERT INTO spec_flows VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      "flow-1",
      "Archived specification",
      "Plan a generic capability.",
      "Legacy Workspace",
      "completed",
      "SKIP_OPERATIONAL_SENTINEL",
      "2029-01-03T00:00:00.000Z",
      "2029-01-04T00:00:00.000Z",
    );
  database.prepare("INSERT INTO jobs(payload) VALUES (?)").run("SKIP_OPERATIONAL_SENTINEL");
  database.prepare("INSERT INTO runs(detail) VALUES (?)").run("SKIP_OPERATIONAL_SENTINEL");
  database
    .prepare("INSERT INTO browser_sessions VALUES (?, ?)")
    .run("browser-1", "SKIP_OPERATIONAL_SENTINEL");
  database
    .prepare("INSERT INTO approvals VALUES (?, ?)")
    .run("approval-1", "SKIP_OPERATIONAL_SENTINEL");
  database.close();
}

function createMemoryFixture(path: string): void {
  const database = new NodeSqlite.DatabaseSync(path);
  database.exec(`
    CREATE TABLE captured_turns (
      id INTEGER PRIMARY KEY,
      user_text TEXT,
      assistant_text TEXT,
      repo_scope TEXT
    );
    CREATE TABLE memory_chunks (
      id INTEGER PRIMARY KEY,
      turn_id INTEGER,
      source_kind TEXT NOT NULL,
      source_weight REAL NOT NULL,
      content TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      repo_scope TEXT NOT NULL,
      source_agent TEXT NOT NULL,
      transcript_path TEXT NOT NULL,
      heading TEXT,
      source_location TEXT,
      embedding_model TEXT,
      embedding_dimensions INTEGER,
      chunker_version TEXT NOT NULL
    );
    CREATE TABLE capture_queue (id INTEGER PRIMARY KEY, payload TEXT, status TEXT);
    CREATE TABLE ingest_checkpoints (path TEXT PRIMARY KEY, offset INTEGER);
  `);
  database
    .prepare("INSERT INTO captured_turns VALUES (?, ?, ?, ?)")
    .run(1, "SKIP_OPERATIONAL_SENTINEL", "SKIP_OPERATIONAL_SENTINEL", "Legacy Workspace");
  database
    .prepare("INSERT INTO memory_chunks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      10,
      1,
      "summary",
      0.5,
      "Archived context with its source retained.",
      "2029-01-05T00:00:00.000Z",
      "Legacy Workspace",
      "example-agent",
      "/private/archive/transcript.jsonl",
      "Example heading",
      "turn 2",
      "old-embedding",
      3,
      "legacy-v1",
    );
  database
    .prepare("INSERT INTO capture_queue VALUES (?, ?, ?)")
    .run(1, "SKIP_OPERATIONAL_SENTINEL", "pending");
  database
    .prepare("INSERT INTO ingest_checkpoints VALUES (?, ?)")
    .run("SKIP_OPERATIONAL_SENTINEL", 42);
  database.close();
}

function classification(
  manifest: Awaited<ReturnType<typeof runSelectiveMigration>>["manifest"],
  source: "state" | "memory" | "automations",
  name: string,
) {
  return manifest.classifications.find((entry) => entry.source === source && entry.name === name);
}

function readJsonLines(path: string): Array<Record<string, unknown>> {
  const text = NodeFS.readFileSync(path, "utf8").trim();
  if (!text) return [];
  return text.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

function provenanceSourceLabel(record: Record<string, unknown>): Record<string, unknown> {
  return asRecord(asRecord(record.provenance).sourceLabel);
}

function provenanceDigest(record: Record<string, unknown>): unknown {
  return asRecord(record.provenance).sourceRowSha256;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected an object record.");
  }
  return value as Record<string, unknown>;
}

function fileHash(path: string): string {
  return NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex");
}
