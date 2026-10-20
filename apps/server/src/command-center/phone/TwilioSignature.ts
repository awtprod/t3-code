// @effect-diagnostics nodeBuiltinImport:off - HMAC verification needs node:crypto's timingSafeEqual.
/**
 * TwilioSignature - the `X-Twilio-Signature` check for Twilio's voice
 * callbacks (https://www.twilio.com/docs/usage/security, checked 2026-10-19):
 *
 *   base64(HMAC-SHA1(auth token, <full URL> + <POST params sorted by name, each name + value>))
 *
 * The URL is the one Twilio requested, query string included. Callers pass the
 * URL Command Center gave Twilio, rebuilt from the configured public base URL
 * and the validated query, never from Host or X-Forwarded headers. Repeated
 * parameter names follow Twilio's helper libraries: distinct values sorted,
 * each appended as name + value.
 *
 * The digest is always computed and compared in constant time, as base64 text,
 * also for a missing or malformed header.
 *
 * @module TwilioSignature
 */
import * as NodeCrypto from "node:crypto";

export const TWILIO_SIGNATURE_HEADER = "x-twilio-signature";

/** HMAC-SHA1 is 20 bytes: 27 base64 characters and one `=`. */
const SIGNATURE_PATTERN = /^[A-Za-z0-9+/]{27}=$/u;

const signedPayload = (url: string, params: ReadonlyArray<readonly [string, string]>): string => {
  const byName = new Map<string, Set<string>>();
  for (const [name, value] of params) {
    const values = byName.get(name) ?? new Set<string>();
    values.add(value);
    byName.set(name, values);
  }
  let payload = url;
  // Code-unit order, which is Twilio's "Unix-style case-sensitive" order for ASCII names.
  for (const name of [...byName.keys()].toSorted()) {
    for (const value of [...(byName.get(name) ?? [])].toSorted()) {
      payload += name + value;
    }
  }
  return payload;
};

/** The signature Twilio sends for `url` and the form parameters `params`. */
export const computeTwilioSignature = (input: {
  readonly authToken: string;
  readonly url: string;
  readonly params: ReadonlyArray<readonly [string, string]>;
}): string =>
  NodeCrypto.createHmac("sha1", Buffer.from(input.authToken, "utf8"))
    .update(Buffer.from(signedPayload(input.url, input.params), "utf8"))
    .digest("base64");

/** Whether `header` is Twilio's signature of exactly this URL and these parameters. */
export const verifyTwilioSignature = (input: {
  readonly authToken: string;
  readonly url: string;
  readonly params: ReadonlyArray<readonly [string, string]>;
  readonly header: string | undefined;
}): boolean => {
  // Compared as base64 text, so a non-canonical encoding of the same bytes does not pass.
  const expected = Buffer.from(computeTwilioSignature(input), "ascii");
  const wellFormed = input.header !== undefined && SIGNATURE_PATTERN.test(input.header);
  const provided = wellFormed ? Buffer.from(input.header, "ascii") : Buffer.alloc(expected.length);
  return NodeCrypto.timingSafeEqual(expected, provided) && wellFormed;
};
