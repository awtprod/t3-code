// @effect-diagnostics nodeBuiltinImport:off - Manual rollback manifest CLI.
import * as NodePath from "node:path";

import { buildRollbackManifest, writeRollbackManifest } from "./operations.ts";

interface Arguments {
  readonly backupManifestPath: string;
  readonly runtimeDirectory: string;
  readonly targetServiceUnit?: string | undefined;
  readonly legacyServiceUnits: readonly string[];
  readonly stateDefinitionPaths: readonly string[];
  readonly bindHost?: string | undefined;
  readonly port?: number | undefined;
  readonly healthUrl?: string | undefined;
  readonly outputPath?: string | undefined;
  readonly write: boolean;
  readonly confirmReviewed: boolean;
}

function usage(): never {
  throw new Error(`Usage:
  node scripts/command-center/rollback-manifest.ts \\
    --backup-manifest /absolute/staging/manifest.json \\
    --runtime-dir /absolute/runtime \\
    --legacy-service legacy-console.service \\
    --state-definition /absolute/service-definition \\
    [--target-service command-center.service] [--host 127.0.0.1] [--port 4530] \\
    [--health-url http://127.0.0.1:4530/] \\
    [--output /absolute/rollback-manifest.json --write --confirm-reviewed]

Without --write, the reviewed manifest is printed and no file is created. Writing requires both an
absent output path and the explicit --confirm-reviewed acknowledgement. This tool never controls a
service, changes routing, cuts over, or rolls back.`);
}

function parseArguments(argv: readonly string[]): Arguments {
  const values = new Map<string, string>();
  const legacyServiceUnits: string[] = [];
  const stateDefinitionPaths: string[] = [];
  let write = false;
  let confirmReviewed = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--write") {
      write = true;
      continue;
    }
    if (flag === "--confirm-reviewed") {
      confirmReviewed = true;
      continue;
    }
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value) usage();
    index += 1;
    if (flag === "--legacy-service") legacyServiceUnits.push(value);
    else if (flag === "--state-definition") stateDefinitionPaths.push(NodePath.resolve(value));
    else if (
      [
        "--backup-manifest",
        "--runtime-dir",
        "--target-service",
        "--host",
        "--port",
        "--health-url",
        "--output",
      ].includes(flag)
    ) {
      if (values.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
      values.set(flag, value);
    } else usage();
  }

  const backupManifest = values.get("--backup-manifest");
  const runtimeDirectory = values.get("--runtime-dir");
  if (
    !backupManifest ||
    !runtimeDirectory ||
    legacyServiceUnits.length === 0 ||
    stateDefinitionPaths.length === 0
  ) {
    usage();
  }
  if (write && (!values.get("--output") || !confirmReviewed)) {
    throw new Error("Writing requires --output and --confirm-reviewed.");
  }
  if (!write && confirmReviewed) {
    throw new Error("--confirm-reviewed is only valid with --write.");
  }
  const portValue = values.get("--port");
  return {
    backupManifestPath: NodePath.resolve(backupManifest),
    runtimeDirectory: NodePath.resolve(runtimeDirectory),
    targetServiceUnit: values.get("--target-service"),
    legacyServiceUnits,
    stateDefinitionPaths,
    bindHost: values.get("--host"),
    port: portValue === undefined ? undefined : Number(portValue),
    healthUrl: values.get("--health-url"),
    outputPath: values.get("--output"),
    write,
    confirmReviewed,
  };
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const manifest = await buildRollbackManifest(args);
  if (args.write && args.outputPath) {
    await writeRollbackManifest(NodePath.resolve(args.outputPath), manifest);
    process.stdout.write(`${NodePath.resolve(args.outputPath)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
