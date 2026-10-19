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

import { resolveTrustedHostExecutable } from "../vcs/HostGitSecurity.ts";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);

export type ApprovedGitHubProfile = "awtprod" | "ccn";

const expectedLogin: Record<ApprovedGitHubProfile, string> = {
  awtprod: "awtprod",
  ccn: "charlottecomedynetwork",
};

export function approvedGitHubProfileForOwner(owner: string): ApprovedGitHubProfile | null {
  switch (owner.toLowerCase()) {
    case "awtprod":
      return "awtprod";
    case "ccn":
    case "charlottecomedynetwork":
      return "ccn";
    default:
      return null;
  }
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
): Promise<{ readonly account: ApprovedGitHubProfile; readonly token: string }> {
  const account = approvedGitHubProfileForOwner(owner);
  if (account === null) throw new Error("No approved GitHub profile for this repository owner.");
  const executable = resolveExecutable();
  if (executable === undefined) throw new Error(`GitHub profile ${account} is unavailable.`);

  let token: string;
  try {
    const login = (
      await run(executable, [`codex-${account}`, "gh", "api", "user", "--jq", ".login"])
    ).trim();
    if (login.toLowerCase() !== expectedLogin[account]) {
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
        expectedLogin[account],
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
