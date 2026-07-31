import { COMMAND_CENTER_WEBHOOK_MAX_PAYLOAD_BYTES } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { WebhookAdmissionError, make as makeWebhookAdmission } from "./WebhookAdmission.ts";
import { CommandCenterNotReadyError, CommandCenterReadinessGate } from "./ReadinessGate.ts";

export const COMMAND_CENTER_WEBHOOK_HTTP_PATH = "/api/command-center/webhooks";

class WebhookBodyReadError extends Schema.TaggedErrorClass<WebhookBodyReadError>()(
  "WebhookBodyReadError",
  {
    reason: Schema.Literals(["invalid-length", "payload-too-large", "read-failed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const noStoreHeaders = { "cache-control": "no-store" } as const;
const isWebhookBodyReadError = Schema.is(WebhookBodyReadError);
const isWebhookAdmissionError = Schema.is(WebhookAdmissionError);
const isCommandCenterNotReadyError = Schema.is(CommandCenterNotReadyError);

export function webhookErrorResponse(error: unknown): HttpServerResponse.HttpServerResponse {
  if (isCommandCenterNotReadyError(error)) {
    return HttpServerResponse.jsonUnsafe(
      { error: "webhook_unavailable" },
      { status: 503, headers: noStoreHeaders },
    );
  }
  if (isWebhookBodyReadError(error)) {
    const tooLarge = error.reason === "payload-too-large";
    return HttpServerResponse.jsonUnsafe(
      { error: tooLarge ? "webhook_payload_too_large" : "invalid_webhook_request" },
      { status: tooLarge ? 413 : 400, headers: noStoreHeaders },
    );
  }
  if (isWebhookAdmissionError(error)) {
    if (error.reason === "payload-too-large") {
      return HttpServerResponse.jsonUnsafe(
        { error: "webhook_payload_too_large" },
        { status: 413, headers: noStoreHeaders },
      );
    }
    if (error.reason === "invalid-request" || error.reason === "invalid-payload") {
      return HttpServerResponse.jsonUnsafe(
        { error: "invalid_webhook_request" },
        { status: 400, headers: noStoreHeaders },
      );
    }
    if (error.reason === "admission-failed") {
      const triggerReason =
        typeof error.cause === "object" &&
        error.cause !== null &&
        "reason" in error.cause &&
        typeof error.cause.reason === "string"
          ? error.cause.reason
          : undefined;
      const status =
        triggerReason === "not-found"
          ? 404
          : triggerReason === "ambiguous-webhook"
            ? 409
            : triggerReason === "invalid-webhook" || triggerReason === "trigger-mismatch"
              ? 400
              : 503;
      return HttpServerResponse.jsonUnsafe(
        { error: "webhook_admission_failed" },
        { status, headers: noStoreHeaders },
      );
    }
    // Missing or malformed runtime credentials are intentionally indistinguishable
    // from an invalid sender credential so the endpoint does not reveal host state.
    return HttpServerResponse.jsonUnsafe(
      { error: "invalid_webhook_credential" },
      {
        status: 401,
        headers: { ...noStoreHeaders, "www-authenticate": "CommandCenter-HMAC" },
      },
    );
  }
  return HttpServerResponse.jsonUnsafe(
    { error: "webhook_unavailable" },
    { status: 503, headers: noStoreHeaders },
  );
}

export const collectBoundedWebhookBody = (input: {
  readonly contentLength?: string;
  readonly stream: Stream.Stream<Uint8Array, unknown>;
}): Effect.Effect<Uint8Array, WebhookBodyReadError> => {
  const rawLength = input.contentLength;
  if (rawLength !== undefined && !/^\d+$/u.test(rawLength)) {
    return Effect.fail(new WebhookBodyReadError({ reason: "invalid-length" }));
  }
  if (rawLength !== undefined && Number(rawLength) > COMMAND_CENTER_WEBHOOK_MAX_PAYLOAD_BYTES) {
    return Effect.fail(new WebhookBodyReadError({ reason: "payload-too-large" }));
  }

  return input.stream.pipe(
    Stream.runFoldEffect(
      () => ({ chunks: [] as Uint8Array[], bytes: 0 }),
      (state, chunk) => {
        const bytes = state.bytes + chunk.byteLength;
        if (bytes > COMMAND_CENTER_WEBHOOK_MAX_PAYLOAD_BYTES) {
          return Effect.fail(new WebhookBodyReadError({ reason: "payload-too-large" }));
        }
        state.chunks.push(chunk);
        return Effect.succeed({ chunks: state.chunks, bytes });
      },
    ),
    Effect.map(({ chunks, bytes }) => {
      const body = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return body;
    }),
    Effect.mapError((cause) =>
      isWebhookBodyReadError(cause)
        ? cause
        : new WebhookBodyReadError({ reason: "read-failed", cause }),
    ),
  );
};

export const readBoundedWebhookBody = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<Uint8Array, WebhookBodyReadError> =>
  collectBoundedWebhookBody({
    ...(request.headers["content-length"] === undefined
      ? {}
      : { contentLength: request.headers["content-length"] }),
    stream: request.stream,
  });

const routeLayer = HttpRouter.add(
  "POST",
  COMMAND_CENTER_WEBHOOK_HTTP_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const readiness = yield* CommandCenterReadinessGate;
    const admission = yield* makeWebhookAdmission;
    return yield* readiness.requireReady.pipe(
      Effect.andThen(readBoundedWebhookBody(request)),
      Effect.flatMap((body) => admission.admitHttp({ headers: request.headers, body })),
      Effect.match({
        onFailure: webhookErrorResponse,
        onSuccess: (execution) =>
          HttpServerResponse.jsonUnsafe(
            {
              accepted: true,
              executionId: execution.id,
              automationId: execution.automationId,
              state: execution.state,
              definitionDigest: execution.definitionDigest,
            },
            { status: 202, headers: noStoreHeaders },
          ),
      }),
    );
  }),
);

/**
 * Builds authentication inside the route boundary. The remaining requirements
 * are existing runtime-only services: the secret store, automation runs, and
 * Command Center projection service.
 */
export const webhookHttpRouteLayer = routeLayer;
