# Sales pipeline

The sales pipeline is an optional Command Center Space feature. It is disabled unless a private Space configuration contains:

```json
{
  "features": { "salesPipeline": true }
}
```

Existing Spaces retain their prior contract and interface. When enabled, web and desktop show a Pipeline destination and mobile shows a compact grouped Pipeline screen.

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

Keep the dedicated Google connection and sales automations disabled during deployment. Use the worktree-local `.t3` runtime for the first prospect → qualification → exact approval → Gmail draft → manual send → reply/no-reply smoke test. Enable the private connection and automations only after the smoke test succeeds.
