# Dedicated openclaw-server deployment

These assets stage the dedicated `commandcenter` identity without stopping the legacy services or
changing Tailscale Serve. Run `sudo ./provision.sh` on `openclaw-server`, then authenticate each
GitHub profile interactively as the service user:

```sh
sudo -u commandcenter env HOME=/var/lib/command-center \
  COMMAND_CENTER_GITHUB_PROVISIONING_IDENTITY=awtprod \
  /opt/command-center/bin/gh auth login --hostname github.com --git-protocol https --scopes admin:org,gist,repo,workflow

sudo -u commandcenter env HOME=/var/lib/command-center \
  COMMAND_CENTER_GITHUB_PROVISIONING_IDENTITY=ccn \
  /opt/command-center/bin/gh auth login --hostname github.com --git-protocol https --scopes gist,read:org,repo,workflow
```

Clone the private configuration only after the awtprod profile is authenticated:

```sh
sudo -u commandcenter env HOME=/var/lib/command-center \
  COMMAND_CENTER_GITHUB_PROVISIONING_IDENTITY=awtprod \
  /opt/command-center/bin/gh repo clone awtprod/command-center-config /var/lib/command-center/config \
  -- --branch runtime/openclaw-deployed
```

Validate it offline with its checked-in command before starting the candidate. Provider logins must
be performed separately through the six identity-specific wrappers; do not copy the existing users'
provider homes. Install the pinned service-owned CLIs with `sudo ./install-provider-clis.sh`, then
authenticate `codex-awtprod`, `codex-ccn`, `claude-awtprod`, `claude-ccn`, `kimi-awtprod`, and
`kimi-ccn` deliberately. The wrappers put the matching GitHub profile and provider home in the
process environment and fail closed when an instance name is not mapped.

The provisioner seeds `runtime/userdata/settings.json` only when it does not already exist. That
fresh-state seed declares the six labeled provider instances and their isolated homes; rerunning the
provisioner never overwrites live settings.

The provisioner installs `command-center.candidate.service`, not the live unit. Promoting it,
stopping legacy services, and changing the Tailscale root route are cutover actions and require the
operator approval described in the migration plan.

`install-release.sh <full-commit>` builds a previously staged source archive into a root-owned,
read-only release and updates `/opt/command-center/current` while the candidate is stopped.
`bootstrap-data.sh` clones the fresh config and initial repositories only after both isolated GitHub
profiles exist, validates the config, and verifies both correct and mismatched identity routing.
Neither script starts a service or changes Tailscale.
