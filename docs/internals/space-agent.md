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
