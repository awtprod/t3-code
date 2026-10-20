// @effect-diagnostics nodeBuiltinImport:off - Offline owner-operated credential provisioning CLI.
/**
 * Offline CLI for the phone connection secret (same style as
 * `credentials:webhooks:provision`):
 *
 *   pnpm credentials:phone -- set --from-json /absolute/connection.json --base-dir /absolute/runtime
 *   pnpm credentials:phone -- status --base-dir /absolute/runtime
 *
 * `set` validates the JSON with the server's own decoder and writes it
 * atomically to `<base-dir>/userdata/secrets/command-center-phone-connection.bin`
 * (0600, directory 0700). `--from-json -` reads stdin. `status` prints whether
 * a valid connection is stored and the masked numbers; it never prints the API
 * key, the webhook secret, the Twilio credentials, the tool secret, the public
 * URL, or a full phone number.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Option from "effect/Option";

import {
  decodePhoneConnection,
  maskPhoneNumber,
  PHONE_CONNECTION_MAX_BYTES,
  PHONE_CONNECTION_SECRET_NAME,
} from "./PhoneConnection.ts";

const USAGE = `Usage:
  pnpm credentials:phone -- set --from-json <file|-> --base-dir /absolute/runtime
  pnpm credentials:phone -- status --base-dir /absolute/runtime

The JSON is {"apiKey","webhookSecret","agentId","ownerAgentId","phoneNumberId","ownerNumber","ownerName"},
plus "twilio" and "conference" together for conference mode (docs/operations/phone-calls.md)
(numbers in E.164, e.g. +15550100000). It is stored in the server secret store, never in Git.`;

export type PhoneCliCommand =
  | { readonly command: "set"; readonly baseDir: string; readonly source: string }
  | { readonly command: "status"; readonly baseDir: string };

export function argumentsFrom(argv: ReadonlyArray<string>): PhoneCliCommand {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const [command, ...rest] = args;
  let baseDir: string | undefined;
  let source: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (value === undefined) throw new Error(USAGE);
    if (flag === "--base-dir" && baseDir === undefined) baseDir = value;
    else if (flag === "--from-json" && source === undefined && command === "set") source = value;
    else throw new Error(USAGE);
    index += 1;
  }
  if (baseDir === undefined || !NodePath.isAbsolute(baseDir)) throw new Error(USAGE);
  if (command === "status") return { command, baseDir: NodePath.resolve(baseDir) };
  if (command === "set" && source !== undefined) {
    if (source !== "-" && !NodePath.isAbsolute(source)) throw new Error(USAGE);
    return { command, baseDir: NodePath.resolve(baseDir), source };
  }
  throw new Error(USAGE);
}

export const phoneSecretPath = (baseDir: string) =>
  NodePath.join(baseDir, "userdata", "secrets", `${PHONE_CONNECTION_SECRET_NAME}.bin`);

const readBounded = (source: string): Uint8Array => {
  const bytes = NodeFS.readFileSync(source === "-" ? 0 : source);
  if (bytes.byteLength > PHONE_CONNECTION_MAX_BYTES) {
    throw new Error("The phone connection JSON exceeds the byte limit.");
  }
  return Uint8Array.from(bytes);
};

/** Validate and write the secret atomically. Returns whether an entry was replaced. */
export function setPhoneConnection(input: {
  readonly baseDir: string;
  readonly plaintext: Uint8Array;
}): { readonly destination: string; readonly replaced: boolean } {
  if (Option.isNone(decodePhoneConnection(input.plaintext))) {
    throw new Error(
      "The JSON does not match the phone connection shape (see usage); nothing was written.",
    );
  }
  const destination = phoneSecretPath(input.baseDir);
  const secretsDir = NodePath.dirname(destination);
  NodeFS.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  NodeFS.chmodSync(secretsDir, 0o700);
  const replaced = NodeFS.existsSync(destination);
  const temporary = `${destination}.${process.pid}.tmp`;
  const handle = NodeFS.openSync(temporary, "wx", 0o600);
  try {
    NodeFS.writeFileSync(handle, input.plaintext);
    NodeFS.fsyncSync(handle);
  } catch (cause) {
    NodeFS.closeSync(handle);
    NodeFS.rmSync(temporary, { force: true });
    throw cause;
  }
  NodeFS.closeSync(handle);
  NodeFS.chmodSync(temporary, 0o600);
  NodeFS.renameSync(temporary, destination);
  NodeFS.chmodSync(destination, 0o600);
  return { destination, replaced };
}

/** Human-readable status lines. Never includes a secret or a full number. */
export function phoneConnectionStatus(baseDir: string): ReadonlyArray<string> {
  const destination = phoneSecretPath(baseDir);
  if (!NodeFS.existsSync(destination)) {
    return [`Phone connection: not configured (${destination} is absent).`];
  }
  const connection = decodePhoneConnection(Uint8Array.from(NodeFS.readFileSync(destination)));
  if (Option.isNone(connection)) {
    return [`Phone connection: INVALID at ${destination}; run set again.`];
  }
  const mode = NodeFS.statSync(destination).mode & 0o777;
  const value = connection.value;
  return [
    `Phone connection: configured (${destination}, mode ${mode.toString(8)})`,
    `Owner: ${value.ownerName} (${maskPhoneNumber(value.ownerNumber)})`,
    "API key: set (not shown)",
    "Webhook secret: set (not shown)",
    `Third-party agent: ${value.agentId}`,
    `Owner agent: ${value.ownerAgentId}`,
    `Phone number id: ${value.phoneNumberId}`,
    ...(value.twilio === undefined || value.conference === undefined
      ? ["Conference mode: off (third-party calls are ElevenLabs outbound calls)"]
      : [
          "Conference mode: on",
          `Twilio account: AC…${value.twilio.accountSid.slice(-4)} (auth token not shown)`,
          `Agent inbound number: ${maskPhoneNumber(value.conference.inboundNumber)}`,
          `Caller id for callees: ${maskPhoneNumber(value.conference.callerId.callee)}`,
          `Caller id for the owner: ${maskPhoneNumber(value.conference.callerId.owner)}`,
          "Public base URL: set (not shown)",
          "Tool secret: set (not shown)",
        ]),
  ];
}

function main(): void {
  const options = argumentsFrom(process.argv.slice(2));
  if (options.command === "status") {
    process.stdout.write(`${phoneConnectionStatus(options.baseDir).join("\n")}\n`);
    return;
  }
  const result = setPhoneConnection({
    baseDir: options.baseDir,
    plaintext: readBounded(options.source),
  });
  process.stdout.write(
    `${result.replaced ? "Replaced" : "Stored"} the phone connection at ${result.destination}\n`,
  );
}

if (import.meta.main) main();
