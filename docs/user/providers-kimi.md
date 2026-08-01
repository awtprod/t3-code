# Kimi Code

T3 Code supports Kimi K3 through the authenticated local server included with Kimi Code 0.31.1 or
newer. Install `@moonshot-ai/kimi-code`, sign in with the Kimi CLI, then enable Kimi under
**Settings → Providers**. The default model is `kimi-code/k3`.

Each ordinary Kimi provider instance owns one loopback-only `kimi web` process. T3 Code reads the
server's private bearer token from `KIMI_CODE_HOME`, discovers the available models and authentication
state, and connects to the REST and WebSocket APIs. The daemon is stopped with its provider instance.
Set a separate KIMI_CODE_HOME path on each provider instance when using multiple accounts.

## Sessions and prompt caching

T3 Code stores Kimi's native session id as the thread resume cursor. Later turns submit only the new
message; T3 Code does not rebuild the transcript and does not maintain a second prompt-response cache.
This preserves Kimi's provider-managed prompt cache through renderer reconnects and T3 Code server
restarts.

Changing the model starts a new thread. Changing the model, thinking level, system instructions, MCP
definitions, tool schemas, or agent profiles can invalidate cached prefixes.

Kimi reports uncached input, cache reads, cache creation, output, context use, and native subagent
usage over its WebSocket status events. Those values appear in the context meter and Usage page.

## Native subagents

Kimi `subagent.spawned`, `started`, `suspended`, `completed`, and `failed` events are shown as native
subagent activity. AgentSwarm positions, foreground/background mode, summaries, and token/cache usage
are retained when the runtime supplies them. Background agents can remain active after the main turn
finishes.

## Attachments and permissions

Interactive approvals, questions, steering, interruption, attachments, and session recovery are
routed through Kimi's native protocol. Images are submitted with their media type as base64 message
content, so they remain scoped to the current prompt rather than a shared upload namespace.

Command Center routes Kimi only on Linux and only after a startup isolation probe succeeds. Before
every automation daemon starts, T3 Code re-verifies a native, non-writable ELF Kimi executable at
version 0.31.1 or newer and the canonical Bubblewrap isolation runtime. An npm or script-shim Kimi
installation remains interactive-only.

Each automation task receives a separate Kimi daemon and private home. Only the exact managed
workspace is mounted, native filesystem/shell/terminal/background-shell/web/fetch/hook/plugin tools
and ambient MCP or project-agent overrides are disabled, and main agents and subagents receive the
same T3-owned scoped workspace tools. Full-access runs and incomplete cleanup fail closed.
