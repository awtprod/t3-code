/**
 * PhoneConnection - the one ElevenLabs Agents + Twilio connection of this
 * environment, stored as a single JSON secret in `ServerSecretStore`
 * (`<secretsDir>/command-center-phone-connection.bin`, mode 0600).
 *
 * The shape is validated at the boundary every time it is read (here and in
 * the offline `credentials:phone` CLI), so a hand-edited or truncated secret
 * fails closed instead of reaching the outbound-call client or the webhook
 * verifier. Decode errors never echo the input: the JSON holds the API key and
 * the webhook secret.
 *
 * The secret is re-read on every use rather than cached. Calls are rare (a few
 * a day), the file is tiny, and a rotation through the CLI then takes effect
 * without a server restart; there is no cache to invalidate.
 *
 * @module PhoneConnection
 */
import { CommandCenterError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";

export const PHONE_CONNECTION_SECRET_NAME = "command-center-phone-connection";
/** Upper bound for the stored JSON; the real value is well under 1 KiB. */
export const PHONE_CONNECTION_MAX_BYTES = 16 * 1024;

/** E.164: a plus sign and 8 to 15 digits, no leading zero. */
const E164_PATTERN = /^\+[1-9]\d{7,14}$/u;

export const PhoneNumberE164 = Schema.String.check(
  Schema.isPattern(E164_PATTERN, {
    message: "Phone numbers must be E.164, for example +15550100000.",
  }),
);

/** ElevenLabs resource ids (agent ids, phone number ids). */
const ElevenLabsResourceId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u),
);

/** API keys and webhook secrets: visible ASCII, no whitespace. */
const SecretToken = Schema.String.check(
  Schema.isMinLength(16),
  Schema.isMaxLength(512),
  Schema.isPattern(/^[\x21-\x7e]+$/u),
);

/** C0 control characters and DEL; `allowLineBreaks` permits tab, line feed, and carriage return. */
export const hasControlCharacters = (text: string, allowLineBreaks = false): boolean => {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (allowLineBreaks && (code === 0x09 || code === 0x0a || code === 0x0d)) continue;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

const OwnerName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(80),
  Schema.makeFilter(
    (value) =>
      (value.trim() === value && !hasControlCharacters(value)) ||
      "The owner name must be trimmed single-line text.",
  ),
);

/** Twilio Account SIDs: `AC` and 32 lowercase hex digits. */
export const TwilioAccountSid = Schema.String.check(
  Schema.isPattern(/^AC[0-9a-f]{32}$/u, {
    message: "The Twilio Account SID must be AC followed by 32 hex digits.",
  }),
);

/** REST credentials of the Twilio account that owns both numbers. */
export const TwilioCredentials = Schema.Struct({
  accountSid: TwilioAccountSid,
  authToken: SecretToken,
});
export type TwilioCredentials = typeof TwilioCredentials.Type;

/**
 * Where Twilio and ElevenLabs reach this server's phone webhook mount
 * (`/api/command-center/phone/webhook` behind the public proxy). Twilio signs
 * the exact URL it requests and drops the port of an https voice URL, so the
 * value is a plain https origin plus path: no port, credentials, query,
 * fragment, or trailing slash. Signatures are checked against this value,
 * never against request headers.
 */
export const PhonePublicBaseUrl = Schema.String.check(
  Schema.isMaxLength(300),
  Schema.makeFilter((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return "The public base URL must be an absolute https URL.";
    }
    return (
      (url.protocol === "https:" &&
        url.port === "" &&
        url.username === "" &&
        url.password === "" &&
        url.search === "" &&
        url.hash === "" &&
        !value.endsWith("/") &&
        `${url.origin}${url.pathname}` === value) ||
      "The public base URL must be https, with no port, query, fragment, or trailing slash."
    );
  }),
);

/** Shared secret of the ElevenLabs initiation webhook and server tool header. */
const ToolSecret = SecretToken.check(Schema.isMinLength(32));

/** Twilio <Say> provider-qualified voice id; availability is checked by Twilio. */
const TwilioSayVoice = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.isPattern(/^(?:Polly|Google|ElevenLabs)\.[A-Za-z0-9][A-Za-z0-9_-]*$/u),
  Schema.makeFilter(
    (value) =>
      (value.trim() === value && !hasControlCharacters(value)) ||
      "The Say voice must be a single-line Provider.Voice identifier.",
  ),
);

/**
 * Conference mode for third-party calls: Command Center owns a Twilio
 * Conference and the third-party agent joins it as one participant.
 */
export const PhoneConferenceConfig = Schema.Struct({
  /** The second Twilio number, imported into ElevenLabs and assigned to `agentId`. */
  inboundNumber: PhoneNumberE164,
  /** Caller ids for the callee and owner legs: the main number or a Twilio Verified Caller ID. */
  callerId: Schema.Struct({ callee: PhoneNumberE164, owner: PhoneNumberE164 }),
  publicBaseUrl: PhonePublicBaseUrl,
  toolSecret: ToolSecret,
  /** Voice for the owner brief and return announcement; absent uses Twilio's default. */
  sayVoice: Schema.optional(TwilioSayVoice),
});
export type PhoneConferenceConfig = typeof PhoneConferenceConfig.Type;

export const PhoneConnection = Schema.Struct({
  /** ElevenLabs API key (`xi-api-key`). */
  apiKey: SecretToken,
  /** Shared secret of the ElevenLabs post-call webhook (HMAC key). */
  webhookSecret: SecretToken,
  /** Agent used for calls to third parties. */
  agentId: ElevenLabsResourceId,
  /** Agent used for calls to the owner. */
  ownerAgentId: ElevenLabsResourceId,
  /** The natively imported Twilio number, as an ElevenLabs phone number id. */
  phoneNumberId: ElevenLabsResourceId,
  ownerNumber: PhoneNumberE164,
  ownerName: OwnerName,
  /** Twilio REST credentials; present exactly when `conference` is. */
  twilio: Schema.optional(TwilioCredentials),
  /** Conference mode for third-party calls; absent means ElevenLabs outbound calls. */
  conference: Schema.optional(PhoneConferenceConfig),
}).check(
  Schema.makeFilter(
    (value) =>
      (value.twilio === undefined) === (value.conference === undefined) ||
      "`twilio` and `conference` are set together or not at all.",
  ),
);
export type PhoneConnection = typeof PhoneConnection.Type;

/** A connection in conference mode. */
export type PhoneConferenceConnection = PhoneConnection & {
  readonly twilio: TwilioCredentials;
  readonly conference: PhoneConferenceConfig;
};

export const isPhoneConferenceConnection = (
  connection: PhoneConnection,
): connection is PhoneConferenceConnection =>
  connection.twilio !== undefined && connection.conference !== undefined;

const decodeConnection = Schema.decodeUnknownOption(PhoneConnection, {
  onExcessProperty: "error",
});

/**
 * Decode stored or operator-supplied bytes. Returns `None` for anything that
 * is oversized, not UTF-8, not JSON, or not exactly the connection shape.
 */
export const decodePhoneConnection = (bytes: Uint8Array): Option.Option<PhoneConnection> => {
  if (bytes.byteLength === 0 || bytes.byteLength > PHONE_CONNECTION_MAX_BYTES) {
    return Option.none();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    // Malformed input is reported as "invalid" by the caller; the parser
    // message is dropped on purpose because it can quote the secret text.
    return Option.none();
  }
  return decodeConnection(parsed);
};

/** The last four digits of a number, for activity rows and status output. */
export const maskPhoneNumber = (number: string): string =>
  `…${number.replace(/\D/gu, "").slice(-4)}`;

export interface PhoneConnectionStoreShape {
  /** `None` when no connection is stored; fails when the stored value is invalid. */
  readonly load: Effect.Effect<Option.Option<PhoneConnection>, CommandCenterError>;
}

export class PhoneConnectionStore extends Context.Service<
  PhoneConnectionStore,
  PhoneConnectionStoreShape
>()("@awtprod/command-center/command-center/phone/PhoneConnection/PhoneConnectionStore") {}

const PHONE_CONNECTION_INVALID_MESSAGE =
  "The stored phone connection is invalid. Re-run `pnpm credentials:phone -- set`.";

export const makePhoneConnectionStore = (
  secrets: ServerSecretStore["Service"],
): PhoneConnectionStoreShape => {
  const load = secrets.get(PHONE_CONNECTION_SECRET_NAME).pipe(
    Effect.mapError(
      (cause) =>
        new CommandCenterError({
          reason: "persistence",
          message: "The phone connection could not be read.",
          cause,
        }),
    ),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<PhoneConnection>()),
        onSome: (bytes) => {
          const decoded = decodePhoneConnection(bytes);
          return Option.isSome(decoded)
            ? Effect.succeed(decoded)
            : Effect.fail(
                new CommandCenterError({
                  reason: "config",
                  message: PHONE_CONNECTION_INVALID_MESSAGE,
                }),
              );
        },
      }),
    ),
    Effect.withSpan("PhoneConnectionStore.load"),
  );
  return PhoneConnectionStore.of({ load });
};

export const layer = Layer.effect(
  PhoneConnectionStore,
  Effect.gen(function* () {
    return makePhoneConnectionStore(yield* ServerSecretStore);
  }),
);
