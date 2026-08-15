// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Offline deployment safety utility.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

export const OPERATIONS_MANIFEST_VERSION = 1;
export const DEFAULT_COMMAND_CENTER_PORT = 4530;
export const DEFAULT_MINIMUM_FREE_BYTES = 5n * 1024n * 1024n * 1024n;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SERVICE_UNIT_PATTERN = /^[A-Za-z0-9_.@-]+\.service$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

export interface RollbackManifestOptions {
  readonly backupManifestPath: string;
  readonly runtimeDirectory: string;
  readonly targetServiceUnit?: string | undefined;
  readonly legacyServiceUnits: readonly string[];
  readonly stateDefinitionPaths: readonly string[];
  readonly bindHost?: string | undefined;
  readonly port?: number | undefined;
  readonly healthUrl?: string | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface RollbackManifest {
  readonly schemaVersion: 1;
  readonly manifestKind: "command-center-rollback";
  readonly status: "reviewed-ready-for-preflight";
  readonly createdAt: string;
  readonly safety: {
    readonly cutoverPerformedByTool: false;
    readonly rollbackPerformedByTool: false;
    readonly destructiveActionsAvailable: false;
  };
  readonly backup: {
    readonly manifestPath: string;
    readonly manifestSha256: string;
    readonly entryCount: number;
  };
  readonly target: {
    readonly serviceUnit: string;
    readonly runtimeDirectory: string;
    readonly bindHost: string;
    readonly port: number;
    readonly healthUrl: string;
  };
  readonly legacy: {
    readonly serviceUnits: readonly string[];
    readonly stateDefinitions: readonly FileSnapshot[];
  };
  readonly rollbackTriggers: readonly string[];
  readonly rollbackSteps: readonly ManualOperation[];
}

export interface FileSnapshot {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface ManualOperation {
  readonly id: string;
  readonly description: string;
  readonly automated: false;
}

export interface DeploymentPreflightOptions {
  readonly rollbackManifestPath: string;
  readonly minimumFreeBytes?: bigint | undefined;
  readonly probeHealth?: ((url: string) => Promise<HealthProbeResult>) | undefined;
  readonly availableBytes?: ((path: string) => Promise<bigint>) | undefined;
  readonly isGitManaged?: ((path: string) => Promise<boolean>) | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface HealthProbeResult {
  readonly ok: boolean;
  readonly status: number | null;
  readonly detail: string;
}

export interface PreflightCheck {
  readonly id: string;
  readonly status: "pass" | "fail";
  readonly detail: string;
}

export interface DeploymentPreflightReport {
  readonly schemaVersion: 1;
  readonly reportKind: "command-center-cutover-preflight";
  readonly checkedAt: string;
  readonly status: "ready-for-manual-cutover" | "cutover-refused";
  readonly readyForManualCutover: boolean;
  readonly cutoverPerformedByTool: false;
  readonly checks: readonly PreflightCheck[];
}

interface ValidatedBackup {
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly entryCount: number;
}

export async function buildRollbackManifest(
  options: RollbackManifestOptions,
): Promise<RollbackManifest> {
  const runtimeDirectory = requireAbsolutePath(options.runtimeDirectory, "Runtime directory");
  const backup = await validateBackupManifest(options.backupManifestPath);
  const bindHost = validateLoopbackHost(options.bindHost ?? "127.0.0.1");
  const port = validatePort(options.port ?? DEFAULT_COMMAND_CENTER_PORT);
  const healthUrl = validateLoopbackHealthUrl(
    options.healthUrl ?? `http://${formatUrlHost(bindHost)}:${port}/`,
    port,
  );
  const targetServiceUnit = validateServiceUnit(
    options.targetServiceUnit ?? "command-center.service",
  );
  const legacyServiceUnits = [
    ...new Set(options.legacyServiceUnits.map(validateServiceUnit)),
  ].sort();
  if (legacyServiceUnits.length === 0) {
    throw new Error("At least one legacy service unit is required for a rollback manifest.");
  }
  if (legacyServiceUnits.includes(targetServiceUnit)) {
    throw new Error("The target service unit cannot also be a legacy rollback service unit.");
  }
  if (options.stateDefinitionPaths.length === 0) {
    throw new Error("At least one legacy state or service definition snapshot is required.");
  }
  const stateDefinitions = await Promise.all(
    [...new Set(options.stateDefinitionPaths)].sort().map(snapshotFile),
  );

  return {
    schemaVersion: OPERATIONS_MANIFEST_VERSION,
    manifestKind: "command-center-rollback",
    status: "reviewed-ready-for-preflight",
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    safety: {
      cutoverPerformedByTool: false,
      rollbackPerformedByTool: false,
      destructiveActionsAvailable: false,
    },
    backup,
    target: {
      serviceUnit: targetServiceUnit,
      runtimeDirectory,
      bindHost,
      port,
      healthUrl,
    },
    legacy: { serviceUnits: legacyServiceUnits, stateDefinitions },
    rollbackTriggers: [
      "Target health validation fails.",
      "Required routing or authenticated access is unavailable.",
      "Imported data counts or provenance differ from the reviewed migration manifest.",
    ],
    rollbackSteps: [
      manualOperation("stop-target", "Stop the target through the approved service manager."),
      manualOperation(
        "restore-definitions",
        "Restore only the snapshotted service and routing definitions after verifying their digests.",
      ),
      manualOperation(
        "restore-data-if-required",
        "Restore data only from the verified backup bundle and only to operator-confirmed paths.",
      ),
      manualOperation(
        "start-legacy",
        "Start the recorded legacy units through the approved service manager.",
      ),
      manualOperation(
        "verify-legacy",
        "Verify legacy health and routing, then record the rollback outcome.",
      ),
    ],
  };
}

export async function writeRollbackManifest(
  outputPath: string,
  manifest: RollbackManifest,
): Promise<void> {
  const resolved = requireAbsolutePath(outputPath, "Rollback manifest output");
  await NodeFSP.mkdir(NodePath.dirname(resolved), { recursive: true, mode: 0o700 });
  const handle = await NodeFSP.open(resolved, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function runDeploymentPreflight(
  options: DeploymentPreflightOptions,
): Promise<DeploymentPreflightReport> {
  const checks: PreflightCheck[] = [];
  const rollbackManifestPath = requireAbsolutePath(
    options.rollbackManifestPath,
    "Rollback manifest",
  );
  let manifest: RollbackManifest | undefined;

  await runCheck(checks, "rollback-manifest", async () => {
    manifest = await readRollbackManifest(rollbackManifestPath);
    return "Rollback manifest schema and manual-only safety flags are valid.";
  });

  await runCheck(checks, "backup-integrity", async () => {
    if (!manifest) throw new Error("Rollback manifest was not valid.");
    const backup = await validateBackupManifest(manifest.backup.manifestPath);
    if (backup.manifestSha256 !== manifest.backup.manifestSha256) {
      throw new Error("Backup manifest digest no longer matches the rollback manifest.");
    }
    if (backup.entryCount !== manifest.backup.entryCount) {
      throw new Error("Backup entry count no longer matches the rollback manifest.");
    }
    return `${backup.entryCount} backup entries and their digests were verified.`;
  });

  await runCheck(checks, "runtime-boundary", async () => {
    if (!manifest) throw new Error("Rollback manifest was not valid.");
    const runtime = manifest.target.runtimeDirectory;
    const stats = await NodeFSP.lstat(runtime);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("Runtime directory must be a real directory, not a symlink.");
    }
    await NodeFSP.access(runtime, NodeFS.constants.R_OK | NodeFS.constants.W_OK);
    if (await (options.isGitManaged ?? hasGitMetadataInAncestors)(runtime)) {
      throw new Error("Runtime directory is inside a Git worktree.");
    }
    validateLoopbackHost(manifest.target.bindHost);
    validateLoopbackHealthUrl(manifest.target.healthUrl, manifest.target.port);
    return "Runtime storage is writable, outside Git, and bound to loopback only.";
  });

  await runCheck(checks, "rollback-snapshots", async () => {
    if (!manifest) throw new Error("Rollback manifest was not valid.");
    for (const snapshot of manifest.legacy.stateDefinitions) {
      const current = await snapshotFile(snapshot.path);
      if (current.sha256 !== snapshot.sha256 || current.sizeBytes !== snapshot.sizeBytes) {
        throw new Error(`Rollback definition changed after review: ${snapshot.path}`);
      }
    }
    return `${manifest.legacy.stateDefinitions.length} rollback definition snapshots were verified.`;
  });

  await runCheck(checks, "free-disk", async () => {
    if (!manifest) throw new Error("Rollback manifest was not valid.");
    const minimum = options.minimumFreeBytes ?? DEFAULT_MINIMUM_FREE_BYTES;
    if (minimum <= 0n) throw new Error("Minimum free bytes must be positive.");
    const available = await (options.availableBytes ?? readAvailableBytes)(
      manifest.target.runtimeDirectory,
    );
    if (available < minimum) {
      throw new Error(
        `Only ${formatBytes(available)} is available; ${formatBytes(minimum)} is required.`,
      );
    }
    return `${formatBytes(available)} is available (minimum ${formatBytes(minimum)}).`;
  });

  await runCheck(checks, "target-health", async () => {
    if (!manifest) throw new Error("Rollback manifest was not valid.");
    const result = await (options.probeHealth ?? probeLoopbackHealth)(manifest.target.healthUrl);
    if (!result.ok) {
      throw new Error(
        `Loopback health probe failed${result.status === null ? "" : ` with HTTP ${result.status}`}: ${result.detail}`,
      );
    }
    return `Loopback health probe passed with HTTP ${result.status ?? "success"}.`;
  });

  const readyForManualCutover = checks.every((check) => check.status === "pass");
  return {
    schemaVersion: OPERATIONS_MANIFEST_VERSION,
    reportKind: "command-center-cutover-preflight",
    checkedAt: (options.now ?? (() => new Date()))().toISOString(),
    status: readyForManualCutover ? "ready-for-manual-cutover" : "cutover-refused",
    readyForManualCutover,
    cutoverPerformedByTool: false,
    checks,
  };
}

async function readRollbackManifest(path: string): Promise<RollbackManifest> {
  await assertRealFile(path, "Rollback manifest");
  const value = JSON.parse(await NodeFSP.readFile(path, "utf8")) as unknown;
  if (!isRecord(value)) throw new Error("Rollback manifest must be a JSON object.");
  if (
    value.schemaVersion !== OPERATIONS_MANIFEST_VERSION ||
    value.manifestKind !== "command-center-rollback" ||
    value.status !== "reviewed-ready-for-preflight"
  ) {
    throw new Error("Rollback manifest version, kind, or review status is invalid.");
  }
  const safety = requireRecord(value.safety, "Rollback safety");
  if (
    safety.cutoverPerformedByTool !== false ||
    safety.rollbackPerformedByTool !== false ||
    safety.destructiveActionsAvailable !== false
  ) {
    throw new Error("Rollback manifest must retain manual-only safety flags.");
  }
  const backup = requireRecord(value.backup, "Rollback backup");
  requireAbsolutePath(
    requireString(backup.manifestPath, "Backup manifest path"),
    "Backup manifest",
  );
  validateSha256(requireString(backup.manifestSha256, "Backup manifest digest"));
  requirePositiveInteger(backup.entryCount, "Backup entry count");
  const target = requireRecord(value.target, "Rollback target");
  validateServiceUnit(requireString(target.serviceUnit, "Target service unit"));
  requireAbsolutePath(
    requireString(target.runtimeDirectory, "Runtime directory"),
    "Runtime directory",
  );
  validateLoopbackHost(requireString(target.bindHost, "Bind host"));
  const port = requirePositiveInteger(target.port, "Target port");
  validatePort(port);
  validateLoopbackHealthUrl(requireString(target.healthUrl, "Health URL"), port);
  const legacy = requireRecord(value.legacy, "Rollback legacy state");
  if (!Array.isArray(legacy.serviceUnits) || legacy.serviceUnits.length === 0) {
    throw new Error("Rollback manifest must retain at least one legacy service unit.");
  }
  legacy.serviceUnits.forEach((unit) => validateServiceUnit(requireString(unit, "Legacy unit")));
  if (!Array.isArray(legacy.stateDefinitions) || legacy.stateDefinitions.length === 0) {
    throw new Error("Rollback manifest must retain state definition snapshots.");
  }
  for (const entry of legacy.stateDefinitions) {
    const snapshot = requireRecord(entry, "State definition snapshot");
    requireAbsolutePath(requireString(snapshot.path, "Snapshot path"), "Snapshot path");
    validateSha256(requireString(snapshot.sha256, "Snapshot digest"));
    requireNonNegativeInteger(snapshot.sizeBytes, "Snapshot size");
  }
  if (!Array.isArray(value.rollbackSteps) || value.rollbackSteps.length === 0) {
    throw new Error("Rollback manifest must contain manual rollback steps.");
  }
  return value as unknown as RollbackManifest;
}

async function validateBackupManifest(path: string): Promise<ValidatedBackup> {
  const manifestPath = requireAbsolutePath(path, "Backup manifest");
  await assertRealFile(manifestPath, "Backup manifest");
  const bytes = await NodeFSP.readFile(manifestPath);
  const value = JSON.parse(bytes.toString("utf8")) as unknown;
  const root = requireRecord(value, "Backup manifest");
  const backup = requireRecord(root.backup, "Backup section");
  if (backup.status !== "completed") throw new Error("Backup manifest is not completed.");
  if (!Array.isArray(backup.entries) || backup.entries.length === 0) {
    throw new Error("Backup manifest contains no backup entries.");
  }
  const bundleDirectory = NodePath.dirname(manifestPath);
  const realBundleDirectory = await NodeFSP.realpath(bundleDirectory);
  for (const rawEntry of backup.entries) {
    const entry = requireRecord(rawEntry, "Backup entry");
    const relativePath = requireString(entry.relativeBackupPath, "Backup relative path");
    const expectedHash = validateSha256(requireString(entry.backupSha256, "Backup digest"));
    const backupPath = resolveInside(bundleDirectory, relativePath);
    await assertRealFile(backupPath, "Backup entry");
    const realBackupPath = await NodeFSP.realpath(backupPath);
    if (!isInside(realBundleDirectory, realBackupPath)) {
      throw new Error(`Backup entry resolves outside the staging bundle: ${relativePath}`);
    }
    const actualHash = await sha256File(backupPath);
    if (actualHash !== expectedHash) {
      throw new Error(`Backup digest mismatch: ${relativePath}`);
    }
  }
  return {
    manifestPath,
    manifestSha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    entryCount: backup.entries.length,
  };
}

async function snapshotFile(path: string): Promise<FileSnapshot> {
  const resolved = requireAbsolutePath(path, "State definition path");
  const stats = await NodeFSP.lstat(resolved);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`State definition must be a real file: ${resolved}`);
  }
  return { path: resolved, sha256: await sha256File(resolved), sizeBytes: stats.size };
}

async function sha256File(path: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = NodeCrypto.createHash("sha256");
    const stream = NodeFS.createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function hasGitMetadataInAncestors(path: string): Promise<boolean> {
  let current = await NodeFSP.realpath(path);
  while (true) {
    if (NodeFS.existsSync(NodePath.join(current, ".git"))) return true;
    const parent = NodePath.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

async function readAvailableBytes(path: string): Promise<bigint> {
  const stats = await NodeFSP.statfs(path, { bigint: true });
  return stats.bavail * stats.bsize;
}

async function probeLoopbackHealth(url: string): Promise<HealthProbeResult> {
  validateLoopbackHealthUrl(url);
  return await new Promise((resolve) => {
    const request = NodeHttp.request(
      url,
      { method: "GET", headers: { accept: "text/html,application/json" } },
      (response) => {
        response.resume();
        const status = response.statusCode ?? null;
        resolve({
          ok: status !== null && status >= 200 && status < 300,
          status,
          detail: response.statusMessage || "HTTP response received",
        });
      },
    );
    request.setTimeout(5_000, () => request.destroy(new Error("Health probe timed out.")));
    request.on("error", (error) => resolve({ ok: false, status: null, detail: error.message }));
    request.end();
  });
}

async function runCheck(
  checks: PreflightCheck[],
  id: string,
  operation: () => Promise<string>,
): Promise<void> {
  try {
    checks.push({ id, status: "pass", detail: await operation() });
  } catch (error) {
    checks.push({
      id,
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function validateLoopbackHost(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  if (!LOOPBACK_HOSTS.has(normalized)) {
    throw new Error("Deployment bind host must be loopback; public interfaces are refused.");
  }
  return normalized;
}

function validateLoopbackHealthUrl(value: string, expectedPort?: number): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:") {
    throw new Error("Health URL must use plain HTTP on a loopback hostname.");
  }
  validateLoopbackHost(parsed.hostname);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Health URL must not contain credentials, a query, or a fragment.");
  }
  const port = parsed.port ? Number(parsed.port) : 80;
  validatePort(port);
  if (expectedPort !== undefined && port !== expectedPort) {
    throw new Error("Health URL port does not match the target service port.");
  }
  return parsed.toString();
}

function validatePort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error("Port must be an integer between 1 and 65535.");
  }
  return value;
}

function validateServiceUnit(value: string): string {
  if (!SERVICE_UNIT_PATTERN.test(value)) throw new Error(`Invalid systemd service unit: ${value}`);
  return value;
}

function validateSha256(value: string): string {
  if (!SHA256_PATTERN.test(value)) throw new Error("Expected a lowercase SHA-256 digest.");
  return value;
}

function resolveInside(root: string, relativePath: string): string {
  if (NodePath.isAbsolute(relativePath)) throw new Error("Backup entry path must be relative.");
  const resolvedRoot = NodePath.resolve(root);
  const resolved = NodePath.resolve(resolvedRoot, relativePath);
  if (resolved === resolvedRoot || !resolved.startsWith(`${resolvedRoot}${NodePath.sep}`)) {
    throw new Error("Backup entry path escapes the staging bundle.");
  }
  return resolved;
}

async function assertRealFile(path: string, label: string): Promise<void> {
  const stats = await NodeFSP.lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a real file, not a symlink.`);
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = NodePath.relative(root, candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${NodePath.sep}`) &&
    !NodePath.isAbsolute(relative)
  );
}

function requireAbsolutePath(value: string, label: string): string {
  if (!NodePath.isAbsolute(value)) throw new Error(`${label} must be an absolute path.`);
  return NodePath.normalize(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}

function manualOperation(id: string, description: string): ManualOperation {
  return { id, description, automated: false };
}

function formatUrlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function formatBytes(value: bigint): string {
  const gib = Number(value) / 1024 ** 3;
  return `${gib.toFixed(2)} GiB`;
}
