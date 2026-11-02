# Owner-bound outreach execution (inactive draft)

This change extends the existing owner-only Automation `shell.scoped` manifest with one closed outreach profile. It adds no public scheduler permission field and enables no job by itself. Ordinary jobs retain their existing filesystem, network and resource policy.

The owner entry binds an exact automation and node, source definition digest, separate persisted snapshot digest, Space/repository and executor identity. A running execution/checkpoint join, full Automation schema validation and the existing durable policy-digest comparison independently verify those bindings. The manifest reloads on each dispatch; removal denies future admissions but does not cancel an already-started child. Snapshot/config changes require owner reapproval.

Only the fixed canonical Python controller and owner-fixed input path are admitted. No caller-controlled command, initializer, legacy entrypoint, retry authority or additional persistent writable root is accepted. The canonical controller retains sender validation, weekday cap, journal serialization, opt-outs, uncertain-outcome guards and launch hold.

The retained journal is the sole persistent writable root; the existing bounded private temporary filesystem remains. Source, independently pinned controller, input overlay, credential-reference file, dynamic hold-parent directory and resolver/trust inputs are mounted read-only. Mounting the hold directory preserves creation/removal visibility. Existing host writers to the narrowly admitted controller and hold directory remain explicit integrity dependencies; read-only descriptor binds do not make host source content immutable. The profile loader does not read credential contents or create grants.

Network sharing applies only to this fixed command and shares the executor parent's namespace; it is not a destination allowlist. It cannot override enclosing filesystem/network restrictions. Ordinary jobs retain network isolation.

## Resource and activation blockers

The outreach-specific address-space ceiling and Node heap ceiling are not aggregate resident-memory limits. Existing process-group, timeout/output, CPU/process/file and disk admission controls remain, but hard per-run aggregate memory/process containment through a supported production launcher is unresolved. Do not activate this profile on the strength of resource argument tests or a separately capped synthetic fixture.

No concrete production automation/node, source/snapshot digests, input or credential-reference binding is installed by this patch. Owner approval of those exact values, required repository/Prism review, supported host-isolation evidence and a separately approved deployment are still required. No profile installation or real controller invocation is part of this draft.

## Validation and rollback

Focused source tests cover durable SQL authority, service recreation, manifest reload/revocation, malformed profiles, canonical paths and proposed sandbox arguments. Injected filesystem tests verify admission decisions. Runtime and scheduler tests exercise persistence separately. Live Bubblewrap tests were skipped; kernel enforcement, actual scheduled outreach execution and provider readiness were not verified. Independent source review does not replace required Prism review.

Before rolling back to an older binary, prevent new outreach admissions, remove only the new owner manifest entry and drain any admitted child through its supervisor. The older strict manifest schema rejects the new profile fields. Preserve all other entries, retained journal and campaign data. No database migration or automatic data restoration is introduced. Keep the launch hold and remaining campaign readiness gates intact.
