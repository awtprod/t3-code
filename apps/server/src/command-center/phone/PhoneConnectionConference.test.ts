// @effect-diagnostics nodeBuiltinImport:off - exercises the offline CLI against a temporary directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { decodePhoneConnection, isPhoneConferenceConnection } from "./PhoneConnection.ts";
import { phoneConnectionStatus, setPhoneConnection } from "./provisionPhoneConnection.ts";

const legacy = {
  apiKey: "xi_test_api_key_0123456789", // gitleaks:allow (test fixture)
  webhookSecret: "wsec_test_0123456789abcdef", // gitleaks:allow (test fixture)
  agentId: "agent_third_party",
  ownerAgentId: "agent_owner",
  phoneNumberId: "phnum_acme",
  ownerNumber: "+15555550100",
  ownerName: "Andrew",
};
const twilio = {
  accountSid: `AC${"0".repeat(32)}`,
  authToken: "twilio_test_auth_token_0123456789", // gitleaks:allow (test fixture)
};
const conference = {
  inboundNumber: "+15555550111",
  callerId: { callee: "+15555550112", owner: "+15555550113" },
  publicBaseUrl: "https://cc.example.com/api/command-center/phone/webhook",
  toolSecret: "tool_secret_test_0123456789abcdef0123", // gitleaks:allow (test fixture)
};
const full = { ...legacy, twilio, conference };
/** A base URL carrying user information, built so no credential URL appears in the source. */
const urlWithCredentials = (() => {
  const url = new URL(conference.publicBaseUrl);
  url.username = "operator";
  url.password = "secret";
  return url.toString();
})();
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe("conference-mode phone connection", () => {
  it("accepts a connection with both blocks and keeps legacy connections legacy", () => {
    const decoded = decodePhoneConnection(bytes(full));
    expect(decoded).toEqual(Option.some(full));
    expect(Option.map(decoded, isPhoneConferenceConnection)).toEqual(Option.some(true));
    expect(Option.map(decodePhoneConnection(bytes(legacy)), isPhoneConferenceConnection)).toEqual(
      Option.some(false),
    );
  });

  it("requires twilio and conference together", () => {
    expect(decodePhoneConnection(bytes({ ...legacy, conference }))).toEqual(Option.none());
    expect(decodePhoneConnection(bytes({ ...legacy, twilio }))).toEqual(Option.none());
  });

  it("rejects malformed numbers, SIDs, secrets, and base URLs", () => {
    const withConference = (patch: Partial<typeof conference>) => ({
      ...full,
      conference: { ...conference, ...patch },
    });
    for (const value of [
      withConference({ inboundNumber: "5555550111" }),
      withConference({ inboundNumber: "+0555550111" }),
      withConference({ callerId: { callee: "+15555550112", owner: "owner" } }),
      withConference({ publicBaseUrl: "http://cc.example.com/api/command-center/phone/webhook" }),
      withConference({ publicBaseUrl: "https://cc.example.com/api/command-center/phone/webhook/" }),
      withConference({
        publicBaseUrl: "https://cc.example.com:8443/api/command-center/phone/webhook",
      }),
      withConference({ publicBaseUrl: "https://cc.example.com/hook?x=1" }),
      withConference({ publicBaseUrl: "https://cc.example.com/hook#x" }),
      withConference({ publicBaseUrl: urlWithCredentials }),
      withConference({ publicBaseUrl: "cc.example.com/hook" }),
      withConference({ toolSecret: "too-short-secret-0123456789" }), // gitleaks:allow (test fixture)
      withConference({ toolSecret: "has spaces in it, 0123456789abcdef0123456789" }), // gitleaks:allow (test fixture)
      { ...full, twilio: { ...twilio, accountSid: `AC${"0".repeat(31)}` } },
      { ...full, twilio: { ...twilio, accountSid: `AC${"A".repeat(32)}` } },
      { ...full, twilio: { ...twilio, authToken: "short" } },
      { ...full, conference: { ...conference, extra: true } },
    ]) {
      expect(decodePhoneConnection(bytes(value))).toEqual(Option.none());
    }
  });
});

describe("credentials:phone status in conference mode", () => {
  const directories: Array<string> = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports conference mode without secrets, the public URL, or full numbers", () => {
    const base = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cc-phone-conference-"));
    directories.push(base);
    setPhoneConnection({ baseDir: base, plaintext: bytes(full) });
    const status = phoneConnectionStatus(base).join("\n");
    expect(status).toContain("Conference mode: on");
    expect(status).toContain("…0111");
    for (const hidden of [
      twilio.authToken,
      twilio.accountSid,
      conference.toolSecret,
      conference.publicBaseUrl,
      "cc.example.com",
      conference.inboundNumber,
      conference.callerId.callee,
      conference.callerId.owner,
    ]) {
      expect(status).not.toContain(hidden);
    }
    setPhoneConnection({ baseDir: base, plaintext: bytes(legacy) });
    expect(phoneConnectionStatus(base).join("\n")).toContain("Conference mode: off");
  });
});
