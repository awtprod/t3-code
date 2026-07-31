// @effect-diagnostics nodeBuiltinImport:off - Offline owner-operated credential provisioning CLI.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  COMMAND_CENTER_CREDENTIAL_KEY_ENV,
  COMMAND_CENTER_CREDENTIAL_KEY_FILE_ENV,
  decodeCommandCenterCredentialKey,
  encryptCommandCenterCredential,
} from "./CredentialStore.ts";
import {
  COMMAND_CENTER_WEBHOOK_SECRET_NAME,
  isValidCommandCenterWebhookCredentialFile,
} from "./WebhookAdmission.ts";

const MAX_PLAINTEXT_BYTES = 128 * 1024;

function usage(): never {
  throw new Error(`Usage:
  pnpm credentials:webhooks:provision -- --base-dir /absolute/runtime [--replace]

Reads credential JSON from stdin, validates it, and writes only an encrypted owner-readable entry
under the explicit runtime directory. The master key must be supplied through exactly one of
${COMMAND_CENTER_CREDENTIAL_KEY_ENV} or ${COMMAND_CENTER_CREDENTIAL_KEY_FILE_ENV}. Existing entries
are preserved unless --replace is explicitly supplied.`);
}

export function argumentsFrom(argv: readonly string[]): {
  readonly baseDir: string;
  readonly replace: boolean;
} {
  const commandArguments = argv[0] === "--" ? argv.slice(1) : argv;
  let baseDir: string | undefined;
  let replace = false;
  for (let index = 0; index < commandArguments.length; index += 1) {
    const argument = commandArguments[index];
    if (argument === "--replace") {
      replace = true;
      continue;
    }
    if (argument === "--base-dir") {
      if (baseDir !== undefined || commandArguments[index + 1] === undefined) usage();
      baseDir = commandArguments[index + 1];
      index += 1;
      continue;
    }
    usage();
  }
  if (baseDir === undefined || !NodePath.isAbsolute(baseDir)) usage();
  return { baseDir: NodePath.resolve(baseDir), replace };
}

function masterKey(): Uint8Array {
  const inline = process.env[COMMAND_CENTER_CREDENTIAL_KEY_ENV];
  const keyFile = process.env[COMMAND_CENTER_CREDENTIAL_KEY_FILE_ENV];
  if ((inline === undefined) === (keyFile === undefined)) {
    throw new Error("Configure exactly one Command Center credential master-key source.");
  }
  if (inline !== undefined) {
    const decoded = decodeCommandCenterCredentialKey(inline);
    if (decoded === undefined) throw new Error("The Command Center credential key is invalid.");
    return decoded;
  }
  if (!NodePath.isAbsolute(keyFile!)) throw new Error("The credential key file must be absolute.");
  const stat = NodeFS.statSync(keyFile!);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
    throw new Error("The credential key file must be regular and owner-only.");
  }
  const decoded = decodeCommandCenterCredentialKey(NodeFS.readFileSync(keyFile!, "utf8"));
  if (decoded === undefined) throw new Error("The Command Center credential key is invalid.");
  return decoded;
}

function readBoundedStdin(): Uint8Array {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const input = NodeFS.readFileSync(0);
  bytes += input.byteLength;
  if (bytes > MAX_PLAINTEXT_BYTES) throw new Error("Credential input exceeds the byte limit.");
  chunks.push(input);
  return Uint8Array.from(Buffer.concat(chunks));
}

function main(): void {
  const options = argumentsFrom(process.argv.slice(2));
  const plaintext = readBoundedStdin();
  if (!isValidCommandCenterWebhookCredentialFile(plaintext)) {
    throw new Error("Credential input does not match the webhook credential schema.");
  }
  const envelope = encryptCommandCenterCredential({
    name: COMMAND_CENTER_WEBHOOK_SECRET_NAME,
    plaintext,
    key: masterKey(),
  });
  const secretsDir = NodePath.join(options.baseDir, "userdata", "secrets");
  const destination = NodePath.join(secretsDir, `${COMMAND_CENTER_WEBHOOK_SECRET_NAME}.bin`);
  NodeFS.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  NodeFS.chmodSync(secretsDir, 0o700);
  if (!options.replace && NodeFS.existsSync(destination)) {
    throw new Error("The encrypted webhook credential entry already exists.");
  }
  const temporary = `${destination}.${process.pid}.tmp`;
  const handle = NodeFS.openSync(temporary, "wx", 0o600);
  try {
    NodeFS.writeFileSync(handle, envelope);
    NodeFS.fsyncSync(handle);
  } finally {
    NodeFS.closeSync(handle);
  }
  NodeFS.chmodSync(temporary, 0o600);
  NodeFS.renameSync(temporary, destination);
  NodeFS.chmodSync(destination, 0o600);
  process.stdout.write(`Provisioned encrypted webhook credentials at ${destination}\n`);
}

if (import.meta.main) main();
