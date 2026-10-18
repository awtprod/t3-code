// @effect-diagnostics globalFetch:off
/**
 * ElevenLabsClient - starts an outbound phone call through ElevenLabs Agents
 * on a natively imported Twilio number.
 *
 * Endpoint and field names were taken from the ElevenLabs docs on 2026-10-17:
 * https://elevenlabs.io/docs/eleven-agents/api-reference/twilio/outbound-call
 *   POST https://api.elevenlabs.io/v1/convai/twilio/outbound-call
 *   body: agent_id, agent_phone_number_id, to_number,
 *         conversation_initiation_client_data.dynamic_variables
 *   200:  success (boolean), message (string), conversation_id?, callSid?
 * Authentication is the `xi-api-key` header.
 *
 * Every request is bounded: one 15 s deadline covers connect, headers, and the
 * response body, the body read stops at 64 KiB, and interrupting the calling
 * fiber aborts the request. Errors carry the HTTP status and a short, redacted
 * body; the API key is never part of an error.
 *
 * Only a 4xx or 503 HTTP status (`http`) or an explicit `success: false`
 * (`rejected`) proves the call was not started. Any other 5xx (500, 502, 504,
 * ...) can arrive after ElevenLabs already asked Twilio to dial, a timeout or
 * transport failure has no answer at all, and an unusable 2xx answer
 * (`invalid-response`) may belong to a call that is already ringing;
 * `callMayHaveStarted` tells them apart.
 *
 * @module ElevenLabsClient
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const ELEVENLABS_API_BASE_URL = "https://api.elevenlabs.io";
const ELEVENLABS_OUTBOUND_CALL_PATH = "/v1/convai/twilio/outbound-call";
const ELEVENLABS_REQUEST_TIMEOUT_MS = 15_000;
const RESPONSE_MAX_BYTES = 64 * 1024;
const ERROR_BODY_CHARS = 300;

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class ElevenLabsCallError extends Schema.TaggedError<ElevenLabsCallError>()(
  "ElevenLabsCallError",
  {
    reason: Schema.Literals(["timeout", "transport", "http", "rejected", "invalid-response"]),
    message: Schema.String,
    status: Schema.optional(Schema.Number),
    body: Schema.optional(Schema.String),
  },
) {}

/** The variables every agent prompt may reference; all are always present. */
export interface PhoneCallDynamicVariables {
  readonly purpose: string;
  readonly brief: string;
  readonly allowed_outcomes: string;
  readonly owner_name: string;
  readonly callee_name: string;
  readonly patch_in_when: string;
  readonly call_kind: "third_party" | "owner";
  readonly question: string;
}

export interface OutboundCallRequest {
  readonly apiKey: string;
  readonly agentId: string;
  readonly agentPhoneNumberId: string;
  /** E.164 number to dial. */
  readonly to: string;
  readonly dynamicVariables: PhoneCallDynamicVariables;
}

export interface OutboundCallStarted {
  readonly conversationId: string;
  readonly callSid?: string;
}

export interface ElevenLabsClientShape {
  readonly startOutboundCall: (
    request: OutboundCallRequest,
  ) => Effect.Effect<OutboundCallStarted, ElevenLabsCallError>;
}

export class ElevenLabsClient extends Context.Service<ElevenLabsClient, ElevenLabsClientShape>()(
  "@awtprod/command-center/command-center/phone/ElevenLabsClient",
) {}

/** Conversation ids are used as row keys and in URLs, so they are kept to a safe alphabet. */
export const ElevenLabsConversationId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u),
);

const OutboundCallResponse = Schema.Struct({
  success: Schema.Boolean,
  message: Schema.String,
  conversation_id: Schema.optional(Schema.NullOr(Schema.String)),
  callSid: Schema.optional(Schema.NullOr(Schema.String)),
});
const isElevenLabsCallError = Schema.is(ElevenLabsCallError);

/** An HTTP status that proves no call was started: a 4xx refusal, or 503 (unavailable before any work). */
const isDefiniteRefusalStatus = (status: number): boolean =>
  (status >= 400 && status <= 499) || status === 503;

/**
 * False only when ElevenLabs answered that it did not start the call (`success: false`,
 * HTTP 4xx, or HTTP 503). Any other 5xx, a missing status, and every no-answer or unusable
 * answer may belong to a call that is already ringing.
 */
export const callMayHaveStarted = (error: ElevenLabsCallError): boolean => {
  if (error.reason === "rejected") return false;
  if (error.reason === "http") {
    return error.status === undefined || !isDefiniteRefusalStatus(error.status);
  }
  return true;
};
const decodeResponse = Schema.decodeUnknownOption(Schema.fromJsonString(OutboundCallResponse));
const isConversationId = Schema.is(ElevenLabsConversationId);

/** Clip and redact text from the provider: phone-number-like digit runs keep their last four. */
const redactProviderText = (text: string): string => {
  const redacted = text
    .replace(/\+?\d[\d\s().-]{5,}\d/gu, (match) => `…${match.replace(/\D/gu, "").slice(-4)}`)
    .replace(/\s+/gu, " ")
    .trim();
  return redacted.length <= ERROR_BODY_CHARS
    ? redacted
    : `${redacted.slice(0, ERROR_BODY_CHARS - 1)}…`;
};

/** Reads at most `maxBytes` of the body; a longer body is cut off and the stream canceled. */
const readBoundedText = async (response: Response, maxBytes: number): Promise<string> => {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = maxBytes - total;
      const chunk = value.byteLength > room ? value.subarray(0, room) : value;
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } finally {
    // Release the connection whether the body ended, overflowed, or failed.
    await reader.cancel().catch(() => undefined);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
};

export interface ElevenLabsClientOptions {
  readonly fetchImpl?: FetchLike;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

export const makeElevenLabsClient = (
  options: ElevenLabsClientOptions = {},
): ElevenLabsClientShape => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${options.baseUrl ?? ELEVENLABS_API_BASE_URL}${ELEVENLABS_OUTBOUND_CALL_PATH}`;
  const timeoutMs = options.timeoutMs ?? ELEVENLABS_REQUEST_TIMEOUT_MS;

  const post = async (request: OutboundCallRequest, interrupt: AbortSignal) => {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([interrupt, deadline]);
    const failed = (cause: unknown) =>
      isElevenLabsCallError(cause)
        ? cause
        : deadline.aborted
          ? new ElevenLabsCallError({
              reason: "timeout",
              message: `ElevenLabs did not answer within ${Math.round(timeoutMs / 1000)} s.`,
            })
          : new ElevenLabsCallError({
              reason: "transport",
              message: "ElevenLabs could not be reached.",
            });
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "xi-api-key": request.apiKey,
        },
        body: JSON.stringify({
          agent_id: request.agentId,
          agent_phone_number_id: request.agentPhoneNumberId,
          to_number: request.to,
          conversation_initiation_client_data: {
            dynamic_variables: request.dynamicVariables,
          },
        }),
        redirect: "error",
        signal,
      });
      if (!response.ok) {
        // 4xx and 503 prove the call was not started even when the body cannot be read;
        // any other 5xx may have been sent after ElevenLabs asked Twilio to dial.
        const text = await readBoundedText(response, RESPONSE_MAX_BYTES).catch(() => "");
        throw new ElevenLabsCallError({
          reason: "http",
          message: isDefiniteRefusalStatus(response.status)
            ? `ElevenLabs refused the call (HTTP ${response.status}).`
            : `ElevenLabs failed while starting the call (HTTP ${response.status}); it may have started.`,
          status: response.status,
          body: redactProviderText(text),
        });
      }
      const text = await readBoundedText(response, RESPONSE_MAX_BYTES);
      const decoded = decodeResponse(text);
      if (Option.isNone(decoded)) {
        throw new ElevenLabsCallError({
          reason: "invalid-response",
          message: "ElevenLabs returned an unexpected response.",
          status: response.status,
          body: redactProviderText(text),
        });
      }
      if (!decoded.value.success) {
        throw new ElevenLabsCallError({
          reason: "rejected",
          message: `ElevenLabs did not start the call: ${redactProviderText(decoded.value.message)}`,
          status: response.status,
        });
      }
      const conversationId = decoded.value.conversation_id;
      if (
        conversationId === undefined ||
        conversationId === null ||
        !isConversationId(conversationId)
      ) {
        throw new ElevenLabsCallError({
          reason: "invalid-response",
          message: "ElevenLabs started the call without a usable conversation id.",
          status: response.status,
        });
      }
      const callSid = decoded.value.callSid;
      return callSid === undefined || callSid === null || callSid.length === 0
        ? { conversationId }
        : { conversationId, callSid: callSid.slice(0, 128) };
    } catch (cause) {
      throw failed(cause);
    }
  };

  const startOutboundCall: ElevenLabsClientShape["startOutboundCall"] = (request) =>
    Effect.tryPromise({
      try: (interrupt) => post(request, interrupt),
      catch: (cause) =>
        isElevenLabsCallError(cause)
          ? cause
          : new ElevenLabsCallError({
              reason: "transport",
              message: "ElevenLabs could not be reached.",
            }),
    }).pipe(Effect.withSpan("ElevenLabsClient.startOutboundCall"));

  return ElevenLabsClient.of({ startOutboundCall });
};

export const layer = Layer.succeed(ElevenLabsClient, makeElevenLabsClient());
