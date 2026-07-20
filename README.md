# Command Center

Command Center is a conversation-first agent workspace for coordinating projects, repositories,
automations, approvals, connections, and governed memory from one durable entry point.

This repository contains the generic public application. Operator-specific Spaces, repository
mappings, prompts, policies, schedules, and automation definitions belong in a separate private
configuration checkout. Credentials and user data never belong in either repository.

> [!IMPORTANT]
> This fork is under active development and is not yet a published replacement for upstream T3
> Code releases. Build it from source in an isolated runtime directory until the migration and
> rollback rehearsal is complete.

## Architecture

Command Center preserves T3 Code's projects, threads, provider sessions, worktrees, terminals,
approvals, responsive web application, remote access, and Electron foundations. Command Center
features are added through isolated contracts, services, projections, routes, and UI modules so
tagged upstream releases can continue to be reviewed and merged.

The deployment boundary is deliberately split:

- This public repository contains platform code, migrations, schemas, tests, and fictional examples.
- A private configuration repository contains non-secret operator configuration.
- `~/.command-center` contains runtime databases, encrypted credentials, memory indexes, logs,
  attachments, and worktrees outside Git.

See [public repository safety](./docs/operations/public-repository-safety.md) for the enforced
boundary and publication checklist. See
[webhook automation admission](./docs/operations/webhook-automation-trigger.md) for the scoped
paired-client RPC and runtime-only HMAC adapter.

## Development

Install [Vite+](https://viteplus.dev/guide/), then install dependencies and start the application:

```bash
vp i
vp run dev
```

Set `COMMAND_CENTER_CONFIG_DIR` to the root of a private configuration checkout. Generic schema and
fixture examples are available in [`examples/command-center`](./examples/command-center). Without
that override, the application looks for the sibling checkout `~/.command-center-config`, keeping
the Git-managed private configuration outside the non-Git runtime directory. `COMMAND_CENTER_HOME`
can override the runtime directory; the legacy `T3CODE_HOME` variable remains supported.

Before committing or publishing changes, run:

```bash
vp run typecheck
vp run public:check
vp run fmt:check
```

The application can run without private configuration, but it reports that state explicitly and
does not invent operator Spaces or connections.

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
