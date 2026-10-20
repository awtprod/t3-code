// @effect-diagnostics globalFetch:off
/**
 * TwilioClient - the four Twilio Voice REST calls conference-mode phone calls
 * need. Resource and parameter names were taken from the Twilio API reference
 * on 2026-10-19 (base `https://api.twilio.com/2010-04-01/Accounts/{AccountSid}`):
 *
 * - `POST Conferences/{FriendlyName}/Participants.json` adds an outbound
 *   participant (creating the conference on first use); answers `call_sid`
 *   and `conference_sid`.
 * - `POST Calls.json` places a call that fetches its TwiML from `Url`;
 *   answers `sid`.
 * - `POST Conferences/{ConferenceSid}/Participants/{CallSid}.json` holds,
 *   mutes, or announces to one participant.
 * - `POST Conferences/{ConferenceSid}.json` with `Status=completed` ends a
 *   conference.
 *
 * Requests are form-encoded with HTTP basic auth (Account SID, Auth Token).
 * Every request is bounded like the ElevenLabs client: one 15 s deadline over
 * connect, headers, and body, a 64 KiB body cap, abort on interruption, no
 * redirects, and no retries (a creating POST is not idempotent). Errors carry
 * the HTTP status, Twilio's numeric error code, and a short redacted message;
 * credentials are never part of an error.
 *
 * Only a 4xx proves that nothing was created. A 5xx, a timeout, a transport
 * failure, or an unusable 2xx answer may belong to a call that is already
 * ringing; `twilioRequestMayHaveStarted` tells them apart.
 *
 * @module TwilioClient
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { type FetchLike, readBoundedText, redactProviderText } from "./ElevenLabsClient.ts";
import type { TwilioCredentials } from "./PhoneConnection.ts";

const TWILIO_API_BASE_URL = "https://api.twilio.com";
const TWILIO_REQUEST_TIMEOUT_MS = 15_000;
const RESPONSE_MAX_BYTES = 64 * 1024;

export class TwilioRequestError extends Schema.TaggedError<TwilioRequestError>()(
  "TwilioRequestError",
  {
    reason: Schema.Literals(["timeout", "transport", "http", "invalid-response"]),
    message: Schema.String,
    status: Schema.optional(Schema.Number),
    /** Twilio's numeric error code from the error body, when it sent one. */
    code: Schema.optional(Schema.Number),
  },
) {}

/** False only for a 4xx answer, which proves Twilio created nothing. */
export const twilioRequestMayHaveStarted = (error: TwilioRequestError): boolean =>
  !(
    error.reason === "http" &&
    error.status !== undefined &&
    error.status >= 400 &&
    error.status <= 499
  );

export const TwilioCallSid = Schema.String.check(Schema.isPattern(/^CA[0-9a-f]{32}$/u));
export const TwilioConferenceSid = Schema.String.check(Schema.isPattern(/^CF[0-9a-f]{32}$/u));

/** Call progress events a status callback is sent for. */
export type TwilioStatusCallbackEvent = "answered" | "completed";

export interface AddParticipantRequest {
  readonly conferenceName: string;
  readonly from: string;
  readonly to: string;
  readonly label: string;
  readonly startConferenceOnEnter: boolean;
  readonly endConferenceOnExit: boolean;
  /** Seconds to let the participant's phone ring. */
  readonly timeout: number;
  readonly statusCallback: string;
  readonly statusCallbackEvents: ReadonlyArray<TwilioStatusCallbackEvent>;
  /** TwiML played while the conference has not started (POST). */
  readonly waitUrl?: string;
}

export interface CreateCallRequest {
  readonly from: string;
  readonly to: string;
  /** TwiML fetched (POST) when the call is answered. */
  readonly url: string;
  readonly timeout: number;
  readonly statusCallback: string;
  readonly statusCallbackEvents: ReadonlyArray<TwilioStatusCallbackEvent>;
}

export interface UpdateParticipantRequest {
  readonly conferenceSid: string;
  readonly callSid: string;
  readonly hold?: boolean;
  readonly holdUrl?: string;
  readonly muted?: boolean;
  readonly announceUrl?: string;
}

export interface TwilioClientShape {
  readonly addParticipant: (
    credentials: TwilioCredentials,
    request: AddParticipantRequest,
  ) => Effect.Effect<
    { readonly callSid: string; readonly conferenceSid: string },
    TwilioRequestError
  >;
  readonly createCall: (
    credentials: TwilioCredentials,
    request: CreateCallRequest,
  ) => Effect.Effect<{ readonly callSid: string }, TwilioRequestError>;
  readonly updateParticipant: (
    credentials: TwilioCredentials,
    request: UpdateParticipantRequest,
  ) => Effect.Effect<void, TwilioRequestError>;
  readonly endConference: (
    credentials: TwilioCredentials,
    conferenceSid: string,
  ) => Effect.Effect<void, TwilioRequestError>;
}

export class TwilioClient extends Context.Service<TwilioClient, TwilioClientShape>()(
  "@awtprod/command-center/command-center/phone/TwilioClient",
) {}

const ParticipantResponse = Schema.Struct({
  call_sid: TwilioCallSid,
  conference_sid: TwilioConferenceSid,
});
const CallResponse = Schema.Struct({ sid: TwilioCallSid });
const ErrorResponse = Schema.Struct({
  code: Schema.optional(Schema.NullOr(Schema.Number)),
  message: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeParticipant = Schema.decodeUnknownOption(Schema.fromJsonString(ParticipantResponse));
const decodeCall = Schema.decodeUnknownOption(Schema.fromJsonString(CallResponse));
const decodeError = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorResponse));
const isTwilioRequestError = Schema.is(TwilioRequestError);

type FormFields = ReadonlyArray<readonly [string, string]>;

const flag = (value: boolean) => (value ? "true" : "false");

const callbackFields = (
  statusCallback: string,
  events: ReadonlyArray<TwilioStatusCallbackEvent>,
): FormFields => [
  ["StatusCallback", statusCallback],
  ["StatusCallbackMethod", "POST"],
  // The REST API takes one StatusCallbackEvent parameter per event.
  ...events.map((event) => ["StatusCallbackEvent", event] as const),
];

export interface TwilioClientOptions {
  readonly fetchImpl?: FetchLike;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

export const makeTwilioClient = (options: TwilioClientOptions = {}): TwilioClientShape => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? TWILIO_API_BASE_URL;
  const timeoutMs = options.timeoutMs ?? TWILIO_REQUEST_TIMEOUT_MS;

  const post = async (
    credentials: TwilioCredentials,
    resource: string,
    fields: FormFields,
    interrupt: AbortSignal,
  ): Promise<string> => {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([interrupt, deadline]);
    const url = `${baseUrl}/2010-04-01/Accounts/${encodeURIComponent(credentials.accountSid)}/${resource}`;
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Basic ${btoa(`${credentials.accountSid}:${credentials.authToken}`)}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(
          fields.map(([name, value]): [string, string] => [name, value]),
        ).toString(),
        redirect: "error",
        signal,
      });
      const text = await readBoundedText(response, RESPONSE_MAX_BYTES).catch((cause: unknown) => {
        // A 4xx proves nothing was created even when its body cannot be read.
        if (!response.ok) return "";
        throw cause;
      });
      if (!response.ok) {
        const detail = Option.getOrUndefined(decodeError(text));
        const message = redactProviderText(detail?.message ?? "");
        throw new TwilioRequestError({
          reason: "http",
          message: `Twilio answered HTTP ${response.status}${message.length === 0 ? "" : `: ${message}`}`,
          status: response.status,
          ...(typeof detail?.code === "number" ? { code: detail.code } : {}),
        });
      }
      return text;
    } catch (cause) {
      if (isTwilioRequestError(cause)) throw cause;
      throw deadline.aborted
        ? new TwilioRequestError({
            reason: "timeout",
            message: `Twilio did not answer within ${Math.round(timeoutMs / 1000)} s.`,
          })
        : new TwilioRequestError({ reason: "transport", message: "Twilio could not be reached." });
    }
  };

  const request = <A>(
    span: string,
    credentials: TwilioCredentials,
    resource: string,
    fields: FormFields,
    decode: (text: string) => Option.Option<A>,
  ): Effect.Effect<A, TwilioRequestError> =>
    Effect.tryPromise({
      try: async (interrupt) => {
        const text = await post(credentials, resource, fields, interrupt);
        const decoded = decode(text);
        if (Option.isNone(decoded)) {
          throw new TwilioRequestError({
            reason: "invalid-response",
            message: "Twilio returned an unexpected response.",
          });
        }
        return decoded.value;
      },
      catch: (cause) =>
        isTwilioRequestError(cause)
          ? cause
          : new TwilioRequestError({
              reason: "transport",
              message: "Twilio could not be reached.",
            }),
    }).pipe(Effect.withSpan(span));

  const ignoreBody = () => Option.some(undefined);
  const conferencePath = (conferenceSid: string) =>
    `Conferences/${encodeURIComponent(conferenceSid)}`;

  return TwilioClient.of({
    addParticipant: (credentials, input) =>
      request(
        "TwilioClient.addParticipant",
        credentials,
        `Conferences/${encodeURIComponent(input.conferenceName)}/Participants.json`,
        [
          ["From", input.from],
          ["To", input.to],
          ["Label", input.label],
          ["StartConferenceOnEnter", flag(input.startConferenceOnEnter)],
          ["EndConferenceOnExit", flag(input.endConferenceOnExit)],
          ["Beep", "false"],
          ["Timeout", String(input.timeout)],
          ...(input.waitUrl === undefined
            ? []
            : ([
                ["WaitUrl", input.waitUrl],
                ["WaitMethod", "POST"],
              ] as const)),
          ...callbackFields(input.statusCallback, input.statusCallbackEvents),
        ],
        (text) =>
          Option.map(decodeParticipant(text), (body) => ({
            callSid: body.call_sid,
            conferenceSid: body.conference_sid,
          })),
      ),
    createCall: (credentials, input) =>
      request(
        "TwilioClient.createCall",
        credentials,
        "Calls.json",
        [
          ["From", input.from],
          ["To", input.to],
          ["Url", input.url],
          ["Method", "POST"],
          ["Timeout", String(input.timeout)],
          ...callbackFields(input.statusCallback, input.statusCallbackEvents),
        ],
        (text) => Option.map(decodeCall(text), (body) => ({ callSid: body.sid })),
      ),
    updateParticipant: (credentials, input) =>
      request(
        "TwilioClient.updateParticipant",
        credentials,
        `${conferencePath(input.conferenceSid)}/Participants/${encodeURIComponent(input.callSid)}.json`,
        [
          ...(input.hold === undefined ? [] : ([["Hold", flag(input.hold)]] as const)),
          ...(input.holdUrl === undefined
            ? []
            : ([
                ["HoldUrl", input.holdUrl],
                ["HoldMethod", "POST"],
              ] as const)),
          ...(input.muted === undefined ? [] : ([["Muted", flag(input.muted)]] as const)),
          ...(input.announceUrl === undefined
            ? []
            : ([
                ["AnnounceUrl", input.announceUrl],
                ["AnnounceMethod", "POST"],
              ] as const)),
        ],
        ignoreBody,
      ),
    endConference: (credentials, conferenceSid) =>
      request(
        "TwilioClient.endConference",
        credentials,
        `${conferencePath(conferenceSid)}.json`,
        [["Status", "completed"]],
        ignoreBody,
      ),
  });
};

export const layer = Layer.succeed(TwilioClient, makeTwilioClient());
