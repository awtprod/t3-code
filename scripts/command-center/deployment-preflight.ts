// @effect-diagnostics nodeBuiltinImport:off - Read-only deployment gate CLI.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { runDeploymentPreflight } from "./operations.ts";

interface Arguments {
  readonly rollbackManifestPath: string;
  readonly minimumFreeBytes?: bigint | undefined;
  readonly outputPath?: string | undefined;
}

function usage(): never {
  throw new Error(`Usage:
  node scripts/command-center/deployment-preflight.ts \\
    --rollback-manifest /absolute/rollback-manifest.json \\
    [--minimum-free-gib 5] [--output /absolute/preflight-report.json]

This command performs read-only integrity, disk, loopback, rollback, and health checks. A failed
check exits nonzero and explicitly refuses cutover. It never controls services or routing.`);
}

function parseArguments(argv: readonly string[]): Arguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !flag ||
      !value ||
      !["--rollback-manifest", "--minimum-free-gib", "--output"].includes(flag)
    ) {
      usage();
    }
    if (values.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
    values.set(flag, value);
  }
  const rollbackManifest = values.get("--rollback-manifest");
  if (!rollbackManifest) usage();
  const minimumGiB = values.get("--minimum-free-gib");
  let minimumFreeBytes: bigint | undefined;
  if (minimumGiB !== undefined) {
    if (!/^\d+$/.test(minimumGiB) || BigInt(minimumGiB) < 1n) {
      throw new Error("--minimum-free-gib must be a positive whole number.");
    }
    minimumFreeBytes = BigInt(minimumGiB) * 1024n * 1024n * 1024n;
  }
  return {
    rollbackManifestPath: NodePath.resolve(rollbackManifest),
    minimumFreeBytes,
    outputPath: values.get("--output"),
  };
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const report = await runDeploymentPreflight(args);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (args.outputPath) {
    const outputPath = NodePath.resolve(args.outputPath);
    const handle = await NodeFSP.open(outputPath, "wx", 0o600);
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  process.stdout.write(serialized);
  if (!report.readyForManualCutover) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
