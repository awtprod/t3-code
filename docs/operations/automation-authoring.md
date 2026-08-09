# Automation authoring

Command Center reads and runs committed automation definitions on every supported server platform.
Local automation creation and editing have a narrower v1 deployment boundary: authoring is enabled
only on Linux when a trusted system Python interpreter and `renameat2(RENAME_EXCHANGE)` are
available.

The desktop or web client does not need to run on Linux. The Automations screen's **Runs on**
selector scopes definition reads, creates, saves, and subsequent runs to one connected environment.
A Windows client can therefore author against a paired Linux server; the Linux server owns the
private configuration checkout, performs the atomic commit, and runs the committed automation.
Changing environments discards no saved data, and the selector is disabled while the current editor
has unsaved changes so a draft cannot cross environment boundaries.

Save and autosave are durability actions, not readiness gates. Incomplete step configuration,
unfinished schedules, and graph validation issues are committed so authoring work is not lost.
Those issues remain visible in the editor, and execution validation still prevents an unfinished
definition from running successfully. Invalid storage shapes and credential- or host-path-shaped
private data remain rejected rather than being written to Git.

## Preflight

Before the editor offers a local save, the server verifies all of the following:

- the host platform is Linux;
- `/usr/bin/python3` resolves within `/usr/bin`;
- the interpreter and `/`, `/usr`, and `/usr/bin` share the trusted system owner and none is
  group- or world-writable;
- isolated Python (`-I -S`) can complete a temporary `RENAME_EXCHANGE` probe through libc.

The Automations screen reports a failed preflight and disables local create/save controls. Viewing
committed definitions and running committed automations remain available. The filesystem-specific
exchange is checked again at every save and fails closed if the checkout filesystem does not support
the primitive.

Committed definitions are resolved from the checkout's `HEAD` tree by their definition identity,
not by assuming the JSON filename matches the automation id. Read-only viewing therefore also works
from a detached checkout; creation and editing still require a checked-out named branch.

## Atomic publication and recovery

Authoring stages exact service-decoded bytes under `.git/command-center-recovery/<transaction>/`. A
scrubbed, bounded helper opens both the automation parent and recovery directory with
`O_DIRECTORY | O_NOFOLLOW`, pins their device/inode identities, and exchanges the staged and working
files with one dirfd-relative `RENAME_EXCHANGE` operation. The target pathname is never absent.

Before the exchange, the helper writes and fsyncs an immutable `*.prepared.json` manifest. It hashes
and fsyncs both complete files and retains independent `O_EXCL` byte copies in the recovery
transaction. The source is verified stable across each copy and the destination is rehashed, so a
later write through an already-open source descriptor cannot alter recovery evidence. The helper
then exchanges the files, revalidates both inodes and digests, verifies both canonical directories
still identify the pinned descriptors, and fsyncs both parent directories. A validation failure
compensates only while the canonical entry is still the transaction-owned inode; the exact
displaced object is restored and the result is post-verified. Otherwise the helper preserves a
conflict for manual recovery.

The recovery root is mode `0700`. Command Center fsyncs a newly created recovery-root inode and its
entry in `.git`, then fsyncs each transaction inode and its entry in the recovery root before that
transaction is used. This keeps the recovery pathname durable across an unclean shutdown when the
working-file exchange itself has already reached stable storage.

New automation files use the same trusted transaction helper with a no-replace path. It creates and
fsyncs the staged inode inside pinned recovery storage, writes an independent recovery copy and a
prepared manifest, then publishes with dirfd-relative `RENAME_NOREPLACE` and fsyncs both parents. If
later create processing fails, the helper moves only the identity-bound authored inode into a new
recovery transaction; it never unlinks a shared pathname. A concurrent replacement is retained in
place and the recovery transaction is left for review.

The private checkout index follows the same durability boundary. The helper creates `index.lock`
with `O_EXCL` through the pinned `.git` descriptor, writes and fsyncs it, independently copies both
old and new indexes into recovery, and publishes with `RENAME_EXCHANGE`. It fsyncs `.git` immediately,
then moves the displaced old index into recovery with `RENAME_NOREPLACE` and fsyncs both parents.
Compensation is identity-bound and never overwrites a concurrent index winner. Every authoring Git invocation uses a trusted
absolute Git executable, requires Git 2.36 or newer, disables hooks/fsmonitor/untracked-cache, and
sets `core.fsync=all` plus `core.fsyncMethod=fsync` so Git objects, indexes, and refs use the same
power-loss durability policy.

Once the data state and parent directories are durable and post-verified, the transaction is
logically committed before attempting its terminal manifest. Marker or stdout failure from that
point is committed-but-unreported and never initiates rollback; the prepared evidence remains
available for reconciliation.

Recovery transactions are intentionally retained inside `.git`; they are not Git-managed content,
and v1 performs no automatic pruning. Never delete prepared, conflict, rolled-back, or ambiguous
transactions. An operator may prune only an old transaction with a complete manifest after the
recorded commit, working file, and index digests have been verified and the deployment's backup
retention window has elapsed.
