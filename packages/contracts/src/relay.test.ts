import { describe, expect, it } from "vite-plus/test";
import * as OpenApi from "effect/unstable/httpapi/OpenApi";
import * as Schema from "effect/Schema";

import {
  RelayApi,
  RelayDeviceRegistrationRequest,
  RelayProspectNotification,
  relayProspectNotificationIdempotencyKey,
} from "./relay.ts";

const decodeRegistration = Schema.decodeUnknownSync(RelayDeviceRegistrationRequest);
const decodeProspectNotification = Schema.decodeUnknownSync(RelayProspectNotification);

describe("RelayDeviceRegistrationRequest", () => {
  // Older app builds predate platform "web"; their payloads must keep
  // decoding unchanged after the platform union widened.
  it("still decodes iOS payloads from older app builds", () => {
    const decoded = decodeRegistration({
      deviceId: "device-1",
      label: "Julius's iPhone",
      platform: "ios",
      iosMajorVersion: 18,
      appVersion: "1.0.0",
      pushToken: "apns-token",
      preferences: {
        liveActivitiesEnabled: true,
        notificationsEnabled: true,
        notifyOnApproval: true,
        notifyOnInput: true,
        notifyOnCompletion: true,
        notifyOnFailure: true,
      },
    });
    expect(decoded.platform).toBe("ios");
    expect(decoded.iosMajorVersion).toBe(18);
    expect(decoded.webPushEndpoint).toBeUndefined();
  });

  it("decodes web payloads carrying a push subscription without iOS fields", () => {
    const decoded = decodeRegistration({
      deviceId: "web-device-1",
      label: "Chrome on macOS",
      platform: "web",
      webPushEndpoint: "https://push.example.test/subscription/abc",
      webPushP256dh: "p256dh-key",
      webPushAuth: "auth-secret",
      preferences: {
        liveActivitiesEnabled: false,
        notificationsEnabled: true,
        notifyOnApproval: true,
        notifyOnInput: true,
        notifyOnCompletion: true,
        notifyOnFailure: true,
      },
    });
    expect(decoded.platform).toBe("web");
    expect(decoded.iosMajorVersion).toBeUndefined();
    expect(decoded.webPushEndpoint).toBe("https://push.example.test/subscription/abc");
  });
});

describe("RelayProspectNotification", () => {
  const itemId = "prospect-review:lead/123";
  const valid = {
    type: "prospect",
    itemId,
    spaceId: "space-1",
    evaluationId: "evaluation-1",
    environmentId: "environment-1",
    title: "New prospect",
    body: "Acme is ready for review.",
    deepLink: `/prospects/${encodeURIComponent(itemId)}`,
  } as const;

  it("decodes the canonical tagged payload", () => {
    expect(decodeProspectNotification(valid)).toEqual(valid);
  });

  it.each([
    ["empty item", { ...valid, itemId: "" }],
    ["wrong item prefix", { ...valid, itemId: "prospect:lead-1" }],
    ["empty title", { ...valid, title: "" }],
    ["oversize title", { ...valid, title: "x".repeat(121) }],
    ["oversize body", { ...valid, body: "x".repeat(241) }],
    ["query", { ...valid, deepLink: `${valid.deepLink}?selected=1` }],
    ["fragment", { ...valid, deepLink: `${valid.deepLink}#selected` }],
    ["extra slash", { ...valid, deepLink: `${valid.deepLink}/child` }],
    ["noncanonical encoding", { ...valid, deepLink: "/prospects/prospect-review%3alead%2f123" }],
    [
      "different item",
      { ...valid, deepLink: `/prospects/${encodeURIComponent("prospect-review:other")}` },
    ],
  ])("rejects %s", (_label, candidate) => {
    expect(() => decodeProspectNotification(candidate)).toThrow();
  });

  it("derives a stable identity from item and evaluation", () => {
    expect(relayProspectNotificationIdempotencyKey(valid)).toBe(
      relayProspectNotificationIdempotencyKey({ ...valid }),
    );
    expect(relayProspectNotificationIdempotencyKey(valid)).toContain("evaluation-1");
  });
});

describe("RelayApi security", () => {
  it("describes DPoP access tokens using the HTTP DPoP authorization scheme", () => {
    const document = OpenApi.fromApi(RelayApi);

    expect(document.components.securitySchemes?.relayDpop).toEqual({
      type: "http",
      scheme: "DPoP",
      description: "DPoP-bound access token. Requests must also include the DPoP proof JWT header.",
    });
  });
});
