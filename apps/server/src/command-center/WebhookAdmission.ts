import {
  COMMAND_CENTER_WEBHOOK_MAX_PAYLOAD_BYTES,
  CommandCenterWebhookDeliveryId,
  CommandCenterWebhookRoute,
  normalizeCommandCenterWebhookRoute,
  type CommandCenterAutomationExecution,
} from "@t3tools/contracts";
import { SpaceId } from "@command-center/core";
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as AutomationTriggerCoordinator from "./automation/TriggerCoordinator.ts";
import * as CommandCenterCredentialStore from "./CredentialStore.ts";

export const COMMAND_CENTER_WEBHOOK_SECRET_NAME = "command-center-webhooks";
export const COMMAND_CENTER_WEBHOOK_TIMESTAMP_SKEW_MS = 5 * 60 * 1_000;
export const COMMAND_CENTER_WEBHOOK_HEADERS = {
  credentialId: "x-command-center-credential-id",
  spaceId: "x-command-center-space-id",
  route: "x-command-center-webhook-route",
  deliveryId: "x-command-center-delivery-id",
  timestamp: "x-command-center-timestamp",
  signature: "x-command-center-signature",
} as const;

const CredentialId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
);
const EncodedSecret = Schema.String.check(
  Schema.isMinLength(43),
  Schema.isMaxLength(86),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/u),
);
const WebhookCredentialFile = Schema.Struct({
  version: Schema.Literal(1),
  credentials: Schema.Array(
    Schema.Struct({
      id: CredentialId,
      spaceId: SpaceId,
      route: CommandCenterWebhookRoute,
      secret: EncodedSecret,
    }),
  ).check(Schema.isMaxLength(100)),
});
type WebhookCredentialFile = typeof WebhookCredentialFile.Type;
const decodeWebhookCredentialFile = Schema.decodeUnknownSync(WebhookCredentialFile);
const decodeJson = Schema.decodeUnknownSync(Schema.Json);
const isWebhookRoute = Schema.is(CommandCenterWebhookRoute);
const isWebhookDeliveryId = Schema.is(CommandCenterWebhookDeliveryId);

export class WebhookAdmissionError extends Schema.TaggedErrorClass<WebhookAdmissionError>()(
  "WebhookAdmissionError",
  {
    reason: Schema.Literals([
      "credentials-unavailable",
      "invalid-request",
      "unauthorized",
      "stale-request",
      "payload-too-large",
      "invalid-payload",
      "admission-failed",
    ]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const admissionError = (
  reason: WebhookAdmissionError["reason"],
  message: string,
  cause?: unknown,
) =>
  new WebhookAdmissionError({
    reason,
    message,
    ...(cause === undefined ? {} : { cause }),
  });

type WebhookHeaders = Readonly<Record<string, string | undefined>>;

export interface WebhookSignatureFields {
  readonly credentialId: string;
  readonly spaceId: string;
  readonly route: string;
  readonly deliveryId: string;
  readonly timestamp: string;
}

function signaturePrefix(fields: WebhookSignatureFields): Uint8Array {
  return new TextEncoder().encode(
    [
      "command-center-webhook-v1",
      fields.timestamp,
      fields.credentialId,
      fields.spaceId,
      fields.route,
      fields.deliveryId,
      "",
    ].join("\n"),
  );
}

/** Produces the exact v1 signature used by the external HTTP adapter. */
export function createCommandCenterWebhookSignature(input: {
  readonly secret: Uint8Array;
  readonly fields: WebhookSignatureFields;
  readonly body: Uint8Array;
}): string {
  const digest = NodeCrypto.createHmac("sha256", input.secret)
    .update(signaturePrefix(input.fields))
    .update(input.body)
    .digest("hex");
  return `sha256=${digest}`;
}

function decodeSecret(source: string): Uint8Array | undefined {
  try {
    const secret = Buffer.from(source, "base64url");
    return secret.byteLength >= 32 &&
      secret.byteLength <= 64 &&
      secret.toString("base64url") === source
      ? secret
      : undefined;
  } catch {
    return undefined;
  }
}

function requestFields(headers: WebhookHeaders): WebhookSignatureFields {
  return {
    credentialId: headers[COMMAND_CENTER_WEBHOOK_HEADERS.credentialId] ?? "",
    spaceId: headers[COMMAND_CENTER_WEBHOOK_HEADERS.spaceId] ?? "",
    route: headers[COMMAND_CENTER_WEBHOOK_HEADERS.route] ?? "",
    deliveryId: headers[COMMAND_CENTER_WEBHOOK_HEADERS.deliveryId] ?? "",
    timestamp: headers[COMMAND_CENTER_WEBHOOK_HEADERS.timestamp] ?? "",
  };
}

function hasSafeCanonicalFields(fields: WebhookSignatureFields): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(fields.credentialId) &&
    fields.spaceId.length > 0 &&
    fields.spaceId.length <= 200 &&
    fields.spaceId.trim() === fields.spaceId &&
    !/[\r\n]/u.test(fields.spaceId) &&
    isWebhookRoute(fields.route) &&
    normalizeCommandCenterWebhookRoute(fields.route) === fields.route &&
    isWebhookDeliveryId(fields.deliveryId) &&
    fields.deliveryId.trim() === fields.deliveryId &&
    /^\d{1,13}$/u.test(fields.timestamp)
  );
}

function suppliedSignature(source: string | undefined): Uint8Array {
  return /^sha256=[a-f0-9]{64}$/u.test(source ?? "")
    ? Buffer.from(source!.slice("sha256=".length), "hex")
    : Buffer.alloc(32);
}

function credentialFile(source: Uint8Array): WebhookCredentialFile | undefined {
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source));
    const decoded = decodeWebhookCredentialFile(parsed);
    const ids = new Set<string>();
    for (const credential of decoded.credentials) {
      if (ids.has(credential.id) || decodeSecret(credential.secret) === undefined) return undefined;
      ids.add(credential.id);
    }
    return decoded;
  } catch {
    return undefined;
  }
}

/** Validate plaintext before an offline provisioning tool encrypts it. */
export const isValidCommandCenterWebhookCredentialFile = (source: Uint8Array): boolean =>
  credentialFile(source) !== undefined;

function decodePayload(body: Uint8Array): Schema.Json | undefined {
  try {
    return decodeJson(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)));
  } catch {
    return undefined;
  }
}

export interface WebhookAdmissionShape {
  readonly admitHttp: (input: {
    readonly headers: WebhookHeaders;
    readonly body: Uint8Array;
  }) => Effect.Effect<CommandCenterAutomationExecution, WebhookAdmissionError>;
}

export class WebhookAdmission extends Context.Service<WebhookAdmission, WebhookAdmissionShape>()(
  "@awtprod/command-center/command-center/WebhookAdmission",
) {}

export function makeWebhookAdmission(dependencies: {
  readonly secrets: CommandCenterCredentialStore.CommandCenterCredentialStoreShape;
  readonly triggers: AutomationTriggerCoordinator.AutomationTriggerCoordinatorShape;
}): WebhookAdmissionShape {
  const admitHttp = Effect.fn("WebhookAdmission.admitHttp")(function* (
    input: Parameters<WebhookAdmissionShape["admitHttp"]>[0],
  ) {
    if (input.body.byteLength > COMMAND_CENTER_WEBHOOK_MAX_PAYLOAD_BYTES) {
      return yield* admissionError(
        "payload-too-large",
        "The webhook payload exceeds the configured byte limit.",
      );
    }

    const stored = yield* dependencies.secrets
      .get(COMMAND_CENTER_WEBHOOK_SECRET_NAME)
      .pipe(
        Effect.mapError((cause) =>
          admissionError(
            "credentials-unavailable",
            "Webhook credentials could not be loaded.",
            cause,
          ),
        ),
      );
    const credentials = Option.isSome(stored) ? credentialFile(stored.value) : undefined;
    if (credentials === undefined) {
      return yield* admissionError(
        "credentials-unavailable",
        "Webhook credentials are unavailable.",
      );
    }

    const fields = requestFields(input.headers);
    const binding = credentials.credentials.find(
      (credential) => credential.id === fields.credentialId,
    );
    const secret = binding === undefined ? Buffer.alloc(32) : decodeSecret(binding.secret)!;
    const expected = createCommandCenterWebhookSignature({
      secret,
      fields,
      body: input.body,
    });
    const signatureMatches = NodeCrypto.timingSafeEqual(
      Buffer.from(expected.slice("sha256=".length), "hex"),
      suppliedSignature(input.headers[COMMAND_CENTER_WEBHOOK_HEADERS.signature]),
    );

    if (
      !signatureMatches ||
      !hasSafeCanonicalFields(fields) ||
      binding === undefined ||
      binding.spaceId !== fields.spaceId ||
      binding.route !== fields.route
    ) {
      return yield* admissionError("unauthorized", "Webhook authentication failed.");
    }

    const timestampMs = Number(fields.timestamp) * 1_000;
    const nowMs = yield* Clock.currentTimeMillis;
    if (
      !Number.isSafeInteger(timestampMs) ||
      Math.abs(nowMs - timestampMs) > COMMAND_CENTER_WEBHOOK_TIMESTAMP_SKEW_MS
    ) {
      return yield* admissionError(
        "stale-request",
        "Webhook timestamp is outside the allowed window.",
      );
    }

    const payload = decodePayload(input.body);
    if (payload === undefined) {
      return yield* admissionError("invalid-payload", "Webhook body must contain valid JSON.");
    }

    return yield* dependencies.triggers
      .admitWebhook({
        admissionSource: `credential:${fields.credentialId}`,
        spaceId: binding.spaceId,
        route: binding.route,
        deliveryId: fields.deliveryId,
        payload,
      })
      .pipe(
        Effect.mapError((cause) =>
          admissionError("admission-failed", "Webhook automation admission failed.", cause),
        ),
      );
  });

  return WebhookAdmission.of({ admitHttp });
}

export const make = Effect.gen(function* () {
  const secrets = yield* CommandCenterCredentialStore.make;
  const triggers = yield* AutomationTriggerCoordinator.make;
  return makeWebhookAdmission({ secrets, triggers });
});

export const layer = Layer.effect(WebhookAdmission, make);
