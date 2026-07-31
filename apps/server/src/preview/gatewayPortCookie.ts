/**
 * The signed cookie that names which loopback port the preview gateway forwards to.
 *
 * The gateway is mounted at the *root* of its own port rather than under a
 * `/preview/<port>/` prefix, because dev servers emit absolute URLs
 * (`/@vite/client`, `/src/main.tsx`, the HMR socket) that would resolve against
 * the gateway origin and 404 under a prefix. Root mounting means the request
 * path can no longer carry the target port, so the port travels in a cookie.
 *
 * A cookie the browser can edit would turn the gateway into a "pick your own
 * upstream" control, so the value is HMAC-signed with the same server secret
 * machinery the session cookie uses and carries its own expiry. Verification is
 * pure and lives here so it can be tested exhaustively; the port range and
 * loopback rules stay in {@link ./gatewayTarget.ts}.
 */

import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { base64UrlEncode, signPayload, timingSafeEqualBase64Url } from "../auth/utils.ts";

import { resolveGatewayPort } from "./gatewayTarget.ts";

const PREVIEW_PORT_COOKIE_NAME = "t3_preview_port";

/** Name of the server secret that signs preview port cookies. */
export const PREVIEW_PORT_SIGNING_SECRET_NAME = "preview-gateway-key";

/** Bytes of entropy in the preview port signing secret. */
export const PREVIEW_PORT_SIGNING_SECRET_BYTES = 32;

/** How long a port selection stays valid before the client must re-select. */
export const PREVIEW_PORT_COOKIE_TTL_MILLIS = 12 * 60 * 60 * 1000;

/**
 * Desktop mode runs several servers on one machine, each with its own signing
 * secret; a shared cookie name would make them fight over the same slot the way
 * the session cookie would. Mirrors `resolveSessionCookieName`.
 */
export function resolvePreviewPortCookieName(input: {
  readonly mode: "web" | "desktop";
  readonly port: number;
}): string {
  if (input.mode !== "desktop") {
    return PREVIEW_PORT_COOKIE_NAME;
  }
  return `${PREVIEW_PORT_COOKIE_NAME}_${input.port}`;
}

export type PreviewPortCookieRejection =
  | "malformed"
  | "bad-signature"
  | "expired"
  | "unusable-port";

export type PreviewPortCookieVerification =
  | { readonly ok: true; readonly port: number; readonly expiresAtMillis: number }
  | { readonly ok: false; readonly reason: PreviewPortCookieRejection };

const PreviewPortClaims = Schema.Struct({
  port: Schema.Int,
  exp: Schema.Int,
});

const encodeClaims = Schema.encodeSync(Schema.fromJsonString(PreviewPortClaims));
const decodeClaims = Schema.decodeUnknownResult(Schema.fromJsonString(PreviewPortClaims));

/**
 * Mint a signed cookie value naming `port` as the gateway's upstream.
 *
 * The port is not re-validated here: callers mint from a port they have already
 * resolved, and signing is the wrong place to discover a bad one — by the time
 * verification rejects it, the caller can no longer be told what it did wrong.
 */
export function signPreviewPortCookie(input: {
  readonly port: number;
  readonly expiresAtMillis: number;
  readonly secret: Uint8Array;
}): string {
  const encoded = base64UrlEncode(
    encodeClaims({ port: input.port, exp: Math.floor(input.expiresAtMillis) }),
  );
  return `${encoded}.${signPayload(encoded, input.secret)}`;
}

/**
 * Verify a cookie value and recover the port it names.
 *
 * `selfPorts` are the server's own listening ports, forwarded to
 * {@link resolveGatewayPort} so a cookie can never aim the gateway at itself —
 * including a cookie that was validly signed before those ports were known.
 */
export function verifyPreviewPortCookie(input: {
  readonly value: string | undefined;
  readonly secret: Uint8Array;
  readonly nowMillis: number;
  readonly selfPorts?: ReadonlyArray<number>;
}): PreviewPortCookieVerification {
  if (typeof input.value !== "string" || input.value.length === 0) {
    return { ok: false, reason: "malformed" };
  }

  const parts = input.value.split(".");
  if (parts.length !== 2) {
    return { ok: false, reason: "malformed" };
  }
  const [encoded, signature] = parts;
  if (!encoded || !signature) {
    return { ok: false, reason: "malformed" };
  }

  // Signature first: everything below this line parses attacker-supplied bytes.
  if (!timingSafeEqualBase64Url(signPayload(encoded, input.secret), signature)) {
    return { ok: false, reason: "bad-signature" };
  }

  const decoded = Result.getOrUndefined(Encoding.decodeBase64UrlString(encoded));
  if (decoded === undefined) {
    return { ok: false, reason: "malformed" };
  }
  const claims = Result.getOrUndefined(decodeClaims(decoded));
  if (claims === undefined) {
    return { ok: false, reason: "malformed" };
  }
  if (claims.exp <= input.nowMillis) {
    return { ok: false, reason: "expired" };
  }

  const resolved = resolveGatewayPort(claims.port, input.selfPorts ?? []);
  if (!resolved.ok) {
    return { ok: false, reason: "unusable-port" };
  }

  return { ok: true, port: resolved.port, expiresAtMillis: claims.exp };
}

/** Human-readable explanation for a rejected cookie, safe to return in a response body. */
export function describePreviewPortCookieRejection(reason: PreviewPortCookieRejection): string {
  switch (reason) {
    case "malformed":
      return "Preview port selection is unreadable. Select a preview port again.";
    case "bad-signature":
      return "Preview port selection was not issued by this server.";
    case "expired":
      return "Preview port selection has expired. Select a preview port again.";
    case "unusable-port":
      return "Preview port selection names a port the gateway will not forward to.";
  }
}
