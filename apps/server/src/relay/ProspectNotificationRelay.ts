import { ItemId, SpaceId, type Item } from "@command-center/core";
import {
  RELAY_PROSPECT_BODY_MAX_LENGTH,
  RELAY_PROSPECT_EVALUATION_ID_MAX_LENGTH,
  RELAY_PROSPECT_ITEM_ID_MAX_LENGTH,
  RELAY_PROSPECT_SPACE_ID_MAX_LENGTH,
  RELAY_PROSPECT_TITLE_MAX_LENGTH,
  RelayProspectNotification,
  RelayProspectNotificationPublishResponse,
  relayProspectNotificationIdempotencyKey,
  type RelayDeliveryResult,
  type RelayProspectNotificationPublishProofPayload,
} from "@t3tools/contracts/relay";
import {
  normalizeRelayIssuer,
  RELAY_PROSPECT_NOTIFICATION_PUBLISH_TYP,
  signRelayJwt,
} from "@t3tools/shared/relayJwt";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";
import { getOrCreateEnvironmentKeyPairFromSecretStore } from "../cloud/environmentKeys.ts";
import * as CommandCenterService from "../command-center/Service.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";

export const PROSPECT_NOTIFICATION_RELAY_TIMEOUT_MS = 5_000;
export const PROSPECT_NOTIFICATION_RELAY_MAX_RESPONSE_BYTES = 32 * 1024;
export const PROSPECT_NOTIFICATION_MAX_ITEMS = 10;

const PROSPECT_EVALUATION_MARKER_MAX_LENGTH = 16_000;
const PROSPECT_EVALUATION_EXECUTION_ID_MAX_LENGTH = 256;
const PROSPECT_EVALUATION_NODE_ID_MAX_LENGTH = 256;
const PROSPECT_EVALUATION_MARKER_PATTERN = /\n?<!-- prospect-evaluation:([A-Za-z0-9_-]+) -->\s*$/u;

const ProspectItemId = ItemId.check(
  Schema.isMaxLength(RELAY_PROSPECT_ITEM_ID_MAX_LENGTH),
  Schema.isPattern(/^prospect-review:/u),
);
const ProspectSpaceId = SpaceId.check(Schema.isMaxLength(RELAY_PROSPECT_SPACE_ID_MAX_LENGTH));
const ProspectNotificationNotifyInput = Schema.Struct({
  spaceId: ProspectSpaceId,
  itemIds: Schema.Array(ProspectItemId).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(PROSPECT_NOTIFICATION_MAX_ITEMS),
    Schema.makeFilter(
      (itemIds) =>
        new Set(itemIds).size === itemIds.length ||
        "Prospect notification item IDs must be unique.",
    ),
  ),
});
const decodeNotifyInput = Schema.decodeUnknownEffect(ProspectNotificationNotifyInput, {
  onExcessProperty: "error",
});

const Probability = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const ProspectEvaluation = Schema.Struct({
  version: Schema.Literal(1),
  executionId: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(PROSPECT_EVALUATION_EXECUTION_ID_MAX_LENGTH),
  ),
  nodeId: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(PROSPECT_EVALUATION_NODE_ID_MAX_LENGTH),
  ),
  channelId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  fingerprint: Schema.String.check(
    Schema.isMaxLength(RELAY_PROSPECT_EVALUATION_ID_MAX_LENGTH),
    Schema.isPattern(/^[a-f0-9]{64}$/u),
  ),
  route: Schema.Literals(["review", "investigate"]),
  routerChoice: Schema.Literals(["ignore", "defer", "investigate", "review"]),
  probabilities: Schema.Struct({
    ignore: Probability,
    defer: Probability,
    investigate: Probability,
    review: Probability,
  }),
  memoryIds: Schema.Array(Schema.String.check(Schema.isNonEmpty())).check(Schema.isMaxLength(100)),
  initialStatus: Schema.Literal("review"),
  observationRecorded: Schema.Literal(true),
  feedbackStatus: Schema.Literal("review"),
  policyVersion: Schema.Literal("prospect-review-shortlist-v1"),
  routerModel: Schema.Literal("typesafe-ai/jev"),
});
type ProspectEvaluation = typeof ProspectEvaluation.Type;
const decodeProspectEvaluation = Schema.decodeUnknownExit(ProspectEvaluation, {
  onExcessProperty: "error",
});

export interface ProspectNotificationRelayNotifyInput {
  readonly spaceId: SpaceId;
  readonly itemIds: ReadonlyArray<ItemId>;
}

export type ProspectNotificationRelayFailureReason =
  | "invalid_request"
  | "item_load_failed"
  | "item_not_found"
  | "item_space_mismatch"
  | "item_not_actionable"
  | "evaluation_provenance_invalid"
  | "not_configured"
  | "signing_failed"
  | "request_failed"
  | "timed_out"
  | "redirect_rejected"
  | "response_too_large"
  | "response_invalid";

export type ProspectNotificationRelayItemResult =
  | {
      readonly itemId: ItemId;
      readonly evaluationId: string;
      readonly status: "queued";
      readonly idempotencyKey: string;
      readonly deliveries: ReadonlyArray<RelayDeliveryResult>;
    }
  | {
      readonly itemId: ItemId;
      readonly status: "failed";
      readonly reason: ProspectNotificationRelayFailureReason;
      readonly evaluationId?: string;
      readonly idempotencyKey?: string;
      readonly deliveries: ReadonlyArray<RelayDeliveryResult>;
    }
  | {
      readonly itemId: ItemId;
      readonly status: "skipped";
      readonly reason: "already_reviewed";
    };

/** A failed batch retains all per-item outcomes so the notify checkpoint can retry observably. */
export class ProspectNotificationRelayBatchError extends Error {
  readonly _tag = "ProspectNotificationRelayBatchError";
  readonly reason: ProspectNotificationRelayFailureReason;
  readonly results: ReadonlyArray<ProspectNotificationRelayItemResult>;

  constructor(
    reason: ProspectNotificationRelayFailureReason,
    results: ReadonlyArray<ProspectNotificationRelayItemResult>,
  ) {
    super(
      results.length === 0
        ? `Prospect notification batch failed: ${reason}.`
        : `Prospect notification batch failed for ${results
            .filter((result) => result.status === "failed")
            .map((result) => result.itemId)
            .join(", ")}.`,
    );
    this.name = "ProspectNotificationRelayBatchError";
    this.reason = reason;
    this.results = results;
  }
}

export class ProspectNotificationRelay extends Context.Service<
  ProspectNotificationRelay,
  {
    readonly notify: (
      input: ProspectNotificationRelayNotifyInput,
    ) => Effect.Effect<
      ReadonlyArray<ProspectNotificationRelayItemResult>,
      ProspectNotificationRelayBatchError
    >;
  }
>()("@awtprod/command-center/relay/ProspectNotificationRelay") {}

const decodeNotification = Schema.decodeUnknownEffect(RelayProspectNotification);
const decodeResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RelayProspectNotificationPublishResponse),
);

function boundedNotificationText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  return trimmed.length <= maxLength
    ? trimmed
    : `${trimmed.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function itemFailure(
  itemId: ItemId,
  reason: ProspectNotificationRelayFailureReason,
  evaluationId?: string,
): ProspectNotificationRelayItemResult {
  return {
    itemId,
    status: "failed",
    reason,
    ...(evaluationId === undefined
      ? {}
      : {
          evaluationId,
          idempotencyKey: relayProspectNotificationIdempotencyKey({ itemId, evaluationId }),
        }),
    deliveries: [],
  };
}

function parseMarker(description: string | undefined): ProspectEvaluation | undefined {
  const encoded = description?.match(PROSPECT_EVALUATION_MARKER_PATTERN)?.[1];
  if (encoded === undefined || encoded.length > PROSPECT_EVALUATION_MARKER_MAX_LENGTH) {
    return undefined;
  }
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) return undefined;
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const decoded = decodeProspectEvaluation(parsed);
    return Exit.isSuccess(decoded) ? decoded.value : undefined;
  } catch {
    return undefined;
  }
}

function visibleDescription(item: Item): string | undefined {
  const body = boundedNotificationText(
    (item.description ?? "").replace(PROSPECT_EVALUATION_MARKER_PATTERN, ""),
    RELAY_PROSPECT_BODY_MAX_LENGTH,
  );
  return body.length === 0 ? undefined : body;
}

export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const commandCenter = yield* CommandCenterService.CommandCenterService;
  const httpClient = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const environmentKeyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(secrets);

  const readSecretString = (name: string) =>
    secrets
      .get(name)
      .pipe(
        Effect.map((value) =>
          Option.isSome(value) ? new TextDecoder().decode(value.value).trim() : null,
        ),
      );

  const publishItem = Effect.fn("prospect_notification_relay.publishItem")(function* (
    item: Item,
    evaluation: ProspectEvaluation,
    body: string,
  ) {
    const evaluationId = evaluation.fingerprint;
    const idempotencyKey = relayProspectNotificationIdempotencyKey({
      itemId: item.id,
      evaluationId,
    });
    const environmentIdResult = yield* serverEnvironment.getEnvironmentId.pipe(Effect.result);
    if (environmentIdResult._tag === "Failure") {
      return itemFailure(item.id, "request_failed", evaluationId);
    }
    const environmentId = environmentIdResult.success;
    const notification = yield* decodeNotification({
      type: "prospect",
      itemId: item.id,
      spaceId: item.spaceId,
      evaluationId,
      environmentId,
      title: boundedNotificationText(item.title, RELAY_PROSPECT_TITLE_MAX_LENGTH),
      body,
      deepLink: `/prospects/${encodeURIComponent(item.id)}`,
    }).pipe(
      Effect.mapError(() => "invalid_request" as const),
      Effect.result,
    );
    if (notification._tag === "Failure") {
      return itemFailure(item.id, notification.failure, evaluationId);
    }
    const secretsResult = yield* Effect.all([
      readSecretString(RELAY_URL_SECRET),
      readSecretString(RELAY_ISSUER_SECRET),
      readSecretString(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
    ]).pipe(Effect.result);
    if (secretsResult._tag === "Failure") {
      return itemFailure(item.id, "request_failed", evaluationId);
    }
    const [relayUrl, relayIssuer, environmentCredential] = secretsResult.success;
    if (!relayUrl || !environmentCredential) {
      return itemFailure(item.id, "not_configured", evaluationId);
    }
    const jtiResult = yield* crypto.randomUUIDv4.pipe(Effect.result);
    if (jtiResult._tag === "Failure") {
      return itemFailure(item.id, "signing_failed", evaluationId);
    }
    const now = yield* DateTime.now;
    const proofPayload = {
      iss: `t3-env:${environmentId}`,
      aud: normalizeRelayIssuer(relayIssuer || relayUrl),
      sub: environmentId,
      jti: jtiResult.success,
      iat: Math.floor(now.epochMilliseconds / 1_000),
      exp: Math.floor(DateTime.add(now, { minutes: 5 }).epochMilliseconds / 1_000),
      environmentId,
      itemId: notification.success.itemId,
      notification: notification.success,
    } satisfies RelayProspectNotificationPublishProofPayload;
    const proof = yield* signRelayJwt({
      privateKey: environmentKeyPair.privateKey,
      typ: RELAY_PROSPECT_NOTIFICATION_PUBLISH_TYP,
      payload: proofPayload,
    }).pipe(Effect.result);
    if (proof._tag === "Failure") {
      return itemFailure(item.id, "signing_failed", evaluationId);
    }

    const endpoint = new URL(
      `/v1/environments/${encodeURIComponent(environmentId)}/prospect-notifications`,
      relayUrl,
    ).toString();
    const response = yield* HttpClientRequest.post(endpoint).pipe(
      HttpClientRequest.bearerToken(environmentCredential),
      HttpClientRequest.bodyJson({ notification: notification.success, proof: proof.success }),
      Effect.flatMap(httpClient.execute),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.timeoutOption(Duration.millis(PROSPECT_NOTIFICATION_RELAY_TIMEOUT_MS)),
      Effect.result,
    );
    if (response._tag === "Failure") {
      return itemFailure(item.id, "request_failed", evaluationId);
    }
    if (Option.isNone(response.success)) {
      return itemFailure(item.id, "timed_out", evaluationId);
    }
    const httpResponse = response.success.value;
    if (httpResponse.status >= 300 && httpResponse.status < 400) {
      return itemFailure(item.id, "redirect_rejected", evaluationId);
    }
    if (httpResponse.status < 200 || httpResponse.status >= 300) {
      return itemFailure(item.id, "request_failed", evaluationId);
    }
    const responseBody = yield* collectUint8StreamText({
      stream: httpResponse.stream,
      maxBytes: PROSPECT_NOTIFICATION_RELAY_MAX_RESPONSE_BYTES,
    }).pipe(Effect.result);
    if (responseBody._tag === "Failure") {
      return itemFailure(item.id, "request_failed", evaluationId);
    }
    if (responseBody.success.truncated) {
      return itemFailure(item.id, "response_too_large", evaluationId);
    }
    if (responseBody.success.invalidUtf8) {
      return itemFailure(item.id, "response_invalid", evaluationId);
    }
    const parsed = yield* decodeResponse(responseBody.success.text).pipe(Effect.result);
    if (parsed._tag === "Failure" || parsed.success.idempotencyKey !== idempotencyKey) {
      return itemFailure(item.id, "response_invalid", evaluationId);
    }
    return parsed.success.status === "queued"
      ? ({
          itemId: item.id,
          evaluationId,
          status: "queued" as const,
          idempotencyKey,
          deliveries: parsed.success.deliveries,
        } satisfies ProspectNotificationRelayItemResult)
      : ({
          itemId: item.id,
          evaluationId,
          status: "failed" as const,
          idempotencyKey,
          reason: "request_failed" as const,
          deliveries: parsed.success.deliveries,
        } satisfies ProspectNotificationRelayItemResult);
  });

  return ProspectNotificationRelay.of({
    notify: Effect.fn("prospect_notification_relay.notify")(function* (input) {
      const decoded = yield* decodeNotifyInput(input).pipe(Effect.result);
      if (decoded._tag === "Failure") {
        return yield* Effect.fail(new ProspectNotificationRelayBatchError("invalid_request", []));
      }

      const loaded = yield* commandCenter
        .queryItems({ spaceId: decoded.success.spaceId, limit: 500 })
        .pipe(Effect.result);
      if (loaded._tag === "Failure") {
        return yield* Effect.fail(
          new ProspectNotificationRelayBatchError(
            "item_load_failed",
            decoded.success.itemIds.map((itemId) => itemFailure(itemId, "item_load_failed")),
          ),
        );
      }

      const itemsById = new Map(loaded.success.items.map((item) => [item.id, item] as const));
      const results: ProspectNotificationRelayItemResult[] = [];
      for (const itemId of decoded.success.itemIds) {
        const item = itemsById.get(itemId);
        if (item === undefined) {
          results.push(itemFailure(itemId, "item_not_found"));
          continue;
        }
        if (item.spaceId !== decoded.success.spaceId) {
          results.push(itemFailure(itemId, "item_space_mismatch"));
          continue;
        }
        const evaluation = parseMarker(item.description);
        if (evaluation === undefined) {
          results.push(itemFailure(itemId, "evaluation_provenance_invalid"));
          continue;
        }
        if (item.kind !== "decision") {
          results.push(itemFailure(itemId, "item_not_actionable"));
          continue;
        }
        if (item.status !== "review") {
          results.push({ itemId, status: "skipped", reason: "already_reviewed" });
          continue;
        }
        const body = visibleDescription(item);
        if (body === undefined) {
          results.push(itemFailure(itemId, "evaluation_provenance_invalid"));
          continue;
        }
        results.push(yield* publishItem(item, evaluation, body));
      }

      const failedResult = results.find((result) => result.status === "failed");
      if (failedResult !== undefined) {
        return yield* Effect.fail(
          new ProspectNotificationRelayBatchError(failedResult.reason, results),
        );
      }
      return results;
    }),
  });
});

export const layer = Layer.effect(ProspectNotificationRelay, make).pipe(
  Layer.provide(FetchHttpClient.layer),
);
