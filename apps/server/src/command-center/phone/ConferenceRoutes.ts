// @effect-diagnostics nodeBuiltinImport:off - the tool token is compared with node:crypto's timingSafeEqual.
/**
 * ConferenceRoutes - the HTTP side of conference-mode calls, below the phone
 * webhook mount so the same public path (Funnel / reverse proxy) reaches them:
 *
 * | Route                                   | Caller     | Credential                    |
 * | --------------------------------------- | ---------- | ----------------------------- |
 * | `…/webhook/elevenlabs/initiation`       | ElevenLabs | `x-cc-phone-token` header     |
 * | `…/webhook/elevenlabs/tool/bring-owner-in` | ElevenLabs | `x-cc-phone-token` header  |
 * | `…/webhook/twilio/status`               | Twilio     | `X-Twilio-Signature`          |
 * | `…/webhook/twilio/owner-twiml`          | Twilio     | `X-Twilio-Signature`          |
 * | `…/webhook/twilio/hold`, `…/announce`   | Twilio     | `X-Twilio-Signature`          |
 *
 * The routes sit outside bearer auth like the post-call webhook. The token is
 * compared with `conference.toolSecret` in constant time; a Twilio signature
 * is checked against the URL Command Center gave Twilio, rebuilt from
 * `conference.publicBaseUrl` and the validated query, never from request
 * headers, and the form's `AccountSid` must be the configured account. A server
 * without a conference-mode connection answers every route like a bad
 * credential. There is no switch that skips either check.
 *
 * Bodies are capped at 1 MiB while streaming and shape-checked before use; bad
 * input answers 400 or 401, never 5xx. Each route decodes, calls one
 * `ConferenceCalls` method, and maps the result.
 *
 * @module ConferenceRoutes
 */
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { CommandCenterReadinessGate } from "../ReadinessGate.ts";
import { collectBoundedWebhookBody, webhookErrorResponse } from "../WebhookHttp.ts";
import {
  announceTwiml,
  type BringOwnerInResult,
  ConferenceCalls,
  HOLD_TWIML,
  normalizeBridgeReason,
} from "./ConferenceCalls.ts";
import {
  ConferenceCallId,
  ConferenceLegName,
  type TwilioCallbackRoute,
  twilioCallbackUrl,
} from "./ConferenceCallState.ts";
import { ElevenLabsConversationId } from "./ElevenLabsClient.ts";
import {
  hasControlCharacters,
  isPhoneConferenceConnection,
  makePhoneConnectionStore,
  type PhoneConferenceConnection,
} from "./PhoneConnection.ts";
import { PHONE_WEBHOOK_HTTP_PATH } from "./PhoneWebhook.ts";
import { TwilioCallSid } from "./TwilioClient.ts";
import { TWILIO_SIGNATURE_HEADER, verifyTwilioSignature } from "./TwilioSignature.ts";

const PHONE_TOKEN_HEADER = "x-cc-phone-token";

export const ConferenceRoute = Schema.Literals([
  "elevenlabs/initiation",
  "elevenlabs/tool/bring-owner-in",
  "twilio/status",
  "twilio/owner-twiml",
  "twilio/hold",
  "twilio/announce",
]);
export type ConferenceRoute = typeof ConferenceRoute.Type;

export interface ConferenceHttpRequest {
  /** The request target as received: path and query string. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: Uint8Array;
}

export type ConferenceHttpResult =
  | { readonly kind: "json"; readonly status: 200 | 400 | 401 | 404 | 503; readonly body: unknown }
  | { readonly kind: "twiml"; readonly body: string }
  | { readonly kind: "empty" };

const json = (status: 200 | 400 | 401 | 404 | 503, body: unknown): ConferenceHttpResult => ({
  kind: "json",
  status,
  body,
});
const unauthorized = json(401, { error: "invalid_webhook_credential" });
const invalid = json(400, { error: "invalid_webhook_request" });
const unavailable = json(503, { error: "webhook_unavailable" });

// ── ElevenLabs ───────────────────────────────────────────────────────────────

const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value, "utf8").digest();

/** Constant-time comparison of the `x-cc-phone-token` header with the tool secret. */
const phoneTokenMatches = (header: string | undefined, secret: string): boolean =>
  NodeCrypto.timingSafeEqual(sha256(header ?? ""), sha256(secret)) && header !== undefined;

const OptionalText = (max: number) =>
  Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(max))));

const InitiationBody = Schema.Struct({
  conversation_id: ElevenLabsConversationId,
  agent_id: OptionalText(200),
  called_number: OptionalText(64),
  call_sid: OptionalText(64),
  caller_id: OptionalText(64),
});

const BringOwnerInBody = Schema.Struct({
  reason: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(1_000),
    Schema.makeFilter(
      (value) =>
        (value.trim().length > 0 && !hasControlCharacters(value, true)) ||
        "The reason must be non-blank text without control characters.",
    ),
  ),
  conversation_id: OptionalText(128),
  call_sid: OptionalText(64),
});

/** UTF-8 text of a body; `None` when it is not UTF-8. */
const utf8 = (body: Uint8Array): Option.Option<string> => {
  try {
    return Option.some(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    // Not UTF-8: answered as an invalid request.
    return Option.none();
  }
};
const decodeInitiationJson = Schema.decodeUnknownOption(Schema.fromJsonString(InitiationBody));
const decodeBringOwnerInJson = Schema.decodeUnknownOption(Schema.fromJsonString(BringOwnerInBody));
const decodeInitiation = (body: Uint8Array) => Option.flatMap(utf8(body), decodeInitiationJson);
const decodeBringOwnerIn = (body: Uint8Array) => Option.flatMap(utf8(body), decodeBringOwnerInJson);

/** ElevenLabs sends unset dynamic variables as empty strings. */
const present = (value: string | null | undefined) =>
  value === undefined || value === null || value.length === 0 ? undefined : value;

const bringOwnerInFailed = (connection: PhoneConferenceConnection): BringOwnerInResult => ({
  status: "failed",
  message: `${connection.ownerName} could not be brought in because of a Command Center error. Tell the callee that ${connection.ownerName} is not available right now and continue the call.`,
});

// ── Twilio ───────────────────────────────────────────────────────────────────

type Pairs = ReadonlyArray<readonly [string, string]>;

const queryPairs = (url: string): Pairs => {
  const index = url.indexOf("?");
  return [...new URLSearchParams(index === -1 ? "" : url.slice(index + 1)).entries()];
};

const formPairs = (body: Uint8Array): Option.Option<Pairs> =>
  Option.map(utf8(body), (text) => [...new URLSearchParams(text).entries()]);

/** The value of a parameter that occurs exactly once. */
const single = (pairs: Pairs, name: string): string | undefined => {
  const values = pairs.filter(([key]) => key === name);
  return values.length === 1 ? values[0]?.[1] : undefined;
};

const isCallId = Schema.is(ConferenceCallId);
const isLegName = Schema.is(ConferenceLegName);
const isCallSid = Schema.is(TwilioCallSid);

/**
 * The call id (and leg) of a Twilio request whose signature matches the URL
 * Command Center gave Twilio for this route; `None` for anything else.
 */
const authenticateTwilioRequest = (input: {
  readonly connection: PhoneConferenceConnection;
  readonly route: TwilioCallbackRoute;
  readonly request: ConferenceHttpRequest;
}): Option.Option<{
  readonly callId: string;
  readonly leg: ConferenceLegName | undefined;
  readonly params: Pairs;
}> => {
  const query = queryPairs(input.request.url);
  const callId = single(query, "call");
  const rawLeg = single(query, "leg");
  const leg = rawLeg !== undefined && isLegName(rawLeg) ? rawLeg : undefined;
  // Exactly the query Command Center gave Twilio: `call`, plus `leg` on status callbacks.
  if (
    query.length !== (input.route === "status" ? 2 : 1) ||
    callId === undefined ||
    !isCallId(callId) ||
    (input.route === "status" && leg === undefined)
  ) {
    return Option.none();
  }
  const params = formPairs(input.request.body);
  if (Option.isNone(params)) return Option.none();
  const signed = verifyTwilioSignature({
    authToken: input.connection.twilio.authToken,
    url: twilioCallbackUrl({
      publicBaseUrl: input.connection.conference.publicBaseUrl,
      route: input.route,
      callId,
      ...(leg === undefined ? {} : { leg }),
    }),
    params: params.value,
    header: input.request.headers[TWILIO_SIGNATURE_HEADER],
  });
  if (!signed || single(params.value, "AccountSid") !== input.connection.twilio.accountSid) {
    return Option.none();
  }
  return Option.some({ callId, leg, params: params.value });
};

// ── Dispatch ─────────────────────────────────────────────────────────────────

const handleTwilio = Effect.fn("ConferenceRoutes.twilio")(function* (
  connection: PhoneConferenceConnection,
  route: TwilioCallbackRoute,
  request: ConferenceHttpRequest,
) {
  const calls = yield* ConferenceCalls;
  const authenticated = authenticateTwilioRequest({ connection, route, request });
  if (Option.isNone(authenticated)) return unauthorized;
  const { callId, leg, params } = authenticated.value;
  switch (route) {
    case "hold":
      return { kind: "twiml", body: HOLD_TWIML } as const;
    case "announce":
      return { kind: "twiml", body: announceTwiml(connection.ownerName) } as const;
    case "owner-twiml": {
      const callSid = single(params, "CallSid");
      if (callSid === undefined || !isCallSid(callSid)) return invalid;
      return {
        kind: "twiml",
        body: yield* calls.ownerTwiml(connection, { callId, callSid }),
      } as const;
    }
    case "status": {
      const callSid = single(params, "CallSid");
      const callStatus = single(params, "CallStatus");
      if (
        leg === undefined ||
        callSid === undefined ||
        !isCallSid(callSid) ||
        callStatus === undefined ||
        callStatus.length > 32
      ) {
        return invalid;
      }
      // Unknown calls, duplicates, and late callbacks are all acknowledged.
      yield* calls.twilioStatus(connection, { callId, leg, callSid, callStatus });
      return { kind: "empty" } as const;
    }
  }
});

const handleElevenLabs = Effect.fn("ConferenceRoutes.elevenLabs")(function* (
  connection: PhoneConferenceConnection,
  route: "elevenlabs/initiation" | "elevenlabs/tool/bring-owner-in",
  request: ConferenceHttpRequest,
) {
  const calls = yield* ConferenceCalls;
  if (!phoneTokenMatches(request.headers[PHONE_TOKEN_HEADER], connection.conference.toolSecret)) {
    return unauthorized;
  }
  if (route === "elevenlabs/initiation") {
    const body = decodeInitiation(request.body);
    if (Option.isNone(body)) return invalid;
    const agentId = present(body.value.agent_id);
    const calledNumber = present(body.value.called_number);
    const callSid = present(body.value.call_sid);
    const result = yield* calls.initiation(connection, {
      conversationId: body.value.conversation_id,
      ...(agentId === undefined ? {} : { agentId }),
      ...(calledNumber === undefined ? {} : { calledNumber }),
      ...(callSid === undefined ? {} : { callSid }),
    });
    return result.kind === "not-found"
      ? json(404, { error: "call_not_found" })
      : json(200, {
          type: "conversation_initiation_client_data",
          dynamic_variables: result.dynamicVariables,
        });
  }
  const body = decodeBringOwnerIn(request.body);
  if (Option.isNone(body)) return invalid;
  const conversationId = present(body.value.conversation_id);
  const callSid = present(body.value.call_sid);
  const result = yield* calls
    .bringOwnerIn(connection, {
      reason: normalizeBridgeReason(body.value.reason),
      ...(conversationId === undefined ? {} : { conversationId }),
      ...(callSid === undefined ? {} : { callSid }),
    })
    .pipe(
      // The agent needs an answer it can act on, not a transport error.
      Effect.catch((cause) =>
        Effect.logWarning("bring_owner_in failed", { cause }).pipe(
          Effect.as(bringOwnerInFailed(connection)),
        ),
      ),
    );
  return json(200, result);
});

/**
 * Authenticate, decode, and run one conference route. Never fails: every
 * outcome is an HTTP result.
 */
export const handleConferenceRequest = (route: ConferenceRoute, request: ConferenceHttpRequest) =>
  Effect.gen(function* () {
    const loaded = yield* makePhoneConnectionStore(yield* ServerSecretStore).load;
    // No connection, or one without conference mode: indistinguishable from a bad credential.
    const connection = Option.filter(loaded, isPhoneConferenceConnection);
    if (Option.isNone(connection)) return unauthorized;
    switch (route) {
      case "elevenlabs/initiation":
      case "elevenlabs/tool/bring-owner-in":
        return yield* handleElevenLabs(connection.value, route, request);
      case "twilio/status":
        return yield* handleTwilio(connection.value, "status", request);
      case "twilio/owner-twiml":
        return yield* handleTwilio(connection.value, "owner-twiml", request);
      case "twilio/hold":
        return yield* handleTwilio(connection.value, "hold", request);
      case "twilio/announce":
        return yield* handleTwilio(connection.value, "announce", request);
    }
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("phone conference route failed", { route, cause }).pipe(
        Effect.as(unavailable),
      ),
    ),
  );

// ── HTTP ─────────────────────────────────────────────────────────────────────

const noStoreHeaders = { "cache-control": "no-store" } as const;

const toResponse = (result: ConferenceHttpResult): HttpServerResponse.HttpServerResponse => {
  switch (result.kind) {
    case "json":
      return HttpServerResponse.jsonUnsafe(result.body, {
        status: result.status,
        headers: noStoreHeaders,
      });
    case "twiml":
      return HttpServerResponse.text(result.body, {
        status: 200,
        contentType: "text/xml",
        headers: noStoreHeaders,
      });
    case "empty":
      return HttpServerResponse.empty({ status: 204, headers: noStoreHeaders });
  }
};

const routeLayer = (route: ConferenceRoute) =>
  HttpRouter.add(
    "POST",
    `${PHONE_WEBHOOK_HTTP_PATH}/${route}`,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const readiness = yield* CommandCenterReadinessGate;
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
          handleConferenceRequest(route, { url: request.url, headers: request.headers, body }),
        ),
        Effect.match({ onFailure: webhookErrorResponse, onSuccess: toResponse }),
      );
    }),
  );

/** Registered beside the post-call webhook; needs the readiness gate, secret store, and `ConferenceCalls`. */
export const conferenceRoutesLayer = Layer.mergeAll(
  routeLayer("elevenlabs/initiation"),
  routeLayer("elevenlabs/tool/bring-owner-in"),
  routeLayer("twilio/status"),
  routeLayer("twilio/owner-twiml"),
  routeLayer("twilio/hold"),
  routeLayer("twilio/announce"),
);
