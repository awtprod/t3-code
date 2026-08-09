# Sales pipeline

The sales pipeline is an optional Command Center Space feature. The feature flag controls whether the client shows the Pipeline destination, while the explicit policy capabilities control access to its operations. A minimal private Space configuration contains:

```json
{
  "connectionIds": ["sales-google"],
  "features": { "salesPipeline": true },
  "policy": {
    "allowedCapabilities": [
      "cc.sales.read",
      "cc.sales.propose",
      "cc.sales.write",
      "cc.connections.google.gmail.read",
      "cc.connections.google.gmail.drafts.create"
    ],
    "autoRunRiskLevels": ["low", "reversible"]
  }
}
```

Keep any other capabilities the Space already needs in `allowedCapabilities`; the list is authoritative rather than additive. The root configuration must define the referenced connection with both `gmail.read` and `gmail.drafts.create`; enable it first in an isolated smoke-test configuration and only later in the deployed configuration. Existing Spaces retain their prior contract and interface. When enabled, web and desktop show a Pipeline destination and mobile shows a compact grouped Pipeline screen.

## Runtime data

Prospects, activity history, outreach previews, approval digests, and Gmail identifiers are stored only in the Command Center runtime database. They are not generic Items and are never written to the code or private-configuration repositories.

The stage sequence is Researched, Qualified, Drafted, Contacted, Replied, Call booked, Proposal sent, Won, Nurture, and Lost. Agent credentials can propose Researched records. Human actions own qualification, stage changes, exact outreach approval, and Won/Lost outcomes.

## Gmail safety boundary

`GoogleDraftConnector` is separate from the existing Google read connector. Its exact command allowlist contains only `gmail.drafts.create`, `gmail.drafts.list`, and `gmail.drafts.get`; every invocation includes `--gmail-no-send`. The email body is passed through standard input.

Creating a draft is a three-step operation:

1. Command Center shows the complete recipient, subject, and body and stores their digest.
2. A human approves that exact digest.
3. The connector reconciles existing Gmail drafts before creating one, then stores the Gmail draft id.

Sending, forwarding, deleting, and mailbox modification are not exposed. The operator sends manually in Gmail. Deterministic read-only reconciliation can mark sent messages Contacted, inbound messages Replied, and prepare separate three-day and seven-day follow-up previews. Every follow-up requires a new digest-bound approval before a Gmail draft can be created.

## Activation

Configure these host-only environment variables before the smoke test:

- `COMMAND_CENTER_SALES_PROSPECTOR_DB` — the exact absolute path to the Prospector SQLite database.
- `COMMAND_CENTER_GOG_BINARY` — the exact absolute path to the pinned `gog` 0.15.0 binary described in `docs/operations/google-read-connector.md`.

The importer accepts current public-source records and legacy `manual` records only when they have an email method, high confidence, a contact-check timestamp, and a public website. Records with missing or unverifiable provenance remain excluded until Prospector is backfilled.

Keep the dedicated Google connection and sales automations disabled during deployment. Use the worktree-local `.t3` runtime for the first prospect → qualification → exact approval → Gmail draft → manual send → reply/no-reply smoke test. Enable the private connection and automations only after the smoke test succeeds. If the Pipeline destination appears but requests fail with a capability error, verify the Space policy above rather than changing the feature flag.
