# Prospect evaluation operations

`prospect.evaluate` is a server-side automation node for bounded shortlist review of existing
Prospector candidates. It does not discover or qualify leads, alter Prospector, draft or
send outreach, or qualify a lead by itself. Keep the automation disabled until the runtime profile
has been provisioned and a fixture run has been reviewed. An empty-memory cold start is valid;
Andrew-approved seed memories are a quality recommendation before enabling a real schedule.

## Runtime profile

The automation config contains only a profile name and a limit. The named profile is an encrypted
Command Center credential at `prospect-evaluation.profile.<name>`. Provision its UTF-8 JSON value
through `CommandCenterCredentialStore.set` from a trusted server-side provisioning context; do not
write this document into the private automation repository or an automation node.

The exact v1 profile shape is:

```json
{
  "schemaVersion": 1,
  "spaceId": "prospect-space",
  "prospectorDbPath": "/absolute/path/to/prospector.sqlite",
  "gatewayApiKey": "<AI_GATEWAY_API_KEY>",
  "supabaseUrl": "https://awbefohirbesfpouwirt.supabase.co",
  "supabaseServiceRoleKey": "<SUPABASE_SERVICE_ROLE_KEY>",
  "embedding": {
    "provider": "google-gemini",
    "model": "gemini-embedding-2",
    "dimensions": 768,
    "apiKey": "<GEMINI_API_KEY>"
  }
}
```

For example, the profile name `prospect-primary` resolves only
`prospect-evaluation.profile.prospect-primary`. The Space ID must exactly match the automation's
Space. The database path must be absolute. The Supabase URL, gateway endpoint, embedding origin,
provider, model, and dimension are fixed by v1 and cannot be overridden. Extra profile or node
fields are rejected. CredentialStore's master encryption key must already be configured.

The Prospector database account needs filesystem read access, not write access. The connector opens
SQLite with `readOnly: true`, selects at most 501 rows to prove whether its 500-row scan bound was
reached, and closes the handle after every cycle. It selects current pipeline candidates only,
excluding skipped, contacted, sent, and suppressed records. A scan-bound exhaustion fails visibly
instead of silently starving later candidates.

## Seed Open Brain

Open Brain starts empty. Seed Andrew-approved lead-review criteria before enabling a real schedule:

1. Write each criterion or example as a short standalone document. Label its metadata
   `kind: "human_policy"`, `scope: <exact spaceId>`, `project: "prospect-review"`, and include
   its source and effective date. Model observations must never use `human_policy`.
2. Generate an embedding with the profile's Google endpoint and model, requesting
   `output_dimensionality: 768`. Reject any response that is not exactly 768 finite numbers.
3. Call the fixed Supabase `upsert_thought(content, payload)` RPC with `{ content, payload:
{ metadata } }`; do not put the embedding in the RPC payload. Validate that the response contains
   a UUID `id` and a non-empty `fingerprint`.
4. `PATCH /rest/v1/thoughts?id=eq.<returned UUID>` with an `embedding` containing exactly 768
   finite numbers, and require the update to succeed.
5. Confirm `match_thoughts` returns the seeded ID only when filtered by the same Space and project.

There is no general-purpose seed CLI in this slice. The supported pathway is the existing Open Brain
RPC from trusted server-side provisioning code. Empty memory remains valid and is explicitly stated
in every resulting Item; it is not represented as an error or as hidden context.

## Disabled automation example

The source below is intentionally disabled. Replace only the non-secret Space and static route IDs,
commit it through the existing automation authoring flow, then enable it after fixture review.

```json
{
  "schemaVersion": 1,
  "id": "daily-prospect-shortlist",
  "name": "Daily prospect shortlist review",
  "spaceId": "prospect-space",
  "enabled": false,
  "trigger": {
    "kind": "schedule",
    "expression": "0 9 * * 1-5",
    "timezone": "America/New_York"
  },
  "nodes": [
    {
      "id": "evaluate",
      "kind": "prospect.evaluate",
      "config": { "profile": "prospect-primary", "limit": 10 }
    },
    {
      "id": "notify",
      "kind": "prospect.notify",
      "config": {}
    }
  ],
  "edges": [{ "from": "evaluate", "to": "notify" }],
  "layout": {},
  "policy": {}
}
```

`prospect.notify` is a separate durable retry checkpoint after evaluation. It consumes only the
evaluator's actionable decision Item IDs; an empty actionable batch succeeds without contacting the
relay. Notification content and evaluation identity are derived from the persisted Items, never from
node data. This example has no `agent.run`, draft, or outreach path.

## Pause, resume, and recovery

Use the existing automation `enabled` control to pause and resume the schedule: save `enabled: false`
to pause admission, and save `enabled: true` to resume. The schedule runner queries only committed,
enabled definitions. Disabling does not delete Items, executions, retry checkpoints, or the schedule
cursor. Existing automation retries remain capped by the durable runtime; the connector performs no
private retry loop.

Every candidate outcome creates a deterministic Command Center Item. `review` and `investigate`
become `decision` Items in `review`; confident `ignore` and `defer` become `task` Items in `done` so
the review UI can exclude them. Creation starts at `captured`, then moves to the intended status.
Replay repairs an interrupted `captured` record but never overwrites a later human status. Subsequent
cycles save human transitions as idempotent Open Brain review feedback. A feedback or observation
write failure keeps the node retryable and observable.

## Deployment prerequisites

Before enabling a real schedule, verify all of the following:

- the server runtime includes `node:sqlite` and can read the exact Prospector database path;
- the CredentialStore encryption key and named profile are present;
- the profile Space exactly matches the automation Space;
- the Prospector schema is current and includes `channels`, `sends`, and `suppressions`;
- the AI Gateway key may call `typesafe-ai/jev`;
- the Gemini key may call `gemini-embedding-2` with 768-dimensional output;
- the fixed Supabase project exposes `match_thoughts` and `upsert_thought` to its service role;
- Andrew-approved policy memories are preferably seeded and scoped before schedule enablement;
- a disposable SQLite fixture run and a bounded copied-data dry run have been reviewed.

Notification delivery requires both a Command Center server deployment and a separate relay endpoint
deployment. Server changes require the normal rebuild before restart. Deployment and live-path
verification are outside this implementation slice.

## Not included

This slice does not implement dynamic worker/model selection, outreach, draft creation, Prospector
evaluation tables, Prospector pipeline mutations, memory-policy authoring, or a profile/seed CLI.
Notification queuing reports its own relay result; Item creation is not notification success. A later
dynamic worker feature needs a separately reviewed route contract rather than accepting model IDs
from Jev or automation runtime data.
