// @effect-diagnostics nodeBuiltinImport:off - signatures are computed independently with node:crypto.
import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { parsePhoneWebhookEvent, verifyElevenLabsSignature } from "./PhoneWebhook.ts";

const SECRET = "wsec_test_0123456789abcdef"; // gitleaks:allow (test fixture)
const NOW_MS = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-17T15:00:00.000Z"));
const encoder = new TextEncoder();

/** The scheme of the official SDKs: `t=<ts>,v0=<hex hmac-sha256 of "<ts>.<raw body>">`. */
const sign = (body: string, timestampSeconds: number, secret = SECRET) =>
  `t=${timestampSeconds},v0=${NodeCrypto.createHmac("sha256", secret).update(`${timestampSeconds}.${body}`).digest("hex")}`;

const nowSeconds = Math.floor(NOW_MS / 1000);
const transcription = (data: Record<string, unknown>) =>
  JSON.stringify({ type: "post_call_transcription", event_timestamp: nowSeconds, data });

describe("verifyElevenLabsSignature", () => {
  const body = transcription({ agent_id: "agent_owner", conversation_id: "conv_1" });
  const verify = (header: string | undefined, raw = body, secret = SECRET, nowMs = NOW_MS) =>
    verifyElevenLabsSignature({ header, body: encoder.encode(raw), secret, nowMs });

  it("accepts a fresh signature over the exact body", () => {
    expect(verify(sign(body, nowSeconds))).toBe("valid");
    // Header elements may carry spaces and appear in any order.
    const [t, v0] = sign(body, nowSeconds).split(",");
    expect(verify(` ${v0}, ${t}`)).toBe("valid");
  });

  it("rejects a changed body, a wrong secret, and malformed headers", () => {
    expect(verify(sign(body, nowSeconds), `${body} `)).toBe("unauthorized");
    expect(verify(sign(body, nowSeconds, "wsec_other_secret_value"))).toBe("unauthorized");
    for (const header of [
      undefined,
      "",
      `t=${nowSeconds}`,
      `v0=${"a".repeat(64)}`,
      `t=${nowSeconds},v0=not-hex`,
      `t=abc,${sign(body, nowSeconds).split(",")[1]}`,
      `t=${nowSeconds},t=${nowSeconds},${sign(body, nowSeconds).split(",")[1]}`,
    ]) {
      expect(verify(header)).toBe("unauthorized");
    }
  });

  it("accepts retries up to 30 minutes old and at most five minutes of future skew", () => {
    expect(verify(sign(body, nowSeconds - 4 * 60))).toBe("valid");
    // ElevenLabs retries post-call deliveries 30 s, 2 m, 8 m, and 30 m apart.
    expect(verify(sign(body, nowSeconds - 29 * 60))).toBe("valid");
    expect(verify(sign(body, nowSeconds - 31 * 60))).toBe("stale");
    expect(verify(sign(body, nowSeconds + 4 * 60))).toBe("valid");
    expect(verify(sign(body, nowSeconds + 6 * 60))).toBe("stale");
  });
});

describe("parsePhoneWebhookEvent", () => {
  const parse = (raw: string) => parsePhoneWebhookEvent(encoder.encode(raw));

  it("reads the summary, the outcome, and the owner's answer from a transcription", () => {
    const event = parse(
      transcription({
        agent_id: "agent_owner",
        conversation_id: "conv_1",
        status: "done",
        transcript: [{ role: "agent", message: "Hi Andrew" }],
        analysis: {
          call_successful: "success",
          transcript_summary: "Andrew approved the  vendor\nswitch.",
          data_collection_results: {
            outcome: { data_collection_id: "outcome", value: "approved", rationale: "said yes" },
            owner_answer: {
              data_collection_id: "owner_answer",
              value: "yes",
              rationale: "said yes",
            },
          },
        },
      }),
    );
    expect(event).toEqual(
      Option.some({
        kind: "ended",
        conversationId: "conv_1",
        summary: "Andrew approved the vendor switch.",
        outcome: "approved",
        ownerAnswer: "yes",
      }),
    );
  });

  it("falls back to call_successful and tolerates missing analysis", () => {
    expect(
      parse(
        transcription({
          agent_id: "agent_x",
          conversation_id: "conv_2",
          analysis: {
            call_successful: "failure",
            data_collection_results: { outcome: { value: null } },
          },
        }),
      ),
    ).toEqual(
      Option.some({
        kind: "ended",
        conversationId: "conv_2",
        summary: "No summary was produced.",
        outcome: "failure",
      }),
    );
    expect(
      parse(transcription({ agent_id: "agent_x", conversation_id: "conv_3", analysis: null })),
    ).toEqual(
      Option.some({
        kind: "ended",
        conversationId: "conv_3",
        summary: "No summary was produced.",
        outcome: "unknown",
      }),
    );
  });

  it("reads call initiation failures", () => {
    expect(
      parse(
        JSON.stringify({
          type: "call_initiation_failure",
          event_timestamp: nowSeconds,
          data: { agent_id: "agent_x", conversation_id: "conv_4", failure_reason: "no-answer" },
        }),
      ),
    ).toEqual(
      Option.some({ kind: "not-connected", conversationId: "conv_4", failureReason: "no-answer" }),
    );
  });

  it("ignores other event types and rejects malformed bodies", () => {
    expect(
      parse(JSON.stringify({ type: "post_call_audio", data: { full_audio: "AAAA" } })),
    ).toEqual(Option.some({ kind: "ignored" }));
    for (const raw of [
      "not json",
      "[]",
      JSON.stringify({ data: {} }),
      transcription({ conversation_id: "conv_5" }),
      transcription({ agent_id: "agent_x", conversation_id: "../etc" }),
      transcription({ agent_id: "agent_x", conversation_id: "conv_6", analysis: "nope" }),
    ]) {
      expect(parse(raw)).toEqual(Option.none());
    }
    expect(parsePhoneWebhookEvent(new Uint8Array([0xff, 0xfe, 0x7b]))).toEqual(Option.none());
  });
});
