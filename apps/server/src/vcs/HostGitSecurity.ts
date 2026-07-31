// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

const NULL_DEVICE = NodeProcess.platform === "win32" ? "NUL" : "/dev/null";
const NO_EXECUTABLE_PATH =
  NodeProcess.platform === "win32"
    ? `${NodeProcess.env.SYSTEMROOT ?? "C:\\Windows"}\\System32\\__command_center_no_executables__`
    : "/dev/null";

export const HOST_GIT_HARDENED_CONFIG_ENTRIES = Object.freeze([
  ["core.hooksPath", NULL_DEVICE],
  ["core.fsmonitor", "false"],
  ["core.untrackedCache", "false"],
  ["protocol.ext.allow", "never"],
  ["commit.gpgSign", "false"],
  ["tag.gpgSign", "false"],
  ["log.showSignature", "false"],
  ["core.sshCommand", "ssh"],
] as const);

/**
 * Repository-local metadata is not authority to execute code in the server
 * process. These command-scope values override the local checkout config.
 */
export const HOST_GIT_HARDENED_CONFIG_ARGS = Object.freeze(
  HOST_GIT_HARDENED_CONFIG_ENTRIES.flatMap(([key, value]) => ["-c", `${key}=${value}`]),
);

export type GitSpawningCliKind = "github" | "gitlab" | "azure-devops";

const TRUSTED_GIT_SPAWNING_CLI_ENVIRONMENT_KEYS = {
  github: [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "GH_HOST",
    "GH_CONFIG_DIR",
  ],
  gitlab: [
    "GITLAB_TOKEN",
    "GITLAB_URI",
    "GITLAB_HOST",
    "GITLAB_API_HOST",
    "GLAB_CONFIG_DIR",
    "CI_JOB_TOKEN",
  ],
  "azure-devops": ["AZURE_DEVOPS_EXT_PAT", "AZURE_CONFIG_DIR"],
} as const satisfies Record<GitSpawningCliKind, ReadonlyArray<string>>;

const BASE_ENVIRONMENT_KEYS = [
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "SSH_AUTH_SOCK",
] as const;

const DEFAULT_EXECUTABLE_PATH =
  NodeProcess.platform === "win32"
    ? `${NodeProcess.env.SYSTEMROOT ?? "C:\\Windows"}\\System32`
    : "/usr/local/bin:/usr/bin:/bin";

const NAMESPACE_ROOT_UID = (() => {
  if (NodeProcess.platform !== "linux") return undefined;
  try {
    const currentUid = NodeProcess.getuid?.();
    const overflowUid = Number.parseInt(
      NodeFS.readFileSync("/proc/sys/kernel/overflowuid", "utf8").trim(),
      10,
    );
    const namespaceMapsCurrentToRoot = NodeFS.readFileSync("/proc/self/uid_map", "utf8")
      .trim()
      .split("\n")
      .some((line) => {
        const [inside, outside, length] = line.trim().split(/\s+/u).map(Number);
        return inside === currentUid && outside === 0 && length !== undefined && length > 0;
      });
    return Number.isSafeInteger(overflowUid) &&
      overflowUid !== currentUid &&
      namespaceMapsCurrentToRoot
      ? overflowUid
      : undefined;
  } catch {
    return undefined;
  }
})();

export interface TrustedHostExecutableOptions {
  /** Host paths the scoped provider or worktree process can mutate. */
  readonly writableRoots?: ReadonlyArray<string>;
  /** A trusted host-environment snapshot. Primarily injectable for tests. */
  readonly sourceEnvironment?: NodeJS.ProcessEnv;
}

export interface HardenedHostGitEnvironmentOptions extends TrustedHostExecutableOptions {
  readonly allowIndexFile?: boolean;
}

function canonicalPathOrResolved(path: string): string {
  try {
    return NodeFS.realpathSync.native(path);
  } catch {
    return NodePath.resolve(path);
  }
}

function pathIsWithin(candidate: string, root: string): boolean {
  const normalize = (value: string) =>
    NodeProcess.platform === "win32" ? value.toLowerCase() : value;
  const relative = NodePath.relative(normalize(root), normalize(candidate));
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      !NodePath.isAbsolute(relative))
  );
}

function effectiveWritableRoots(writableRoots: ReadonlyArray<string>): ReadonlyArray<string> {
  const roots = new Set<string>();
  for (const root of writableRoots) {
    if (!NodePath.isAbsolute(root)) continue;
    const canonical = canonicalPathOrResolved(root);
    roots.add(canonical);

    // A command cwd may be nested below the actual writable worktree root.
    // Discover every containing Git checkout without invoking Git (which is the
    // executable boundary being established here).
    let ancestor = canonical;
    const directoryCheckoutRoots: Array<string> = [];
    const linkedWorktreeRoots: Array<string> = [];
    for (;;) {
      try {
        const dotGit = NodeFS.lstatSync(NodePath.join(ancestor, ".git"));
        if (dotGit.isFile()) {
          linkedWorktreeRoots.push(canonicalPathOrResolved(ancestor));
        } else if (dotGit.isDirectory()) {
          const ancestorInfo = NodeFS.statSync(ancestor);
          // Ignore ambient temp roots such as /tmp/.git. Every ordinary
          // containing checkout is retained so a nearer provider-created fake
          // .git directory cannot hide the actual primary checkout root.
          const stickyWorldWritable =
            NodeProcess.platform !== "win32" &&
            (ancestorInfo.mode & 0o1000) !== 0 &&
            (ancestorInfo.mode & 0o002) !== 0;
          if (!stickyWorldWritable) directoryCheckoutRoots.push(canonicalPathOrResolved(ancestor));
        }
      } catch {
        // This ancestor is not a checkout root.
      }
      const parent = NodePath.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    for (const checkoutRoot of [...linkedWorktreeRoots, ...directoryCheckoutRoots]) {
      roots.add(checkoutRoot);
    }
  }
  return [...roots];
}

function trustedHostOwnership(info: NodeFS.Stats): boolean {
  if (NodeProcess.platform === "win32") return true;
  const uid = NodeProcess.getuid?.();
  return (
    uid === undefined ||
    info.uid === 0 ||
    info.uid === uid ||
    (NAMESPACE_ROOT_UID !== undefined && info.uid === NAMESPACE_ROOT_UID)
  );
}

function trustedHostMode(info: NodeFS.Stats): boolean {
  return NodeProcess.platform === "win32" || (info.mode & 0o022) === 0;
}

function trustedHostDirectoryChain(directory: string): boolean {
  let current = directory;
  let systemOwnerUid: number | undefined;
  for (;;) {
    let info: NodeFS.Stats;
    try {
      info = NodeFS.statSync(current);
      if (!info.isDirectory() || !trustedHostOwnership(info) || !trustedHostMode(info)) {
        return false;
      }
      if (systemOwnerUid === undefined && (info.uid === 0 || info.uid === NAMESPACE_ROOT_UID)) {
        systemOwnerUid = info.uid;
      }
      if (systemOwnerUid !== undefined && info.uid !== systemOwnerUid) return false;
    } catch {
      return false;
    }
    // An owner-only ancestor is a sufficient trust barrier. This permits test
    // and runtime-owned trees below a sticky temp parent without treating
    // arbitrary sibling entries in that temp directory as trusted.
    if (NodeProcess.platform !== "win32" && (info.mode & 0o077) === 0) return true;
    const parent = NodePath.dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

function safeExecutableDirectories(
  options: TrustedHostExecutableOptions = {},
): ReadonlyArray<string> {
  const sourceEnvironment = options.sourceEnvironment ?? NodeProcess.env;
  const pathValue = readEnvironment(sourceEnvironment, "PATH") ?? DEFAULT_EXECUTABLE_PATH;
  const writableRoots = effectiveWritableRoots(options.writableRoots ?? []);
  const directories: Array<string> = [];
  const seen = new Set<string>();

  for (const entry of pathValue.split(NodePath.delimiter)) {
    // Empty and relative entries resolve against the command cwd and are never
    // valid at this host boundary.
    if (entry.length === 0 || !NodePath.isAbsolute(entry)) continue;
    let canonical: string;
    try {
      canonical = NodeFS.realpathSync.native(entry);
      if (!trustedHostDirectoryChain(canonical)) continue;
    } catch {
      continue;
    }
    if (writableRoots.some((root) => pathIsWithin(canonical, root))) continue;
    const key = NodeProcess.platform === "win32" ? canonical.toLowerCase() : canonical;
    if (seen.has(key)) continue;
    seen.add(key);
    directories.push(canonical);
  }

  return directories;
}

/**
 * Return a canonical absolute executable selected only from trusted absolute
 * PATH directories outside provider/worktree-writable roots. A relative or
 * writable-root executable is rejected even when it appears first on PATH.
 */
export function resolveTrustedHostExecutable(
  command: string,
  options: TrustedHostExecutableOptions = {},
): string | undefined {
  const writableRoots = effectiveWritableRoots(options.writableRoots ?? []);
  const candidates: Array<string> = [];
  if (NodePath.basename(command) === command) {
    const extensions =
      NodeProcess.platform === "win32"
        ? NodePath.extname(command).length > 0
          ? [""]
          : (
              readEnvironment(options.sourceEnvironment ?? NodeProcess.env, "PATHEXT") ??
              ".COM;.EXE;.BAT;.CMD"
            )
              .split(";")
              .filter((extension) => extension.length > 0)
        : [""];
    for (const directory of safeExecutableDirectories(options)) {
      for (const extension of extensions) {
        candidates.push(NodePath.join(directory, `${command}${extension}`));
      }
    }
  } else {
    return undefined;
  }

  for (const candidate of candidates) {
    try {
      const canonical = NodeFS.realpathSync.native(candidate);
      const stat = NodeFS.statSync(canonical);
      const parent = NodeFS.statSync(NodePath.dirname(canonical));
      if (
        !stat.isFile() ||
        !trustedHostOwnership(stat) ||
        !trustedHostMode(stat) ||
        (NodeProcess.platform !== "win32" && stat.uid !== parent.uid) ||
        (NodeProcess.platform !== "win32" && stat.nlink !== 1)
      ) {
        continue;
      }
      NodeFS.accessSync(canonical, NodeFS.constants.X_OK);
      if (writableRoots.some((root) => pathIsWithin(canonical, root))) continue;
      return canonical;
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Exact canonical PATH suitable for pinned host tools and any child Git. */
export function trustedHostExecutablePath(options: TrustedHostExecutableOptions = {}): string {
  return safeExecutableDirectories(options).join(NodePath.delimiter);
}

function trustedHostExecutablePathWithPinnedGit(
  options: TrustedHostExecutableOptions = {},
): string {
  const directories = [...safeExecutableDirectories(options)];
  const git = resolveTrustedHostExecutable("git", options);
  if (git === undefined) return NO_EXECUTABLE_PATH;
  const gitDirectory = NodePath.dirname(git);
  return [gitDirectory, ...directories.filter((directory) => directory !== gitDirectory)].join(
    NodePath.delimiter,
  );
}

function trustedConnectorConfigDirectory(
  value: string,
  options: TrustedHostExecutableOptions,
): boolean {
  if (!NodePath.isAbsolute(value)) return false;
  const writableRoots = effectiveWritableRoots(options.writableRoots ?? []);
  const lexical = NodePath.resolve(value);
  if (writableRoots.some((root) => pathIsWithin(lexical, root))) return false;
  try {
    const canonical = NodeFS.realpathSync.native(value);
    const info = NodeFS.statSync(canonical);
    return (
      info.isDirectory() &&
      trustedHostDirectoryChain(canonical) &&
      !writableRoots.some((root) => pathIsWithin(canonical, root))
    );
  } catch {
    return false;
  }
}

const TRUSTED_OVERRIDE_KEYS = [
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_DATE",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_DATE",
  "GIT_TRACE2_EVENT",
] as const;

function readEnvironment(source: NodeJS.ProcessEnv, key: string): string | undefined {
  const direct = source[key];
  if (direct !== undefined) return direct;
  return Object.entries(source).find(
    ([candidate, value]) => value !== undefined && candidate.toUpperCase() === key,
  )?.[1];
}

/** Build an exact environment; inherited Git execution/location controls never survive. */
export function hardenedHostGitEnvironment(
  trustedOverrides: ReadonlyArray<NodeJS.ProcessEnv | undefined> = [],
  options: HardenedHostGitEnvironmentOptions = {},
): NodeJS.ProcessEnv {
  const sourceEnvironment = options.sourceEnvironment ?? NodeProcess.env;
  const environment: NodeJS.ProcessEnv = {};
  for (const key of BASE_ENVIRONMENT_KEYS) {
    const value = readEnvironment(sourceEnvironment, key);
    if (value !== undefined) environment[key] = value;
  }
  environment.PATH = trustedHostExecutablePathWithPinnedGit(options);
  for (const source of trustedOverrides) {
    if (source === undefined) continue;
    for (const key of TRUSTED_OVERRIDE_KEYS) {
      const value = readEnvironment(source, key);
      if (value !== undefined) environment[key] = value;
    }
    if (options.allowIndexFile) {
      const indexFile = readEnvironment(source, "GIT_INDEX_FILE");
      if (indexFile !== undefined) environment.GIT_INDEX_FILE = indexFile;
    }
  }
  return {
    ...environment,
    LANG: environment.LANG ?? "C.UTF-8",
    LC_ALL: environment.LC_ALL ?? "C.UTF-8",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: NULL_DEVICE,
    GIT_CONFIG_SYSTEM: NULL_DEVICE,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ASKPASS: "true",
    GIT_EDITOR: "true",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_SEQUENCE_EDITOR: "true",
    GIT_SSH_COMMAND: `ssh -F ${NULL_DEVICE}`,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    SSH_ASKPASS: "true",
    SSH_ASKPASS_REQUIRE: "force",
  };
}

export function hardenedHostGitArguments(args: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...HOST_GIT_HARDENED_CONFIG_ARGS, ...args];
}

/**
 * Git 2.36 is the minimum authoring version: older releases do not support the
 * fsync controls used for durable publication, and old 2.35 releases can treat
 * `core.fsmonitor=false` as an executable hook path.
 */
export function supportsHardenedHostGitAuthoring(versionOutput: string): boolean {
  const match = /\bgit version (\d+)\.(\d+)(?:\.(\d+))?/iu.exec(versionOutput.trim());
  if (match?.[1] === undefined || match[2] === undefined) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 2 || (major === 2 && minor >= 36);
}

/**
 * Build the exact environment for a connector CLI command that launches Git.
 * Only the connector's documented authentication/configuration variables are
 * copied; child Git receives the same command-scope policy as direct Git.
 */
export function hardenedGitSpawningCliEnvironment(
  connector: GitSpawningCliKind,
  trustedSources: ReadonlyArray<NodeJS.ProcessEnv | undefined> = [NodeProcess.env],
  options: TrustedHostExecutableOptions = {},
): NodeJS.ProcessEnv {
  const environment = hardenedHostGitEnvironment([], options);
  for (const source of trustedSources) {
    if (source === undefined) continue;
    for (const key of TRUSTED_GIT_SPAWNING_CLI_ENVIRONMENT_KEYS[connector]) {
      const value = readEnvironment(source, key);
      if (value === undefined) continue;
      if (
        ["GH_CONFIG_DIR", "GLAB_CONFIG_DIR", "AZURE_CONFIG_DIR"].includes(key) &&
        !trustedConnectorConfigDirectory(value, options)
      ) {
        continue;
      }
      environment[key] = value;
    }
  }
  environment.GIT_CONFIG_COUNT = String(HOST_GIT_HARDENED_CONFIG_ENTRIES.length);
  for (const [index, [key, value]] of HOST_GIT_HARDENED_CONFIG_ENTRIES.entries()) {
    environment[`GIT_CONFIG_KEY_${index}`] = key;
    environment[`GIT_CONFIG_VALUE_${index}`] = value;
  }
  return environment;
}

const UNSAFE_CORE_CONFIG_VARIABLES = new Set([
  "alternaterefscommand",
  "askpass",
  "editor",
  "fsmonitor",
  "gitproxy",
  "hookspath",
  "pager",
  "sshcommand",
]);

function hasUnescapedTrailingBackslash(value: string): boolean {
  let count = 0;
  for (let index = value.length - 1; index >= 0 && value[index] === "\\"; index -= 1) {
    count += 1;
  }
  return count % 2 === 1;
}

function executableConfigKey(section: string, variable: string, value: string): string | undefined {
  if ((section === "include" || section === "includeif") && variable === "path") {
    return `${section}.path`;
  }
  if (section === "core" && UNSAFE_CORE_CONFIG_VARIABLES.has(variable)) {
    return `core.${variable}`;
  }
  if (section === "filter" && ["clean", "smudge", "process"].includes(variable)) {
    return `filter.*.${variable}`;
  }
  if (section === "diff" && ["command", "external", "textconv"].includes(variable)) {
    return `diff.*.${variable}`;
  }
  if (section === "merge" && variable === "driver") return "merge.*.driver";
  if (section === "credential" && variable === "helper") return "credential.*.helper";
  if (section === "gpg" && variable === "program") return "gpg.*.program";
  if (section === "sequence" && variable === "editor") return "sequence.editor";
  if (section === "interactive" && variable === "difffilter") {
    return "interactive.diffFilter";
  }
  if (section === "remote" && ["receivepack", "uploadpack", "vcs"].includes(variable)) {
    return `remote.*.${variable}`;
  }
  if (section === "difftool" && variable === "cmd") return "difftool.*.cmd";
  if (section === "mergetool" && variable === "cmd") return "mergetool.*.cmd";
  if (section === "tar" && variable === "command") return "tar.*.command";
  if (section === "submodule" && variable === "update") {
    const normalized = value.trim().replace(/^"/u, "");
    if (normalized.startsWith("!")) return "submodule.*.update";
  }
  return undefined;
}

/**
 * Return the first local Git config key capable of selecting or launching an
 * executable callback. Includes are rejected instead of recursively trusting
 * configuration outside the identity-pinned metadata directory. Malformed
 * local configuration also fails closed.
 */
export function unsafeHostGitConfigKey(contents: string): string | undefined {
  const lines = contents.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  let section: string | undefined;
  let continuingValue = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (continuingValue) {
      continuingValue = hasUnescapedTrailingBackslash(rawLine);
      continue;
    }
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue;

    if (line.startsWith("[")) {
      const closingBracket = line.lastIndexOf("]");
      if (closingBracket < 2) return "<malformed>";
      const trailing = line.slice(closingBracket + 1).trim();
      if (trailing.length > 0 && !trailing.startsWith("#") && !trailing.startsWith(";")) {
        return "<malformed>";
      }
      const sectionBody = line.slice(1, closingBracket).trim();
      const sectionMatch = /^([A-Za-z0-9][A-Za-z0-9-]*)(?:\s|\.|$)/u.exec(sectionBody);
      if (sectionMatch?.[1] === undefined) return "<malformed>";
      section = sectionMatch[1].toLowerCase();
      continue;
    }

    if (section === undefined) return "<malformed>";
    const equalsIndex = line.indexOf("=");
    const variableText = (equalsIndex < 0 ? line : line.slice(0, equalsIndex)).trim();
    const variableMatch = /^([A-Za-z][A-Za-z0-9-]*)$/u.exec(variableText);
    if (variableMatch?.[1] === undefined) return "<malformed>";
    const variable = variableMatch[1].toLowerCase();
    const value = equalsIndex < 0 ? "" : line.slice(equalsIndex + 1).trim();
    const unsafeKey = executableConfigKey(section, variable, value);
    if (unsafeKey !== undefined) return unsafeKey;
    continuingValue = hasUnescapedTrailingBackslash(rawLine);
  }

  return continuingValue ? "<malformed>" : undefined;
}
