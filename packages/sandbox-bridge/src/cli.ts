/**
 * Minimal flag parsing shared by the three sandbox binaries. The server invokes
 * them with a fixed, non-negotiable argv shape (see ThreadPreviewProxy and
 * ContainerSandboxBackend), so this only needs `--flag value` and `--flag`.
 */
export type ParsedArgs = {
  readonly subcommand: string | undefined;
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
};

const VALUE_FLAGS = new Set(["listen", "config", "endpoint"]);

export const parseArgs = (argv: ReadonlyArray<string>): ParsedArgs => {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  let subcommand: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) {
      subcommand ??= token;
      continue;
    }
    const body = token.slice(2);
    const equals = body.indexOf("=");
    if (equals > 0) {
      values.set(body.slice(0, equals), body.slice(equals + 1));
      continue;
    }
    const next = argv[index + 1];
    if (VALUE_FLAGS.has(body) && next !== undefined && !next.startsWith("--")) {
      values.set(body, next);
      index += 1;
      continue;
    }
    flags.add(body);
  }
  return { subcommand, values, flags };
};

/**
 * Handles `--help`, printing `usage` to stdout. The container build uses this as
 * its smoke check, so every binary must answer it without side effects.
 */
export const printedHelp = (args: ParsedArgs, usage: string) => {
  if (!args.flags.has("help")) return false;
  process.stdout.write(`${usage}\n`);
  return true;
};

/** Splits `host:port` (the only listen form the server passes) into its parts. */
export const parseListenAddress = (value: string, fallbackPort: number) => {
  const separator = value.lastIndexOf(":");
  if (separator < 0) return { host: value, port: fallbackPort };
  const port = Number(value.slice(separator + 1));
  // Port 0 is accepted so tests can bind an ephemeral port; the bound port is
  // then reported on the stderr listening line.
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error(`invalid listen port in ${value}`);
  return { host: value.slice(0, separator), port };
};
