// @effect-diagnostics nodeBuiltinImport:off - HMAC verification needs node:crypto's timingSafeEqual.
/**
 * PhoneWebhook - the ElevenLabs post-call webhook, `POST /api/command-center/phone/webhook`.
 *
 * The route sits outside bearer auth like `/api/command-center/webhooks`; the
 * ElevenLabs signature is its only credential. Verification follows the
 * official SDKs (elevenlabs-js `webhooks.constructEvent`, elevenlabs-python
 * `construct_event`), checked 2026-10-17:
 *
 *   ElevenLabs-Signature: t=<unix seconds>,v0=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 *
 * The digest is compared in constant time before the body is parsed. The
 * timestamp may be up to 30 minutes old, the SDKs' tolerance, so retried
 * post-call deliveries (30 s, 2 m, 8 m, then 30 m apart) are not dropped after
 * five minutes; it may be at most five minutes in the future (clock skew, as
 * for the automation webhooks). Rows are keyed by conversation id, so a replay inside that window
 * writes nothing new. Bodies are capped at 1 MiB while streaming.
 *
 * Handled event types (https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks):
 * - `post_call_transcription`: "Phone: ended …" activity row with the summary
 *   and outcome; for an owner call that asked a question, a Space agent reply
 *   row with Andrew's answer (`analysis.data_collection_results.owner_answer`,
 *   else the summary), so the existing reply wake delivers it.
 * - `call_initiation_failure`: "Phone: not connected …" row (and the reply for
 *   a question call, so the agent does not wait for an answer).
 * Every other type, and every conversation this server did not start, is
 * acknowledged with 204 and ignored. Rows are keyed by conversation id, so a
 * replayed delivery writes nothing new.
 *
 * @module PhoneWebhook
 */
import * as NodeCrypto from "node:crypto";

import { COMMAND_CENTER_WEBHOOK_MAX_PAYLOAD_BYTES } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { CommandCenterReadinessGate } from "../ReadinessGate.ts";
import * as SpaceActivity from "../SpaceActivity.ts";
import { recordSpaceAgentReply } from "../SpaceAgentReplies.ts";
import { COMMAND_CENTER_WEBHOOK_TIMESTAMP_SKEW_MS } from "../WebhookAdmission.ts";

/** How old a signed delivery may be: the SDKs' tolerance, which covers ElevenLabs' retries. */
const ELEVENLABS_WEBHOOK_MAX_AGE_MS = 30 * 60 * 1_000;
import { collectBoundedWebhookBody, webhookErrorResponse } from "../WebhookHttp.ts";
import { ElevenLabsConversationId } from "./ElevenLabsClient.ts";
import { makePhoneConnectionStore } from "./PhoneConnection.ts";
import {
  PHONE_ACTIVITY_SOURCE_KIND,
  phoneEndSourceId,
  phoneStartSourceId,
  PhoneCallStatus,
  phoneTitleFromStart,
} from "./PhoneCalls.ts";

const PHONE_WEBHOOK_HTTP_PATH = "/api/command-center/phone/webhook";
const ELEVENLABS_SIGNATURE_HEADER = "elevenlabs-signature";
/**
 * ElevenLabs documents no per-conversation dashboard URL, so rows link the
 * documented "Get conversation details" API resource (needs the API key).
 */
const elevenLabsConversationUrl = (conversationId: string) =>
  `https://api.elevenlabs.io/v1/convai/conversations/${conversationId}`;

const SUMMARY_CHARS = 300;
const ANSWER_CHARS = 200;
const MAX_SIGNATURES = 4;

// ── Signature ────────────────────────────────────────────────────────────────

export type ElevenLabsSignatureCheck = "valid" | "unauthorized" | "stale";

/** Lowercase hex HMAC-SHA256 over `<t>.<body>`, the value after `v0=`. */
const computeElevenLabsSignature = (input: {
  readonly secret: string;
  readonly timestamp: string;
  readonly body: Uint8Array;
}): string =>
  NodeCrypto.createHmac("sha256", Buffer.from(input.secret, "utf8"))
    .update(Buffer.from(`${input.timestamp}.`, "utf8"))
    .update(input.body)
    .digest("hex");

const parseSignatureHeader = (
  header: string | undefined,
): { readonly timestamp: string; readonly signatures: ReadonlyArray<string> } | undefined => {
  if (header === undefined || header.length === 0 || header.length > 1024) return undefined;
  let timestamp: string | undefined;
  const signatures: Array<string> = [];
  for (const part of header.split(",")) {
    const element = part.trim();
    if (element.startsWith("t=")) {
      // Two timestamps make the signed string ambiguous; refuse instead of picking one.
      if (timestamp !== undefined) return undefined;
      timestamp = element.slice(2);
    } else if (element.startsWith("v0=")) {
      signatures.push(element.slice(3));
    }
  }
  if (
    timestamp === undefined ||
    !/^\d{1,12}$/u.test(timestamp) ||
    signatures.length === 0 ||
    signatures.length > MAX_SIGNATURES
  ) {
    return undefined;
  }
  return { timestamp, signatures };
};

const hexDigest = (value: string): Buffer =>
  /^[a-f0-9]{64}$/u.test(value) ? Buffer.from(value, "hex") : Buffer.alloc(32);

/**
 * Verify an `ElevenLabs-Signature` header. The digest is always computed and
 * compared in constant time; the timestamp window is checked only after a
 * signature matched, so an attacker learns nothing about the clock.
 */
export const verifyElevenLabsSignature = (input: {
  readonly header: string | undefined;
  readonly body: Uint8Array;
  readonly secret: string;
  readonly nowMs: number;
}): ElevenLabsSignatureCheck => {
  const parsed = parseSignatureHeader(input.header);
  const expected = Buffer.from(
    computeElevenLabsSignature({
      secret: input.secret,
      timestamp: parsed?.timestamp ?? "0",
      body: input.body,
    }),
    "hex",
  );
  let matched = false;
  for (const signature of parsed?.signatures ?? [""]) {
    matched = NodeCrypto.timingSafeEqual(expected, hexDigest(signature)) || matched;
  }
  if (parsed === undefined || !matched) return "unauthorized";
  const timestampMs = Number(parsed.timestamp) * 1000;
  return input.nowMs - timestampMs > ELEVENLABS_WEBHOOK_MAX_AGE_MS ||
    timestampMs - input.nowMs > COMMAND_CENTER_WEBHOOK_TIMESTAMP_SKEW_MS
    ? "stale"
    : "valid";
};

// ── Payload ──────────────────────────────────────────────────────────────────

const ScalarValue = Schema.Union([Schema.String, Schema.Number, Schema.Boolean]);
const DataCollectionEntry = Schema.Struct({
  value: Schema.optional(Schema.NullOr(Schema.Unknown)),
});
const Envelope = Schema.Struct({ type: Schema.String, data: Schema.Unknown });
const TranscriptionData = Schema.Struct({
  agent_id: Schema.String,
  conversation_id: ElevenLabsConversationId,
  analysis: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        call_successful: Schema.optional(Schema.NullOr(Schema.String)),
        transcript_summary: Schema.optional(Schema.NullOr(Schema.String)),
        data_collection_results: Schema.optional(
          Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
        ),
      }),
    ),
  ),
});
const InitiationFailureData = Schema.Struct({
  agent_id: Schema.String,
  conversation_id: ElevenLabsConversationId,
  failure_reason: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(Envelope));
const decodeTranscription = Schema.decodeUnknownOption(TranscriptionData);
const decodeInitiationFailure = Schema.decodeUnknownOption(InitiationFailureData);
const decodeDataCollectionEntry = Schema.decodeUnknownOption(DataCollectionEntry);
const isScalar = Schema.is(ScalarValue);

export type PhoneWebhookEvent =
  | {
      readonly kind: "ended";
      readonly conversationId: string;
      readonly summary: string;
      readonly outcome: string;
      readonly ownerAnswer?: string;
    }
  | {
      readonly kind: "not-connected";
      readonly conversationId: string;
      readonly failureReason: string;
    }
  | { readonly kind: "ignored" };

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

/** A data-collection field's value as short text, when it has one. */
const collected = (
  results: Readonly<Record<string, unknown>> | null | undefined,
  key: string,
): string | undefined => {
  const entry = results?.[key];
  if (entry === undefined) return undefined;
  const decoded = decodeDataCollectionEntry(entry);
  if (Option.isNone(decoded) || !isScalar(decoded.value.value)) return undefined;
  const text = oneLine(String(decoded.value.value), ANSWER_CHARS);
  return text.length === 0 ? undefined : text;
};

/**
 * Shape-check a verified body. `None` means the body is not a valid event
 * (400); `ignored` means a well-formed event this server does not act on (204).
 */
export const parsePhoneWebhookEvent = (body: Uint8Array): Option.Option<PhoneWebhookEvent> => {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    // Not UTF-8: reported to the sender as an invalid request by the caller.
    return Option.none();
  }
  const envelope = decodeEnvelope(text);
  if (Option.isNone(envelope)) return Option.none();
  if (envelope.value.type === "post_call_transcription") {
    const data = decodeTranscription(envelope.value.data);
    if (Option.isNone(data)) return Option.none();
    const analysis = data.value.analysis ?? undefined;
    const results = analysis?.data_collection_results;
    const ownerAnswer = collected(results, "owner_answer");
    const summary = oneLine(analysis?.transcript_summary ?? "", SUMMARY_CHARS);
    return Option.some({
      kind: "ended",
      conversationId: data.value.conversation_id,
      summary: summary.length === 0 ? "No summary was produced." : summary,
      outcome:
        collected(results, "outcome") ??
        (analysis?.call_successful === undefined || analysis.call_successful === null
          ? "unknown"
          : oneLine(analysis.call_successful, 40)),
      ...(ownerAnswer === undefined ? {} : { ownerAnswer }),
    });
  }
  if (envelope.value.type === "call_initiation_failure") {
    const data = decodeInitiationFailure(envelope.value.data);
    if (Option.isNone(data)) return Option.none();
    const reason = oneLine(data.value.failure_reason ?? "", 40);
    return Option.some({
      kind: "not-connected",
      conversationId: data.value.conversation_id,
      failureReason: reason.length === 0 ? "unknown" : reason,
    });
  }
  return Option.some({ kind: "ignored" });
};

// ── Processing ───────────────────────────────────────────────────────────────

export class PhoneWebhookError extends Schema.TaggedError<PhoneWebhookError>()(
  "PhoneWebhookError",
  {
    reason: Schema.Literals([
      "unauthorized",
      "invalid-payload",
      "payload-too-large",
      "unavailable",
    ]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface PhoneWebhookResult {
  /** 200 when the event was recorded or was already recorded; 204 when ignored. */
  readonly status: 200 | 204;
  readonly duplicate: boolean;
}

export interface PhoneWebhookShape {
  readonly handle: (input: {
    readonly signatureHeader: string | undefined;
    readonly body: Uint8Array;
  }) => Effect.Effect<PhoneWebhookResult, PhoneWebhookError>;
}

const ignored: PhoneWebhookResult = { status: 204, duplicate: false };

/**
 * Built from the runtime's SQL client and secret store only, so the HTTP route
 * can construct it per request (route requirements resolve at request time).
 */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = makePhoneConnectionStore(yield* ServerSecretStore);
  const activity = yield* SpaceActivity.make;

  const unavailable = (cause: unknown) =>
    new PhoneWebhookError({
      reason: "unavailable",
      message: "The phone webhook could not be processed.",
      cause,
    });

  const record = Effect.fn("PhoneWebhook.record")(function* (
    event: Exclude<PhoneWebhookEvent, { readonly kind: "ignored" }>,
  ) {
    const starts = yield* sql<{
      readonly spaceId: string;
      readonly title: string;
      readonly status: string;
      readonly summary: string;
    }>`
      SELECT space_id AS "spaceId", title, status, summary
      FROM command_center_space_activity
      WHERE source_kind = ${PHONE_ACTIVITY_SOURCE_KIND}
        AND source_id = ${phoneStartSourceId(event.conversationId)}
      ORDER BY id ASC
      LIMIT 1
    `;
    const start = starts[0];
    // Not a call this server placed (or its row is gone): acknowledge and ignore.
    if (start === undefined) return ignored;
    const asked = start.status === PhoneCallStatus.askingOwner;
    const occurredAt = DateTime.formatIso(yield* DateTime.now);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const inserted = yield* activity.record({
          spaceId: start.spaceId,
          occurredAt,
          sourceKind: PHONE_ACTIVITY_SOURCE_KIND,
          sourceId: phoneEndSourceId(event.conversationId),
          projectId: null,
          title: phoneTitleFromStart(
            start.title,
            event.kind === "ended" ? "ended" : "not connected",
          ),
          status: event.kind === "ended" ? PhoneCallStatus.ended : PhoneCallStatus.notConnected,
          text:
            event.kind === "ended"
              ? `${event.summary} (outcome: ${event.outcome})`
              : `The call did not connect (${event.failureReason}).`,
          eventSequence: SpaceActivity.SPACE_ACTIVITY_EXTERNAL_EVENT_SEQUENCE,
          url: elevenLabsConversationUrl(event.conversationId),
        });
        if (!inserted) return { status: 200 as const, duplicate: true };
        if (asked) {
          yield* recordSpaceAgentReply(sql, {
            sourceId: `phone:${event.conversationId}`,
            spaceId: start.spaceId,
            itemId: `phone:${event.conversationId}`,
            // An asking row's summary is exactly the question (see PhoneCalls).
            itemTitle: `Phone call: ${start.summary}`,
            kind: "comment",
            body:
              event.kind === "not-connected"
                ? `Andrew did not pick up (${event.failureReason}); no answer was recorded.`
                : event.ownerAnswer === undefined
                  ? `Answered by phone. ${event.summary}`
                  : `Answered by phone: ${event.ownerAnswer}. ${event.summary}`,
            occurredAt,
          });
        }
        return { status: 200 as const, duplicate: false };
      }),
    );
  });

  const handle: PhoneWebhookShape["handle"] = (input) =>
    Effect.gen(function* () {
      if (input.body.byteLength > COMMAND_CENTER_WEBHOOK_MAX_PAYLOAD_BYTES) {
        return yield* new PhoneWebhookError({
          reason: "payload-too-large",
          message: "The phone webhook payload exceeds the byte limit.",
        });
      }
      const connection = yield* store.load.pipe(Effect.mapError(unavailable));
      if (Option.isNone(connection)) {
        // Indistinguishable from a bad signature, like the automation webhooks.
        return yield* new PhoneWebhookError({
          reason: "unauthorized",
          message: "Phone webhook authentication failed.",
        });
      }
      const check = verifyElevenLabsSignature({
        header: input.signatureHeader,
        body: input.body,
        secret: connection.value.webhookSecret,
        nowMs: yield* Clock.currentTimeMillis,
      });
      if (check !== "valid") {
        return yield* new PhoneWebhookError({
          reason: "unauthorized",
          message: "Phone webhook authentication failed.",
        });
      }
      const event = parsePhoneWebhookEvent(input.body);
      if (Option.isNone(event)) {
        return yield* new PhoneWebhookError({
          reason: "invalid-payload",
          message: "The phone webhook body is not a valid ElevenLabs event.",
        });
      }
      if (event.value.kind === "ignored") return ignored;
      return yield* record(event.value).pipe(Effect.mapError(unavailable));
    });

  return { handle } satisfies PhoneWebhookShape;
});

// ── HTTP route ───────────────────────────────────────────────────────────────

const noStoreHeaders = { "cache-control": "no-store" } as const;
const isPhoneWebhookError = Schema.is(PhoneWebhookError);

/** Phone webhook errors map here; readiness and body-read errors use the automation webhook mapping. */
const phoneWebhookErrorResponse = (error: unknown): HttpServerResponse.HttpServerResponse => {
  if (!isPhoneWebhookError(error)) return webhookErrorResponse(error);
  switch (error.reason) {
    case "unauthorized":
      return HttpServerResponse.jsonUnsafe(
        { error: "invalid_webhook_signature" },
        { status: 401, headers: noStoreHeaders },
      );
    case "invalid-payload":
      return HttpServerResponse.jsonUnsafe(
        { error: "invalid_webhook_request" },
        { status: 400, headers: noStoreHeaders },
      );
    case "payload-too-large":
      return HttpServerResponse.jsonUnsafe(
        { error: "webhook_payload_too_large" },
        { status: 413, headers: noStoreHeaders },
      );
    case "unavailable":
      return HttpServerResponse.jsonUnsafe(
        { error: "webhook_unavailable" },
        { status: 503, headers: noStoreHeaders },
      );
  }
};

/**
 * Signature-authenticated route outside bearer auth, registered beside the
 * automation webhooks. It needs only the runtime's readiness gate, SQL client,
 * and secret store.
 */
export const phoneWebhookHttpRouteLayer = HttpRouter.add(
  "POST",
  PHONE_WEBHOOK_HTTP_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const readiness = yield* CommandCenterReadinessGate;
    const webhook = yield* make;
    return yield* readiness.requireReady.pipe(
      Effect.andThen(
        collectBoundedWebhookBody({
          ...(request.headers["content-length"] === undefined
            ? {}
            : { contentLength: request.headers["content-length"] }),
          stream: request.stream,
        }),
      ),
      Effect.flatMap((body) =>
        webhook.handle({ signatureHeader: request.headers[ELEVENLABS_SIGNATURE_HEADER], body }),
      ),
      Effect.tapError((error) =>
        isPhoneWebhookError(error) && error.reason === "unavailable"
          ? Effect.logWarning("phone webhook processing failed", { cause: error.cause })
          : Effect.void,
      ),
      Effect.match({
        onFailure: phoneWebhookErrorResponse,
        onSuccess: (result) =>
          result.status === 204
            ? HttpServerResponse.empty({ status: 204, headers: noStoreHeaders })
            : HttpServerResponse.jsonUnsafe(
                { received: true, duplicate: result.duplicate },
                { status: 200, headers: noStoreHeaders },
              ),
      }),
    );
  }),
);
