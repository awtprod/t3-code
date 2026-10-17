# Google connector

Command Center supports Gmail, Calendar, and Drive reads plus approval-gated Gmail draft creation through
[`gog` v0.15.0](https://github.com/openclaw/gogcli/releases/tag/v0.15.0). It intentionally exposes no
send operation.

## Install and pin

Install the v0.15.0 release artifact for the server platform, verify it against the checksums
published with that release, and set `COMMAND_CENTER_GOG_BINARY` to the resulting absolute binary
path. At startup, Command Center runs `gog --version` and refuses every Google request unless the
output identifies v0.15.0.

Do not point `COMMAND_CENTER_GOG_BINARY` at a floating package-manager path. Upgrade the pin only in
a reviewed application change that updates the invocation tests against the corresponding tagged
source.

## Authorize least privilege

The Automations editor can run the split remote OAuth flow and store a Space-scoped runtime binding.
The first account on an environment requires a Desktop OAuth client JSON upload. The server passes
that document to `gog auth credentials` over stdin and stores it only below the runtime credential
directory.

The editor's consent always passes `--readonly` and `--gmail-scope readonly`. It requests the
Calendar service (`--services gmail,calendar`) when the user ticks "Also read Google Calendar" or
when an enabled connection of the same Space, for the same account, already declares
`calendar.read`. With `--readonly`, gog v0.15.0 maps Calendar to
`https://www.googleapis.com/auth/calendar.readonly`; without it, gog would request the read-write
`https://www.googleapis.com/auth/calendar` scope (`internal/googleauth/service.go` at the v0.15.0
tag). The runtime read allowlist below never enables a Calendar write command either way. Draft
creation adds only `--extra-scopes https://www.googleapis.com/auth/gmail.compose`.

The editor can also remove an app-created binding from its Space. Removal intentionally leaves the
underlying `gog` authorization intact because one authorized account can back bindings in multiple
Spaces. Connections declared in private configuration remain owner-managed and cannot be removed
from the editor.

Operators can still authorize an account directly as the same service account that operates Command
Center. Use only the required services and scope modes:

```console
gog auth add operator@example.com --services gmail,calendar,drive --readonly --gmail-scope readonly --drive-scope readonly
```

Draft creation additionally requires the Gmail compose scope. Runtime invocations retain the exact
draft-only command allowlist and `--gmail-no-send` restriction.

The runtime places gog's configuration under the Command Center secrets directory by setting
`XDG_CONFIG_HOME` for the child process. OAuth client JSON, refresh tokens, and any file-keyring
password belong in runtime credential storage, never either Git repository.

## Layered enforcement

Every invocation is an argv array—never a shell command—and includes all of these controls:

- `--enable-commands` with the exact v1 read-command list;
- `--gmail-no-send` and `--no-input` for runtime reads and drafts;
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

The OAuth scopes are the first boundary, the exact read or draft command allowlist is the second, and the scoped
MCP credential is the third. A Command thread must have `cc.connections.google.read`, be bound to a
Space, and select an enabled connection configured for that same Space.

## Space agent mail and calendar

A Space agent sees Gmail and Calendar when its Space policy allows
`cc.connections.google.gmail.read` or `cc.connections.google.calendar.read` and an enabled Google
connection of that Space carries the same capability (the checks `cc_google_read` makes). The
first such connection by id is used per feed.

- Brief: every server-authored Space agent turn includes a "Mail + calendar" section after Open
  Items: up to 10 unread inbox threads from the last day (sender, subject, age, message count;
  promotions and social tabs left out) and the next 48 hours of events in the agent's timezone,
  with overlapping timed events marked `conflict`. The section is capped at 2,500 characters,
  marked untrusted, fetched with a 10-second limit per feed (both feeds run concurrently), and
  cached for five minutes per Space (one minute after a failure). A feed that cannot be read
  becomes one "unavailable" line naming only the failure category, never gog's stderr. The
  `cc_space_brief` MCP tool and Run briefs do not include this section, because they cannot check
  the caller's Google read scope.
- Activity: `GoogleActivityPoller` runs every 10 minutes (first poll one minute after startup) for
  each Space with an enabled agent. It searches `is:unread is:important newer_than:1d` (at most 20
  threads) and lists timed events starting in the next 60 minutes (at most 10), and records at
  most 20 new Space activity rows per Space per poll, calendar first. The activity table's
  unique key is the dedupe: mail rows use source id `gmail:<threadId>:<messageCount>` (a new reply
  is announced again), event rows `calendar:<eventId>:<startIso>` (a moved event is announced
  again). These rows use source kind `run` and event sequence 0, which keeps them out of the
  activity reactor's resume cursors. Quiet hours, debounce, and the daily wake cap stay with the
  wake loop. A failing feed (gog missing, connection unavailable, timeout) is logged once per
  failure streak and skipped.

gog v0.15.0's `gmail search` returns threads (thread id, newest date, first sender, subject,
labels, message count) without a snippet, so neither surface shows message text.

Live smoke tests are deliberately opt-in. They should cover only search, retrieval, agenda,
availability, conflict detection, listing, and metadata/export reads, plus negative checks proving
that send, update, share, and delete commands are unavailable.
