# Webhook automation admission

Webhook automation definitions are executable only after they are committed in the private
configuration checkout. A definition uses a canonical local route such as `/hooks/sample`; routes
with traversal, query strings, fragments, duplicate slashes, or a trailing slash are rejected.

Command Center exposes two authenticated admission paths:

- Paired browser and Electron clients call `cc.automations.webhook.admit`. The normal environment
  session must include `command-center:operate`.
- External senders call `POST /api/command-center/webhooks` with a runtime-only HMAC credential.

Both paths call the same trigger coordinator. It selects exactly one enabled automation in the
requested Space and route, pins the committed configuration SHA and definition digest, and uses the
authenticated admission source, Space, route, and sender delivery ID as the durable idempotency
identity. That identity is independent of whichever automation currently owns the route, so a
configuration reassignment cannot replay an old delivery into a different automation. Repeating an
identical delivery returns the existing execution; reusing its identity with different content or
definition metadata fails as an idempotency conflict.

## Runtime credentials

External credentials are not part of the private configuration repository. The server stores an
AES-256-GCM envelope under the runtime entry name `command-center-webhooks`; the credential name is
authenticated with the ciphertext so an entry cannot be copied into a different slot. The
decrypted value is UTF-8 JSON in this shape:

```json
{
  "version": 1,
  "credentials": [
    {
      "id": "sample-hook",
      "spaceId": "sample-space",
      "route": "/hooks/sample",
      "secret": "<base64url-encoded-random-secret>"
    }
  ]
}
```

Use 32–64 random bytes for each webhook secret and encode them as unpadded base64url. The envelope
master key is exactly 32 random bytes encoded as canonical, unpadded base64url. Supply it through
exactly one of:

- `COMMAND_CENTER_CREDENTIAL_KEY`, injected by the host service manager; or
- `COMMAND_CENTER_CREDENTIAL_KEY_FILE`, an absolute path to a regular owner-only file with no group
  or world permission bits.

If the key is absent, malformed, supplied twice, or cannot authenticate the envelope, external
webhooks fail closed without revealing which condition occurred. A rotated key requires
decrypting and re-encrypting the entry offline; there is no network credential-management API.
Keep the secret-store directory owner-only and its encrypted entry mode `0600`. Do not place the
key, plaintext credential JSON, encrypted entry, or generated signatures in either Git repository.

Provision an entry from stdin so the plaintext is never a command-line argument:

```sh
secret-management-tool read webhook-config | \
  pnpm credentials:webhooks:provision -- --base-dir /absolute/runtime
```

The command refuses to overwrite an existing entry. Rotation requires the explicit `--replace`
flag after the operator has retained a recoverable copy through the host secret-management system.
Remove the ephemeral plaintext input immediately through that system's normal secure workflow.

For systemd, prefer a credential drop-in rather than placing the key directly in an environment
file. For example, an operator-managed encrypted credential can be exposed only to the service as:

```ini
[Service]
LoadCredentialEncrypted=command-center-credential-key:/absolute/operator-managed/key.cred
Environment=COMMAND_CENTER_CREDENTIAL_KEY_FILE=%d/command-center-credential-key
```

## Signed request

The request body is raw JSON and may be at most 1 MiB. Send these headers:

| Header                           | Value                                                    |
| -------------------------------- | -------------------------------------------------------- |
| `X-Command-Center-Credential-Id` | Credential ID from the runtime binding                   |
| `X-Command-Center-Space-Id`      | Exact bound Space ID                                     |
| `X-Command-Center-Webhook-Route` | Exact canonical route                                    |
| `X-Command-Center-Delivery-Id`   | Stable visible-ASCII delivery ID, at most 200 characters |
| `X-Command-Center-Timestamp`     | Unix time in seconds                                     |
| `X-Command-Center-Signature`     | `sha256=` followed by lowercase HMAC-SHA-256 hex         |

Build the signed bytes as the following UTF-8 prefix, including its final newline, followed
immediately by the unmodified request-body bytes:

```text
command-center-webhook-v1
<timestamp>
<credential-id>
<space-id>
<route>
<delivery-id>
```

The server looks up the runtime binding, calculates the HMAC, and compares it in constant time
before parsing JSON. It then enforces a five-minute timestamp window and verifies that the signed
Space and route exactly match the credential binding. A retry outside the timestamp window must use
a new timestamp and signature while preserving the same delivery ID.

The endpoint returns `202` with the pinned execution identity when accepted. Authentication
failures are intentionally generic, malformed JSON returns `400`, oversized bodies return `413`,
and missing or ambiguous committed routes return `404` or `409` after successful authentication.

The server remains Tailscale-only by default. Enabling webhook definitions does not expose the
endpoint to the public internet or weaken the normal environment-session scopes.
