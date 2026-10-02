/**
 * Server tests must never see the host Command Center that launched them.
 *
 * Agents and developers often run this suite from inside a live Command
 * Center process, which exports its private config directory, runtime home,
 * GitHub identities, web-push subject, Windows media bridge and sandbox
 * runtime settings (including a sandbox auth token). Any of those
 * leaking into a test either points it at real private state or silently
 * changes expectations (tests that default a value with `??=` keep the host's
 * value instead). Clear them before every test file; tests that need one set
 * it explicitly.
 */
const HOST_ENVIRONMENT_VARIABLES = [
  "T3CODE_HOME",
  "T3CODE_WEB_PUSH_SUBJECT",
  "T3CODE_RESOURCE_MONITOR_PATH",
  "T3_SERVICE_LAUNCHER_CONTEXT",
  "T3_BOOT_SERVICE_UNIT",
  "CLAUDE_CONFIG_DIR",
] as const;

/**
 * Every variable with one of these prefixes describes the host Command Center:
 * its home, private config, GitHub identities and gog binary; the Windows
 * media bridge; and the sandbox runtime.
 */
const HOST_ENVIRONMENT_PREFIXES = ["COMMAND_CENTER_", "CC_WINDOWS_MEDIA_", "T3_SANDBOX_"] as const;

/** Set once the host variables are cleared, so a test can prove the setup ran. */
export const HOST_ENVIRONMENT_ISOLATED = "T3_SERVER_TEST_HOST_ENVIRONMENT_ISOLATED";

for (const name of HOST_ENVIRONMENT_VARIABLES) {
  delete process.env[name];
}
for (const name of Object.keys(process.env)) {
  if (HOST_ENVIRONMENT_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    delete process.env[name];
  }
}
process.env[HOST_ENVIRONMENT_ISOLATED] = "1";
