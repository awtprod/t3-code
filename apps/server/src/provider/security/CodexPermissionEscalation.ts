/**
 * Classification for Codex `item/permissions/requestApproval` — the sandbox
 * escalation request.
 *
 * This request is not "may I run this tool". It is "may I widen my sandbox",
 * carrying an arbitrary list of filesystem paths (each read/write/deny) plus a
 * flag that can re-enable network access. The requesting side is the untrusted
 * one, so the decision has to be made on the *requested permissions*, never on
 * which tool happened to trigger them.
 *
 * Two things are derived here:
 *   - `classifyCodexPermissionRequest` — is this escalation read-only, and
 *     which `ProviderRequestKind` should carry it to the client.
 *   - `describeCodexPermissionRequest` — a human-readable summary, because the
 *     persisted approval activity keeps only a `detail` string (the raw params
 *     in `args` are dropped at ingestion), and an approval prompt that cannot
 *     say which paths are being requested is not reviewable.
 */

import type * as EffectCodexSchema from "effect-codex-app-server/schema";
import type { ProviderRequestKind } from "@t3tools/contracts";

/**
 * Kind carried to the client for a prompted sandbox escalation.
 *
 * Fixed rather than derived per request: `ProviderRuntimeIngestion` maps the
 * kind from the canonical request type alone, so a kind that varied per request
 * would disagree between the opened and resolved activities. `file-change` is
 * the conservative choice — any escalation that reaches a prompt can grant
 * writes — and both web and mobile already render it, so the prompt stays
 * answerable without widening `ProviderRequestKind` across every client fold.
 */
export const CODEX_PERMISSION_REQUEST_KIND: ProviderRequestKind = "file-change";

type PermissionParams = EffectCodexSchema.ServerRequest__PermissionsRequestApprovalParams;
type PermissionProfile = EffectCodexSchema.ServerRequest__RequestPermissionProfile;
type FileSystemPath = EffectCodexSchema.ServerRequest__FileSystemPath;

/** Maximum paths named in the summary before it collapses to a count. */
const MAX_SUMMARIZED_PATHS = 4;

export interface CodexPermissionClassification {
  /**
   * True only when every requested grant is a read. Any write, any deny-flip,
   * any legacy `write[]` entry, or any network enable makes this false.
   */
  readonly readOnly: boolean;
  /** True when the request would re-enable network access. */
  readonly network: boolean;
  /** Reasons the request was not classified read-only, for the prompt detail. */
  readonly escalations: ReadonlyArray<string>;
}

function renderFileSystemPath(path: FileSystemPath): string {
  switch (path.type) {
    case "path":
      return path.path;
    case "glob_pattern":
      return path.pattern;
    case "special":
      return path.value.kind === "unknown" ? path.value.path : `<${path.value.kind}>`;
  }
}

/**
 * Classify a requested profile. Absent/null fields are treated as "not
 * requested" rather than as a grant, but an entirely empty profile is still
 * read-only=true — it asks for nothing.
 */
export function classifyCodexPermissionRequest(
  permissions: PermissionProfile,
): CodexPermissionClassification {
  const escalations: string[] = [];
  const fileSystem = permissions.fileSystem ?? undefined;

  const writeEntries = (fileSystem?.entries ?? []).filter((entry) => entry.access === "write");
  if (writeEntries.length > 0) {
    escalations.push(
      `write access to ${writeEntries.map((entry) => renderFileSystemPath(entry.path)).join(", ")}`,
    );
  }

  // `deny` narrows rather than widens, but it still rewrites the sandbox
  // profile, so it is never auto-granted.
  const denyEntries = (fileSystem?.entries ?? []).filter((entry) => entry.access === "deny");
  if (denyEntries.length > 0) {
    escalations.push(
      `sandbox denials for ${denyEntries.map((entry) => renderFileSystemPath(entry.path)).join(", ")}`,
    );
  }

  const legacyWrite = fileSystem?.write ?? [];
  if (legacyWrite.length > 0) {
    escalations.push(`write access to ${legacyWrite.join(", ")}`);
  }

  const network = permissions.network?.enabled === true;
  if (network) {
    escalations.push("network access");
  }

  return {
    readOnly: escalations.length === 0,
    network,
    escalations,
  };
}

function summarizePaths(paths: ReadonlyArray<string>): string | undefined {
  if (paths.length === 0) return undefined;
  if (paths.length <= MAX_SUMMARIZED_PATHS) return paths.join(", ");
  return `${paths.slice(0, MAX_SUMMARIZED_PATHS).join(", ")} (+${paths.length - MAX_SUMMARIZED_PATHS} more)`;
}

/**
 * Build the `detail` string shown on the approval prompt. Always names what is
 * being requested; the reason Codex supplied is appended when present.
 */
export function describeCodexPermissionRequest(params: PermissionParams): string {
  const fileSystem = params.permissions.fileSystem ?? undefined;
  const parts: string[] = [];

  const readPaths = [
    ...(fileSystem?.entries ?? [])
      .filter((entry) => entry.access === "read")
      .map((entry) => renderFileSystemPath(entry.path)),
    ...(fileSystem?.read ?? []),
  ];
  const writePaths = [
    ...(fileSystem?.entries ?? [])
      .filter((entry) => entry.access === "write")
      .map((entry) => renderFileSystemPath(entry.path)),
    ...(fileSystem?.write ?? []),
  ];
  const denyPaths = (fileSystem?.entries ?? [])
    .filter((entry) => entry.access === "deny")
    .map((entry) => renderFileSystemPath(entry.path));

  const writeSummary = summarizePaths(writePaths);
  if (writeSummary) parts.push(`write: ${writeSummary}`);
  const readSummary = summarizePaths(readPaths);
  if (readSummary) parts.push(`read: ${readSummary}`);
  const denySummary = summarizePaths(denyPaths);
  if (denySummary) parts.push(`deny: ${denySummary}`);
  if (params.permissions.network?.enabled === true) parts.push("network access");

  const requested = parts.length > 0 ? parts.join("; ") : "no additional permissions";
  const reason = params.reason?.trim();
  return reason ? `${requested} — ${reason}` : requested;
}
