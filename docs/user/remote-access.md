# Remote access

Connect a phone, browser, or another desktop app to Command Center running on a different
machine. That machine must stay running and reachable while you work.

## T3 Connect

T3 Connect makes an environment available to your other devices without setting
up router forwarding. In the desktop app on the host, open **Settings →
Connections**, sign in, and enable **T3 Connect** for that environment.

For a command-line host, run:

```bash
npx @awtprod/command-center connect
```

Follow the sign-in instructions. Setup offers a
[background service](./background-service.md); if you decline it, start the
server with `command-center serve`. Saving your sign-in alone does not make the machine
reachable.

On your other device, sign in to the same T3 Connect account and choose the
environment. Over SSH, the CLI prints a browser link and a short code. Open the
link on any device, confirm the code matches, and approve. The CLI continues on
its own, so you do not need to forward an OAuth callback port.

T3 Connect renews access credentials when needed without disconnecting a healthy
connection. Pull request diffs and provider settings keep working after the
previous credential expires. A failed renewal affects that request; it does not
disconnect an otherwise healthy conversation.

### Browser notifications

When your account is signed in to T3 Connect, the web app can notify your browser when an agent
needs approval or input, or when work finishes — the same agent activity that powers mobile push
notifications. Enable it per browser in **Settings** → **Connections** → **Browser notifications**.

Notifications flow through T3 Connect: the environment publishes agent activity to your account,
and the relay delivers it to every browser you enabled. Environments connected only over the local
network without T3 Connect do not send notifications. On iPhone and iPad, first add the web app to
your home screen (**Share** → **Add to Home Screen**); iOS only delivers web notifications to
installed apps.

## Pair over a LAN or private network

Use direct pairing when the other device can reach the host's network address.

On a desktop host, open **Settings → Connections**, enable **Network access**,
then create a pairing link using an address the other device can reach. Changing
network access restarts the desktop app. You can turn it off in the same place.

For a command-line host, replace `<private-ip>` with the host's LAN or tailnet
address:

```bash
npx @awtprod/command-center serve --host <private-ip>
```

If a server is already running, generate a fresh link without restarting it:

```bash
npx @awtprod/command-center pair
```

Scan the QR code on your phone or paste the pairing URL into **Add environment**
in the receiving app. Connection settings are under **Settings → Connections**
on web and desktop and **Settings → Environments** on mobile. A loopback address
such as `127.0.0.1` reaches only the device opening the link.

Pairing authorizes that device for future connections. Use a fresh one-time link
for each new device; you do not need the original token to reconnect. Links
created in Settings can only be copied from the client that created them while
its Connections page stays open. If you leave or reload that page, create
another link to share.

### Balance new threads across machines

Auto balance is off by default. On web and desktop, enable it in
**Settings → Connections → Load balancing** to automatically choose a machine for
new threads in projects grouped across connected environments. The section
appears once two or more machines are switched on.
Each machine starts at **Normal**. Choose **Prefer** to favor it when it has CPU and
memory available, **Less often** to reduce its share, or **Manual only** to exclude
it from automatic selection. These are preferences, not fixed traffic percentages.
Preferences are saved separately in each client.

The composer checks eligible machines when choosing a draft's environment, then keeps
that choice stable. Choose **Auto balance** again to check current resources, or choose
a specific machine to override it. Choosing a branch or worktree also keeps the draft
on that machine. Existing threads stay where they started. If resource checks are
unavailable or all eligible machines are full, choose a machine manually to continue.
Mobile keeps its manual environment selection.

### Tailscale HTTPS

Join both devices to the same tailnet. In the desktop app, enable **Tailscale
HTTPS** in **Settings → Connections**. Turn it off there to remove that route.

To start a command-line server with Tailscale HTTPS:

```bash
npx @awtprod/command-center serve --tailscale-serve
```

For an already-running server:

```bash
npx @awtprod/command-center pair --tailscale
```

The pairing link uses an address such as `https://machine.tailnet.ts.net/`.
The mapping created by `pair --tailscale` persists across restarts. Remove its
default-port mapping with:

```bash
tailscale serve --https=443 off
```

If that port is already in use, choose another with
`--tailscale-serve-port`. See `command-center pair --help` for other pairing options.

### Hosted web app

[awtprod-command-center.vercel.app](https://awtprod-command-center.vercel.app) needs an HTTPS endpoint. It connects directly
to your server; a hosted pairing link does not make an unreachable backend
reachable or convert HTTP to HTTPS.

For a plain HTTP LAN endpoint, use the direct pairing URL in a browser that can
open it, or pair from the desktop app. On mobile, an IP address entered without a
scheme uses HTTP, so include `https://` when your server uses HTTPS.

## Desktop-managed SSH

In the desktop app, open **Settings → Connections → Add environment**, choose
**SSH**, and enter a host or SSH alias such as `user@example.com`. Command Center
starts or reuses a server there and opens the port forward for you. Projects,
provider credentials, and agent work stay on the remote machine.

The launcher connects with a non-interactive `sh` session, writes a small launcher
script under `~/.command-center/ssh-launch/<host-key>/`, and starts or reuses the
server through `npx`. The remote host needs [provider setup](./install.md#providers)
and a Node.js runtime that satisfies the server package's `engines.node` requirement:

```text
^22.16 || ^23.11 || >=24.10
```

If `node` is not on `PATH`, the launcher tries common non-interactive shell locations
and version-manager shims or activation hooks:

- `~/.local/bin`, `~/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
- Volta via `~/.volta/bin`
- asdf via `~/.asdf/shims`, `~/.asdf/bin`, or `~/.asdf/asdf.sh`
- mise via `~/.local/share/mise/shims`, `~/.mise/shims`, or `mise activate sh`
- fnm via `fnm env --use-on-cd --shell sh` or `fnm env --shell sh`
- nodenv via `~/.nodenv/bin`, `~/.nodenv/shims`, or `nodenv init -`
- nvm via `$NVM_DIR/nvm.sh`, then `nvm use default`, `nvm use node`, or `nvm use --lts`
- installed nvm versions under `$NVM_DIR/versions/node/*/bin`

If launch fails with `node: command not found`, a port-scan failure, or a message
that the remote Node version does not satisfy the required range, check the same
non-interactive shell path the launcher uses. Provider CLIs must be on that `PATH`
too:

```bash
ssh user@example.com 'sh -lc "command -v node && node --version && command -v claude codex"'
```

If that does not print a compatible Node version, configure your version manager for
non-interactive shells or install a compatible Node binary in one of the searched
locations. With nvm, setting a compatible default, such as `nvm alias default 24`,
can resolve the problem.

If SSH reconnecting fails after an app update, retry the launch once. The launcher
compares its generated runner script, stops stale launcher-managed remote servers,
and starts a fresh one, so you should not normally need to delete
`~/.command-center/ssh-launch` or kill server processes manually. Removing the
connection stops a server that Command Center launched; a server that was already
running is left alone.

For Antigravity's Google callback on a remote host, see
[remote sign-in](./providers-antigravity.md#sign-in-from-a-remote-device).

## Manage or revoke access

On the host, **Settings → Connections** lets authorized administrators create
pairing links and revoke client sessions. Revoking an unused link prevents new
pairings; revoke a device's session to remove its existing access. Command-line
management is available through `command-center auth --help`. The package also
installs `t3` as a temporary compatibility alias, but new scripts and remote
bootstrap commands should use `command-center`.

A session with an open connection stays listed after its access credential
expires.

To remove an environment from T3 Connect, open your account menu's **T3 Connect**
page, or **Settings → T3 Connect** on mobile, and choose **Deregister**. This
revokes its cloud access and frees its host space even when the environment is
offline or has been wiped. Removing an environment from a device's connection
settings only forgets it on that device; it stays registered to your account.

When idle tunnel cleanup is enabled, T3 Connect removes a linked environment's
tunnel after it stays offline for several minutes. The environment stays linked
and keeps the same address. When the host starts again or wakes, T3 Connect
creates a replacement tunnel on its own. You do not need to pair again. Cleanup
usually runs five to ten minutes after the tunnel goes down.

On a command-line host, `command-center connect unlink` disables exposure while
retaining your login; `command-center connect logout` also clears that login. Background-service
[removal](./background-service.md#manage-the-service) is separate.

Treat pairing URLs and authorization codes as passwords. Do not include them in
screenshots, logs, or bug reports.

## T3 Connect troubleshooting

Run `command-center connect status` on the host to inspect saved authorization and
link configuration. It is not a live reachability check. If the environment appears
offline, run `command-center service status` and read the displayed log. If it disappears
when SSH closes, see [background-service platform notes](./background-service.md#platform-support).

| Error                                                     | Recovery                                                                                                                                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment_link_limit_exceeded` or managed tunnel limit | Deregister an unused environment, then restart Command Center on the host.                                                                                                      |
| `auth_invalid` or `invalid_bearer`                        | Run `command-center connect login`. If credentials were revoked, run `command-center connect logout`, then `command-center connect` again. Restart the server after signing in. |
| Expired or invalid link proof                             | Check the host's date and time, update Command Center, then restart it.                                                                                                         |
| HTTP 403 without a recognized error                       | Check relay access, proxies, and firewall rules. Keep any Cloudflare Ray ID for a bug report.                                                                                   |
| HTTP 408, 429, or 5xx                                     | Check network and relay availability. Startup retries temporary failures for up to ten minutes.                                                                                 |

After fixing a permanent rejection, restart the host's server. On Linux, use
`systemctl --user restart command-center.service` for the background service. For a
foreground server, stop it and run `command-center serve` again with your usual options.
Include the diagnostic message and trace ID when reporting a persistent failure.

For a connection that still fails after linking, check the date and time on both
devices. For server version warnings, follow [Updating Command Center](./updating.md).

## Use a Remote Server as the Desktop Primary

The Electron desktop can use a paired remote environment as its primary backend. In this mode the
remote environment owns execution; Desktop does not start a second local backend.

1. Pair the remote environment from **Settings** → **Connections** → **Add environment**.
2. In **Desktop execution**, choose **Remote server** and enter its HTTP or HTTPS base URL.
3. Test the connection, then choose **Make remote primary and restart**.

Remote-primary mode persists across ordinary launches. The desktop loads its web bundle from the
remote server and sends HTTP and WebSocket traffic directly to it using the saved pairing session.
Projects, files, git state, terminals, and provider sessions therefore remain on the remote machine.

If the remote server is unavailable, Command Center shows a local recovery window. It never falls
back to Windows automatically. You can retry, edit the endpoint, quit, or select **Start local for
this launch**. The last option relaunches with a conspicuous local-override indicator and leaves the
persisted Remote preference unchanged, so the next ordinary launch returns to remote-only mode.

To run work on the desktop machine, switch the primary back to **Windows local** or **WSL** in
Connections and restart. Local execution is not available while the remote server remains primary.

## Using the Desktop App as a Remote Only

If a computer should only drive work running elsewhere, turn off its local environment. In the
desktop app, open **Settings → Connections** and switch off **Local
environment**. Command Center restarts without a local server: no local agents or terminals run, WSL
backends stay off, and other devices can no longer connect to this computer. Your projects,
history, and saved connections are kept, and you keep working through pairing, T3 Connect, or SSH.

Switch **Local environment** back on in the same place to restart with your previous local
settings.
