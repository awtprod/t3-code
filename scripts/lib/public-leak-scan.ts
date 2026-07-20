// @effect-diagnostics nodeBuiltinImport:off - Repository safety runs before the application runtime.
import * as NodePath from "node:path";
import * as NodeNet from "node:net";
import * as NodeURL from "node:url";

export interface PublicLeakFinding {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly rule: string;
  readonly message: string;
  readonly revision?: string;
}

interface ContentRule {
  readonly id: string;
  readonly message: string;
  readonly pattern: RegExp;
}

export function parseAddedLineNumbers(patch: string): ReadonlySet<number> {
  const added = new Set<number>();
  let nextLine: number | null = null;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
    if (hunk !== null) {
      nextLine = Number(hunk[1]);
      continue;
    }
    if (nextLine === null || line.startsWith("\\ No newline")) continue;
    if (line.startsWith("+")) {
      added.add(nextLine);
      nextLine += 1;
    } else if (!line.startsWith("-")) {
      nextLine += 1;
    }
  }
  return added;
}

const CONTENT_RULES: readonly ContentRule[] = [
  {
    id: "private-key",
    message: "Private key material is not allowed in the public repository.",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/gu,
  },
  {
    id: "github-token",
    message: "A GitHub credential-shaped value is not allowed in the public repository.",
    pattern: /\b(?:gh[opusr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/gu,
  },
  {
    id: "cloud-access-key",
    message: "A cloud access-key-shaped value is not allowed in the public repository.",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
  },
  {
    id: "google-client-secret",
    message: "A Google client-secret-shaped value is not allowed in the public repository.",
    pattern: /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/gu,
  },
  {
    id: "slack-token",
    message: "A Slack credential-shaped value is not allowed in the public repository.",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/gu,
  },
  {
    id: "account-address",
    message: "Account addresses must be replaced with a reserved example domain.",
    pattern:
      /(?<![A-Za-z0-9.!#$%&'*+/=?^_~-])[A-Za-z0-9.!#$%&'*+/=?^_~-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?![A-Za-z0-9-])/gu,
  },
  {
    id: "posix-home-path",
    message: "Absolute home-directory paths must be replaced with portable placeholders.",
    pattern: /(?<![A-Za-z0-9:])\/(?:home|Users)\/[A-Za-z0-9._ -]+(?:\/|$)/gu,
  },
  {
    id: "root-home-path",
    message: "Absolute root home-directory paths must be replaced with portable placeholders.",
    pattern: /(?<![A-Za-z0-9:])\/(?:root|var\/root)(?:\/|$)/gu,
  },
  {
    id: "windows-home-path",
    message: "Absolute home-directory paths must be replaced with portable placeholders.",
    pattern: /\b[A-Za-z]:[\\/]Users[\\/][A-Za-z0-9._ -]+(?:[\\/]|$)/gu,
  },
  {
    id: "windows-absolute-path",
    message: "Absolute Windows paths must be replaced with portable placeholders.",
    pattern: /(?<![A-Za-z0-9])[A-Za-z]:[\\/](?![\\/])[^\\/\r\n"'<>|?*]+[\\/][^\\/\r\n"'<>|?*]+/gu,
  },
  {
    id: "windows-unc-path",
    message: "Absolute Windows network paths must be replaced with portable placeholders.",
    pattern:
      /(?<![\\])(?:\\\\){1,2}[^\\/\r\n"'<>|?*]+[\\/][^\\/\r\n"'<>|?*]+(?:[\\/][^\\/\r\n"'<>|?*]+)?/gu,
  },
];

const ABSOLUTE_URL_PATTERN = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"'`]+/gu;
const SCP_GIT_REMOTE_PATTERN =
  /(?<![\p{L}\p{N}._+-])git@(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):[^\s<>"'`]+/giu;
const NETWORK_URL_SCHEMES = new Set([
  "amqp",
  "amqps",
  "ftp",
  "ftps",
  "git",
  "grpc",
  "grpcs",
  "http",
  "https",
  "imap",
  "imaps",
  "mariadb",
  "mongodb",
  "mongodb+srv",
  "mysql",
  "nats",
  "pop3",
  "pop3s",
  "postgres",
  "postgresql",
  "redis",
  "rediss",
  "smtp",
  "smtps",
  "ssh",
  "ws",
  "wss",
]);
const PRIVATE_DNS_SUFFIXES = [
  ".cluster.local",
  ".home.arpa",
  ".internal",
  ".intranet",
  ".private",
  ".local",
  ".corp",
  ".home",
  ".lan",
  ".svc",
] as const;
const RESERVED_DOCUMENTATION_HOSTS = new Set(["example.com", "example.net", "example.org"]);
const PLACEHOLDER_TAILNET_HOSTS = new Set(["example-tailnet.ts.net", "example.ts.net"]);

const FORBIDDEN_FILE_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)\.env(?:\..+)?$/iu,
  /\.(?:accdb|db|db3|duckdb|mdb|rdb|realm|sqlite|sqlite3)(?:[.-].+)?$/iu,
  /\.(?:jsonl|log|ndjson)(?:[.-].+)?$/iu,
  /\.(?:pem|key|p12|pfx|mobileprovision)$/iu,
  /(?:^|\/)transcripts?(?:\/|$)/iu,
  /(?:^|\/)[^/]*\.transcript(?:\.(?:json|jsonl|log|md|ndjson|txt))?(?:[.-].+)?$/iu,
];

const RESERVED_EMAIL_SUFFIXES = ["@example.com", "@example.net", "@example.org", "@example.test"];
const PUBLIC_GIT_SSH_USERS = new Set(["git@bitbucket.org", "git@github.com", "git@gitlab.com"]);

export function parsePrivateDenylist(value: string | undefined): readonly string[] {
  if (!value) return [];
  return [
    ...new Set(
      value
        .split(/[\n,]/u)
        .map((term) => term.trim())
        .filter((term) => term.length >= 3),
    ),
  ];
}

export function scanPublicPath(
  path: string,
  denylist: readonly string[] = [],
): readonly PublicLeakFinding[] {
  const normalizedPath = normalizePath(path);
  const identifierPath = normalizedPath.replace(/[-_./]+/gu, " ");
  const containsPrivateIdentifier = [normalizedPath, identifierPath].some(
    (candidate) =>
      scanPrivateDenylistText({ path: normalizedPath, text: candidate, denylist }).length > 0,
  );
  const findings: PublicLeakFinding[] = containsPrivateIdentifier
    ? [
        {
          path: normalizedPath,
          line: 1,
          column: 1,
          rule: "private-denylist",
          message: "An operator-defined private identifier is not allowed in a public path.",
        },
      ]
    : [];
  if (NodePath.posix.basename(normalizedPath) === ".env.example") return findings;

  if (FORBIDDEN_FILE_PATTERNS.some((pattern) => pattern.test(normalizedPath))) {
    findings.push({
      path: normalizedPath,
      line: 1,
      column: 1,
      rule: "sensitive-file",
      message:
        "Runtime, credential, or environment files are not allowed in the public repository.",
    });
  }
  return findings;
}

const REVIEWABLE_BINARY_FILE_PATTERN = /\.(?:avif|gif|icns|ico|jpe?g|otf|png|ttf|webp|woff2?)$/iu;

export function isReviewablePublicBinary(path: string): boolean {
  return REVIEWABLE_BINARY_FILE_PATTERN.test(normalizePath(path));
}

/** Extract human-readable metadata without treating compressed payload bytes as trusted text. */
export function extractPublicBinaryMetadata(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("utf8")
    .replace(/[^\p{L}\p{N}\p{P}\p{Z}\t\r\n]+/gu, "\n");
}

export function makePublicBlobFinding(input: {
  readonly path: string;
  readonly rule: "oversized-file" | "unreviewed-binary";
  readonly message: string;
  readonly revision?: string;
}): PublicLeakFinding {
  return {
    path: normalizePath(input.path),
    line: 1,
    column: 1,
    rule: input.rule,
    message: input.message,
    ...(input.revision === undefined ? {} : { revision: input.revision }),
  };
}

export function scanPublicText({
  path,
  text,
  denylist = [],
}: {
  readonly path: string;
  readonly text: string;
  readonly denylist?: readonly string[];
}): readonly PublicLeakFinding[] {
  const findings: PublicLeakFinding[] = [];

  for (const rule of CONTENT_RULES) {
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      if (
        rule.id === "account-address" &&
        (isReservedExampleAddress(match[0]) || isScpGitRemoteAccount(text, match.index, match[0]))
      ) {
        continue;
      }
      findings.push(makeFinding(path, text, match.index, rule.id, rule.message));
    }
  }

  findings.push(...scanPrivateUrls(path, text));
  findings.push(...scanPrivateScpGitRemotes(path, text));

  findings.push(...scanPrivateDenylistText({ path, text, denylist }));

  return findings;
}

export function scanPrivateDenylistText({
  path,
  text,
  denylist,
}: {
  readonly path: string;
  readonly text: string;
  readonly denylist: readonly string[];
}): readonly PublicLeakFinding[] {
  const findings: PublicLeakFinding[] = [];
  const lowerText = text.toLocaleLowerCase("en-US");
  for (const term of denylist) {
    const lowerTerm = term.toLocaleLowerCase("en-US");
    let index = lowerText.indexOf(lowerTerm);
    while (index !== -1) {
      if (hasIdentifierBoundaries(lowerText, index, lowerTerm)) {
        findings.push(
          makeFinding(
            path,
            text,
            index,
            "private-denylist",
            "An operator-defined private identifier is not allowed in the public repository.",
          ),
        );
      }
      index = lowerText.indexOf(lowerTerm, index + lowerTerm.length);
    }
  }

  return findings;
}

function hasIdentifierBoundaries(text: string, index: number, term: string) {
  if (!/^[\p{L}\p{N}_]/u.test(term) || !/[\p{L}\p{N}_]$/u.test(term)) return true;
  const before = index === 0 ? "" : (text[index - 1] ?? "");
  const after = text[index + term.length] ?? "";
  return !/[\p{L}\p{N}_]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after);
}

export function scanPublicAddedText({
  path,
  text,
  patch,
  denylist = [],
  revision,
  denylistOnly = false,
}: {
  readonly path: string;
  readonly text: string;
  readonly patch: string;
  readonly denylist?: readonly string[];
  readonly revision?: string;
  readonly denylistOnly?: boolean;
}): readonly PublicLeakFinding[] {
  const addedLines = parseAddedLineNumbers(patch);
  const findings = denylistOnly
    ? [
        ...scanPrivateUrls(path, text),
        ...scanPrivateScpGitRemotes(path, text),
        ...scanPrivateDenylistText({ path, text, denylist }),
      ]
    : scanPublicText({ path, text, denylist });

  return findings
    .filter((finding) => addedLines.has(finding.line))
    .map((finding) => (revision === undefined ? finding : { ...finding, revision }));
}

function scanPrivateScpGitRemotes(path: string, text: string): readonly PublicLeakFinding[] {
  const findings: PublicLeakFinding[] = [];
  SCP_GIT_REMOTE_PATTERN.lastIndex = 0;

  for (const match of text.matchAll(SCP_GIT_REMOTE_PATTERN)) {
    const hostname = match[1];
    if (hostname === undefined || !isPrivateUrlHost(hostname)) continue;
    findings.push(
      makeFinding(
        path,
        text,
        match.index,
        "private-git-remote",
        "Git remotes using private network hosts are not allowed in the public repository.",
      ),
    );
  }

  return findings;
}

function isScpGitRemoteAccount(text: string, index: number, account: string): boolean {
  if (!account.toLocaleLowerCase("en-US").startsWith("git@")) return false;
  const pathStart = index + account.length;
  return text[pathStart] === ":" && /^[^\s<>"'`]+/u.test(text.slice(pathStart + 1));
}

function scanPrivateUrls(path: string, text: string): readonly PublicLeakFinding[] {
  const findings: PublicLeakFinding[] = [];
  ABSOLUTE_URL_PATTERN.lastIndex = 0;

  for (const match of text.matchAll(ABSOLUTE_URL_PATTERN)) {
    const parsed = parseAbsoluteUrl(match[0]);
    if (parsed === undefined) continue;
    const scheme = parsed.protocol.slice(0, -1).toLocaleLowerCase("en-US");
    const hasSensitiveUserInfo = isSensitiveUrlUserInfo(parsed, scheme);
    if (!hasSensitiveUserInfo && !NETWORK_URL_SCHEMES.has(scheme)) continue;
    if (!hasSensitiveUserInfo && !isPrivateUrlHost(parsed.hostname)) continue;

    findings.push(
      makeFinding(
        path,
        text,
        match.index,
        "private-url",
        "Private network URLs and URLs containing user information are not allowed in the public repository.",
      ),
    );
  }

  return findings;
}

function isSensitiveUrlUserInfo(parsed: NodeURL.URL, scheme: string): boolean {
  if (parsed.username.length === 0 && parsed.password.length === 0) return false;
  return !(
    parsed.username === "git" &&
    parsed.password.length === 0 &&
    (scheme === "git" || scheme === "ssh")
  );
}

function parseAbsoluteUrl(raw: string): NodeURL.URL | undefined {
  let candidate = raw;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const parsed = new NodeURL.URL(candidate);
      const hostname = parsed.hostname;
      if (hostname.startsWith("[") || !/[),;!?}\]]$/u.test(hostname)) {
        return parsed;
      }
    } catch {
      // Markdown and prose punctuation may be adjacent to a URL.
    }

    if (!/[),;!?}\]]$/u.test(candidate)) return undefined;
    candidate = candidate.slice(0, -1);
  }
  return undefined;
}

function isPrivateUrlHost(rawHostname: string): boolean {
  const hostname = normalizeUrlHostname(rawHostname);
  if (hostname.length === 0 || isReservedPublicHost(hostname)) return false;

  const ipVersion = NodeNet.isIP(hostname);
  if (ipVersion === 4) return isPrivateIpv4(hostname);
  if (ipVersion === 6) return isPrivateIpv6(hostname);

  if (hostname === "ts.net" || hostname.endsWith(".ts.net")) {
    return !PLACEHOLDER_TAILNET_HOSTS.has(hostname);
  }
  if (PRIVATE_DNS_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return true;

  // Network URLs with a single-label host are local/private by definition.
  return !hostname.includes(".");
}

function normalizeUrlHostname(value: string): string {
  let hostname = value.toLocaleLowerCase("en-US");
  if (hostname.startsWith("[") && hostname.endsWith("]")) hostname = hostname.slice(1, -1);
  return hostname.replace(/\.+$/u, "");
}

function isReservedPublicHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (
    hostname === "example" ||
    hostname.endsWith(".example") ||
    hostname === "invalid" ||
    hostname.endsWith(".invalid") ||
    hostname === "test" ||
    hostname.endsWith(".test")
  ) {
    return true;
  }
  if (
    [...RESERVED_DOCUMENTATION_HOSTS].some(
      (reserved) => hostname === reserved || hostname.endsWith(`.${reserved}`),
    )
  ) {
    return true;
  }

  if (NodeNet.isIP(hostname) === 4) {
    const [first, second, third] = parseIpv4(hostname);
    return (
      first === 127 ||
      (first === 192 && second === 0 && third === 2) ||
      (first === 198 && second === 51 && third === 100) ||
      (first === 203 && second === 0 && third === 113)
    );
  }
  if (NodeNet.isIP(hostname) === 6) {
    return hostname === "::1" || isDocumentationIpv6(hostname);
  }

  return false;
}

function isPrivateIpv4(hostname: string): boolean {
  const [first, second] = parseIpv4(hostname);
  return (
    first === 10 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function parseIpv4(hostname: string): readonly [number, number, number, number] {
  const parts = hostname.split(".").map(Number);
  return [parts[0] ?? -1, parts[1] ?? -1, parts[2] ?? -1, parts[3] ?? -1];
}

function isPrivateIpv6(hostname: string): boolean {
  const firstHextet = Number.parseInt(hostname.split(":", 1)[0] ?? "", 16);
  if (
    (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) ||
    (firstHextet >= 0xfe80 && firstHextet <= 0xfebf)
  ) {
    return true;
  }

  const mapped = ipv4MappedAddress(hostname);
  return mapped === undefined ? false : isPrivateIpv4(mapped);
}

function isDocumentationIpv6(hostname: string): boolean {
  const [first = "", second = ""] = hostname.split(":");
  return Number.parseInt(first, 16) === 0x2001 && Number.parseInt(second, 16) === 0x0db8;
}

function ipv4MappedAddress(hostname: string): string | undefined {
  const mapped = /^(?:::ffff:|0:0:0:0:0:ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/iu.exec(hostname);
  if (mapped === null) return undefined;
  const high = Number.parseInt(mapped[1] ?? "", 16);
  const low = Number.parseInt(mapped[2] ?? "", 16);
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join(".");
}

function makeFinding(
  path: string,
  text: string,
  index: number,
  rule: string,
  message: string,
): PublicLeakFinding {
  const prefix = text.slice(0, index);
  const lines = prefix.split("\n");
  return {
    path: normalizePath(path),
    line: lines.length,
    column: (lines.at(-1)?.length ?? 0) + 1,
    rule,
    message,
  };
}

function isReservedExampleAddress(value: string) {
  const lower = value.toLocaleLowerCase("en-US");
  return (
    PUBLIC_GIT_SSH_USERS.has(lower) ||
    RESERVED_EMAIL_SUFFIXES.some((suffix) => lower.endsWith(suffix))
  );
}

function normalizePath(path: string) {
  return path.split(NodePath.sep).join("/").split(String.fromCharCode(92)).join("/");
}
