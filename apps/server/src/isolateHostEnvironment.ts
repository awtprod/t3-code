/**
 * Server tests must never see the host Command Center that launched them.
 *
 * Agents and developers often run this suite from inside a live Command
 * Center process, which exports its private config directory, runtime home,
 * GitHub identities, web-push subject and Windows media bridge. Any of those
 * leaking into a test either points it at real private state or silently
 * changes expectations (tests that default a value with `??=` keep the host's
 * value instead). Clear them before every test file; tests that need one set
 * it explicitly.
 */
const HOST_ENVIRONMENT_VARIABLES = [
  "COMMAND_CENTER_HOME",
  "COMMAND_CENTER_CONFIG_DIR",
  "COMMAND_CENTER_GITHUB_IDENTITY",
  "COMMAND_CENTER_GITHUB_PROVISIONING_IDENTITY",
  "T3CODE_HOME",
  "T3CODE_WEB_PUSH_SUBJECT",
  "CC_WINDOWS_MEDIA_SSH_CONFIG",
  "CC_WINDOWS_MEDIA_SSH_ALIAS",
] as const;

for (const name of HOST_ENVIRONMENT_VARIABLES) {
  delete process.env[name];
}
