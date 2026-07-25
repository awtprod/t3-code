import { assert, describe, it } from "@effect/vitest";

import { signPayload } from "../auth/utils.ts";
import {
  describePreviewPortCookieRejection,
  resolvePreviewPortCookieName,
  signPreviewPortCookie,
  verifyPreviewPortCookie,
} from "./gatewayPortCookie.ts";

const secret = new Uint8Array(32).fill(7);
const otherSecret = new Uint8Array(32).fill(9);
const now = 1_800_000_000_000;
const later = now + 60_000;

const mint = (port: number, expiresAtMillis = later) =>
  signPreviewPortCookie({ port, expiresAtMillis, secret });

describe("resolvePreviewPortCookieName", () => {
  it("uses one name in web mode and a per-port name in desktop mode", () => {
    assert.equal(resolvePreviewPortCookieName({ mode: "web", port: 13_773 }), "t3_preview_port");
    assert.equal(
      resolvePreviewPortCookieName({ mode: "desktop", port: 13_773 }),
      "t3_preview_port_13773",
    );
    // Two desktop servers on one machine must not overwrite each other's selection.
    assert.notEqual(
      resolvePreviewPortCookieName({ mode: "desktop", port: 13_773 }),
      resolvePreviewPortCookieName({ mode: "desktop", port: 13_791 }),
    );
  });
});

describe("preview port cookie round trip", () => {
  it("recovers the port it was signed with", () => {
    const result = verifyPreviewPortCookie({ value: mint(5173), secret, nowMillis: now });
    assert.deepStrictEqual(result, { ok: true, port: 5173, expiresAtMillis: later });
  });

  it("produces a different value per port", () => {
    assert.notEqual(mint(5173), mint(5174));
  });
});

describe("verifyPreviewPortCookie", () => {
  // The whole point of signing: a browser-editable cookie would otherwise be a
  // "pick your own upstream" control on the gateway.
  it("rejects a value signed with a different secret", () => {
    const forged = signPreviewPortCookie({
      port: 5173,
      expiresAtMillis: later,
      secret: otherSecret,
    });
    assert.deepStrictEqual(verifyPreviewPortCookie({ value: forged, secret, nowMillis: now }), {
      ok: false,
      reason: "bad-signature",
    });
  });

  it("rejects a tampered payload even though the signature is well-formed", () => {
    const [, signature] = mint(5173).split(".");
    const swapped = mint(9999).split(".")[0];
    assert.deepStrictEqual(
      verifyPreviewPortCookie({ value: `${swapped}.${signature}`, secret, nowMillis: now }),
      { ok: false, reason: "bad-signature" },
    );
  });

  it("rejects structurally broken values", () => {
    for (const value of [undefined, "", "nodot", "too.many.dots", ".", "payload.", ".signature"]) {
      const result = verifyPreviewPortCookie({ value, secret, nowMillis: now });
      assert.equal(result.ok, false, `${JSON.stringify(value)} must be rejected`);
    }
  });

  // Signed but corrupt: the bytes are ours, so the failure has to be a rejection
  // rather than a thrown decode error surfacing as a 500.
  it("rejects a correctly signed payload that is not the expected shape", () => {
    for (const payload of [
      "not-json",
      '{"port":5173}',
      '{"exp":123}',
      '{"port":"5173","exp":1}',
      '{"port":5173.5,"exp":1}',
      "[]",
    ]) {
      const encoded = Buffer.from(payload, "utf8").toString("base64url");
      const signed = `${encoded}.${signPayload(encoded, secret)}`;
      assert.deepStrictEqual(
        verifyPreviewPortCookie({ value: signed, secret, nowMillis: now }),
        { ok: false, reason: "malformed" },
        `${payload} must be rejected as malformed`,
      );
    }
  });

  it("rejects an expired selection", () => {
    assert.deepStrictEqual(
      verifyPreviewPortCookie({ value: mint(5173, now - 1), secret, nowMillis: now }),
      { ok: false, reason: "expired" },
    );
    // Boundary: expiry is exclusive, so exp === now is already expired.
    assert.deepStrictEqual(
      verifyPreviewPortCookie({ value: mint(5173, now), secret, nowMillis: now }),
      { ok: false, reason: "expired" },
    );
    assert.equal(
      verifyPreviewPortCookie({ value: mint(5173, now + 1), secret, nowMillis: now }).ok,
      true,
    );
  });

  // A validly signed cookie is still not permission to reach any port: the
  // range rules stay authoritative, including for cookies minted before the
  // server knew which ports were its own.
  it("still applies the gateway port rules to a validly signed port", () => {
    assert.deepStrictEqual(verifyPreviewPortCookie({ value: mint(22), secret, nowMillis: now }), {
      ok: false,
      reason: "unusable-port",
    });
    assert.deepStrictEqual(
      verifyPreviewPortCookie({
        value: mint(13_773),
        secret,
        nowMillis: now,
        selfPorts: [13_773, 8445],
      }),
      { ok: false, reason: "unusable-port" },
    );
    assert.deepStrictEqual(
      verifyPreviewPortCookie({
        value: mint(5173),
        secret,
        nowMillis: now,
        selfPorts: [13_773, 8445],
      }),
      { ok: true, port: 5173, expiresAtMillis: later },
    );
  });

  it("explains every rejection", () => {
    for (const reason of ["malformed", "bad-signature", "expired", "unusable-port"] as const) {
      assert.ok(describePreviewPortCookieRejection(reason).length > 0);
    }
  });
});
