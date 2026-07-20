import { COMMAND_CENTER_WEBHOOK_MAX_PAYLOAD_BYTES } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { CommandCenterNotReadyError } from "./ReadinessGate.ts";
import { collectBoundedWebhookBody, webhookErrorResponse } from "./WebhookHttp.ts";

it.effect("collects chunked webhook bodies without crossing the byte boundary", () =>
  Effect.gen(function* () {
    const body = yield* collectBoundedWebhookBody({
      contentLength: "6",
      stream: Stream.make(new Uint8Array([1, 2]), new Uint8Array([3, 4, 5, 6])),
    });
    expect(Array.from(body)).toEqual([1, 2, 3, 4, 5, 6]);
  }),
);

it.effect("rejects oversized declared and chunked webhook bodies", () =>
  Effect.gen(function* () {
    const declared = yield* collectBoundedWebhookBody({
      contentLength: String(COMMAND_CENTER_WEBHOOK_MAX_PAYLOAD_BYTES + 1),
      stream: Stream.empty,
    }).pipe(Effect.flip);
    expect(declared.reason).toBe("payload-too-large");

    const streamed = yield* collectBoundedWebhookBody({
      stream: Stream.make(
        new Uint8Array(COMMAND_CENTER_WEBHOOK_MAX_PAYLOAD_BYTES),
        new Uint8Array([1]),
      ),
    }).pipe(Effect.flip);
    expect(streamed.reason).toBe("payload-too-large");
  }),
);

it("returns a non-disclosing service-unavailable response before startup is ready", () => {
  const response = webhookErrorResponse(new CommandCenterNotReadyError({ state: "failed" }));
  expect(response.status).toBe(503);
  expect(response.headers["cache-control"]).toBe("no-store");
});
