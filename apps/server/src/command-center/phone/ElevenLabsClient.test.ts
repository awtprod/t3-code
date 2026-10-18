// @effect-diagnostics preferSchemaOverJson:off - asserts the exact JSON wire body.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import {
  callMayHaveStarted,
  ElevenLabsCallError,
  type FetchLike,
  makeElevenLabsClient,
  type OutboundCallRequest,
} from "./ElevenLabsClient.ts";

const request: OutboundCallRequest = {
  apiKey: "test-api-key-0123456789", // gitleaks:allow (test fixture)
  agentId: "agent_third_party",
  agentPhoneNumberId: "phnum_acme",
  to: "+15550100000",
  dynamicVariables: {
    purpose: "Confirm Tuesday's delivery window",
    brief: "Acme Supply delivers on Tuesday; confirm 9-11am works.",
    allowed_outcomes: "confirm 9-11am; reschedule to Wednesday",
    owner_name: "Andrew",
    callee_name: "Acme Supply",
    patch_in_when: "they ask about pricing",
    call_kind: "third_party",
    question: "",
  },
};

interface Captured {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const capturing = (respond: () => Response) => {
  const calls: Array<Captured> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init });
    return respond();
  };
  return { calls, fetchImpl };
};

/** A fetch that only settles when its signal aborts, recording the signal. */
const hanging = () => {
  const signals: Array<AbortSignal> = [];
  const fetchImpl: FetchLike = (_input, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) return;
      signals.push(signal);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  return { signals, fetchImpl };
};

describe("ElevenLabsClient.startOutboundCall", () => {
  it.effect("posts the documented outbound-call request and returns the conversation id", () =>
    Effect.gen(function* () {
      const { calls, fetchImpl } = capturing(() =>
        jsonResponse(200, {
          success: true,
          message: "Success",
          conversation_id: "conv_abc123",
          callSid: "CA0001",
        }),
      );
      const client = makeElevenLabsClient({ fetchImpl });
      const started = yield* client.startOutboundCall(request);
      expect(started).toEqual({ conversationId: "conv_abc123", callSid: "CA0001" });
      expect(calls).toHaveLength(1);
      const [call] = calls;
      expect(call?.url).toBe("https://api.elevenlabs.io/v1/convai/twilio/outbound-call");
      expect(call?.init?.method).toBe("POST");
      expect(new Headers(call?.init?.headers).get("xi-api-key")).toBe("test-api-key-0123456789");
      expect(new Headers(call?.init?.headers).get("content-type")).toBe("application/json");
      expect(JSON.parse(String(call?.init?.body))).toEqual({
        agent_id: "agent_third_party",
        agent_phone_number_id: "phnum_acme",
        to_number: "+15550100000",
        conversation_initiation_client_data: {
          dynamic_variables: {
            purpose: "Confirm Tuesday's delivery window",
            brief: "Acme Supply delivers on Tuesday; confirm 9-11am works.",
            allowed_outcomes: "confirm 9-11am; reschedule to Wednesday",
            owner_name: "Andrew",
            callee_name: "Acme Supply",
            patch_in_when: "they ask about pricing",
            call_kind: "third_party",
            question: "",
          },
        },
      });
      expect(call?.init?.signal).toBeInstanceOf(AbortSignal);
    }),
  );

  it.effect("fails with a timeout and aborts the request when ElevenLabs does not answer", () =>
    Effect.gen(function* () {
      const { signals, fetchImpl } = hanging();
      const client = makeElevenLabsClient({ fetchImpl, timeoutMs: 5 });
      const error = yield* Effect.flip(client.startOutboundCall(request));
      expect(error.reason).toBe("timeout");
      // No answer: the call may have started.
      expect(callMayHaveStarted(error)).toBe(true);
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(true);
    }),
  );

  it.effect("aborts the in-flight request when the calling fiber is interrupted", () =>
    Effect.gen(function* () {
      const { signals, fetchImpl } = hanging();
      const client = makeElevenLabsClient({ fetchImpl, timeoutMs: 60_000 });
      const fiber = yield* Effect.forkChild(client.startOutboundCall(request));
      for (let turn = 0; turn < 100 && signals.length === 0; turn += 1) yield* Effect.yieldNow;
      expect(signals).toHaveLength(1);
      yield* Fiber.interrupt(fiber);
      expect(signals[0]?.aborted).toBe(true);
    }),
  );

  it.effect("reports an HTTP refusal with its status and a short body that masks numbers", () =>
    Effect.gen(function* () {
      const { fetchImpl } = capturing(() =>
        jsonResponse(422, {
          detail: [{ loc: ["body", "to_number"], msg: "invalid", input: "+15550100000" }],
          padding: "x".repeat(5_000),
        }),
      );
      const error = yield* Effect.flip(
        makeElevenLabsClient({ fetchImpl }).startOutboundCall(request),
      );
      expect(error).toBeInstanceOf(ElevenLabsCallError);
      expect(error.reason).toBe("http");
      // A 4xx proves ElevenLabs did not start the call.
      expect(callMayHaveStarted(error)).toBe(false);
      expect(error.message).toBe("ElevenLabs refused the call (HTTP 422).");
      expect(error.status).toBe(422);
      expect(error.body?.length).toBeLessThanOrEqual(300);
      expect(error.body).toContain("…0000");
      expect(error.body).not.toContain("+15550100000");
      expect(`${error.message} ${error.body}`).not.toContain("test-api-key");
    }),
  );

  it.effect("rejects success=false, a missing conversation id, and a non-JSON body", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [Response, string]> = [
        [jsonResponse(200, { success: false, message: "Agent busy" }), "rejected"],
        [jsonResponse(200, { success: true, message: "ok" }), "invalid-response"],
        [
          jsonResponse(200, { success: true, message: "ok", conversation_id: "bad id!" }),
          "invalid-response",
        ],
        [new Response("<html>gateway</html>", { status: 200 }), "invalid-response"],
      ];
      for (const [response, reason] of cases) {
        const { fetchImpl } = capturing(() => response);
        const error = yield* Effect.flip(
          makeElevenLabsClient({ fetchImpl }).startOutboundCall(request),
        );
        expect(error.reason).toBe(reason);
        // Only an explicit success=false proves a 2xx answer did not start the call.
        expect(callMayHaveStarted(error)).toBe(reason !== "rejected");
      }
    }),
  );

  it.effect("reports a 4xx or 503 status as a definite refusal even if its body fails", () =>
    Effect.gen(function* () {
      for (const status of [429, 503]) {
        const broken = new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new TypeError("terminated"));
          },
        });
        const { fetchImpl } = capturing(() => new Response(broken, { status }));
        const error = yield* Effect.flip(
          makeElevenLabsClient({ fetchImpl }).startOutboundCall(request),
        );
        expect(error.reason).toBe("http");
        expect(error.status).toBe(status);
        expect(callMayHaveStarted(error)).toBe(false);
      }
    }),
  );

  it.effect(
    "treats 4xx and 503 as not started, and any other 5xx as a call that may be ringing",
    () =>
      Effect.gen(function* () {
        const cases: ReadonlyArray<readonly [number, boolean]> = [
          [400, false],
          [401, false],
          [429, false],
          [503, false],
          [500, true],
          [502, true],
          [504, true],
        ];
        for (const [status, mayHaveStarted] of cases) {
          const { fetchImpl } = capturing(() =>
            jsonResponse(status, { detail: "call to +15550100000" }),
          );
          const error = yield* Effect.flip(
            makeElevenLabsClient({ fetchImpl }).startOutboundCall(request),
          );
          expect(error.reason).toBe("http");
          expect(error.status).toBe(status);
          expect(callMayHaveStarted(error)).toBe(mayHaveStarted);
          // The message only says "refused" when the status proves the call was not started.
          expect(error.message).toBe(
            mayHaveStarted
              ? `ElevenLabs failed while starting the call (HTTP ${status}); it may have started.`
              : `ElevenLabs refused the call (HTTP ${status}).`,
          );
          // The redacted body stays on the error either way.
          expect(error.body).toContain("…0000");
          expect(error.body).not.toContain("+15550100000");
        }
      }),
  );

  it("treats an http error without a status as uncertain", () => {
    const error = new ElevenLabsCallError({ reason: "http", message: "ElevenLabs failed." });
    expect(callMayHaveStarted(error)).toBe(true);
  });

  it.effect("stops reading an oversized response body instead of buffering it", () =>
    Effect.gen(function* () {
      let pulled = 0;
      const endless = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          controller.enqueue(new Uint8Array(16 * 1024).fill(0x61));
        },
      });
      const { fetchImpl } = capturing(() => new Response(endless, { status: 200 }));
      const error = yield* Effect.flip(
        makeElevenLabsClient({ fetchImpl }).startOutboundCall(request),
      );
      expect(error.reason).toBe("invalid-response");
      // 64 KiB cap in 16 KiB chunks: a handful of pulls, never an unbounded read.
      expect(pulled).toBeLessThanOrEqual(6);
    }),
  );

  it.effect("maps a network failure to a transport error", () =>
    Effect.gen(function* () {
      const fetchImpl: FetchLike = async () => {
        throw new TypeError("fetch failed");
      };
      const error = yield* Effect.flip(
        makeElevenLabsClient({ fetchImpl }).startOutboundCall(request),
      );
      expect(error.reason).toBe("transport");
      expect(callMayHaveStarted(error)).toBe(true);
    }),
  );
});
