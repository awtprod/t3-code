// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeProcess from "node:process";
import * as NodeUtil from "node:util";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { parseGitHubRepositorySelector } from "@t3tools/source-control-github/server/gitHubRepositoryResolution";

import { resolveTrustedHostExecutable } from "../vcs/HostGitSecurity.ts";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);

export type ApprovedGitHubProfile = string;

interface ConfiguredGitHubProfile {
  readonly owner: string;
  readonly profile: string;
  readonly login: string;
}

/**
 * The host supplies owner -> existing provider profile and expected login.
 * Private organization and account names never belong in the public bundle.
 */
function configuredProfileForOwner(
  owner: string,
  configuration = NodeProcess.env.COMMAND_CENTER_GITHUB_PROFILE_MAP,
): ConfiguredGitHubProfile | null {
  if (configuration === undefined || configuration.trim() === "") return null;
  if (configuration.length > 4_096) throw new Error("GitHub profile map is invalid.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(configuration);
  } catch {
    throw new Error("GitHub profile map is invalid.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("GitHub profile map is invalid.");
  }
  const entries = Object.entries(parsed);
  if (entries.length > 16) throw new Error("GitHub profile map is invalid.");
  for (const [configuredOwner, value] of entries) {
    const mapped = value as Record<string, unknown> | null;
    if (
      !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/u.test(configuredOwner) ||
      mapped === null ||
      typeof mapped !== "object" ||
      Array.isArray(value) ||
      typeof mapped.profile !== "string" ||
      !/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u.test(mapped.profile) ||
      typeof mapped.login !== "string" ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(mapped.login)
    ) {
      throw new Error("GitHub profile map is invalid.");
    }
  }
  const normalizedOwner = owner.toLowerCase();
  const value = Object.hasOwn(parsed, normalizedOwner)
    ? (parsed as Record<string, { profile: string; login: string }>)[normalizedOwner]
    : undefined;
  return value === undefined
    ? null
    : { owner: normalizedOwner, profile: value.profile, login: value.login };
}

export function approvedGitHubProfileForOwner(
  owner: string,
  configuration?: string,
): ApprovedGitHubProfile | null {
  return configuredProfileForOwner(owner, configuration)?.owner ?? null;
}

export type RunProfileCli = (executable: string, args: readonly string[]) => Promise<string>;

const runProfileCli: RunProfileCli = async (executable, args) => {
  const { stdout } = await execFileAsync(executable, [...args], {
    cwd: NodeProcess.cwd(),
    env: {
      PATH: NodeProcess.env.PATH ?? "/opt/command-center/bin:/usr/local/bin:/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
      GH_PROMPT_DISABLED: "1",
      GH_DEBUG: "",
    },
    timeout: 10_000,
    maxBuffer: 4_096,
    windowsHide: true,
  });
  return stdout;
};

/** Read only the selected existing gh login. Do not try another account or inherited token. */
export async function readGitHubProfileCredential(
  owner: string,
  run: RunProfileCli = runProfileCli,
  resolveExecutable: () => string | undefined = () =>
    resolveTrustedHostExecutable("provider-run", { writableRoots: [NodeProcess.cwd()] }),
  configuration?: string,
): Promise<{ readonly account: ApprovedGitHubProfile; readonly token: string }> {
  const selected = configuredProfileForOwner(owner, configuration);
  if (selected === null) throw new Error("No approved GitHub profile for this repository owner.");
  const account = selected.profile;
  const executable = resolveExecutable();
  if (executable === undefined) throw new Error(`GitHub profile ${account} is unavailable.`);

  let token: string;
  try {
    const login = (
      await run(executable, [`codex-${account}`, "gh", "api", "user", "--jq", ".login"])
    ).trim();
    if (login.toLowerCase() !== selected.login.toLowerCase()) {
      throw new Error("Unexpected GitHub login.");
    }
    token = (
      await run(executable, [
        `codex-${account}`,
        "gh",
        "auth",
        "token",
        "--hostname",
        "github.com",
        "--user",
        selected.login,
      ])
    ).trim();
  } catch {
    throw new Error(`GitHub profile ${account} is unavailable.`);
  }
  if (
    token.length === 0 ||
    /\s/u.test(token) ||
    [...token].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) {
    throw new Error(`GitHub profile ${account} is unavailable.`);
  }
  return { account, token };
}

export interface GitHubProfileCredential {
  readonly account: ApprovedGitHubProfile;
  readonly token: Redacted.Redacted<string>;
  readonly fingerprint: string;
}

export class GitHubProfileUnavailableError extends Schema.TaggedError<GitHubProfileUnavailableError>()(
  "GitHubProfileUnavailableError",
  { account: Schema.String },
) {
  override get message(): string {
    return `GitHub profile ${this.account} is unavailable.`;
  }
}

export class GitHubProfileAuth extends Context.Service<
  GitHubProfileAuth,
  {
    readonly get: (
      owner: ApprovedGitHubProfile,
    ) => Effect.Effect<GitHubProfileCredential, GitHubProfileUnavailableError>;
  }
>()("@awtprod/command-center/sourceControl/GitHubProfileAuth") {}

export const layer = Layer.succeed(
  GitHubProfileAuth,
  GitHubProfileAuth.of({
    get: (owner) =>
      Effect.tryPromise({
        try: () => readGitHubProfileCredential(owner),
        catch: () => new GitHubProfileUnavailableError({ account: owner }),
      }).pipe(
        Effect.map(({ account, token }) => ({
          account,
          token: Redacted.make(token),
          fingerprint: `github.com:${NodeCrypto.createHash("sha256").update(token).digest("hex")}`,
        })),
      ),
  }),
);

/** Resolve only an explicitly configured repository profile; other hosts retain their defaults. */
export const forRepository = Effect.fn("GitHubProfileAuth.forRepository")(function* (input: {
  readonly host: string;
  readonly repository: string;
}) {
  if (input.host.toLowerCase() !== "github.com") return null;
  const locator = parseGitHubRepositorySelector(input.repository, "github.com");
  if (locator?.host !== "github.com") return null;
  const owner = yield* Effect.try({
    try: () => approvedGitHubProfileForOwner(locator.owner),
    catch: () => new GitHubProfileUnavailableError({ account: locator.owner }),
  });
  if (owner === null) return null;
  const profiles = yield* GitHubProfileAuth;
  return yield* profiles.get(owner);
});
