// @effect-diagnostics nodeBuiltinImport:off - This is a standalone host migration CLI.
import * as NodeURL from "node:url";

import { runSelectiveMigration, type SelectiveMigrationOptions } from "./migration.ts";

interface ParsedArguments extends SelectiveMigrationOptions {
  readonly help: boolean;
}

export function parseMigrationArguments(arguments_: readonly string[]): ParsedArguments {
  let stateDatabasePath: string | undefined;
  let memoryDatabasePath: string | undefined;
  let targetPath: string | undefined;
  let automationsPath: string | undefined;
  let aliasMapPath: string | undefined;
  let apply = false;
  let help = false;
  const excludedAutomations: string[] = [];

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    switch (argument) {
      case "--state-db":
        stateDatabasePath = requireValue(arguments_, ++index, argument);
        break;
      case "--memory-db":
        memoryDatabasePath = requireValue(arguments_, ++index, argument);
        break;
      case "--target":
        targetPath = requireValue(arguments_, ++index, argument);
        break;
      case "--automations-dir":
        automationsPath = requireValue(arguments_, ++index, argument);
        break;
      case "--alias-map":
        aliasMapPath = requireValue(arguments_, ++index, argument);
        break;
      case "--exclude-automation":
        excludedAutomations.push(requireValue(arguments_, ++index, argument));
        break;
      case "--apply":
        apply = true;
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
      stateDatabasePath: stateDatabasePath ?? "",
      memoryDatabasePath: memoryDatabasePath ?? "",
      targetPath: targetPath ?? "",
      automationsPath,
      aliasMapPath,
      excludedAutomations,
      apply,
    };
  }
  if (!stateDatabasePath) throw new Error("Missing required --state-db argument.");
  if (!memoryDatabasePath) throw new Error("Missing required --memory-db argument.");
  if (!targetPath) throw new Error("Missing required --target argument.");

  return {
    help,
    stateDatabasePath,
    memoryDatabasePath,
    targetPath,
    automationsPath,
    aliasMapPath,
    excludedAutomations,
    apply,
  };
}

export async function main(arguments_: readonly string[] = process.argv.slice(2)): Promise<void> {
  const argumentsParsed = parseMigrationArguments(arguments_);
  if (argumentsParsed.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }
  const result = await runSelectiveMigration(argumentsParsed);
  process.stdout.write(`${JSON.stringify(result.manifest, null, 2)}\n`);
}

function requireValue(arguments_: readonly string[], index: number, flag: string): string {
  const value = arguments_[index];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
  return value;
}

const HELP_TEXT = `Selective Command Center migration staging

Usage:
  node scripts/command-center/migrate.ts \\
    --state-db /absolute/path/to/state.sqlite \\
    --memory-db /absolute/path/to/memory.sqlite \\
    --target /absolute/path/to/new-staging-directory \\
    [--automations-dir /absolute/path/to/automations] \\
    [--alias-map /absolute/path/to/aliases.json] \\
    [--exclude-automation relative/path.json] \\
    [--apply]

The default is a read-only dry run. It prints a manifest and does not create or
write the target. --apply only creates a staging bundle when the target is absent
or empty. The tool never stops services and never writes an application database.
`;

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === NodeURL.pathToFileURL(invokedPath).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
