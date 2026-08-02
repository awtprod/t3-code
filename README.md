# Command Center

Command Center is a conversation-first agent workspace for coordinating projects, repositories,
automations, approvals, connections, and governed memory from one durable entry point.

This repository contains both sides of the application:

- the web, desktop, and mobile clients
- the Command Center server that clients connect to

The server owns project files, Git access, provider processes, credentials, and runtime state. A
client is only a UI for a paired server (called an **environment**). For a first setup, run the web
client and server together on one machine. A separate remote server is optional.

> [!IMPORTANT]
> This fork is under active development and is not yet a published replacement for upstream T3
> Code releases. Build it from source in an isolated runtime directory until the migration and
> rollback rehearsal is complete.

## Set up from scratch

### 1. Install the prerequisites

Install:

- [Git](https://git-scm.com/)
- Node.js `24.13.1` (the version required by this source checkout)
- at least one supported coding-agent CLI

Command Center drives an agent CLI on the **server machine**; it does not include provider
credentials. Install and sign in to one or more providers before starting your first agent session.

| Provider                                              | Binary         | Sign-in command       |
| ----------------------------------------------------- | -------------- | --------------------- |
| [Codex](https://developers.openai.com/codex/cli)      | `codex`        | `codex login`         |
| [Claude Code](https://claude.com/product/claude-code) | `claude`       | `claude auth login`   |
| [Cursor CLI](https://cursor.com/cli)                  | `cursor-agent` | `agent login`         |
| [Grok Build](https://x.ai/cli)                        | `grok`         | `grok login`          |
| [OpenCode](https://opencode.ai)                       | `opencode`     | `opencode auth login` |

See [provider setup](./docs/user/install.md#providers) for binary discovery and multi-account
guidance.

### 2. Clone and install

```bash
git clone https://github.com/awtprod/t3-code.git command-center
cd command-center
corepack enable
corepack install
pnpm install --frozen-lockfile
```

The repository pins pnpm `11.10.0` and includes Vite+ as a development dependency, so a separate
global Vite+ install is not required.

### 3. Start the app and its server

For development with hot reload:

```bash
pnpm dev
```

This starts the Command Center server and the web client together. The startup output prints the
actual ports and a one-time pairing URL. Open the **pairing URL**, not the bare localhost URL, to
create the first authenticated browser session. The default ports are `5733` for the web client and
`13773` for the server, but the runner selects different ports when those are occupied or when
multiple worktrees are running.

For a production-like local build where the server also serves the compiled web client:

```bash
pnpm serve --home-dir /absolute/path/to/command-center-data
```

`pnpm serve` rebuilds the web client before starting. Use `pnpm serve:fast` on later starts when the
web source has not changed. An explicit home directory keeps both modes on the same isolated runtime
database; without it, development and serve mode intentionally use different data directories.

To run the Electron desktop app during development:

```bash
pnpm dev:desktop
```

### 4. Add projects and verify the provider

Open **Settings** in the app and check that the provider CLI is detected. If it is installed outside
the server process's `PATH`, set its absolute binary path in the provider settings.

Add the repository or workspace you want the agent to use. Projects always refer to paths on the
server machine, not paths on the phone or browser running the client. For more detail, see the
[installation guide](./docs/user/install.md).

## Run the server on another machine

Use this when the client and the repositories it controls should live on different machines. The
remote machine needs the same Git, Node.js, source checkout, dependency installation, provider CLI,
and provider login described above.

### Recommended: private network with HTTPS

With [Tailscale](https://tailscale.com/) installed and connected on the server:

```bash
pnpm serve \
  --home-dir /absolute/path/to/command-center-data \
  --tailscale-serve
```

This serves the compiled app and its HTTP/WebSocket API from one origin, asks Tailscale Serve to
publish it over Tailnet HTTPS, and prints a pairing URL. In the desktop app, open **Settings** →
**Connections** → **Add environment** and paste that URL. You can also open the URL directly in a
browser that can reach the Tailnet address.

### Trusted LAN

To listen on every network interface without Tailscale:

```bash
pnpm serve \
  --home-dir /absolute/path/to/command-center-data \
  --host 0.0.0.0
```

Only do this on a trusted network with an appropriate host firewall. Use the pairing URL printed by
the server on the other device. Do not expose the port directly to the public internet.

The hosted web client at <https://awtprod-command-center.vercel.app> can pair with a remote backend
only when that backend is reachable from the browser over HTTPS/WSS. It connects directly to your
server; it does not proxy agent traffic or store server state. Browsers will block a hosted HTTPS
page from connecting to a plain HTTP LAN backend.

For SSH-managed environments, additional pairing methods, and Tailscale endpoint details, see
[Remote Access](./docs/user/remote-access.md).

### What to keep on the server

- Provider CLIs and their authenticated sessions
- The repositories and worktrees agents are allowed to modify
- Git and source-control credentials needed by those repositories
- The Command Center runtime directory and private configuration

Treat pairing URLs like passwords. A one-time pairing token is exchanged for a device session; use
the server's `auth` commands to review or revoke access later.

## Configuration and data

Command Center separates public source, private operator configuration, and runtime data:

| Location                    | Purpose                                                                    | Commit to Git?          |
| --------------------------- | -------------------------------------------------------------------------- | ----------------------- |
| This repository             | Application code, schemas, migrations, and fictional examples              | Yes                     |
| `COMMAND_CENTER_CONFIG_DIR` | Spaces, repository mappings, prompts, policies, and automation definitions | Private repository only |
| `COMMAND_CENTER_HOME`       | Databases, credentials, logs, attachments, indexes, and worktrees          | No                      |

The default runtime directory is `~/.command-center`, and the default private configuration
directory is the adjacent `~/.command-center-config`. If the runtime directory is overridden, the
default config directory is `<runtime-directory>-config`. `T3CODE_HOME` remains supported as a
legacy runtime-directory variable.

The application can run without private configuration. It reports the missing configuration and
does not invent operator Spaces or connections. Generic examples are available in
[`examples/command-center`](./examples/command-center).

The root [`.env.example`](./.env.example) documents optional public build settings for T3 Connect.
They are not required for local or direct remote pairing. Never put server-side secrets in `.env`,
this repository, or the private configuration repository.

See [public repository safety](./docs/operations/public-repository-safety.md) for the enforced
boundary and publication checklist. See
[webhook automation admission](./docs/operations/webhook-automation-trigger.md) for the scoped
paired-client RPC and runtime-only HMAC adapter.

## Useful commands

| Command            | Purpose                                              |
| ------------------ | ---------------------------------------------------- |
| `pnpm dev`         | Start the server and web client with hot reload      |
| `pnpm dev:server`  | Start only the development server                    |
| `pnpm dev:web`     | Start only the web client                            |
| `pnpm dev:desktop` | Start the desktop client and local backend           |
| `pnpm serve`       | Build the web client, then serve it from the backend |
| `pnpm serve:fast`  | Reuse the existing web build and start the backend   |
| `pnpm dev:stop`    | Stop the dev instance launched from this checkout    |

Read [development mode vs serve mode](./docs/getting-started/dev-vs-serve.md) before switching a
long-lived environment between the two.

Before committing or publishing changes, run:

```bash
pnpm typecheck
pnpm public:check
pnpm fmt:check
```

## Architecture

Clients send authenticated HTTP and WebSocket requests to one Command Center server. The server
turns commands into persisted events, projects them into the UI read model, and drives provider CLIs
as subprocesses. Each environment therefore has a single ownership boundary for files, credentials,
agent sessions, and state.

Command Center preserves T3 Code's projects, threads, provider sessions, worktrees, terminals,
approvals, responsive web application, remote access, and Electron foundations. Command Center
features are added through isolated contracts, services, projections, routes, and UI modules so
tagged upstream releases can continue to be reviewed and merged.

## Security model

- Routing is visible, deterministic, and explicit selections take precedence.
- Agent capabilities are scoped to a Space, repository, thread, session, and operation.
- Reads, previews, and policy-allowed reversible work may run automatically. Protected external
  actions require both a narrow server-mediated executor and digest-bound approval; because those
  executors are not enabled in v1, command routes for push, merge, deploy, publication,
  communication, money, sharing, deletion, account/security, and secret changes fail closed.
- Google integration is read-only in v1 and uses an exact command allowlist.
- Webhook automations require a committed definition and either a paired operate-scoped session or
  an HMAC credential bound to the exact Space and route in runtime secret storage.
- Audit entries are append-only and hash-chained.
- Staged changes and CI are scanned for credentials and public/private boundary violations.

## Upstream and license

Command Center is based on [T3 Code](https://github.com/pingdotgg/t3code), initially pinned to
commit `b511227b7ad421c422f1ebca65116776020e4799`. T3 Code's MIT license and attribution are preserved
in [LICENSE](./LICENSE). Upstream changes should arrive through dedicated synchronization pull
requests with both upstream and Command Center verification.

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before proposing changes.
