import { Automation } from "@command-center/core";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

/** Deployment identity and paths belong only in the protected owner manifest. */
export const OUTREACH = {
  name: "canonical-outreach-v1",
  executable: "/usr/bin/python3.12",
  maxAddressSpaceBytes: 8 * 1024 * 1024 * 1024,
} as const;

const BoundedString = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const Identifier = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/u),
);
const Digest = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}(?![\s\S])/u));
const UnixIdentity = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4_294_967_294 }));
export const OutreachExecutionBinding = Schema.Struct({
  project: BoundedString,
  controller: BoundedString,
  journal: BoundedString,
  holdParent: BoundedString,
  environmentId: Schema.String.check(
    Schema.isPattern(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?![\s\S])/u),
  ),
  spaceId: Identifier,
  repositoryId: Identifier,
  uid: UnixIdentity,
  gid: UnixIdentity,
});
export type OutreachExecutionBinding = typeof OutreachExecutionBinding.Type;
export const OutreachExecutionProfile = Schema.Struct({
  name: Schema.Literal(OUTREACH.name),
  binding: OutreachExecutionBinding,
  automationId: Identifier,
  nodeId: Identifier,
  definitionDigest: Digest,
  snapshotDigest: Digest,
  inputPath: BoundedString,
  credentialReferencePath: BoundedString,
});
export type OutreachExecutionProfile = typeof OutreachExecutionProfile.Type;
export const OUTREACH_PROFILE_KEYS = new Set(Object.keys(OutreachExecutionProfile.fields));
export const OUTREACH_BINDING_KEYS = new Set(Object.keys(OutreachExecutionBinding.fields));
const decodeAutomation = Schema.decodeUnknownExit(Automation);
const decodeProfile = Schema.decodeUnknownExit(OutreachExecutionProfile);

const exactAbsolutePath = (value: string): boolean =>
  value.startsWith("/") &&
  value.length <= 4096 &&
  !value.endsWith("/") &&
  value.split("").every((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && code !== 127;
  }) &&
  !value
    .split("/")
    .slice(1)
    .some((part) => part === "" || part === "." || part === "..");
const contains = (parent: string, child: string): boolean =>
  parent === child || child.startsWith(`${parent}/`);
const overlaps = (left: string, right: string): boolean =>
  contains(left, right) || contains(right, left);
const protectedRoots = [
  "/proc",
  "/sys",
  "/dev",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/etc",
  "/run",
  "/tmp",
];
const privateDirectory = (value: string): boolean =>
  exactAbsolutePath(value) &&
  value.split("/").length >= 4 &&
  !protectedRoots.some((root) => contains(root, value));

/** Validate the closed owner policy again at the kernel execution port. */
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
    Exit.isFailure(decodeProfile(profile)) ||
    Object.keys(profile).some((key) => !OUTREACH_PROFILE_KEYS.has(key)) ||
    Object.keys(profile.binding).some((key) => !OUTREACH_BINDING_KEYS.has(key))
  )
    return "Invalid protected execution profile.";
  const binding = profile.binding;
  if (
    ![binding.project, binding.journal, binding.holdParent].every(privateDirectory) ||
    overlaps(binding.project, binding.journal) ||
    overlaps(binding.project, binding.holdParent) ||
    overlaps(binding.journal, binding.holdParent)
  )
    return "Protected directory roles must be canonical, narrow and separate.";
  if (binding.controller !== `${binding.project}/bin/guarded-campaign/guarded_outreach.py`)
    return "The controller must be the canonical entry point inside the protected project.";
  if (
    !exactAbsolutePath(profile.inputPath) ||
    !profile.inputPath.startsWith(`${binding.journal}/`) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/u.test(
      profile.inputPath.slice(binding.journal.length + 1),
    )
  )
    return "Input must be one exact journal JSON file.";
  if (
    !exactAbsolutePath(profile.credentialReferencePath) ||
    protectedRoots.some((root) => contains(root, profile.credentialReferencePath)) ||
    [binding.project, binding.journal, binding.holdParent].some((root) =>
      overlaps(root, profile.credentialReferencePath),
    )
  )
    return "Credential reference must be one separate fixed read-only file.";
  if (entry.spaceId !== binding.spaceId || entry.repositoryId !== binding.repositoryId)
    return "The Space and repository must match the protected owner binding.";
  if (
    entry.executable !== OUTREACH.executable ||
    entry.cwd !== binding.journal ||
    entry.access !== "write" ||
    entry.retryable ||
    !(entry.argv.length === 6 || (entry.argv.length === 7 && entry.argv[6] === "--execute")) ||
    entry.argv[0] !== "-I" ||
    entry.argv[1] !== "-S" ||
    entry.argv[2] !== "-B" ||
    entry.argv[3] !== binding.controller ||
    entry.argv[4] !== "--input" ||
    entry.argv[5] !== profile.inputPath ||
    entry.allowedRoots.length !== 1 ||
    entry.allowedRoots[0]?.canonicalPath !== binding.journal ||
    entry.allowedRoots[0]?.access !== "write"
  )
    return "Only the owner-bound canonical command and journal root are permitted, without automatic retries.";
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
    row.snapshotDigest !== profile.snapshotDigest ||
    row.definitionJson.length > 1024 * 1024 ||
    spaceId !== profile.binding.spaceId
  )
    return false;
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
