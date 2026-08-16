import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  buildEnvironmentAuthHeaders,
  withEnvironmentCredentials,
} from "../state/environmentHttpAuth.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";

export interface SandboxViewerTicket {
  readonly viewerUrl: string;
  readonly expiresAt: string;
}

export class SandboxViewerTicketError extends Schema.TaggedErrorClass<SandboxViewerTicketError>()(
  "SandboxViewerTicketError",
  { message: Schema.String, cause: Schema.optional(Schema.Unknown) },
) {}

const ViewerTicketResponse = Schema.Struct({ viewerUrl: Schema.String, expiresAt: Schema.String });

export function resolveSandboxViewerTicket(input: {
  readonly httpBaseUrl: string;
  readonly threadId: ThreadId;
  readonly value: unknown;
  readonly now: number;
}): SandboxViewerTicket {
  const { value } = input;
  if (typeof value !== "object" || value === null)
    throw new SandboxViewerTicketError({ message: "Desktop viewer ticket response is malformed." });
  const viewerUrl = Reflect.get(value, "viewerUrl");
  const expiresAt = Reflect.get(value, "expiresAt");
  if (
    typeof viewerUrl !== "string" ||
    typeof expiresAt !== "string" ||
    !Number.isFinite(Date.parse(expiresAt))
  ) {
    throw new SandboxViewerTicketError({ message: "Desktop viewer ticket response is malformed." });
  }
  const resolved = new URL(viewerUrl, input.httpBaseUrl);
  const expectedOrigin = new URL(input.httpBaseUrl).origin;
  const expectedPrefix = `/api/thread-desktop/${encodeURIComponent(input.threadId)}/view`;
  if (resolved.origin !== expectedOrigin || resolved.pathname !== expectedPrefix) {
    throw new SandboxViewerTicketError({
      message: "Desktop viewer ticket targeted the wrong environment or thread.",
    });
  }
  if (Date.parse(expiresAt) <= input.now)
    throw new SandboxViewerTicketError({ message: "Desktop viewer ticket expired before use." });
  return { viewerUrl: resolved.toString(), expiresAt };
}

const endpoint = (base: string, threadId: ThreadId) =>
  new URL(`/api/thread-desktop/${encodeURIComponent(threadId)}/viewer-ticket`, base).toString();

export const requestSandboxViewerTicket = Effect.fn("SandboxViewerTicket.request")(
  function* (input: { readonly threadId: ThreadId }) {
    const supervisor = yield* EnvironmentSupervisor;
    const preparedOption = yield* SubscriptionRef.get(supervisor.prepared);
    if (Option.isNone(preparedOption))
      return yield* new SandboxViewerTicketError({ message: "Environment is not connected." });
    const prepared = preparedOption.value;
    const requestUrl = endpoint(prepared.httpBaseUrl, input.threadId);
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    const auth = yield* buildEnvironmentAuthHeaders(
      prepared.httpAuthorization,
      "POST",
      requestUrl,
      signer,
    );
    const request = yield* HttpClientRequest.post(requestUrl).pipe(
      HttpClientRequest.setHeaders({
        ...(auth.authorization === undefined ? {} : { authorization: auth.authorization }),
        ...(auth.dpop === undefined ? {} : { dpop: auth.dpop }),
      }),
      HttpClientRequest.bodyJson({}),
    );
    const response = yield* Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      return yield* withEnvironmentCredentials(prepared.httpAuthorization, client.execute(request));
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.timeout("10 seconds"),
      Effect.mapError(
        (cause) =>
          new SandboxViewerTicketError({
            message: "Could not request a desktop viewer ticket.",
            cause,
          }),
      ),
    );
    if (response.status < 200 || response.status >= 300)
      return yield* new SandboxViewerTicketError({
        message:
          response.status === 403
            ? "The desktop viewer ticket was denied or expired."
            : `Desktop viewer ticket failed (${response.status}).`,
      });
    const value = yield* HttpClientResponse.schemaBodyJson(ViewerTicketResponse)(response).pipe(
      Effect.mapError(
        (cause) =>
          new SandboxViewerTicketError({
            message: "Desktop viewer ticket returned invalid JSON.",
            cause,
          }),
      ),
    );
    const now = yield* Clock.currentTimeMillis;
    return yield* Effect.try({
      try: () =>
        resolveSandboxViewerTicket({
          httpBaseUrl: prepared.httpBaseUrl,
          threadId: input.threadId,
          value,
          now,
        }),
      catch: (cause) =>
        Schema.is(SandboxViewerTicketError)(cause)
          ? cause
          : new SandboxViewerTicketError({
              message: "Desktop viewer ticket response is malformed.",
              cause,
            }),
    });
  },
);
