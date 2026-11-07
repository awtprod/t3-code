/**
 * The one identity Command Center commits under. It reaches Git only through the
 * allowlisted `GIT_AUTHOR_*` / `GIT_COMMITTER_*` environment, never `-c user.*` or
 * `GIT_CONFIG_*`, so a commit never depends on the user's global config. `example.com`
 * is reserved (RFC 2606): it receives no mail, so no GitHub account can verify or claim it.
 */
const COMMAND_CENTER_GIT_IDENTITY = {
  name: "Command Center",
  email: "command-center@example.com",
} as const;

export const commandCenterGitIdentityEnvironment = (): {
  readonly GIT_AUTHOR_NAME: string;
  readonly GIT_AUTHOR_EMAIL: string;
  readonly GIT_COMMITTER_NAME: string;
  readonly GIT_COMMITTER_EMAIL: string;
} => ({
  GIT_AUTHOR_NAME: COMMAND_CENTER_GIT_IDENTITY.name,
  GIT_AUTHOR_EMAIL: COMMAND_CENTER_GIT_IDENTITY.email,
  GIT_COMMITTER_NAME: COMMAND_CENTER_GIT_IDENTITY.name,
  GIT_COMMITTER_EMAIL: COMMAND_CENTER_GIT_IDENTITY.email,
});
