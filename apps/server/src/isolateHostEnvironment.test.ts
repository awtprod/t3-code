import { assert, it } from "@effect/vitest";

// Deliberately does not import ./isolateHostEnvironment.ts: importing it would
// clear the variables itself and hide a missing `setupFiles` entry. This test
// proves the vitest setup ran before any test file.
it("clears inherited host Command Center variables before tests run", () => {
  for (const name of [
    "COMMAND_CENTER_HOME",
    "COMMAND_CENTER_CONFIG_DIR",
    "COMMAND_CENTER_GITHUB_IDENTITY",
    "COMMAND_CENTER_GITHUB_PROVISIONING_IDENTITY",
    "T3CODE_HOME",
    "T3CODE_WEB_PUSH_SUBJECT",
    "CC_WINDOWS_MEDIA_SSH_CONFIG",
    "CC_WINDOWS_MEDIA_SSH_ALIAS",
  ]) {
    assert.strictEqual(process.env[name], undefined, `${name} leaked into the server test run`);
  }
  assert.deepStrictEqual(
    Object.keys(process.env).filter((name) => name.startsWith("T3_SANDBOX_")),
    [],
    "host sandbox runtime settings leaked into the server test run",
  );
});
