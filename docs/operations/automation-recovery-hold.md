# Automation recovery hold (deploying the lease and audit fixes)

Before the automation audit fix (#126), approving, declining, failing or recovering an
approval-gated automation could fail with `CommandCenterAuditReplayConflictError`. Those failures
left durable runtime executions that a newer build will pick up on its **first recovery tick,
immediately at start**. An approved Inbox Gmail draft run, for example, could then create its draft
for an approval that previously showed an error.

This runbook keeps that from happening by surprise. A human runs every step; nothing here is
automated. All inventory commands are read-only.

## 1. Set the hold before the new build starts

With `COMMAND_CENTER_AUTOMATION_RECOVERY_HOLD=true`, an execution that was created before the
process started (a "held" execution) is left exactly as it is:

- recovery does not resume it, or apply decisions or agent results to it;
- opening it in the UI does not apply its decision;
- a new admission that coalesces onto it (a schedule, a webhook, a manual run) does not drive it.

Some things still happen while the hold is set:

- **Explicit decisions:** an approval you explicitly decide on a held run is recorded, and the run is
  marked queued, but it does not run until the hold is lifted.
- **New work:** executions created after the start run normally, including retries, delays and
  agent waits handled by recovery.
- **Inbox drafts:** approving a new Inbox Gmail draft is refused while another draft run (held or
  not) is still active in that Space. Nothing is approved or bound by the refused attempt.

Unset, `false`, `0`, `no`, `off` and `n` mean not held. Any other value holds, so a typo fails
closed rather than releasing anything or stopping the server from starting.

On the server host, as root, before installing the new release:

```bash
install -d -m 0755 /etc/systemd/system/command-center.service.d
printf '[Service]\nEnvironment=COMMAND_CENTER_AUTOMATION_RECOVERY_HOLD=true\n' \
  > /etc/systemd/system/command-center.service.d/recovery-hold.conf
systemctl daemon-reload
systemctl show command-center -p Environment | tr ' ' '\n' | grep RECOVERY_HOLD
```

Expected output: `COMMAND_CENTER_AUTOMATION_RECOVERY_HOLD=true`. Then install and restart the new
release as usual, and confirm the log line:

```bash
journalctl -u command-center --since -5min | grep -E 'recovery-(held|coordinator-started)'
```

The output must include the `command-center.automation.recovery-held` warning. The log's fields are
printed on the lines after each message, so `grep -A4 recovery-coordinator-started` shows
`held: true`.

## 2. Inventory what recovery would touch (read-only)

Run as the service user. The database is opened read-only (`mode=ro`); the script cannot write.

```bash
sudo -u commandcenter python3 - <<'PY'
import sqlite3
db = sqlite3.connect("file:/var/lib/command-center/runtime/userdata/state.sqlite?mode=ro", uri=True)
queries = {
    # Would be driven on the first tick: queued/running, or retry/delay waits.
    "resumable executions": """
        SELECT e.id, e.automation_id, e.state, e.updated_at, e.lease_owner, e.lease_expires_at
        FROM command_center_automation_executions e
        WHERE e.state IN ('queued','running','waiting_retry','waiting_delay')
        ORDER BY e.updated_at""",
    # A decision committed, but the run never resumed (the pre-fix failure mode).
    "decided approvals not applied": """
        SELECT a.id, a.status, a.decided_at, e.id AS execution, e.state
        FROM command_center_approvals a
        JOIN command_center_automation_executions e ON e.id = a.run_id
        WHERE a.action_kind = 'automation.run'
          AND a.status IN ('approved','declined','expired','canceled')
          AND e.state = 'waiting_approval'""",
    # Waiting for approval but no gate was ever projected (now re-projected).
    "unprojected approval gates": """
        SELECT e.id, c.node_id, e.updated_at
        FROM command_center_automation_executions e
        JOIN command_center_automation_node_checkpoints c
          ON c.execution_id = e.id AND c.state = 'waiting_approval'
        WHERE e.state = 'waiting_approval' AND NOT EXISTS (
          SELECT 1 FROM command_center_approvals a
          WHERE a.id = 'automation-approval:' || e.id || ':' || c.node_id)""",
    # Waiting on a child agent Run; resolved and driven on, once the hold lifts.
    "waiting on agent runs": """
        SELECT e.id, e.automation_id, c.node_id, c.resume_key, e.updated_at
        FROM command_center_automation_executions e
        JOIN command_center_automation_node_checkpoints c
          ON c.execution_id = e.id AND c.state = 'waiting_external'
        WHERE e.state = 'waiting_external'""",
    # Steps interrupted mid-run. Unsafe kinds will be failed closed, not re-run.
    "interrupted steps": """
        SELECT c.execution_id, c.node_id, c.node_kind, c.attempt_count, c.started_at
        FROM command_center_automation_node_checkpoints c
        JOIN command_center_automation_executions e ON e.id = c.execution_id
        WHERE c.state = 'running'
          AND e.state NOT IN ('succeeded','failed','canceled')""",
    # Gmail draft receipts that are not settled. 'approved' ones would draft on resume.
    "unsettled Gmail draft receipts": """
        SELECT item_id, revision_id, status, account_alias, connection_id, updated_at
        FROM command_center_inbox_gmail_drafts
        WHERE status IN ('approved','creating','uncertain')""",
}
for title, sql in queries.items():
    rows = db.execute(sql).fetchall()
    print(f"== {title}: {len(rows)}")
    for row in rows:
        print("  ", row)
PY
```

All six counts at zero means there is nothing to decide: go to step 4.

## 3. Decide each listed execution

For every row, decide with the people who own that automation. None of these actions are taken
by the build on its own while the hold is set.

- **Requested approvals:** declining one cancels its run.
- **Resumable executions, decided approvals, and agent waits:** there is currently **no supported way to
  cancel a run that is already past its approval**. If such a run must not happen, keep the hold set
  and raise it before lifting; do not edit the database by hand. If it should still happen, leave
  it. It resumes when the hold is lifted.
- **Unsettled Gmail drafts:** `approved` will create the draft when resumed. `creating` and
  `uncertain` are never retried automatically; check the account's Gmail Drafts and reconcile the
  Inbox item by hand.
- **Interrupted steps:** steps whose kind cannot be safely repeated (scoped shell, prospect
  evaluation and notification, and connector writes other than the Inbox Gmail draft) are failed
  with "outcome is unknown" instead of being run again. Check the external system for the effect
  before retrying the automation.

## 4. Lift the hold

```bash
rm /etc/systemd/system/command-center.service.d/recovery-hold.conf
systemctl daemon-reload
systemctl restart command-center
journalctl -u command-center --since -5min | grep -E 'recovery-(held|coordinator-started|tick)'
```

There must be no `recovery-held` warning. `recovery-tick` lines then report what was resumed.
Afterwards, list any step that was failed closed, so its external effect can be checked:

```bash
sudo -u commandcenter python3 -c "
import sqlite3
db = sqlite3.connect('file:/var/lib/command-center/runtime/userdata/state.sqlite?mode=ro', uri=True)
for row in db.execute(\"SELECT id, automation_id, finished_at, error FROM command_center_automation_executions WHERE state = 'failed' AND error LIKE '%outcome is unknown%' ORDER BY finished_at\"):
    print(row)
"
```

## What the runtime guarantees, and what it cannot

- **One executor per step:** a live lease is exclusive, even between two resumers that share an
  owner name.
  - A running step renews its lease every third of the 30 s lease. A transient renewal error is
    retried while the lease is valid.
  - If the lease is lost, the step is asked to stop and nothing it produces is committed; every
    commit is fenced by the lease token.
  - Stopping is cooperative: a call that already left the process (for example a spawned CLI
    request) may still complete.
- **Requests and shutdown:**
  - A step runs on the server's lifetime, so a closed browser tab or cancelled request does not
    interrupt it, and its result is recorded even with no one waiting.
  - On shutdown, in-flight steps get up to 20 s to finish. A step still running after that is
    interrupted; on restart it is re-run if safe, or failed closed.
  - Check the "interrupted steps" inventory and avoid restarting while long unsafe steps run.
- **Late finish:** a step that finishes after its lease expired, because the process stalled and
  could not renew, is not committed even when no other worker took over. If its kind is unsafe, it
  is failed closed on recovery.
- **Unknown-outcome incidents:** an incident for a step whose outcome is unknown is never closed
  automatically by a later success of the same step. A human resolves it.
- **Not exactly-once for external effects:** a worker that is killed, or stalls past its lease,
  after an external call left the process cannot be fenced after the fact. Only kinds that are
  safe to repeat are re-run after an interruption: pure steps, reads, executors keyed by the
  durable per-attempt idempotency key or a deterministic command, and the claim-protected Inbox
  Gmail draft. Every other kind fails closed for a human to reconcile.
