import { assert, expect, it } from "@effect/vitest";

import {
  approvedGitHubProfileForOwner,
  readGitHubProfileCredential,
  type RunProfileCli,
} from "./GitHubProfileAuth.ts";

const profileMap = JSON.stringify({
  exampleowner: { profile: "primary", login: "exampleowner" },
  "example-org": { profile: "secondary", login: "examplelogin" },
});
const runner = () => "/opt/command-center/bin/provider-run";

it("selects one configured profile and checks its actual login", async () => {
  const calls: string[][] = [];
  const run: RunProfileCli = async (_executable, args) => {
    calls.push([...args]);
    return args[2] === "api" ? "exampleowner\n" : "sample-token\n";
  };
  const credential = await readGitHubProfileCredential("ExampleOwner", run, runner, profileMap);
  assert.equal(credential.account, "primary");
  assert.equal(credential.token, "sample-token");
  assert.deepStrictEqual(calls[0], ["codex-primary", "gh", "api", "user", "--jq", ".login"]);
  assert.deepStrictEqual(calls[1], [
    "codex-primary",
    "gh",
    "auth",
    "token",
    "--hostname",
    "github.com",
    "--user",
    "exampleowner",
  ]);
});

it("maps an organization owner to a separate existing profile and login", async () => {
  const calls: string[][] = [];
  const run: RunProfileCli = async (_executable, args) => {
    calls.push([...args]);
    return args[2] === "api" ? "examplelogin\n" : "sample-token\n";
  };
  const credential = await readGitHubProfileCredential("example-org", run, runner, profileMap);
  assert.equal(credential.account, "secondary");
  assert.deepStrictEqual(calls[0], ["codex-secondary", "gh", "api", "user", "--jq", ".login"]);
  assert.equal(calls[1]?.at(-1), "examplelogin");
});

it("does not read a token when the profile login differs", async () => {
  let calls = 0;
  await expect(
    readGitHubProfileCredential(
      "example-org",
      async () => {
        calls += 1;
        return "another-account\n";
      },
      runner,
      profileMap,
    ),
  ).rejects.toThrow("GitHub profile secondary is unavailable.");
  assert.equal(calls, 1);
});

it("rejects unmapped owners and malformed host configuration before reading a credential", async () => {
  let called = false;
  const run: RunProfileCli = async () => {
    called = true;
    return "token";
  };
  await expect(readGitHubProfileCredential("unknown", run, runner, profileMap)).rejects.toThrow(
    "No approved GitHub profile",
  );
  assert.isNull(approvedGitHubProfileForOwner("unknown", profileMap));
  assert.equal(called, false);
  assert.throws(
    () =>
      approvedGitHubProfileForOwner(
        "exampleowner",
        '{"exampleowner":{"profile":"!bad","login":"exampleowner"}}',
      ),
    "GitHub profile map is invalid.",
  );
  assert.throws(
    () => approvedGitHubProfileForOwner("exampleowner", "x".repeat(4_097)),
    "GitHub profile map is invalid.",
  );
  for (const mapped of [{ login: "exampleowner" }, { profile: 123, login: "exampleowner" }]) {
    assert.throws(
      () => approvedGitHubProfileForOwner("exampleowner", JSON.stringify({ exampleowner: mapped })),
      "GitHub profile map is invalid.",
    );
  }
});
