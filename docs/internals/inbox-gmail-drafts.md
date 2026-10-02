# Inbox Gmail draft executor

An accepted Inbox revision only selects a proposal. `cc.inbox.draft.approve` is a separate authenticated command. It binds the current revision, exact payload and local Item evidence, Space, connection, and resolved Google account to a durable receipt. The existing automation `approval` node then gates one `connector.write` node. The write creates a Gmail **draft** and records its ID; it never sends mail.

Each Space using this path needs exactly one enabled, committed manual automation with this shape. This example is deliberately disabled and is **not** installed in production. Replace `example-space` with the target Space ID and commit the resulting definition through the normal Automation definition flow after the Google connection grants `cc.connections.google.gmail.drafts.create`.

```json
{
  "$schema": "../schemas/automation.schema.json",
  "schemaVersion": 1,
  "id": "inbox-gmail-draft",
  "name": "Create approved Inbox Gmail draft",
  "spaceId": "example-space",
  "enabled": false,
  "trigger": { "kind": "manual" },
  "nodes": [
    { "id": "approve", "kind": "approval", "config": { "approvalKey": "inbox-gmail-draft" } },
    {
      "id": "create-draft",
      "kind": "connector.write",
      "config": { "operation": "gmail.draft.create", "source": "inbox.accepted" }
    }
  ],
  "edges": [{ "from": "approve", "to": "create-draft" }],
  "layout": {
    "nodes": { "approve": { "x": 80, "y": 120 }, "create-draft": { "x": 360, "y": 120 } }
  },
  "policy": { "requireApprovalForExternalWrites": true }
}
```

The `connector.write` config intentionally contains no recipient, body, attachment, or connection. These come only from the accepted Inbox revision. The backend rejects a missing or ambiguous template, stale Item evidence or revision, changed recipient, revoked capability, changed account, and non-owned attachment. A `creating` receipt prevents duplicate delivery. An unverified connector response becomes `uncertain`; it requires reconciliation with Gmail Drafts rather than an automatic retry.

For isolated browser verification, use a disposable worktree server and database. Create a local Item in an active Space, then a direct Inbox candidate with a `prepared-action` payload whose `actionKind` is `gmail.draft.create`, `target` is `{ "kind": "command-center-item", "id": "<item ID>" }`, and `parameters` is a valid `GoogleDraftCreateRequest` for that Space and a test connection. Its evidence must be `{ "source": "command-center-item", "subjectId": "<item ID>", "version": "<Item updatedAt>" }`. Accept the candidate and open that exact Item URL. The **Approve draft** control appears separately from **Accept revision**. Without the enabled template or a granted test connection, the command must fail clearly and must make no Gmail request. For a positive executor test, inject a fake `GoogleReadConnector` into the isolated server test layer and assert one `draftId` receipt; do not use a real account for synthetic verification.
