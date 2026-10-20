import { describe, expect, it } from "@effect/vitest";

import { computeTwilioSignature, verifyTwilioSignature } from "./TwilioSignature.ts";

/**
 * The worked example published in Twilio's request-validation guide
 * (https://www.twilio.com/docs/usage/security): Twilio's own illustrative
 * token, URL, and parameters, with the signature the guide states.
 */
const twilioDocsExample = {
  authToken: "12345",
  url: "https://example.com/myapp.php?foo=1&bar=2",
  params: [
    ["CallSid", "CA1234567890ABCDE"],
    ["Caller", "+14158675310"],
    ["Digits", "1234"],
    ["From", "+14158675310"],
    ["To", "+18005551212"],
  ] as Array<readonly [string, string]>,
  signature: "L/OH5YylLD5NRKLltdqwSvS0BnU=",
};

describe("Twilio request signatures", () => {
  it("reproduces the example in Twilio's documentation", () => {
    expect(computeTwilioSignature(twilioDocsExample)).toBe(twilioDocsExample.signature);
    expect(
      verifyTwilioSignature({ ...twilioDocsExample, header: twilioDocsExample.signature }),
    ).toBe(true);
  });

  it("does not depend on the order the parameters arrived in", () => {
    const shuffled = [...twilioDocsExample.params].toReversed();
    expect(
      verifyTwilioSignature({
        ...twilioDocsExample,
        params: shuffled,
        header: twilioDocsExample.signature,
      }),
    ).toBe(true);
  });

  it("rejects a tampered URL, query, parameter, extra parameter, or the wrong token", () => {
    const header = twilioDocsExample.signature;
    for (const tampered of [
      { ...twilioDocsExample, url: "https://example.com/myapp.php?foo=1&bar=3" },
      { ...twilioDocsExample, url: "https://example.com/myapp.php?bar=2&foo=1" },
      { ...twilioDocsExample, url: "https://attacker.example/myapp.php?foo=1&bar=2" },
      {
        ...twilioDocsExample,
        params: twilioDocsExample.params.map(([name, value]) =>
          name === "Digits" ? ([name, "9999"] as const) : ([name, value] as const),
        ),
      },
      { ...twilioDocsExample, params: [...twilioDocsExample.params, ["CallStatus", "completed"]] },
      { ...twilioDocsExample, authToken: "54321" },
    ] as const) {
      expect(verifyTwilioSignature({ ...tampered, header })).toBe(false);
    }
  });

  it("rejects a missing, malformed, or truncated header without throwing", () => {
    for (const header of [
      undefined,
      "",
      "not base64",
      twilioDocsExample.signature.slice(0, -2),
      `${twilioDocsExample.signature}AAAA`,
      "L/OH5YylLD5NRKLltdqwSvS0BnV=",
    ]) {
      expect(verifyTwilioSignature({ ...twilioDocsExample, header })).toBe(false);
    }
  });

  it("signs repeated parameter names like Twilio's helper libraries", () => {
    const base = { authToken: "12345", url: "https://cc.example.com/hook?call=1" };
    // Distinct values sorted, each appended as name + value.
    expect(
      computeTwilioSignature({
        ...base,
        params: [
          ["Event", "b"],
          ["Event", "a"],
          ["Event", "a"],
        ],
      }),
    ).toBe(
      computeTwilioSignature({
        ...base,
        params: [
          ["Event", "a"],
          ["Event", "b"],
        ],
      }),
    );
  });
});
