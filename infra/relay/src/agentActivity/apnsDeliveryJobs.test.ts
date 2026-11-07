import { describe, expect, it } from "@effect/vitest";
import * as Redacted from "effect/Redacted";

import {
  makeApnsDeliveryJobPayload,
  signApnsDeliveryJob,
  verifySignedApnsDeliveryJob,
} from "./apnsDeliveryJobs.ts";

const secret = Redacted.make("queue-signing-secret");

const notification = {
  title: "Thread",
  body: "Input: Project",
  environmentId: "env",
  threadId: "thread",
  deepLink: "/threads/env/thread",
};

describe("apnsDeliveryJobs", () => {
  it("rejects tampered signed queue jobs", () => {
    const payload = makeApnsDeliveryJobPayload({
      kind: "live_activity_end",
      userId: "user-1",
      deviceId: "device-1",
      token: "token-1",
      aggregate: null,
      createdAt: "2026-05-25T00:00:00.000Z",
      expiresAt: "2026-05-25T00:05:00.000Z",
      jobId: "job-1",
    });
    const signed = signApnsDeliveryJob({ secret, payload });
    const tampered = {
      ...signed,
      payload: {
        ...signed.payload,
        target: {
          ...signed.payload.target,
          token: "attacker-token",
        },
      },
    };

    const result = verifySignedApnsDeliveryJob({
      secret,
      job: tampered,
      nowMs: 0,
    });

    expect(result).toMatchObject({
      _tag: "ApnsDeliveryJobSignatureInvalid",
      jobId: "job-1",
      kind: "live_activity_end",
      userId: "user-1",
      deviceId: "device-1",
      message: "Invalid signature for APNs delivery job job-1.",
    });
  });

  it("accepts web_push jobs and keeps APNs signatures byte-stable", () => {
    const webPushPayload = makeApnsDeliveryJobPayload({
      kind: "web_push",
      userId: "user-1",
      deviceId: "web-device-1",
      token: "https://push.example.test/subscription/abc",
      webPushP256dh: "p256dh-key",
      webPushAuth: "auth-secret",
      aggregate: null,
      notification,
      createdAt: "2026-05-25T00:00:00.000Z",
      expiresAt: "2026-05-25T00:05:00.000Z",
      jobId: "job-web-push-valid",
    });
    expect(
      verifySignedApnsDeliveryJob({
        secret,
        job: signApnsDeliveryJob({ secret, payload: webPushPayload }),
        nowMs: 0,
      }),
    ).toEqual(webPushPayload);
    expect(webPushPayload.target.webPushP256dh).toBe("p256dh-key");

    // The web push key slots must be OMITTED (not null) on APNs jobs: the HMAC
    // covers the exact key set, so their mere presence would invalidate every
    // signature computed by a relay build that predates the field.
    const apnsPayload = makeApnsDeliveryJobPayload({
      kind: "push_notification",
      userId: "user-1",
      deviceId: "device-1",
      token: "token-1",
      aggregate: null,
      notification,
      createdAt: "2026-05-25T00:00:00.000Z",
      expiresAt: "2026-05-25T00:05:00.000Z",
      jobId: "job-push-no-web-keys",
    });
    expect("webPushP256dh" in apnsPayload.target).toBe(false);
    expect("webPushAuth" in apnsPayload.target).toBe(false);
  });

  it("rejects web_push jobs without a notification payload", () => {
    const payload = makeApnsDeliveryJobPayload({
      kind: "web_push",
      userId: "user-1",
      deviceId: "web-device-1",
      token: "https://push.example.test/subscription/abc",
      webPushP256dh: "p256dh-key",
      webPushAuth: "auth-secret",
      aggregate: null,
      createdAt: "2026-05-25T00:00:00.000Z",
      expiresAt: "2026-05-25T00:05:00.000Z",
      jobId: "job-web-push-missing-notification",
    });
    expect(
      verifySignedApnsDeliveryJob({
        secret,
        job: signApnsDeliveryJob({ secret, payload }),
        nowMs: 0,
      }),
    ).toMatchObject({ _tag: "ApnsDeliveryJobPushNotificationMissing" });
  });
});
