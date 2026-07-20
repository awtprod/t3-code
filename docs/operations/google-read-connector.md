# Google read connector

Command Center v1 supports Gmail, Calendar, and Drive reads through
[`gog` v0.15.0](https://github.com/openclaw/gogcli/releases/tag/v0.15.0). It intentionally exposes no
Google mutation API.

## Install and pin

Install the v0.15.0 release artifact for the server platform, verify it against the checksums
published with that release, and set `COMMAND_CENTER_GOG_BINARY` to the resulting absolute binary
path. At startup, Command Center runs `gog --version` and refuses every Google request unless the
output identifies v0.15.0.

Do not point `COMMAND_CENTER_GOG_BINARY` at a floating package-manager path. Upgrade the pin only in
a reviewed application change that updates the invocation tests against the corresponding tagged
source.

## Authorize least privilege

Run OAuth setup as the same service account that operates Command Center. Use only the three v1
services and their read-only scope modes:

```console
gog auth add operator@example.com --services gmail,calendar,drive --readonly --gmail-scope readonly --drive-scope readonly
```

The runtime places gog's configuration under the Command Center secrets directory by setting
`XDG_CONFIG_HOME` for the child process. OAuth client JSON, refresh tokens, and any file-keyring
password belong in runtime credential storage, never either Git repository.

## Layered enforcement

Every invocation is an argv array—never a shell command—and includes all of these controls:

- `--enable-commands` with the exact v1 read-command list;
- `--gmail-no-send` and `--no-input`;
- an end-of-options boundary before every caller-controlled positional value, preventing a value
  from being reinterpreted as a global account or command flag;
- a bounded execution timeout and output limit;
- sanitized Gmail message and thread retrieval;
- typed output marked `untrusted-external` before it reaches an agent.

Requests identify only an exact `spaceId` and `connectionId`. They cannot supply a gog account
selector. The server resolves that selector from the enabled private configuration binding and its
`runtime:google/<alias>` credential reference, then verifies that the connection belongs to the
requested Space.

Connection health is a non-secret runtime projection. A successful pinned-version verification,
read, or export marks that exact Space/connection pair `connected` with a check timestamp; an
operational failure marks it `degraded`; and unavailable configuration remains `disconnected`.
Configuration reloads preserve health for connections that remain enabled, while disabled,
removed, invalid, or Space-reassigned connections are removed or reset before bootstrap. OAuth
tokens, credential references, and account aliases are never written to this projection.

Drive export is still a read operation. It uses the pinned `drive download` command with a
server-generated `--out` path and an allowlisted `--format`: `pdf`, `csv`, `xlsx`, `pptx`, `txt`,
`png`, `docx`, or `md`. The server stores output under runtime `attachments/exports`, applies a
two-minute timeout and 64 MiB file cap, hashes the result, and returns a `cc-artifact://` locator.
Neither callers nor agents can choose or receive a host filesystem path.

The OAuth scopes are the first boundary, the exact command allowlist is the second, and the scoped
MCP credential is the third. A Command thread must have `cc.connections.google.read`, be bound to a
Space, and select an enabled connection configured for that same Space.

Live smoke tests are deliberately opt-in. They should cover only search, retrieval, agenda,
availability, conflict detection, listing, and metadata/export reads, plus negative checks proving
that send, create, update, share, and delete commands are unavailable.
