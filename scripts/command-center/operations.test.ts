// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Isolated operations fixtures.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  buildRollbackManifest,
  runDeploymentPreflight,
  writeRollbackManifest,
} from "./operations.ts";

const temporaryDirectories: string[] = [];
const FIXED_NOW = new Date("2030-01-02T03:04:05.000Z");
const TEN_GIB = 10n * 1024n * 1024n * 1024n;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("rollback manifest", () => {
  it("ships a loopback-only, non-Git runtime service example", () => {
    const unit = NodeFS.readFileSync(
      NodePath.resolve(import.meta.dirname, "../../examples/systemd/command-center.service"),
      "utf8",
    );
    expect(unit).toContain("--base-dir %h/.command-center");
    expect(unit).toContain("--host 127.0.0.1 --port 4530");
    expect(unit).toContain("ReadWritePaths=%h/.command-center");
    expect(unit).toContain("%h/.command-center-config");
    expect(unit).not.toContain("ReadOnlyPaths=%h/.command-center-config");
    expect(unit).not.toContain("0.0.0.0");
    expect(unit).not.toContain("--tailscale-serve");
  });

  it("binds a verified backup and immutable legacy snapshots without taking action", async () => {
    const fixture = makeFixture();
    const manifest = await buildRollbackManifest({
      ...fixture.options,
      now: () => FIXED_NOW,
    });

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      manifestKind: "command-center-rollback",
      status: "reviewed-ready-for-preflight",
      createdAt: FIXED_NOW.toISOString(),
      safety: {
        cutoverPerformedByTool: false,
        rollbackPerformedByTool: false,
        destructiveActionsAvailable: false,
      },
      target: {
        serviceUnit: "command-center.service",
        bindHost: "127.0.0.1",
        port: 4530,
        healthUrl: "http://127.0.0.1:4530/",
      },
      legacy: { serviceUnits: ["legacy-console.service"] },
    });
    expect(manifest.legacy.stateDefinitions).toEqual([
      {
        path: fixture.definitionPath,
        sha256: sha256(NodeFS.readFileSync(fixture.definitionPath)),
        sizeBytes: NodeFS.statSync(fixture.definitionPath).size,
      },
    ]);
    expect(manifest.rollbackSteps.every((step) => step.automated === false)).toBe(true);

    await writeRollbackManifest(fixture.rollbackManifestPath, manifest);
    expect(NodeFS.statSync(fixture.rollbackManifestPath).mode & 0o777).toBe(0o600);
    await expect(writeRollbackManifest(fixture.rollbackManifestPath, manifest)).rejects.toThrow();
  });

  it("refuses public binding, absent backups, and incomplete rollback records", async () => {
    const fixture = makeFixture();
    await expect(
      buildRollbackManifest({ ...fixture.options, bindHost: "0.0.0.0" }),
    ).rejects.toThrow("public interfaces are refused");
    await expect(
      buildRollbackManifest({
        ...fixture.options,
        backupManifestPath: `${fixture.root}/missing.json`,
      }),
    ).rejects.toThrow();
    await expect(
      buildRollbackManifest({ ...fixture.options, legacyServiceUnits: [] }),
    ).rejects.toThrow("At least one legacy service");
    await expect(
      buildRollbackManifest({ ...fixture.options, stateDefinitionPaths: [] }),
    ).rejects.toThrow("At least one legacy state");
  });
});

describe("runDeploymentPreflight", () => {
  it("reports readiness only when every manual-cutover prerequisite passes", async () => {
    const fixture = makeFixture();
    await writeManifest(fixture);
    const report = await runDeploymentPreflight({
      rollbackManifestPath: fixture.rollbackManifestPath,
      availableBytes: async () => TEN_GIB,
      isGitManaged: async () => false,
      probeHealth: async () => ({ ok: true, status: 200, detail: "ok" }),
      now: () => FIXED_NOW,
    });

    expect(report.status, JSON.stringify(report.checks)).toBe("ready-for-manual-cutover");
    expect(report.readyForManualCutover).toBe(true);
    expect(report.cutoverPerformedByTool).toBe(false);
    expect(report.checks).toHaveLength(6);
    expect(report.checks.every((check) => check.status === "pass")).toBe(true);
  });

  it("refuses cutover on low disk and failed health", async () => {
    const fixture = makeFixture();
    await writeManifest(fixture);
    const report = await runDeploymentPreflight({
      rollbackManifestPath: fixture.rollbackManifestPath,
      availableBytes: async () => 1n,
      isGitManaged: async () => false,
      probeHealth: async () => ({ ok: false, status: 503, detail: "not ready" }),
      now: () => FIXED_NOW,
    });

    expect(report.status).toBe("cutover-refused");
    expect(report.readyForManualCutover).toBe(false);
    expect(check(report, "free-disk")).toMatchObject({ status: "fail" });
    expect(check(report, "target-health")).toMatchObject({ status: "fail" });
  });

  it("refuses cutover when a backup or rollback snapshot changed after review", async () => {
    const fixture = makeFixture();
    await writeManifest(fixture);
    NodeFS.appendFileSync(fixture.backupPath, "tampered");
    NodeFS.appendFileSync(fixture.definitionPath, "changed");

    const report = await runDeploymentPreflight({
      rollbackManifestPath: fixture.rollbackManifestPath,
      availableBytes: async () => TEN_GIB,
      isGitManaged: async () => false,
      probeHealth: async () => ({ ok: true, status: 200, detail: "ok" }),
      now: () => FIXED_NOW,
    });

    expect(report.readyForManualCutover).toBe(false);
    expect(check(report, "backup-integrity")).toMatchObject({ status: "fail" });
    expect(check(report, "rollback-snapshots")).toMatchObject({ status: "fail" });
  });

  it("refuses a runtime directory inside Git", async () => {
    const fixture = makeFixture();
    NodeFS.mkdirSync(NodePath.join(fixture.runtimeDirectory, ".git"));
    await writeManifest(fixture);

    const report = await runDeploymentPreflight({
      rollbackManifestPath: fixture.rollbackManifestPath,
      availableBytes: async () => TEN_GIB,
      isGitManaged: async () => true,
      probeHealth: async () => ({ ok: true, status: 200, detail: "ok" }),
      now: () => FIXED_NOW,
    });

    expect(check(report, "runtime-boundary")).toMatchObject({
      status: "fail",
      detail: "Runtime directory is inside a Git worktree.",
    });
    expect(report.readyForManualCutover).toBe(false);
  });
});

function makeFixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cc-operations-"));
  temporaryDirectories.push(root);
  const bundlePath = NodePath.join(root, "bundle");
  const runtimeDirectory = NodePath.join(root, "runtime");
  NodeFS.mkdirSync(NodePath.join(bundlePath, "backups"), { recursive: true });
  NodeFS.mkdirSync(runtimeDirectory);
  const backupPath = NodePath.join(bundlePath, "backups", "state.sqlite");
  NodeFS.writeFileSync(backupPath, "consistent backup fixture\n");
  const backupManifestPath = NodePath.join(bundlePath, "manifest.json");
  NodeFS.writeFileSync(
    backupManifestPath,
    `${JSON.stringify({
      schemaVersion: 1,
      backup: {
        status: "completed",
        entries: [
          {
            sourceKind: "state",
            relativeBackupPath: "backups/state.sqlite",
            backupSha256: sha256(NodeFS.readFileSync(backupPath)),
          },
        ],
      },
    })}\n`,
  );
  const definitionPath = NodePath.join(root, "legacy-console.service");
  NodeFS.writeFileSync(definitionPath, "[Service]\nExecStart=/usr/bin/false\n");
  const rollbackManifestPath = NodePath.join(root, "rollback.json");
  return {
    root,
    runtimeDirectory,
    backupPath,
    backupManifestPath,
    definitionPath,
    rollbackManifestPath,
    options: {
      backupManifestPath,
      runtimeDirectory,
      legacyServiceUnits: ["legacy-console.service"],
      stateDefinitionPaths: [definitionPath],
    },
  };
}

async function writeManifest(fixture: ReturnType<typeof makeFixture>): Promise<void> {
  const manifest = await buildRollbackManifest({ ...fixture.options, now: () => FIXED_NOW });
  await writeRollbackManifest(fixture.rollbackManifestPath, manifest);
}

function sha256(bytes: NodeJS.ArrayBufferView): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

function check(report: Awaited<ReturnType<typeof runDeploymentPreflight>>, id: string) {
  return report.checks.find((entry) => entry.id === id);
}
