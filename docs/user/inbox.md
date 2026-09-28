# Inbox

Inbox is the default Command Center workspace for decisions, questions, proposed changes, useful results, and incidents that need attention. Each item has a durable URL, so browser Back and Forward work normally and a specific item can be bookmarked or shared.

Use the Space menu to view one Space or all Spaces. **Actionable** excludes completed and canceled items. **Recent** includes completed results as well as dismissed items. **Snoozed** follows the environment's current server state, including wake-time expiry. Command Center reads each Space independently and loads more items on demand; counts with a plus sign describe only the loaded page, and an empty Space remains empty instead of showing sample activity.

An Inbox link stays attached to its selected environment, Space, and item when that environment is offline. The page shows the connection or reconnect error without silently opening the same path against another environment.

## Review an item

Select an item to see why it exists, when its source was captured, the business subject it affects, and the evidence attached to its current proposal. If the item is connected to a Run or thread, use the links near the title to open the real work.

The reply box is near the top of the item:

- **Comment** saves your message exactly as written. It does not approve, dismiss, or change the proposal.
- **Request changes** saves the same durable feedback and blocks the current proposal until the request is explicitly resolved.

Unsent replies are kept separately for each environment, authenticated session, Space, and item. They survive navigation and reload when the selected environment supplies an authenticated draft scope. Older servers that do not supply that scope keep drafts in memory for the current page instead of sharing them under a fallback identity.

If a save response is inconclusive, Inbox retains the exact submitted text, intent, item version, and request identity. Retrying reuses that request so the server can recognize a save that already landed, while newer text in the editor remains untouched. A version conflict is handled separately: Inbox keeps the draft and asks you to reload and explicitly submit against the newly reviewed version; it never silently changes the expected version.

## Revise a proposal

Choose **Edit proposal** to prepare a direct revision. If no proposal exists yet, **Create first candidate** provides a structured task-patch starter. Task proposals expose their target and every field with exact before and after JSON values, including booleans. Prepared actions expose their action kind, target, and every named parameter. Human summaries and older before/after notes are labeled as context; the structured payload is the authoritative effect. The evidence identity stays attached to the candidate.

Creating a candidate does not replace the current proposal. Review its exact structured effect, then choose **Accept revision** to make it current or **Discard** to keep the previous proposal. Accepted, superseded, and discarded revisions retain that same structured effect, evidence, and actor in history. Accepting a revision only edits the proposal—it does not authorize or execute the action. Change requests remain blocking until someone marks each one resolved.

Some Inbox items cannot be executed yet. In that case, Inbox explains the limitation and continues to support discussion and revision instead of showing an approval button that cannot work.

For an accepted Gmail draft proposal backed by current local Item evidence, **Approve draft** is a separate action. It creates the exact addressed draft in the connected Gmail account and never sends it. Pending candidates, change requests, closed Items, and stale evidence block approval. Inbox shows the resulting Gmail draft ID when verified. If Gmail's response is inconclusive, Inbox shows a reconciliation state and will not automatically attempt another draft; check Gmail Drafts before taking further action.

## Snooze, dismiss, and reopen

Snoozing requires a future wake time. Snoozed items remain available in the Snoozed view and can be unsnoozed at any time. Dismissed items move to Recent and retain their discussion and proposal history. Reopening a dismissed item returns it to Actionable; it does not repeat any external action that may already have happened.

Older discussion and proposal history is loaded in pages with **Load earlier history**.

Threads and **New thread** remain available from the sidebar. The earlier command workspace is available under **Command**.
