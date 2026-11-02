import { Automation } from "@command-center/core";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

/** This is server-owner policy, never an agent or public scheduler option. */
export const OUTREACH = {
  name: "viewhook-outreach-v1",
  controller: "/srv/viewhook/prospector/bin/guarded-campaign/guarded_outreach.py",
  executable: "/usr/bin/python3.12",
  project: "/srv/viewhook/prospector",
  journal: "/var/lib/command-center/outreach-state/viewhook/journal",
  holdParent: "/home/atryan/Documents/Codex/2026-10-11/task-4",
  environmentId: "205eb0f4-e9b7-4949-b5a4-75c3770193d4",
  spaceId: "viewhook",
  repositoryId: "viewhook-prospector",
  sender: "andrew@getviewhook.com",
  uid: 986,
  gid: 984,
  maxAddressSpaceBytes: 8 * 1024 * 1024 * 1024,
} as const;

export const OutreachExecutionProfile = Schema.Struct({
  name: Schema.Literal(OUTREACH.name),
  automationId: Schema.String,
  nodeId: Schema.String,
  definitionDigest: Schema.String,
  snapshotDigest: Schema.String,
  environmentId: Schema.Literal(OUTREACH.environmentId),
  uid: Schema.Literal(OUTREACH.uid),
  gid: Schema.Literal(OUTREACH.gid),
  inputPath: Schema.String,
  credentialReferencePath: Schema.String,
});
export type OutreachExecutionProfile = typeof OutreachExecutionProfile.Type;
export const OUTREACH_PROFILE_KEYS = new Set(Object.keys(OutreachExecutionProfile.fields));

const decodeAutomation = Schema.decodeUnknownExit(Automation);

const exactAbsolutePath = (value: string): boolean =>
  value.startsWith("/") &&
  !value.endsWith("/") &&
  !value
    .split("/")
    .slice(1)
    .some((part) => part === "" || part === "." || part === "..") &&
  !value.includes("\0");

export function outreachProfileIssue(
  profile: OutreachExecutionProfile,
  entry: {
    readonly spaceId?: string;
    readonly repositoryId?: string;
    readonly executable: string;
    readonly argv: ReadonlyArray<string>;
    readonly cwd: string;
    readonly access: string;
    readonly retryable: boolean;
    readonly allowedRoots: ReadonlyArray<{
      readonly canonicalPath: string;
      readonly access: string;
    }>;
  },
): string | undefined {
  if (
    profile.name !== OUTREACH.name ||
    profile.environmentId !== OUTREACH.environmentId ||
    profile.uid !== OUTREACH.uid ||
    profile.gid !== OUTREACH.gid
  )
    return "Invalid protected executor identity.";
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(profile.automationId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(profile.nodeId) ||
    !/^sha256:[a-f0-9]{64}$/u.test(profile.definitionDigest) ||
    !/^sha256:[a-f0-9]{64}$/u.test(profile.snapshotDigest)
  )
    return "Invalid protected job binding.";
  if (
    !exactAbsolutePath(profile.inputPath) ||
    !profile.inputPath.startsWith(`${OUTREACH.journal}/`) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/u.test(
      profile.inputPath.slice(OUTREACH.journal.length + 1),
    )
  )
    return "Input must be one exact journal JSON file.";
  if (
    !exactAbsolutePath(profile.credentialReferencePath) ||
    profile.credentialReferencePath.startsWith(`${OUTREACH.journal}/`) ||
    profile.credentialReferencePath.startsWith("/proc/") ||
    profile.credentialReferencePath.startsWith("/dev/")
  )
    return "Credential reference must be a fixed read-only file outside the journal.";
  if (entry.spaceId !== OUTREACH.spaceId || entry.repositoryId !== OUTREACH.repositoryId)
    return "Outreach requires the fixed ViewHook Space and repository.";
  if (
    entry.executable !== OUTREACH.executable ||
    entry.cwd !== OUTREACH.journal ||
    entry.access !== "write" ||
    entry.retryable ||
    !(entry.argv.length === 6 || (entry.argv.length === 7 && entry.argv[6] === "--execute")) ||
    entry.argv[0] !== "-I" ||
    entry.argv[1] !== "-S" ||
    entry.argv[2] !== "-B" ||
    entry.argv[3] !== OUTREACH.controller ||
    entry.argv[4] !== "--input" ||
    entry.argv[5] !== profile.inputPath ||
    entry.allowedRoots.length !== 1 ||
    entry.allowedRoots[0]?.canonicalPath !== OUTREACH.journal ||
    entry.allowedRoots[0]?.access !== "write"
  )
    return "Outreach permits only the fixed canonical command, journal root and no automatic retries.";
  return undefined;
}

/** Revalidate the durable definition snapshot, not caller-supplied job claims. */
export function outreachCheckpointMatches(
  profile: OutreachExecutionProfile,
  row: {
    readonly automationId: string;
    readonly definitionDigest: string;
    readonly definitionJson: string;
    readonly snapshotDigest: string;
  },
  allowlistId: string,
  spaceId: string,
): boolean {
  if (
    row.automationId !== profile.automationId ||
    row.definitionDigest !== profile.definitionDigest ||
    row.definitionJson.length > 1024 * 1024
  )
    return false;
  // Runtime persists canonical definition JSON; hash that exact snapshot as well as its stored digest.
  if (row.snapshotDigest !== profile.snapshotDigest) return false;
  try {
    const decoded = decodeAutomation(JSON.parse(row.definitionJson));
    if (Exit.isFailure(decoded)) return false;
    const value = decoded.value;
    if (
      value.id !== profile.automationId ||
      value.spaceId !== spaceId ||
      value.enabled !== true ||
      value.definitionDigest !== profile.definitionDigest
    )
      return false;
    return value.nodes.some(
      (node) =>
        node.id === profile.nodeId &&
        node.kind === "shell.scoped" &&
        node.config.allowlistId === allowlistId,
    );
  } catch {
    return false;
  }
}
