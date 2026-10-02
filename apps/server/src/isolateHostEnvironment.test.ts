import { assert, it } from "@effect/vitest";

// Deliberately does not import ./isolateHostEnvironment.ts: importing it would
// run the cleanup itself and hide a missing `setupFiles` entry. The sentinel
// is only set by the setup file, so this fails in CI too if it is not wired.
it("runs the host environment isolation before server tests", () => {
  assert.strictEqual(
    process.env.T3_SERVER_TEST_HOST_ENVIRONMENT_ISOLATED,
    "1",
    "apps/server vite.config.ts must list src/isolateHostEnvironment.ts in test.setupFiles",
  );
  const leaked = Object.keys(process.env).filter(
    (name) =>
      ["COMMAND_CENTER_", "CC_WINDOWS_MEDIA_", "T3_SANDBOX_"].some((prefix) =>
        name.startsWith(prefix),
      ) ||
      [
        "T3CODE_HOME",
        "T3CODE_WEB_PUSH_SUBJECT",
        "T3CODE_RESOURCE_MONITOR_PATH",
        "T3_SERVICE_LAUNCHER_CONTEXT",
        "T3_BOOT_SERVICE_UNIT",
        "CLAUDE_CONFIG_DIR",
      ].includes(name),
  );
  assert.deepStrictEqual(leaked, [], "host Command Center variables leaked into server tests");
});
