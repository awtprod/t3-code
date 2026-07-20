// @effect-diagnostics nodeBuiltinImport:off - Pre-commit host process wrapper.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const PINNED_GITLEAKS_VERSION = "8.30.1";
const repositoryRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);
const binary = process.env.COMMAND_CENTER_GITLEAKS_BINARY?.trim() || "gitleaks";

const version = NodeChildProcess.spawnSync(binary, ["version"], {
  cwd: repositoryRoot,
  encoding: "utf8",
});

if (version.error !== undefined) {
  throw new Error(
    `Gitleaks ${PINNED_GITLEAKS_VERSION} is required for commits. Install the pinned release or set COMMAND_CENTER_GITLEAKS_BINARY.`,
    { cause: version.error },
  );
}

const versionOutput = `${version.stdout ?? ""}\n${version.stderr ?? ""}`;
if (
  version.status !== 0 ||
  !new RegExp(`\\b${PINNED_GITLEAKS_VERSION.replaceAll(".", "\\.")}\\b`, "u").test(versionOutput)
) {
  throw new Error(
    `Expected Gitleaks ${PINNED_GITLEAKS_VERSION}; received: ${versionOutput.trim()}`,
  );
}

const scan = NodeChildProcess.spawnSync(binary, ["git", "--staged", "--redact", "--no-banner"], {
  cwd: repositoryRoot,
  stdio: "inherit",
});

if (scan.error !== undefined) throw scan.error;
if (scan.status !== 0) process.exit(scan.status ?? 1);
