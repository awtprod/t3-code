# Space agents

A Space can have one always-on agent: a single persistent thread that keeps the
Space's memory current, acts within the Space's policy, and asks the user only
for what needs them. Agents are off unless a Space's config enables one.

## Config

The Space config file takes an optional `agent` block. It is validated when the
config loads (cron syntax, IANA timezones, bounds); an invalid block makes the
whole config invalid, like any other malformed Space file.

```json
"agent": {
  "enabled": true,
  "model": { "provider": "claudeAgent", "model": "claude-opus-5-5" },
  "checkIns": { "cron": ["30 8 * * *", "30 18 * * *"], "timezone": "America/New_York" },
  "quietHours": { "start": "23:00", "end": "07:00", "timezone": "America/New_York" },
  "dailyWakeLimit": 12,
  "debounceMinutes": 10
}
```

`dailyWakeLimit` (1–48) and `debounceMinutes` (1–120) default to 12 and 10. The
canonical block is `Space.agent` and is projected to `command_center_spaces.agent_json`.
Model resolution is `agent.model`, then the Space's `routing` default, then Opus 5.5.

## Thread and scope

- The thread id is `cc-space-agent-<spaceId>` (`SpaceAgentIds.ts`). It is not a
  `cc:` Run thread, so it is not subject to Run provider isolation.
- `SpaceAgent.sendTurn` creates the thread on first use with a bootstrap turn
  and otherwise posts to the existing thread. Every server-authored turn carries
  the Space agent role, the Space instructions, and the Space brief. Turns typed
  in the normal UI go straight to the provider; the agent refreshes context with
  the `cc_space_brief` tool.
- The MCP scope is not registered in memory. `McpSessionRegistry` asks the
  installed resolver on every credential issue, which derives the scope from the
  current config: the Space policy's `allowedCapabilities`, approved memory
  writes, and `role: "space-agent"`. It therefore survives restarts and session
  stops, and a disabled agent or archived Space resolves to no scope. Live
  credentials are re-checked against the current config on every tool call.

## Autonomy and memory

- `cc_runs_start` from a Space agent goes through `submitSpaceAgentCommand`. The
  normal route gate (`submitCommand`) decides the route. The Run is kept and
  authorized only if that gate leaves it queued and ready at a risk listed in the
  Space's `autoRunRiskLevels`. Anything else is rolled back (no Run, approval, or
  receipt) and recorded as a `decision` Item in review with `metadata.spaceAgent`.
- Agent-authorized Runs record the audit event `space-agent-run:<runId>:authorized`.
  The dispatcher reads it to start them as unattended workers, not as the user's
  router conversation.
- `cc_memory_propose` from a Space agent stores approved Memory with
  `provenance.kind = "agent"` and `sourceRef` set to the agent thread id.

## Brief

`renderSpaceBrief` (`SpaceBrief.ts`) renders approved Memory (procedure, decision,
fact, preference; newest first, about 6,000 characters), open Items (Needs You
first, about 2,000 characters), and optional recent activity (newest first, about
2,500 characters). It is empty when there is nothing to show. Every Command Center
Run prompt in the Space includes it.

## Wakes

`SpaceAgentWaker` (`SpaceAgentWaker.ts`) polls every 30 seconds. Each active Space
whose agent is enabled and not paused gets at most one server-authored wake turn
per pass. Its ledger is `command_center_space_agent_state` (migration 081), one
row per Space. A new row starts its activity cursor at the Space's newest
activity row, so older history counts as brief context, not as a wake.

- **Event wake.** New `command_center_space_activity` rows (id above the cursor)
  set `pending_since` to the oldest one's time. The wake fires once
  `pending_since + debounceMinutes` and `last_wake_at + debounceMinutes` have both
  passed, outside quiet hours, while the local day has fewer than `dailyWakeLimit`
  event wakes. Over the limit it waits for the next local day.
- **Check-in.** It fires once per `checkIns.cron` slot, outside quiet hours.
  Slots inside quiet hours are skipped. A slot missed by downtime fires only if
  it is under two hours old, and only once. The slot is persisted before the turn
  is sent, so a restart cannot send it twice. Check-ins also deliver any pending
  events and count in `wakes_today`, but not against `dailyWakeLimit`.
- **Local day.** The wake day (for `dailyWakeLimit`) uses `checkIns.timezone`,
  then `quietHours.timezone`, then America/New_York. Quiet hours use their own timezone.
- **Failures.** A busy agent (`conflict`) leaves the ledger untouched (a claimed
  check-in slot is released) and retries on the next pass. Other failures log a
  warning and back off in memory, from 1 minute doubling up to 30.
- **Delivery.** `deliverWake` is shared by the loop and the manual
  `cc.spaceAgent.wake` RPC. On success it moves the cursor to the newest row it
  delivered, clears `pending_since`, and records `last_wake_at/reason`.
- **Wake text.** It states why the agent woke, then lists up to 20 activity rows
  (newest first, about 3,000 characters, marked as untrusted data), then gives
  the allowed responses: do nothing, update memory, create or update an Item, ask
  via a decision Item, or start an in-policy Run.
- **RPCs.** `cc.spaceAgent.list` adds `paused`, `lastWakeAt`, `lastWakeReason`,
  `wakesToday`, and `pendingEvents`. `cc.spaceAgent.setPaused` (operate scope)
  stops automatic wakes only. Manual wakes still work while paused.

## Replies

When Andrew comments, requests changes, dismisses or changes the status of an
Item whose metadata has `spaceAgent: true`, the server records a pending reply in
`command_center_space_agent_replies` (migration 082). The reply is written inside
the same transaction as the Inbox mutation or `updateItem`. A unique `source_id`
(the mutation or audit event id) makes it idempotent. Status changes made by the
agent itself (actor passed to `updateItem`) are not recorded.

The waker checks for pending replies on every tick, after the check-in and before
the event debounce. Replies wake the agent straight away, with no 10-minute debounce.
Pause, quiet hours, backoff and busy-thread rules still apply. The wake reason is
`reply`. Every wake delivers whatever replies are pending inside a `<replies>` block,
oldest first, capped at 20 rows and 4000 characters with 800 characters per reply.
Each line shows the item id, the clipped title and the reply text, and the block is
marked as untrusted data. Rows are marked delivered only after the turn is sent.

Budget: reply wakes do **not** count against `dailyWakeLimit`. They are Andrew's
direct answer to something the agent asked, so a busy event day should not hold
them back. They still add to `wakes_today`, so they use up the budget left for
event wakes.

## Agent Items

`cc_items_create` called with a space-agent credential stamps the Item with
`metadata.spaceAgent = true` and `threadId`, gives it agent provenance (sourceRef
is the agent thread) and records the audit actor as `agent`.

`cc_items_update` (requires `cc.items.write`, own Space only) lets the agent change
`status`, `title` and `description` through `Service.updateItem`. An empty patch is
rejected.

## Push

`LocalWebPushNotifier` follows the event stream from the audit head, so restarts do
not replay old events. When an agent creates an Item that `itemNeedsYou` reports as
needing Andrew (a needs-you or decision Item), it sends a web push. The push is gated
by the subscription's `notifyOnInput` preference and deep-links to the agent's
thread. Other agent Items do not trigger a push.
