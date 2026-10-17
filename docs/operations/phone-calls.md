# Space agent phone calls

The Space agent can phone the owner (`cc_phone_call_me`) and propose calls to other people
(`cc_phone_call`). ElevenLabs Agents runs the voice conversation on a Twilio number imported into
ElevenLabs; Command Center plans the call, enforces the limits, and records the result. Inbound
calls and SMS are not supported.

- `cc_phone_call_me` dials the owner immediately, subject to quiet hours and a daily cap. When the
  agent asks a yes/no question, the spoken answer comes back as a Space agent reply on the Item
  `phone:<conversation id>`, which wakes the agent like an Inbox reply.
- `cc_phone_call` never dials. It files a `decision` Item, "Call <callee>: <purpose>", with the full
  call plan as an Inbox `phone.call` candidate. Push notifications fire because the agent created
  it. **Approve and call** in the Inbox places the call; that accept needs the
  `command-center:approve` scope and a plan the Space agent filed itself, and it does not dial if
  the agent has since been disabled or lost `cc.phone.call` (a `Phone: not placed …` row says so).
- During any call the voice agent can bridge the owner in ("patch me in") through ElevenLabs'
  `transfer_to_number` tool in conference mode. The owner hears a short brief before the callee is
  connected.
- Every call leaves Space activity rows: `Phone: calling …` when it starts, then `Phone: ended …`
  with the summary, the outcome, and the conversation link, or `Phone: not connected …`. Numbers
  are masked to their last four digits.

## Limits

| Limit                         | Value                                                           |
| ----------------------------- | --------------------------------------------------------------- |
| Calls to the owner            | 3 per Space per local day, never during the agent's quiet hours |
| Calls to third parties        | 5 per Space per local day, only after approval                  |
| Brief read to the voice agent | 1,500 characters                                                |
| Outbound request timeout      | 15 s                                                            |
| Webhook body                  | 1 MiB, signature within 5 minutes                               |

The day and quiet hours use one timezone: `agent.quietHours.timezone`, then
`agent.checkIns.timezone`, then `America/New_York`. Counts come from the activity rows (phone rows
are exempt from the 500-row activity retention), so a call that ElevenLabs refused does not count.
A refused call returns the reason to the agent; an approved call that cannot be placed leaves a
`Phone: not placed …` row. If ElevenLabs gives no usable answer (timeout, connection failure, or an
unreadable success response), the call may already be ringing: it leaves a
`Phone: outcome unknown …` row that counts toward the daily cap, and the tool or the Inbox accept
reports "outcome unknown — do not retry" instead of "not placed" (no end-of-call row follows, so
check the ElevenLabs conversation history).

## Space policy

Phone capabilities are never implied. A Space whose config omits `policy.allowedCapabilities` does
not get them; list them explicitly next to the Space's other capabilities:

```json
"policy": {
  "allowedCapabilities": ["cc.items.read", "cc.items.write", "cc.phone.call-owner", "cc.phone.call"],
  "autoRunRiskLevels": ["low", "reversible"]
}
```

Only the Space agent's own credential can use the phone tools.

## 1. Import the Twilio number into ElevenLabs

Buy a voice-capable number in Twilio. In the ElevenLabs dashboard, open **Agents → Phone Numbers →
Import number → From Twilio** and enter the Twilio Account SID, Auth Token, and the number. Use the
native Twilio import, not a SIP trunk: the warm-transfer brief (`agent_message`) only works on
natively imported Twilio numbers. Copy the phone number id ElevenLabs shows for it.

## 2. Create the two ElevenLabs agents

Create two agents in **Agents → New agent**: one for calls to the owner and one for calls to third
parties. For both:

- **LLM:** Claude Sonnet 5.5.
- **First message:** keep it short, for example `Hi, this is {{owner_name}}'s assistant.`
- **System prompt:** every call sends these dynamic variables: `purpose`, `brief`,
  `allowed_outcomes`, `owner_name`, `callee_name`, `patch_in_when`, `call_kind` (`owner` or
  `third_party`), and `question` (empty unless the owner is asked something). A starting template:

  ```text
  You are {{owner_name}}'s assistant on a phone call with {{callee_name}}.
  Purpose: {{purpose}}
  Background: {{brief}}
  You may agree only to: {{allowed_outcomes}}. Decline anything else politely and say
  {{owner_name}} will follow up.
  If the question below is not empty, ask it plainly and get a clear yes or no:
  {{question}}
  Transfer to {{owner_name}} when: {{patch_in_when}}. Also transfer if the callee insists on
  speaking with {{owner_name}}. When you transfer, set agent_message to one sentence for
  {{owner_name}}: "{{owner_name}}, your assistant here. I have {{callee_name}} on the line about
  {{purpose}}; they need <what they need>." Never read phone numbers aloud.
  ```

- **Tools → System tools → Transfer to number** (`transfer_to_number`) on the third-party agent:
  one rule with destination type **phone**, the owner's number in E.164 (for example
  `+15550100000`), transfer type **conference**, and a condition such as "When the callee needs
  the owner, or the patch-in condition in the prompt is met." In conference mode ElevenLabs reads
  the `agent_message` the voice agent writes to the owner before bridging the callee. Blind and SIP
  REFER transfers skip that brief, so do not use them.
- **Analysis → Data collection:** add `outcome` (string, "What was agreed, in a few words"),
  `owner_answer` (string, "The owner's answer to the question: yes, no, or unclear"), and
  `needs_followup` (boolean). Command Center reads `outcome` and `owner_answer` from the post-call
  webhook; `needs_followup` is for the dashboard.

## 3. Point the post-call webhook at Command Center

In ElevenLabs workspace settings create a webhook with the URL
`https://<public host>/api/command-center/phone/webhook` and enable it for the agents' post-call
transcription events (and call initiation failures). Do not send audio webhooks; their base64 audio
exceeds the 1 MiB body limit. Copy the webhook's shared secret into `webhookSecret` below.

The endpoint authenticates only by the `ElevenLabs-Signature` header (HMAC-SHA-256 over
`<timestamp>.<body>`, as in the ElevenLabs SDKs) and rejects deliveries older than five minutes.
The Command Center server is Tailscale-only by default, so ElevenLabs cannot reach it until this one
path is published (for example through Tailscale Funnel or a reverse proxy that forwards only
`/api/command-center/phone/webhook`). ElevenLabs documents static egress IPs if the proxy can
restrict by source address.

Unknown event types and conversations the server did not start get `204` and are ignored; a
replayed delivery for the same conversation writes nothing new.

## 4. Store the connection

The connection is one JSON secret in the server secret store
(`<base-dir>/userdata/secrets/command-center-phone-connection.bin`, mode 0600). It never goes in the
private config repository or a prompt. Write the JSON to a private file:

```json
{
  "apiKey": "<ElevenLabs API key>",
  "webhookSecret": "<ElevenLabs webhook secret>",
  "agentId": "<third-party agent id>",
  "ownerAgentId": "<owner agent id>",
  "phoneNumberId": "<ElevenLabs phone number id of the Twilio number>",
  "ownerNumber": "+15550100000",
  "ownerName": "Andrew"
}
```

Store it as the user the server runs as, then delete the plaintext file:

```sh
pnpm credentials:phone -- set --from-json /absolute/path/phone.json --base-dir /absolute/runtime
pnpm credentials:phone -- status --base-dir /absolute/runtime
```

`set` validates the shape before writing and replaces an existing entry atomically; `--from-json -`
reads stdin. `status` prints whether a valid connection is stored, the owner's masked number, and the
agent ids, never the API key or the webhook secret. The server reads the secret on every call, so a
change takes effect without a restart.
