/**
 * Settings and pure path helpers for the Windows media picker.
 *
 * The picker browses a remote Windows host (e.g. the editing desktop where
 * Resolve runs) over SSH. Every value here is explicit and absolute: the server
 * process HOME is not the provider HOME that owns the ssh config, so `~` is
 * never expanded.
 *
 * Environment:
 * - `CC_WINDOWS_MEDIA_ENABLED`     "false" disables the picker (default true).
 * - `CC_WINDOWS_MEDIA_SSH_CONFIG`  absolute path passed to `ssh -F`. Required.
 * - `CC_WINDOWS_MEDIA_SSH_ALIAS`   ssh-config Host alias of the Windows box. Required.
 *
 * There are no defaults: the picker stays off until both SSH values are set.
 * - `CC_WINDOWS_MEDIA_ROOTS`       optional `|`-separated allowlist of absolute
 *                                  Windows directories (`|` cannot appear in a
 *                                  Windows path). Unset/empty = every drive.
 *
 * @module WindowsMediaConfig
 */
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

const SSH_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export interface WindowsMediaSettings {
  readonly enabled: boolean;
  readonly sshConfigPath: string;
  readonly hostAlias: string;
  /** Normalized allowlist of browsable roots; null means every drive. */
  readonly roots: ReadonlyArray<string> | null;
}

export class WindowsMediaConfigError extends Error {
  override readonly name = "WindowsMediaConfigError";
}

/**
 * Normalize an absolute Windows path: `/` becomes `\`, repeated separators
 * collapse, the drive letter is upper-cased and trailing separators are dropped
 * (a drive root keeps its separator). Relative paths, `.`/`..` segments, device
 * namespace prefixes, quotes, wildcards and control characters are
 * rejected so an allowlist prefix check cannot be walked out of.
 */
export function normalizeWindowsPath(raw: string): string | null {
  const input = raw.trim().replaceAll("/", "\\");
  if (input.length === 0 || input.length > 4096) return null;
  if (/["*?<>|\u0000-\u001f]/u.test(input)) return null;

  let prefix: string;
  let rest: string;
  const drive = /^([A-Za-z]):(?:\\|$)/u.exec(input);
  if (drive) {
    prefix = `${drive[1]!.toUpperCase()}:\\`;
    rest = input.slice(2);
  } else if (input.startsWith("\\\\")) {
    const unc = input.slice(2);
    if (unc.startsWith("?") || unc.startsWith(".")) return null;
    const [server, share, ...tail] = unc.split("\\").filter((part) => part.length > 0);
    if (!server || !share || server.includes(":") || share.includes(":")) return null;
    prefix = `\\\\${server}\\${share}\\`;
    rest = tail.join("\\");
  } else {
    return null;
  }

  const segments = rest.split("\\").filter((segment) => segment.length > 0);
  for (const segment of segments) {
    if (segment === "." || segment === ".." || segment.includes(":")) return null;
  }
  if (segments.length === 0) {
    // Drive root keeps `X:\`; a UNC share root drops the trailing separator.
    return drive ? prefix : prefix.slice(0, -1);
  }
  return `${prefix}${segments.join("\\")}`;
}

const lower = (value: string) => value.toLowerCase();

/** True for a normalized drive root such as `C:` plus its separator. */
export const isDriveRoot = (path: string): boolean =>
  path.length === 3 && path[1] === ":" && path.endsWith("\\");

/** Case-insensitive "is `path` the root itself or somewhere beneath it". */
export function isWithinRoot(path: string, root: string): boolean {
  const p = lower(path);
  const r = lower(root);
  if (p === r) return true;
  const withSep = r.endsWith("\\") ? r : `${r}\\`;
  return p.startsWith(withSep);
}

export function isPathAllowed(path: string, roots: ReadonlyArray<string> | null): boolean {
  return roots === null || roots.some((root) => isWithinRoot(path, root));
}

/** Join a normalized directory with a single child name. */
export function joinWindowsPath(directory: string, name: string): string {
  return directory.endsWith("\\") ? `${directory}${name}` : `${directory}\\${name}`;
}

/**
 * Parent of a normalized path, or null at a drive root, a UNC share root, or
 * an allowlisted root (the picker never navigates above what it may list).
 */
export function windowsParentPath(
  path: string,
  roots: ReadonlyArray<string> | null,
): string | null {
  if (roots !== null && roots.some((root) => lower(root) === lower(path))) return null;
  if (isDriveRoot(path)) return null;
  const index = path.lastIndexOf("\\");
  if (index < 0) return null;
  const parent = index === 2 && path[1] === ":" ? path.slice(0, 3) : path.slice(0, index);
  if (parent.startsWith("\\\\") && parent.slice(2).split("\\").length < 2) return null;
  if (!isPathAllowed(parent, roots)) return null;
  return parent;
}

export function parseWindowsMediaRoots(raw: string | undefined): ReadonlyArray<string> | null {
  if (raw === undefined || raw.trim().length === 0) return null;
  const roots: string[] = [];
  for (const entry of raw.split("|")) {
    if (entry.trim().length === 0) continue;
    const normalized = normalizeWindowsPath(entry);
    if (normalized === null) {
      throw new WindowsMediaConfigError(
        `CC_WINDOWS_MEDIA_ROOTS entry '${entry.trim()}' is not an absolute Windows path.`,
      );
    }
    roots.push(normalized);
  }
  return roots.length === 0 ? null : roots;
}

export function makeWindowsMediaSettings(input: {
  readonly enabled?: boolean | undefined;
  readonly sshConfigPath?: string | undefined;
  readonly hostAlias?: string | undefined;
  readonly roots?: string | undefined;
}): WindowsMediaSettings {
  const sshConfigPath = input.sshConfigPath?.trim() ?? "";
  const hostAlias = input.hostAlias?.trim() ?? "";
  if (sshConfigPath.length === 0 && hostAlias.length === 0) {
    // Not configured on this server: the picker is simply off.
    return { enabled: false, sshConfigPath: "", hostAlias: "", roots: null };
  }
  if (sshConfigPath.length === 0 || hostAlias.length === 0) {
    throw new WindowsMediaConfigError(
      "Set both CC_WINDOWS_MEDIA_SSH_CONFIG and CC_WINDOWS_MEDIA_SSH_ALIAS to enable the picker.",
    );
  }
  if (!sshConfigPath.startsWith("/")) {
    throw new WindowsMediaConfigError(
      "CC_WINDOWS_MEDIA_SSH_CONFIG must be an absolute path (no ~ expansion).",
    );
  }
  if (!SSH_ALIAS_PATTERN.test(hostAlias)) {
    throw new WindowsMediaConfigError("CC_WINDOWS_MEDIA_SSH_ALIAS is not a valid ssh Host alias.");
  }
  return {
    enabled: input.enabled ?? true,
    sshConfigPath,
    hostAlias,
    roots: parseWindowsMediaRoots(input.roots),
  };
}

const WindowsMediaEnvConfig = Config.all({
  enabled: Config.Boolean("CC_WINDOWS_MEDIA_ENABLED").pipe(Config.option),
  sshConfigPath: Config.String("CC_WINDOWS_MEDIA_SSH_CONFIG").pipe(Config.option),
  hostAlias: Config.String("CC_WINDOWS_MEDIA_SSH_ALIAS").pipe(Config.option),
  roots: Config.String("CC_WINDOWS_MEDIA_ROOTS").pipe(Config.option),
});

/**
 * Read settings from the environment. A malformed value disables the picker
 * (logged) instead of failing server startup.
 */
export const readWindowsMediaSettings: Effect.Effect<WindowsMediaSettings> = Effect.gen(
  function* () {
    const env = yield* WindowsMediaEnvConfig.pipe(Effect.option);
    const values = Option.getOrUndefined(env);
    return yield* Effect.try({
      try: () =>
        makeWindowsMediaSettings({
          enabled: values ? Option.getOrUndefined(values.enabled) : undefined,
          sshConfigPath: values ? Option.getOrUndefined(values.sshConfigPath) : undefined,
          hostAlias: values ? Option.getOrUndefined(values.hostAlias) : undefined,
          roots: values ? Option.getOrUndefined(values.roots) : undefined,
        }),
      catch: (cause) =>
        cause instanceof WindowsMediaConfigError
          ? cause
          : new WindowsMediaConfigError(String(cause)),
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Windows media picker disabled: invalid configuration", {
          cause: cause.message,
        }).pipe(
          Effect.as({
            enabled: false,
            sshConfigPath: "",
            hostAlias: "",
            roots: null,
          } satisfies WindowsMediaSettings),
        ),
      ),
    );
  },
);

const POSIX_SINGLE_QUOTE = /'/gu;
/** Quote one word for a POSIX shell (the agent's Bash tool). */
export const posixShellQuote = (value: string): string =>
  `'${value.replace(POSIX_SINGLE_QUOTE, `'\\''`)}'`;

/**
 * The exact pull command the agent can run. scp addresses the Windows file
 * through OpenSSH's SFTP server, which takes forward-slash drive paths
 * (`C:/...`); the whole `host:path` operand is single-quoted so spaces,
 * `$`, backticks and `;` in Windows file names stay literal in the agent's
 * shell.
 */
export function windowsFileScpCommand(input: {
  readonly sshConfigPath: string;
  readonly host: string;
  readonly path: string;
  readonly destination: string;
}): string {
  const remotePath = input.path.replaceAll("\\", "/");
  return [
    "scp",
    "-F",
    posixShellQuote(input.sshConfigPath),
    posixShellQuote(`${input.host}:${remotePath}`),
    input.destination,
  ].join(" ");
}

/** The prompt line the agent sees for a `windows-file` reference attachment. */
export function windowsFileAttachmentPathLine(input: {
  readonly name: string;
  readonly host: string;
  readonly path: string;
  readonly sshConfigPath: string;
}): string {
  const scp = windowsFileScpCommand({
    sshConfigPath: input.sshConfigPath,
    host: input.host,
    path: input.path,
    destination: "<dest>",
  });
  return (
    `[Referenced Windows file "${input.name}" lives on host ${input.host} at: ${input.path}` +
    ` — it is NOT in the workspace. To edit in DaVinci Resolve, open that Windows path via the davinci-resolve MCP.` +
    ` To work on it locally (e.g. supoclip), copy it first: ${scp}]`
  );
}
