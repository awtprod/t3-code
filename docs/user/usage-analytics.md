# Usage and prompt-cache analytics

Open **Settings → Usage** on web or desktop, or **Settings → Usage** on mobile. The page is scoped to
the selected environment and defaults to 30 days, with 7-, 30-, 90-day, and custom ranges.

Usage is recorded per turn component. The main agent is one component and every native subagent is a
separate component, so provider, model, project, thread, workload, and automation totals include each
component exactly once. Replayed provider events update the same durable row instead of duplicating it.

Token categories are:

- uncached input;
- provider cache reads;
- provider cache creation or writes;
- output, with reasoning output treated as a subset of output;
- context use, duration, and tool use when reported.

Missing provider metrics are **Unavailable**, not zero. A partial coverage label means the upstream
runtime did not expose every category. Existing context-window history is backfilled as partial and
does not invent cache or cost values.

Cache utilization is cache-read input divided by uncached input plus cache reads plus cache writes.
Cache savings is calculated only when both cached and uncached input rates are known.

## Costs and prices

Provider-reported USD cost wins when available. Otherwise T3 Code computes an API-rate estimate from
the effective-dated price table. Subscription and OAuth usage is labeled **API-equivalent estimate**;
it is not an assertion about a subscription bill. Unsupported and custom models remain **Price
unavailable** until an override is configured. T3 Code does not convert currencies or estimate fees
that the provider does not report, such as web-search charges.

The bundled Kimi K3 record effective July 2026 uses $3.00 per million uncached or cache-created input
tokens, $0.30 per million cache-read input tokens, and $15.00 per million output tokens. Override
precedence is provider instance plus model, then provider driver plus model, then the built-in rate.

## Provider limitations

- Codex preserves its native thread and reports cache-read counters.
- Claude preserves cache-read and cache-creation counters separately and may report cost directly.
- Kimi preserves native sessions and reports read/write cache events and subagent usage.
- Cursor, Grok, and OpenCode preserve their native sessions. Cache and detailed token fields appear
  only when the installed runtime exposes trustworthy telemetry.

T3 Code deliberately has no separate prompt-response cache. A second cache could preserve stale tool
results, leak data across projects, and duplicate the providers' own prefix caches.
