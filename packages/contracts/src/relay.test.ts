import { describe, expect, it } from "vite-plus/test";
import * as OpenApi from "effect/unstable/httpapi/OpenApi";
import * as Schema from "effect/Schema";

import { RelayApi, RelayDeviceRegistrationRequest } from "./relay.ts";

const decodeRegistration = Schema.decodeUnknownSync(RelayDeviceRegistrationRequest);

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
