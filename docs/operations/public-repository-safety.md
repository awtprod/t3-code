# Public repository safety

Command Center application code is designed to be public. Operator configuration and runtime data
belong elsewhere:

- Commit generic application code, schemas, tests, and fictional examples to this repository.
- Store Space definitions, repository mappings, prompts, and automation definitions in a separate
  private configuration repository.
- Store credentials, databases, memory, transcripts, logs, attachments, and worktrees in the runtime
  directory outside Git.

The repository has two complementary checks:

1. Gitleaks scans Git history in CI using an action and scanner version pinned in the workflow.
2. `vp run public:check` scans the current change and every historical revision after the pinned
   upstream baseline for private paths, account addresses, private network URLs and URL credentials,
   sensitive file types, high-confidence credentials, and operator-defined terms. A private value
   that was committed and later deleted still fails the check.

Generated dependency lockfile contents receive the private-URL and operator-denylist checks; their
remaining contents are left to Gitleaks because package locators resemble account addresses. Their
paths and all source configuration remain covered by the boundary check.

The same boundary check and Gitleaks v8.30.1 run against staged files before each commit. The hook
refuses a different Gitleaks version; set `COMMAND_CENTER_GITLEAKS_BINARY` when the pinned executable
is not on `PATH`. Staged content is read from Git's index rather than the potentially different
working copy. The upstream baseline lives in `.command-center-public-baseline` and must only be
advanced as part of a reviewed upstream-sync change.

Database files, generic logs, JSONL/NDJSON records, and transcript data are blocked by both ignore
rules and the path scanner. The scanner also rejects operator home directories, Linux root home
directories, Windows drive paths, Windows network paths, private IP ranges, local DNS names,
non-placeholder Tailscale hostnames, credential-bearing URL user information, and SCP-style Git
remotes using private hosts. Use IANA example domains, `.invalid`, TEST-NET addresses, loopback, or
explicit placeholders in public fixtures and documentation. The conventional credential-free `git`
username remains valid for SSH/Git URLs and SCP-style remotes using public hosts.

`.gitleaksignore` contains only exact false-positive fingerprints inherited from the pinned public
T3 Code baseline. Never suppress a Command Center finding: investigate it, remove it from history,
and rotate any exposed credential.

## Private denylist

Names and identifiers that should not appear publicly must not be written into this repository just to
configure the scanner. Supply them privately in either of these ways:

- Set `COMMAND_CENTER_PUBLIC_DENYLIST` to newline- or comma-separated terms in the local environment
  and as an Actions secret.
- Put one term per line in `.command-center-private-denylist`. This filename is ignored by Git.

The scanner reports only the rule, file, and location. It does not print the matched value.
The exact `awtprod` identifier is excluded during parsing because it is the reviewed, deliberately
public publisher identity for Command Center. Public identity exceptions live in source control so
that adding or changing one requires code review; all other private terms continue to fail closed.
Repository maintainers must configure the `COMMAND_CENTER_PUBLIC_DENYLIST` Actions secret before
publishing or running an upstream sync. Trusted CI changes fail when that secret is absent. Fork pull
requests receive the generic safety checks without exposing the private denylist; maintainers must
run the complete private-denylist check before accepting them.

## Before publishing

Configure the local private denylist, run `vp run public:check`, confirm the Gitleaks job passes, and
inspect the complete branch history against the pinned baseline. If a real credential or private
identifier was ever committed, remove it from history and rotate any exposed credential; deleting it
in a later commit is not sufficient.
