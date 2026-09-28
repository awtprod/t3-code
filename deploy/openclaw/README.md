# Dedicated server deployment

These assets stage the dedicated `commandcenter` identity without stopping the legacy services or
changing Tailscale Serve. Run `sudo ./provision.sh` on the target host, then authenticate each
GitHub profile interactively as the service user:

```sh
sudo -u commandcenter env HOME=/var/lib/command-center \
  COMMAND_CENTER_GITHUB_PROVISIONING_IDENTITY=primary \
  /opt/command-center/bin/gh auth login --hostname github.com --git-protocol https --scopes admin:org,gist,repo,workflow

sudo -u commandcenter env HOME=/var/lib/command-center \
  COMMAND_CENTER_GITHUB_PROVISIONING_IDENTITY=secondary \
  /opt/command-center/bin/gh auth login --hostname github.com --git-protocol https --scopes gist,read:org,repo,workflow
```

Set the required repository coordinates, branch, and expected GitHub logins in the environment, then run `sudo --preserve-env=COMMAND_CENTER_CONFIG_REPOSITORY,COMMAND_CENTER_CONFIG_BRANCH,COMMAND_CENTER_PRIMARY_REPOSITORY,COMMAND_CENTER_SECONDARY_REPOSITORY,COMMAND_CENTER_PRIMARY_GITHUB_LOGIN,COMMAND_CENTER_SECONDARY_GITHUB_LOGIN ./bootstrap-data.sh`. The bootstrapper fails before cloning if any value is absent.

Validate it offline with its checked-in command before starting the candidate. Provider logins must
be performed separately through the six identity-specific wrappers; do not copy the existing users'
provider homes. Install the pinned service-owned CLIs with `sudo ./install-provider-clis.sh`, then
authenticate `codex-primary`, `codex-secondary`, `claude-primary`, `claude-secondary`, `kimi-primary`, and
`kimi-secondary` deliberately. The wrappers put the matching GitHub profile and provider home in the
process environment and fail closed when an instance name is not mapped.
Keep the host installer and workspace sandbox image on the same provider CLI versions when updating them.

The provisioner installs `command-center.candidate.service`, not the live unit. Promoting it,
stopping legacy services, and changing the Tailscale root route are cutover actions and require the
operator approval described in the migration plan.

`install-release.sh <full-commit>` builds a previously staged source archive into a root-owned,
read-only release and updates `/opt/command-center/current` while the candidate is stopped.
`bootstrap-data.sh` clones the configured repositories only after both isolated GitHub
profiles exist, validates the config, and verifies both correct and mismatched identity routing.
Neither script starts a service or changes Tailscale.
