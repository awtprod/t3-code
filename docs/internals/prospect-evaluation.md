# Prospect evaluation internals

The first backend slice adds one explicit automation capability, `prospect.evaluate`. It is a narrow
adapter boundary around existing systems: committed automation definitions, encrypted credentials,
the durable automation retry runtime, read-only Prospector data, Open Brain RPCs, Vercel AI Gateway
evaluation, and Command Center Items.

## Trust and authority boundaries

The committed node config is exactly:

```json
{ "profile": "prospect-primary", "limit": 10 }
```

The limit is an integer from 1 through 10. Unknown fields are rejected, so a definition cannot add a
path, URL, API key, prompt, endpoint, provider, or model. The named encrypted profile binds one exact
Space, one absolute Prospector database path, the fixed Open Brain project URL and service role, one
AI Gateway credential, and the fixed Google embedding provider/model/dimension. The connector also
checks the Space after decryption. Secrets are used only as request headers and never enter Item
descriptions, node output, or error text.

All outbound URLs are code constants. Fetch uses `redirect: "error"`, a 15-second abort signal,
96 KiB request bodies, and streaming response reads capped at 512 KiB. There is no connector-local
retry. One cycle is sequential and bounded to 10 candidate evaluations, five memory matches per
candidate, 10 feedback records, and 500 candidate rows plus one overflow sentinel. Each new
candidate makes one query embedding request, one memory RPC, one Jev request, one observation
embedding request, and one observation upsert. Existing completed fingerprints make no model call.
The resulting hard ceiling is 40 model calls per cycle: three per new/repaired candidate plus one
feedback embedding for each of the 10 bounded feedback transitions.

## Candidate selection

`node:sqlite` opens the profile database with `readOnly: true` and closes it through an Effect scope.
The query selects only existing Prospector candidates in `has_email`, `needs_email`, `qualified`,
`growth_checked`, or `ready`; it excludes skips, any contacted/sent state, and normalized email
suppressions. It selects only the fields needed to describe current Prospector evidence.

Prospector remains authoritative for qualification. The connector does not reproduce its scoring
logic and does not write its database. Existing `prospect_score`, growth, operator, solo, upload,
monetization, and descriptive thumbnail evidence are passed through with source labels. The numeric
thumbnail tier is deliberately omitted because current Prospector sources disagree about its
direction. Thumbnail notes, prompt version, and vision model remain visible.

Candidate strings are length-bounded and nullable/empty values become explicit `Not recorded`
facts. Source material and retrieved memories are nested under `contentTrust` labels in Jev state;
the route instructions and criteria remain in the separate question definition.

## Remote contracts

Google embedding uses the [documented Gemini embedding REST endpoint](https://ai.google.dev/gemini-api/docs/embeddings)
`/v1beta/models/gemini-embedding-2:embedContent` and requests
`output_dimensionality: 768`. Every response must contain exactly 768 finite values.

Open Brain lookup calls `match_thoughts` with a five-result cap and metadata filter
`{ scope: profile.spaceId, project: "prospect-review" }`. Every returned record is shape-checked
and checked again for that exact scope. Zero matches is valid.

Jev uses Vercel's [documented evaluation HTTP API](https://vercel.com/docs/ai-gateway/modalities/evaluation),
the fixed model `typesafe-ai/jev`, and one `choice` question with exactly four criteria:
`ignore`, `defer`, `investigate`, and `review`. Its model name, choice, all four finite probabilities,
probability sum, and non-negative integer token usage are validated. `review` and `investigate` are
always actionable. An `ignore` or `defer` choice is promoted to `review` when its probability is
below 0.8 or its lead over the runner-up is below 0.2. Uncertainty can therefore create review work;
it cannot silently discard a candidate.

## Durable Items and replay

An Item ID is:

```text
prospect-review:<channelId>:<sha256 of bounded Prospector evidence + policy/router version>
```

The Item Markdown records known facts, their source, effective and raw routes, all probabilities,
retrieved memory IDs, model and policy versions, usage, and the explicit statement that this is a
shortlist/pass decision rather than authoritative qualification. A bounded HTML comment contains
only non-secret replay metadata.

The service boundary is the only Command Center persistence path: `queryItems`, `createItem`, and
optimistic `updateItem`. No connector SQL touches Command Center tables. Item queries are untruncated
for the exact Space so an older record cannot be hidden by a page limit. A new Item starts in
`captured`, then becomes `review` for actionable routes or `done` for no-action/defer. On replay:

- a completed identical fingerprint is skipped;
- an interrupted `captured` Item is repaired;
- a pending observation upsert is retried idempotently;
- any status other than `captured` is treated as a possible human decision and is not reset.

After a successful decision, the connector embeds and upserts a `model_observation` thought. Its
content explicitly says it is not Andrew-authored policy. If this fails, the marker remains pending
and the durable automation runtime retries the node.

At the beginning of a later cycle, statuses `done`, `canceled`, `waiting`, and `review` that differ
from the marker's last recorded status are embedded and upserted as `review_feedback`. After the RPC
succeeds, an optimistic description-only update advances the marker without changing the human
status. A later reversal is therefore another feedback transition. RPC or optimistic-concurrency
failure stays retryable; successful upserts are idempotently repeatable.

## Output and downstream work

The node returns only a small aggregate:

```json
{
  "evaluatedCount": 2,
  "actionableCount": 1,
  "itemIds": ["prospect-review:..."],
  "investigateCount": 1,
  "investigateItemIds": ["prospect-review:..."],
  "reviewCount": 0,
  "noActionCount": 1,
  "skippedExistingCount": 4,
  "feedbackCount": 1,
  "feedbackRemaining": 0
}
```

This is suitable for `condition`, `transform`, or a statically routed `agent.run`. It contains no
credentials, raw candidate payload, memory content, dynamic model route, or notification claim.

## Deliberate gaps

There is no notification transport, dynamic worker selection, outreach, Prospector write adapter,
new database migration, or memory/profile provisioning CLI. Open Brain must be seeded separately.
Any future Prospector promotion must be an explicit reviewed action and must not make Jev's shortlist
route silently authoritative over `pipeline_status`.
