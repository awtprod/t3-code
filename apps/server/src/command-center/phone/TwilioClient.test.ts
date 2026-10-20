import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import type { FetchLike } from "./ElevenLabsClient.ts";
import { makeTwilioClient, twilioRequestMayHaveStarted } from "./TwilioClient.ts";

const credentials = {
  accountSid: `AC${"0".repeat(32)}`,
  authToken: "twilio_test_auth_token_0123456789", // gitleaks:allow (test fixture)
};
const CALL_SID = `CA${"1".repeat(32)}`;
const CONFERENCE_SID = `CF${"2".repeat(32)}`;

interface Captured {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

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

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const form = (captured: Captured | undefined) =>
  new URLSearchParams(typeof captured?.init?.body === "string" ? captured.init.body : "");

const participant = {
  conferenceName: "cc-call",
  from: "+15555550100",
  to: "+15555550101",
  label: "agent",
  startConferenceOnEnter: false,
  endConferenceOnExit: false,
  timeout: 20,
  statusCallback:
    "https://cc.example.com/api/command-center/phone/webhook/twilio/status?call=x&leg=agent",
  statusCallbackEvents: ["answered", "completed"] as const,
  waitUrl: "https://cc.example.com/api/command-center/phone/webhook/twilio/hold?call=x",
};

describe("TwilioClient", () => {
  it.effect("adds a conference participant with basic auth and the documented form fields", () =>
    Effect.gen(function* () {
      const { calls, fetchImpl } = capturing(() =>
        jsonResponse(201, { call_sid: CALL_SID, conference_sid: CONFERENCE_SID, label: "agent" }),
      );
      const client = makeTwilioClient({ fetchImpl });
      const created = yield* client.addParticipant(credentials, participant);
      expect(created).toEqual({ callSid: CALL_SID, conferenceSid: CONFERENCE_SID });
      const [call] = calls;
      expect(call?.url).toBe(
        `https://api.twilio.com/2010-04-01/Accounts/${credentials.accountSid}/Conferences/cc-call/Participants.json`,
      );
      expect(call?.init?.method).toBe("POST");
      expect(call?.init?.redirect).toBe("error");
      const headers = new Headers(call?.init?.headers);
      expect(headers.get("authorization")).toBe(
        `Basic ${btoa(`${credentials.accountSid}:${credentials.authToken}`)}`,
      );
      expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
      const body = form(call);
      expect(Object.fromEntries(body)).toMatchObject({
        From: "+15555550100",
        To: "+15555550101",
        Label: "agent",
        StartConferenceOnEnter: "false",
        EndConferenceOnExit: "false",
        Beep: "false",
        Timeout: "20",
        WaitUrl: participant.waitUrl,
        WaitMethod: "POST",
        StatusCallback: participant.statusCallback,
        StatusCallbackMethod: "POST",
      });
      // One StatusCallbackEvent parameter per event.
      expect(body.getAll("StatusCallbackEvent")).toEqual(["answered", "completed"]);
    }),
  );

  it.effect("places a call, updates a participant, and ends a conference", () =>
    Effect.gen(function* () {
      const responses = [
        jsonResponse(201, { sid: CALL_SID, status: "queued" }),
        jsonResponse(200, { call_sid: CALL_SID, hold: true }),
        jsonResponse(200, { sid: CONFERENCE_SID, status: "completed" }),
      ];
      const { calls, fetchImpl } = capturing(() => responses.shift() ?? jsonResponse(500, {}));
      const client = makeTwilioClient({ fetchImpl });
      expect(
        yield* client.createCall(credentials, {
          from: "+15555550100",
          to: "+15555550102",
          url: "https://cc.example.com/hook/twilio/owner-twiml?call=x",
          timeout: 30,
          statusCallback: "https://cc.example.com/hook/twilio/status?call=x&leg=owner",
          statusCallbackEvents: ["answered", "completed"],
        }),
      ).toEqual({ callSid: CALL_SID });
      yield* client.updateParticipant(credentials, {
        conferenceSid: CONFERENCE_SID,
        callSid: CALL_SID,
        hold: true,
        holdUrl: "https://cc.example.com/hook/twilio/hold?call=x",
        muted: true,
      });
      yield* client.endConference(credentials, CONFERENCE_SID);
      expect(calls.map((call) => call.url.replace(/^.*\/Accounts\/AC0+\//u, ""))).toEqual([
        "Calls.json",
        `Conferences/${CONFERENCE_SID}/Participants/${CALL_SID}.json`,
        `Conferences/${CONFERENCE_SID}.json`,
      ]);
      expect(Object.fromEntries(form(calls[0]))).toMatchObject({
        Url: "https://cc.example.com/hook/twilio/owner-twiml?call=x",
        Method: "POST",
        Timeout: "30",
      });
      expect(Object.fromEntries(form(calls[1]))).toEqual({
        Hold: "true",
        HoldUrl: "https://cc.example.com/hook/twilio/hold?call=x",
        HoldMethod: "POST",
        Muted: "true",
      });
      expect(Object.fromEntries(form(calls[2]))).toEqual({ Status: "completed" });
    }),
  );

  it.effect("tells a 4xx refusal from answers that may belong to a ringing call", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.flip(
        makeTwilioClient({
          fetchImpl: capturing(() =>
            jsonResponse(400, { code: 21211, message: "Invalid 'To' Phone Number: +15555550109" }),
          ).fetchImpl,
        }).addParticipant(credentials, participant),
      );
      expect(refused.reason).toBe("http");
      expect(refused.code).toBe(21211);
      expect(refused.message).not.toContain("+15555550109");
      expect(twilioRequestMayHaveStarted(refused)).toBe(false);

      for (const respond of [
        () => jsonResponse(500, { message: "internal" }),
        () => jsonResponse(201, { call_sid: "not-a-sid" }),
        () => new Response("<html>", { status: 200 }),
      ]) {
        const error = yield* Effect.flip(
          makeTwilioClient({ fetchImpl: capturing(respond).fetchImpl }).addParticipant(
            credentials,
            participant,
          ),
        );
        expect(twilioRequestMayHaveStarted(error)).toBe(true);
        expect(JSON.stringify(error)).not.toContain(credentials.authToken);
      }
    }),
  );

  it.effect("times out, aborting the request, when Twilio does not answer", () =>
    Effect.gen(function* () {
      const { signals, fetchImpl } = hanging();
      const error = yield* Effect.flip(
        makeTwilioClient({ fetchImpl, timeoutMs: 5 }).endConference(credentials, CONFERENCE_SID),
      );
      expect(error.reason).toBe("timeout");
      expect(twilioRequestMayHaveStarted(error)).toBe(true);
      expect(signals[0]?.aborted).toBe(true);
    }),
  );

  it.effect("aborts the in-flight request when the calling fiber is interrupted", () =>
    Effect.gen(function* () {
      const { signals, fetchImpl } = hanging();
      const fiber = yield* makeTwilioClient({ fetchImpl, timeoutMs: 60_000 })
        .createCall(credentials, {
          from: "+15555550100",
          to: "+15555550102",
          url: "https://cc.example.com/hook",
          timeout: 30,
          statusCallback: "https://cc.example.com/hook",
          statusCallbackEvents: ["completed"],
        })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
      expect(signals[0]?.aborted).toBe(true);
    }),
  );
});
