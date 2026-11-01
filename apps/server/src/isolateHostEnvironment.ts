/**
 * Server tests must never see the host Command Center that launched them: its
 * exported private config, runtime home, identities and bridge settings would
 * point a test at real private state or leak into `??=` defaults. Cleared
 * before every test file; a test that needs one sets it explicitly.
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
 * Every variable with one of these prefixes describes the host Command Center.
 * `T3_SANDBOX_` is scrubbed even though the sandbox feature is gone: deployed
 * service units still export those variables, one of them a credential, which
 * must never reach a test.
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
