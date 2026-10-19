import { assert, expect, it } from "@effect/vitest";

import { readGitHubProfileCredential, type RunProfileCli } from "./GitHubProfileAuth.ts";

it("selects the exact approved profile and never falls back to another login", async () => {
  const calls: Array<{ executable: string; args: readonly string[] }> = [];
  const run: RunProfileCli = async (executable, args) => {
    calls.push({ executable, args });
    if (args[0] === "codex-ccn") throw new Error("profile unavailable");
    if (args[2] === "api") return "awtprod\n";
    return "sample-token\n";
  };

  const awtprod = await readGitHubProfileCredential(
    "awtprod",
    run,
    () => "/opt/command-center/bin/provider-run",
  );
  assert.equal(awtprod.account, "awtprod");
  assert.equal(awtprod.token, "sample-token");
  assert.deepStrictEqual(calls[0]?.args, ["codex-awtprod", "gh", "api", "user", "--jq", ".login"]);
  assert.deepStrictEqual(calls[1]?.args, [
    "codex-awtprod",
    "gh",
    "auth",
    "token",
    "--hostname",
    "github.com",
    "--user",
    "awtprod",
  ]);

  await expect(
    readGitHubProfileCredential("ccn", run, () => "/opt/command-center/bin/provider-run"),
  ).rejects.toThrow("GitHub profile ccn is unavailable.");
  assert.deepStrictEqual(calls[2]?.args, ["codex-ccn", "gh", "api", "user", "--jq", ".login"]);
  assert.equal(calls.length, 3);
});

it("requires the Charlotte Comedy Network login for the ccn profile", async () => {
  const calls: string[][] = [];
  const run: RunProfileCli = async (_executable, args) => {
    calls.push([...args]);
    if (args[2] === "api") return "charlottecomedynetwork\n";
    return "sample-token\n";
  };
  const credential = await readGitHubProfileCredential(
    "ccn",
    run,
    () => "/opt/command-center/bin/provider-run",
  );
  assert.equal(credential.account, "ccn");
  assert.deepStrictEqual(calls[1], [
    "codex-ccn",
    "gh",
    "auth",
    "token",
    "--hostname",
    "github.com",
    "--user",
    "charlottecomedynetwork",
  ]);
});

it("does not read a token when the profile login differs", async () => {
  let calls = 0;
  await expect(
    readGitHubProfileCredential(
      "ccn",
      async () => {
        calls++;
        return "another-account\n";
      },
      () => "/opt/command-center/bin/provider-run",
    ),
  ).rejects.toThrow("GitHub profile ccn is unavailable.");
  assert.equal(calls, 1);
});

it("rejects an unsupported profile before running any CLI", async () => {
  let called = false;
  await expect(
    readGitHubProfileCredential("evil", async () => {
      called = true;
      return "token";
    }),
  ).rejects.toThrow("No approved GitHub profile");
  assert.equal(called, false);
});
