import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { AuthCommandCenterApproveScope, AuthCommandCenterOperateScope } from "@t3tools/contracts";
import * as Auth from "../auth/EnvironmentAuth.ts";
import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import { RoomError, TeammateRooms } from "./TeammateRooms.ts";
import { collectBoundedWebhookBody } from "./WebhookHttp.ts";

export const layer = HttpRouter.add(
  "POST",
  "/api/command-center/rooms",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* EnvironmentAuth;
    const session = yield* auth.authenticateHttpRequest(request);
    if (
      !session.scopes.includes(AuthCommandCenterApproveScope) ||
      !session.scopes.includes(AuthCommandCenterOperateScope)
    ) {
      return HttpServerResponse.empty({ status: 403 });
    }
    const body = yield* collectBoundedWebhookBody({
      stream: request.stream,
      ...(request.headers["content-length"] === undefined
        ? {}
        : { contentLength: request.headers["content-length"] }),
    }).pipe(Effect.timeout("10 seconds"));
    const input = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
      new TextDecoder().decode(body),
    );
    const rooms = yield* TeammateRooms;
    return HttpServerResponse.jsonUnsafe(
      yield* rooms.request({ kind: "owner", id: session.subject }, input),
      { headers: { "cache-control": "no-store" } },
    );
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          { error: Schema.is(RoomError)(cause) ? cause.reason : "request-rejected" },
          {
            status: Auth.isServerAuthCredentialError(cause)
              ? 401
              : Schema.is(RoomError)(cause)
                ? ({ conflict: 409, forbidden: 403, invalid: 400, unavailable: 503 } as const)[
                    cause.reason
                  ]
                : 400,
          },
        ),
      ),
    ),
  ),
);
