import { AutomationId, SpaceId } from "@command-center/core";
import { COMMAND_CENTER_WEBHOOK_MAX_PAYLOAD_BYTES } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { type AutomationTriggerCoordinatorShape } from "./automation/TriggerCoordinator.ts";
import { CommandCenterCredentialStore } from "./CredentialStore.ts";
import {
  COMMAND_CENTER_WEBHOOK_HEADERS,
  COMMAND_CENTER_WEBHOOK_SECRET_NAME,
  WebhookAdmission,
  createCommandCenterWebhookSignature,
  makeWebhookAdmission,
  type WebhookSignatureFields,
} from "./WebhookAdmission.ts";

const secret = Buffer.alloc(32, 7);
const nowMs = 1_784_505_600_000;
const nowTimestamp = String(nowMs / 1_000);
const body = new TextEncoder().encode(JSON.stringify({ sample: true }));

const credentialBytes = new TextEncoder().encode(
  JSON.stringify({
    version: 1,
    credentials: [
      {
        id: "sample-hook",
        spaceId: "space-a",
        route: "/hooks/sample",
        secret: secret.toString("base64url"),
      },
    ],
  }),
);

function signedHeaders(
  overrides: Partial<WebhookSignatureFields> = {},
  signedBody: Uint8Array = body,
) {
  const fields: WebhookSignatureFields = {
    credentialId: "sample-hook",
    spaceId: "space-a",
    route: "/hooks/sample",
    deliveryId: "delivery-1",
    timestamp: nowTimestamp,
    ...overrides,
  };
  return {
    [COMMAND_CENTER_WEBHOOK_HEADERS.credentialId]: fields.credentialId,
    [COMMAND_CENTER_WEBHOOK_HEADERS.spaceId]: fields.spaceId,
    [COMMAND_CENTER_WEBHOOK_HEADERS.route]: fields.route,
    [COMMAND_CENTER_WEBHOOK_HEADERS.deliveryId]: fields.deliveryId,
    [COMMAND_CENTER_WEBHOOK_HEADERS.timestamp]: fields.timestamp,
    [COMMAND_CENTER_WEBHOOK_HEADERS.signature]: createCommandCenterWebhookSignature({
      secret,
      fields,
      body: signedBody,
    }),
  };
}

function testLayer(admissions: Array<Record<string, unknown>>) {
  const secrets = CommandCenterCredentialStore.of({
    get: (name) =>
      name === COMMAND_CENTER_WEBHOOK_SECRET_NAME
        ? Effect.succeed(Option.some(credentialBytes))
        : Effect.succeed(Option.none()),
    set: () => Effect.die("unused"),
    create: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
  });
  const coordinator = {
    admitSchedule: () => Effect.die("unused"),
    admitWebhook: (input) => {
      admissions.push(input);
      return Effect.succeed({
        id: "execution-1",
        automationId: AutomationId.make("sample-automation"),
        idempotencyKey: `webhook:sample-automation:${input.deliveryId}`,
        spaceId: input.spaceId,
        configCommitSha: "1".repeat(40),
        definitionDigest: `sha256:${"a".repeat(64)}`,
        state: "queued",
        input: {},
        lease: null,
        checkpoints: [],
        output: null,
        error: null,
        createdAt: "2026-07-20T00:00:00.000Z",
        updatedAt: "2026-07-20T00:00:00.000Z",
        finishedAt: null,
      });
    },
  } satisfies AutomationTriggerCoordinatorShape;
  return Layer.succeed(WebhookAdmission, makeWebhookAdmission({ secrets, triggers: coordinator }));
}

it.effect(
  "authenticates before decoding and admits the exact credential-bound Space and route",
  () => {
    const admissions: Array<Record<string, unknown>> = [];
    return Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      const admission = yield* WebhookAdmission;
      const execution = yield* admission.admitHttp({ headers: signedHeaders(), body });

      expect(execution.id).toBe("execution-1");
      expect(admissions).toEqual([
        {
          admissionSource: "credential:sample-hook",
          spaceId: SpaceId.make("space-a"),
          route: "/hooks/sample",
          deliveryId: "delivery-1",
          payload: { sample: true },
        },
      ]);
    }).pipe(Effect.provide(testLayer(admissions)));
  },
);

it.effect("rejects a tampered invalid-JSON body as unauthorized before parsing it", () => {
  const admissions: Array<Record<string, unknown>> = [];
  const tampered = new TextEncoder().encode("not-json");
  return Effect.gen(function* () {
    yield* TestClock.setTime(nowMs);
    const admission = yield* WebhookAdmission;
    const error = yield* admission
      .admitHttp({ headers: signedHeaders({}, body), body: tampered })
      .pipe(Effect.flip);
    expect(error.reason).toBe("unauthorized");
    expect(admissions).toEqual([]);
  }).pipe(Effect.provide(testLayer(admissions)));
});

it.effect("rejects stale signatures and exact binding mismatches", () => {
  const admissions: Array<Record<string, unknown>> = [];
  return Effect.gen(function* () {
    yield* TestClock.setTime(nowMs);
    const admission = yield* WebhookAdmission;
    const stale = yield* admission
      .admitHttp({ headers: signedHeaders({ timestamp: "1" }), body })
      .pipe(Effect.flip);
    expect(stale.reason).toBe("stale-request");

    const foreignSpace = yield* admission
      .admitHttp({ headers: signedHeaders({ spaceId: "space-b" }), body })
      .pipe(Effect.flip);
    expect(foreignSpace.reason).toBe("unauthorized");
    expect(admissions).toEqual([]);
  }).pipe(Effect.provide(testLayer(admissions)));
});

it.effect(
  "enforces the payload byte bound before credential lookup or automation admission",
  () => {
    const admissions: Array<Record<string, unknown>> = [];
    return Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      const admission = yield* WebhookAdmission;
      const oversized = new Uint8Array(COMMAND_CENTER_WEBHOOK_MAX_PAYLOAD_BYTES + 1);
      const error = yield* admission
        .admitHttp({ headers: signedHeaders({}, oversized), body: oversized })
        .pipe(Effect.flip);
      expect(error.reason).toBe("payload-too-large");
      expect(admissions).toEqual([]);
    }).pipe(Effect.provide(testLayer(admissions)));
  },
);
