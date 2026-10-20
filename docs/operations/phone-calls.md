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
  connected, and the voice agent leaves the call. With [conference mode](#5-conference-mode) the
  agent instead steps out while the owner talks and takes the call back when he hangs up.
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
| Webhook body                  | 1 MiB; signed at most 30 minutes ago, 5 minutes ahead           |

The day and quiet hours use one timezone: `agent.quietHours.timezone`, then
`agent.checkIns.timezone`, then `America/New_York`. Counts come from the activity rows (phone rows
are exempt from the 500-row activity retention), so a call that ElevenLabs refused does not count.
A refused call returns the reason to the agent; an approved call that cannot be placed leaves a
`Phone: not placed …` row. A 4xx or 503 status, or an explicit `success: false`, proves the call was
not started. If ElevenLabs gives no usable answer (timeout, connection failure, an unreadable
success response, or any other 5xx such as 500, 502, or 504), the call may already be ringing: it
leaves a `Phone: outcome unknown …` row that counts toward the daily cap, and the tool or the Inbox
accept reports "outcome unknown — do not retry" instead of "not placed" (no end-of-call row follows,
so check the ElevenLabs conversation history).

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
`<timestamp>.<body>`, as in the ElevenLabs SDKs) and rejects deliveries signed more than 30 minutes
ago (the SDKs' tolerance, so retried deliveries are kept) or more than five minutes ahead.
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

## 5. Conference mode

In the default mode a third-party call is an ElevenLabs outbound call, and bridging the owner in
with `transfer_to_number` removes the voice agent from the call. Conference mode keeps the agent:
Command Center owns a Twilio Conference for each third-party call and the third-party agent is one
participant in it. When the callee needs the owner (a bank verifying the card holder, for example),
the agent calls the `bring_owner_in` server tool: the owner's phone rings with a short spoken brief,
the agent is put on hold and muted (it neither hears nor is heard, so the owner's answers never
reach its transcript), and when the owner hangs up the agent is taken off hold, hears "<owner> has
finished and left the call. Continue with the callee.", and continues. Owner calls
(`cc_phone_call_me`) are unchanged.

How a call runs:

1. Approving the call dials the agent leg: Twilio calls the second number (below) from
   `callerId.owner`; ElevenLabs answers it with the third-party agent, which waits in silence.
2. Before answering, ElevenLabs fetches the call's dynamic variables from Command Center (the
   initiation webhook). That request writes the `Phone: calling …` row, exactly as in the default
   mode. Only a call to the agent's number from the caller id of the agent leg (`callerId.owner`)
   is matched; any other caller is refused. An agent leg that answers without fetching them is
   ended (`Phone: not connected …`).
3. Command Center then dials the callee from `callerId.callee`. The conference starts when the
   callee answers and ends when the callee hangs up. A callee who does not answer leaves
   `Phone: not connected …`.
4. `bring_owner_in` writes `Phone: bringing <owner> in — <reason>`; when the owner leaves,
   `Phone: <owner> left; assistant continued`. The post-call webhook writes `Phone: ended …` as
   always.

### Twilio and ElevenLabs setup

1. Buy a second voice-capable Twilio number (the agent's number) in the same Twilio account, import
   it into ElevenLabs natively (as in step 1), and assign it to the third-party agent.
2. To show the owner's mobile to callees, add it in Twilio as a Verified Caller ID and use it as
   `callerId.callee`; otherwise use the main Twilio number. `callerId.owner` should be the main
   Twilio number; it is also the caller id of the agent leg.
3. Generate a tool secret (at least 32 characters, for example
   `python3 -c 'import secrets; print(secrets.token_urlsafe(32))'`) and store it as an ElevenLabs
   workspace secret.
4. On the third-party agent:
   - **Security → conversation initiation data for inbound Twilio calls:** on, webhook URL
     `<publicBaseUrl>/elevenlabs/initiation`, with the secret sent in the `x-cc-phone-token` header.
   - **Server tool** `bring_owner_in`: `POST <publicBaseUrl>/elevenlabs/tool/bring-owner-in`, same
     header, JSON body `{ "reason": string, "conversation_id"?: string, "call_sid"?: string }`
     (`reason`: what the callee needs from the owner, one sentence; fill the other two from the
     system variables `system__conversation_id` and `system__call_sid`). Set the tool's response
     timeout to at least 60 seconds: the tool answers when the owner has joined, did not answer, or
     after 45 seconds of ringing. It answers `{ "status", "message" }`; `status` is `joined`,
     `no-answer`, `busy`, `failed`, `refused`, or `calling`, and `message` tells the agent what to
     say or do.
   - Empty first message, a long silence timeout, and no `transfer_to_number`. The prompt tells the
     agent to stay quiet until the callee speaks, to put the callee on hold before calling
     `bring_owner_in`, to stay silent while the owner talks, and never to end the call while waiting
     for him.
5. Publish the sub-paths of the webhook mount: Twilio and ElevenLabs reach
   `/api/command-center/phone/webhook/twilio/…` and `/api/command-center/phone/webhook/elevenlabs/…`
   under the same public prefix as the post-call webhook.

### Connection keys

Add both blocks to the connection JSON from step 4 (they are set together or not at all) and store
it again with `pnpm credentials:phone -- set`:

```json
{
  "twilio": {
    "accountSid": "AC00000000000000000000000000000000",
    "authToken": "<Twilio auth token>"
  },
  "conference": {
    "inboundNumber": "+15555550111",
    "callerId": { "callee": "+15555550112", "owner": "+15555550113" },
    "publicBaseUrl": "https://cc.example.com/api/command-center/phone/webhook",
    "toolSecret": "<tool secret>"
  }
}
```

`publicBaseUrl` is the public URL of the webhook mount: https, no port, query, or trailing slash.
Twilio signs the exact URL it calls, and Command Center checks every Twilio request against URLs it
builds from this value (never from request headers), so it must match what Twilio is given. `status`
reports conference mode with masked numbers and never prints the Twilio credentials, the tool
secret, or the URL. Removing both blocks returns to the default mode.

### Authentication

Twilio routes accept only requests whose `X-Twilio-Signature` matches the Auth Token and whose
`AccountSid` is the configured account. ElevenLabs routes accept only the `x-cc-phone-token` header.
Without a conference-mode connection every route answers like a bad credential. Bodies are capped at
1 MiB, and malformed input gets 400, never a server error.

### Limits and untested behavior

| Limit                      | Value                                                                    |
| -------------------------- | ------------------------------------------------------------------------ |
| Conference calls in flight | 1 per server; another approved call is not placed ("in progress")        |
| Call tracking              | 2 hours; then the call is ended if still live and marked outcome unknown |
| Bringing the owner in      | counts as an owner call (3 per day), never during quiet hours            |
| `bring_owner_in` wait      | 45 seconds from dialing the owner, then `calling`                        |
| Twilio requests            | 15 s each, not retried; holding the agent is bounded to 10 s             |
| Ringing                    | agent 20 s, callee 45 s, owner 30 s                                      |

The call record lives in `<state dir>/phone/active-call.json` (mode 0600) so a restart does not lose
a live call; an unreadable record blocks new conference calls until it is removed. If the post-call
webhook never arrives, the call still ends normally but has no `Phone: ended …` row.

Not built yet: voicemail detection on the callee leg, relaying keypad tones the owner presses
(whether DTMF crosses a Twilio Conference is untested), more than one call at a time, and recording.
