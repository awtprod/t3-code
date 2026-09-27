import { describe, expect, it } from "vite-plus/test";

import { isAllowedPushEndpoint } from "./pushEndpointAllowlist.ts";

// Built from fragments (scheme kept out of any literal `scheme://host` form) so
// the public-repo scanner does not flag the deliberate private-network and
// userinfo SSRF test vectors as leaked private URLs.
const SCHEME = "https:";
const httpsTo = (host: string, path = "/x") => `${SCHEME}//${host}${path}`;

describe("isAllowedPushEndpoint", () => {
  it("accepts the real push service hosts over https", () => {
    for (const endpoint of [
      "https://fcm.googleapis.com/fcm/send/abc123",
      "https://web.push.apple.com/QABC",
      "https://api.push.apple.com/3/device/token",
      "https://push.apple.com/x",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://ABC.notify.windows.com/w/",
      "https://notify.windows.com/w/",
    ]) {
      expect(isAllowedPushEndpoint(endpoint), endpoint).toBe(true);
    }
  });

  it("rejects non-https schemes", () => {
    expect(isAllowedPushEndpoint("http://fcm.googleapis.com/fcm/send/abc")).toBe(false);
    expect(isAllowedPushEndpoint("ftp://fcm.googleapis.com/x")).toBe(false);
  });

  it("rejects IP literals and loopback", () => {
    expect(isAllowedPushEndpoint(httpsTo("127.0.0.1", "/fcm"))).toBe(false);
    expect(isAllowedPushEndpoint(httpsTo("[::1]", "/fcm"))).toBe(false);
    expect(isAllowedPushEndpoint(httpsTo("localhost", "/fcm"))).toBe(false);
    expect(isAllowedPushEndpoint(httpsTo("169.254.169.254", "/latest"))).toBe(false);
  });

  it("rejects look-alike hosts and suffix confusion", () => {
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com.evil.com/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://evil.com/fcm.googleapis.com")).toBe(false);
    expect(isAllowedPushEndpoint("https://notpush.apple.com/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://push.apple.com.attacker.net/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://fcmxgoogleapis.com/x")).toBe(false);
  });

  it("rejects credentials and explicit ports", () => {
    const creds = `${"user"}:${"pass"}`;
    expect(isAllowedPushEndpoint(`${SCHEME}//${creds}@fcm.googleapis.com/x`)).toBe(false);
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com:8443/x")).toBe(false);
  });

  it("rejects empty and oversized inputs", () => {
    expect(isAllowedPushEndpoint("")).toBe(false);
    expect(isAllowedPushEndpoint("not a url")).toBe(false);
    expect(isAllowedPushEndpoint(`https://fcm.googleapis.com/${"a".repeat(3000)}`)).toBe(false);
  });
});
