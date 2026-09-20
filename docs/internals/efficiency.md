# Model efficiency

> For maintainers. This subsystem picks the smallest model that fits a task and,
> optionally, trims tool output the task does not need. Everything below is
> **off by default**; with defaults, behavior is byte-for-byte identical to a
> build without it.

The efficiency subsystem has four parts:

1. **Routing tiers** — deterministic selection of a provider/model per turn.
2. **The Judge** — one service that asks a cheap model typed questions and gets
   calibrated probabilities back.
3. **Confidence-gated tier judgment** — an optional judge call that can nudge the
   routed tier.
4. **The tool-result sieve** — an optional judge-driven trim of large tool
   results before they reach the agent (Claude provider).

Settings live in [`packages/contracts/src/efficiency.ts`](../../packages/contracts/src/efficiency.ts)
under `ServerSettings.efficiency`; the UI is
[`apps/web/src/components/settings/EfficiencySettings.tsx`](../../apps/web/src/components/settings/EfficiencySettings.tsx).

## Routing tiers

`efficiency.enabled` turns on automatic routing for threads whose routing mode is
`auto`. Three tiers — `economy`, `balanced`, `quality` — each map to a list of
`candidates` (`instanceId` + `model` + optional provider options). The pure
resolver [`resolveInteractiveEfficiency`](../../apps/server/src/efficiency/EfficiencyRouting.ts)
picks the tier, then the first healthy enabled candidate for that tier, falling
back to the caller's model when none is available.

**Tier precedence** (highest wins):

1. an explicit `rule` match (operator intent — always wins);
2. a confidence-gated **judgment** (see below);
3. the command's `efficiencyTier`;
4. the thread's `efficiencyTier`;
5. `defaultTier`.

The resolver is pure and synchronous and runs in
[`CommandDispatcher`](../../apps/server/src/orchestration/CommandDispatcher.ts)
immediately before dispatch, and in the `efficiencyPreviewDecision` RPC
([`ws.ts`](../../apps/server/src/ws.ts)) for the settings-page preview. The
resulting `EfficiencyDecision` persists on the turn
(`turns.efficiency_decision_json`).

`contextThresholds` and `toolWarnings` are advisory display thresholds per tier;
`experiments` opt a fraction of new threads into an A/B tier comparison.

## The Judge

[`apps/server/src/efficiency/Judge.ts`](../../apps/server/src/efficiency/Judge.ts)
is an Effect `Context.Service` with one method, `ask`, and a live `enabled`
flag. It has three transports, chosen by `efficiency.judge.transport`:

- **`off`** (default): `enabled` is `false` and `ask` fails with
  `JudgeError{reason:"disabled"}`. Every consumer treats that as "no judgment"
  and falls through to today's behavior.
- **`typesafe`**: posts to `https://api.typesafe.ai/v1/systemone` with the
  TypeSafe System One protocol verbatim. The key is read from the env var named
  by `apiKeyEnv` (default `TYPESAFE_API_KEY`); it is never logged. TypeSafe
  returns typed answers with probabilities and a confidence, which we validate
  and pass through.
- **`openai-compatible`**: posts one `/chat/completions` request with a
  `response_format: json_schema` asking the model for **raw probabilities** per
  question. `choice`, `score`, and `confidence` are then computed **in code** —
  the model is never trusted to compute them. Defaults: base URL
  `http://127.0.0.1:8317/v1` (the host's cliproxyapi gateway, same as Prism),
  model `glm-5.3-flash`, key env `COMMAND_CENTER_JUDGE_API_KEY`. `resolveJudgeConfig`
  applies these gateway defaults when the operator left the TypeSafe defaults in
  place.

### Question and answer shapes

Three question types (`noul`, `choice`, `score`) and their matching answers are
defined at the top of `Judge.ts`. `noul` returns a single probability; `choice`
returns a probability per named option; `score` returns a probability per rubric
level.

### Confidence formula

Confidence is `1 − normalized entropy`. For a normalized distribution `p` over
`n` outcomes, Shannon entropy `H = −Σ pᵢ·ln(pᵢ)` (with `0·ln0 = 0`) divided by
`ln(n)` scales to `[0, 1]`; confidence is the complement:

- a one-hot distribution → entropy 0 → **confidence 1**;
- a uniform distribution → entropy `ln(n)` → **confidence 0**;
- `n ≤ 1` → **confidence 1** (nothing to be uncertain about).

`score` is the probability-weighted level index `Σ i·pᵢ`; `choice` is the
argmax option. See `confidenceFromDistribution` / `weightedScore` /
`argmaxIndex`, tested with fixed distributions in
[`Judge.test.ts`](../../apps/server/src/efficiency/Judge.test.ts).

### Bounds, usage, and the decision log

- **Bounded**: per-attempt timeout (default 15 s, one retry on 429/529 with
  backoff); `maxStateChars` (default 120 000) is refused rather than truncated;
  responses are validated at the boundary (malformed or missing answers →
  `JudgeError`, never a partial answer).
- **Usage**: every call writes a row to `internal_generation_usage` with
  `operation = "judge.<operation>"` (the same table
  [`TextGeneration`](../../apps/server/src/textGeneration/TextGeneration.ts)
  uses), priced from the `jev-latest` entry in `LOCAL_RATE_OVERRIDES`
  ([`usagePricing.ts`](../../apps/server/src/usage/usagePricing.ts): $0.042 / 1M
  input, output free — <https://docs.typesafe.ai/models>).
- **Decision log**: one JSON line per call to
  `<server userdata dir>/efficiency/judge-decisions.jsonl`, rotated to `.1` at
  20 MB. This is the shadow-mode evidence trail (operation, model, latency,
  usage, question keys, answers or error, and any caller `meta`).

The layer is wired once, alongside `ServerSettingsService`, in
[`server.ts`](../../apps/server/src/server.ts) (`JudgeLayerLive`).

## Confidence-gated tier judgment

When `efficiency.tierJudgment.enabled` and the judge is enabled, each auto-routed
turn asks the judge one `score` question (`complexity`, rubric levels =
economy/balanced/quality) plus a `needs_investigation` `noul` kept only for the
decision log and later calibration. The request/answer mapping lives in
[`TierJudgment.ts`](../../apps/server/src/efficiency/TierJudgment.ts).

The mapped tier (`round(score)` clamped to economy..quality) overrides the static
tier **only** when no rule matched and `confidence >= minConfidence`
(default 0.6). The judgment — `{ score, confidence, tier, applied, reason?,
model }` — is recorded on the `EfficiencyDecision` whether or not it was applied,
so the composer preview and the persisted decision show it. **Any judge error or
a disabled judge leaves routing byte-for-byte identical to today.**

## Tool-result sieve (slice B)

The sieve (winnow) trims large tool results the task is unlikely to need, before
they reach the Claude agent. It is configured by `efficiency.sieve` and is
implemented in slice B (`apps/server/src/efficiency/ToolResultSieve.ts` plus a
`PostToolUse` hook adapter in the Claude adapter). Slice A owns the settings
shape and this documentation.

Design, as specified in `model-efficiency/DESIGN.md` §B:

- **Scope**: only tools in `sieve.tools` (default `["Read", "Grep"]`; `Bash`
  is opt-in and off — re-running it has side effects), only when the serialized
  result is at least `minChars`. `Read`/`Grep` are safe to trim because the agent
  can re-run them narrowed.
- **Blocks**: split into `blockLines`-line blocks (`b001`…), capped at
  `maxBlocks` (beyond that the result passes through unjudged). The judge is
  asked one `noul` per block ("is this block needed for the task?") plus an
  `is_error` `noul`.
- **Policy in code**: `is_error >= keepAbove` ⇒ hide nothing. A block is hidden
  only when `P(needed) < dropBelow`; `dropBelow <= P < keepAbove` is kept and
  logged as uncertain. If hidden/total chars `< minPruneRatio`, the result is
  left untouched. Any judge failure, unknown output shape, or `mode: "off"` ⇒
  untouched. The schema enforces `dropBelow < keepAbove`.
- **Modes**: `shadow` judges and logs but never rewrites; `active` rewrites.
  Hidden ranges are replaced by a short, deterministic stub telling the agent how
  to re-run the tool to recover them. Rebuilt output keeps the tool's exact shape
  (Read's `cat -n` prefixes, Grep's `file:line:`).

The sieve reuses the same `Judge` service and `efficiency.sieve` settings defined
here; see the slice B PR for the hook wiring and probe results.

## Prune-only compaction (slice C) — blocked

The idea (`fast-jev-compaction`) is to replace the SDK's compaction _summary_
with a _prune_: drop whole tool calls/results (the agent can re-run them) instead
of summarizing, keeping pinned first/newest messages, with thresholds in code and
a fallback to the built-in path on any failure.

Replacing compaction messages needs the `session.compact` **function hook**,
which requires **Claude Code ≥ 2.1.274** with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.
The SDK 0.3.170 `PreCompact` hook has no output that can replace messages.

**Status of the prerequisites:**

- The deployed provider-cli is being upgraded from **2.1.258** to **2.1.278**
  (`deploy/openclaw/install-provider-clis.sh`). The **2.1.278** binary contains
  both `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` and the `session.compact` function
  hook (verified 2026-09-20), so the prerequisite for prune-only compaction is
  now met on that binary.
- The tool-result sieve's `PostToolUse` `updatedToolOutput` rewrite is honored on
  **2.1.258 and 2.1.278 only when the replacement matches the tool's output
  shape** (Read keeps its `cat -n` line-number prefixes and continuity, Grep
  keeps `file:line:` lines) — a mismatched shape is dropped rather than applied,
  which is why the sieve rebuilds output in the tool's exact format.

The tool-result sieve (slice B) still delivers most of the same benefit upstream:
results that would later be pruned never enter context in the first place. With
2.1.278 deployed, prune-only compaction can now be built against the
`session.compact` hook (enable `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`).
