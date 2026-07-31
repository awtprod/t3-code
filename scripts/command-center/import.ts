// @effect-diagnostics nodeBuiltinImport:off - This is a standalone offline migration CLI.
import * as NodeURL from "node:url";

import { importMigrationBundle, type ImportMigrationBundleOptions } from "./importBundle.ts";

interface ParsedArguments extends ImportMigrationBundleOptions {
  readonly help: boolean;
}

export function parseImportArguments(arguments_: readonly string[]): ParsedArguments {
  let bundlePath: string | undefined;
  let targetDatabasePath: string | undefined;
  let backupPath: string | undefined;
  let spaceMapPath: string | undefined;
  let defaultSpaceId: string | undefined;
  let apply = false;
  let confirmTargetOffline = false;
  let help = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    switch (argument) {
      case "--bundle":
        bundlePath = requireValue(arguments_, ++index, argument);
        break;
      case "--database":
        targetDatabasePath = requireValue(arguments_, ++index, argument);
        break;
      case "--backup":
        backupPath = requireValue(arguments_, ++index, argument);
        break;
      case "--space-map":
        spaceMapPath = requireValue(arguments_, ++index, argument);
        break;
      case "--default-space":
        defaultSpaceId = requireValue(arguments_, ++index, argument);
        break;
      case "--apply":
        apply = true;
        break;
      case "--confirm-target-offline":
        confirmTargetOffline = true;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (help) {
    return {
      help,
      bundlePath: bundlePath ?? "",
      targetDatabasePath: targetDatabasePath ?? "",
      backupPath,
      spaceMapPath,
      defaultSpaceId,
      apply,
      confirmTargetOffline,
    };
  }
  if (!bundlePath) throw new Error("Missing required --bundle argument.");
  if (!targetDatabasePath) throw new Error("Missing required --database argument.");
  return {
    help,
    bundlePath,
    targetDatabasePath,
    backupPath,
    spaceMapPath,
    defaultSpaceId,
    apply,
    confirmTargetOffline,
  };
}

export async function main(arguments_: readonly string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseImportArguments(arguments_);
  if (parsed.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }
  const result = await importMigrationBundle(parsed);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function requireValue(arguments_: readonly string[], index: number, flag: string): string {
  const value = arguments_[index];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
  return value;
}

const HELP_TEXT = `Offline Command Center migration import

Usage:
  node scripts/command-center/import.ts \\
    --bundle /absolute/path/to/reviewed-staging-bundle \\
    --database /absolute/path/to/isolated-command-center.sqlite \\
    [--space-map /absolute/path/to/private-space-map.json] \\
    [--default-space stable-space-id]

Dry run is the default. To apply, first stop the isolated target service, then add:

  --apply --confirm-target-offline --backup /absolute/path/to/absent-rollback.sqlite

The importer verifies manifest hashes and counts, writes only archive Artifacts and
untrusted read-only Memory records, records an audit event and idempotency receipt,
and never enables imported automations. Disabled automation definitions stay in the
private staging/config review workflow.
`;

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === NodeURL.pathToFileURL(invokedPath).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
