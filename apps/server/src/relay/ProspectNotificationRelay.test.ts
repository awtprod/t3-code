import type { Item, ItemId, SpaceId } from "@command-center/core";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";
import * as CommandCenterService from "../command-center/Service.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProspectNotificationRelay from "./ProspectNotificationRelay.ts";

const spaceId = "space-1" as SpaceId;
const fingerprint = "a".repeat(64);
const decodeUnknownJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

function evaluation(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    version: 1,
    executionId: "execution-123",
    nodeId: "evaluate-prospects",
    channelId: "channel-123",
    fingerprint,
    route: "review",
    routerChoice: "review",
    probabilities: { ignore: 0.05, defer: 0.05, investigate: 0.1, review: 0.8 },
    memoryIds: [],
    initialStatus: "review",
    observationRecorded: true,
    feedbackStatus: "review",
    policyVersion: "prospect-review-shortlist-v1",
    routerModel: "typesafe-ai/jev",
    ...overrides,
  };
}

function marker(value: Readonly<Record<string, unknown>> = evaluation()) {
  return `<!-- prospect-evaluation:${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")} -->`;
}

function prospectItem(overrides: Partial<Item> = {}): Item {
  return {
    id: "prospect-review:lead/123" as ItemId,
    spaceId,
    kind: "decision",
    status: "review",
    priority: "high",
    title: `  ${"Persisted title ".repeat(12)}  `,
    description: `  ${"Persisted body ".repeat(30)}\n\n${marker()}  `,
    artifactIds: [],
    provenance: { kind: "automation", capturedAt: "2026-09-19T00:00:00.000Z" },
    metadata: {},
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:01.000Z",
    ...overrides,
  };
}

function secretStore() {
  const values = new Map<string, Uint8Array>([
    [RELAY_URL_SECRET, new TextEncoder().encode("https://relay.example.test/base")],
    [RELAY_ISSUER_SECRET, new TextEncoder().encode("https://issuer.example.test")],
    [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, new TextEncoder().encode("environment-credential")],
  ]);
  return ServerSecretStore.ServerSecretStore.of({
    get: (name) =>
      Effect.succeed(
        values.has(name) ? Option.some(Uint8Array.from(values.get(name)!)) : Option.none(),
      ),
    set: (name, value) => Effect.sync(() => void values.set(name, Uint8Array.from(value))),
    create: (name, value) => Effect.sync(() => void values.set(name, Uint8Array.from(value))),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        const value = new Uint8Array(bytes);
        values.set(name, value);
        return value;
      }),
    remove: (name) => Effect.sync(() => void values.delete(name)),
  });
}

function layer(
  execute: HttpClient.HttpClient["execute"],
  options: {
    readonly items?: ReadonlyArray<Item>;
    readonly queryItems?: CommandCenterService.CommandCenterServiceShape["queryItems"];
  } = {},
) {
  const queryItems =
    options.queryItems ??
    ((input) =>
      Effect.succeed({
        items: (options.items ?? [prospectItem()]).filter(
          (item) =>
            (input.spaceId === undefined || item.spaceId === input.spaceId) &&
            (input.statuses === undefined || input.statuses.includes(item.status)),
        ),
      }));
  const commandCenter = CommandCenterService.CommandCenterService.of({
    queryItems,
  } as unknown as CommandCenterService.CommandCenterServiceShape);
  return Layer.effect(
    ProspectNotificationRelay.ProspectNotificationRelay,
    ProspectNotificationRelay.make,
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ServerSecretStore.ServerSecretStore, secretStore()),
        Layer.succeed(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed("environment-1" as EnvironmentId),
          getDescriptor: Effect.die("unused descriptor"),
        }),
        Layer.succeed(CommandCenterService.CommandCenterService, commandCenter),
        Layer.succeed(HttpClient.HttpClient, HttpClient.make(execute)),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
}

const notify = (input: ProspectNotificationRelay.ProspectNotificationRelayNotifyInput) =>
  Effect.gen(function* () {
    const relay = yield* ProspectNotificationRelay.ProspectNotificationRelay;
    return yield* relay.notify(input);
  });

const request = {
  spaceId,
  itemIds: [prospectItem().id] as const,
} satisfies ProspectNotificationRelay.ProspectNotificationRelayNotifyInput;

function queuedResponse(httpRequest: Parameters<HttpClient.HttpClient["execute"]>[0]) {
  const requestBody: any = decodeUnknownJson(
    httpRequest.body._tag === "Uint8Array"
      ? new TextDecoder().decode(httpRequest.body.body)
      : "null",
  );
  return HttpClientResponse.fromWeb(
    httpRequest,
    Response.json({
      status: "queued",
      idempotencyKey: `prospect:${encodeURIComponent(requestBody.notification.itemId)}:${encodeURIComponent(requestBody.notification.evaluationId)}`,
      deliveries: [],
    }),
  );
}

describe("ProspectNotificationRelay", () => {
  it.effect(
    "loads the exact Space and derives bounded signed content from persisted provenance",
    () => {
      let requestBody: any;
      let requestUrl = "";
      let authorization = "";
      let query: unknown;
      return Effect.gen(function* () {
        const results = yield* notify(request);
        expect(results).toMatchObject([
          { itemId: request.itemIds[0], evaluationId: fingerprint, status: "queued" },
        ]);
        expect(query).toEqual({ spaceId, limit: 500 });
        expect(requestUrl).toBe(
          "https://relay.example.test/v1/environments/environment-1/prospect-notifications",
        );
        expect(authorization).toBe("Bearer environment-credential");
        expect(requestBody.notification).toMatchObject({
          type: "prospect",
          itemId: request.itemIds[0],
          spaceId,
          evaluationId: fingerprint,
          environmentId: "environment-1",
          deepLink: `/prospects/${encodeURIComponent(request.itemIds[0])}`,
        });
        expect(requestBody.notification.title).toHaveLength(120);
        expect(requestBody.notification.title).toContain("Persisted title");
        expect(requestBody.notification.body).toHaveLength(240);
        expect(requestBody.notification.body).toContain("Persisted body");
        expect(requestBody.notification.body).not.toContain("prospect-evaluation");
        expect(requestBody.proof).toEqual(expect.any(String));
      }).pipe(
        Effect.provide(
          layer(
            (httpRequest) =>
              Effect.sync(() => {
                requestUrl = httpRequest.url;
                authorization = httpRequest.headers.authorization ?? "";
                requestBody = decodeUnknownJson(
                  httpRequest.body._tag === "Uint8Array"
                    ? new TextDecoder().decode(httpRequest.body.body)
                    : "null",
                );
                return queuedResponse(httpRequest);
              }),
            {
              queryItems: (input) => {
                query = input;
                return Effect.succeed({ items: [prospectItem()] });
              },
            },
          ),
        ),
      );
    },
  );

  it.effect("rejects caller-supplied title, body, evaluation identity, or path", () => {
    let requests = 0;
    const injected = {
      ...request,
      title: "caller title",
      body: "caller body",
      evaluationId: "caller-evaluation",
      deepLink: "/caller/path",
    } as unknown as ProspectNotificationRelay.ProspectNotificationRelayNotifyInput;
    return notify(injected).pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error).toMatchObject({ reason: "invalid_request", results: [] });
          expect(requests).toBe(0);
        }),
      ),
      Effect.provide(
        layer(() => {
          requests += 1;
          return Effect.die("caller-controlled notification reached HTTP");
        }),
      ),
    );
  });

  it.effect("rejects malformed or duplicate Item IDs before loading Items", () => {
    let queries = 0;
    const malformedRequests = [
      { spaceId, itemIds: ["ordinary-item" as ItemId] },
      { spaceId, itemIds: [request.itemIds[0], request.itemIds[0]] },
    ];
    return Effect.gen(function* () {
      for (const malformed of malformedRequests) {
        const error = yield* notify(malformed).pipe(Effect.flip);
        expect(error).toMatchObject({ reason: "invalid_request", results: [] });
      }
      expect(queries).toBe(0);
    }).pipe(
      Effect.provide(
        layer(() => Effect.die("malformed input reached HTTP"), {
          queryItems: () => {
            queries += 1;
            return Effect.die("malformed input reached the Item repository");
          },
        }),
      ),
    );
  });

  it.effect("rejects cross-Space, missing, and non-actionable Items observably", () => {
    const crossSpace = prospectItem({ spaceId: "space-2" as SpaceId });
    const nonActionable = prospectItem({
      id: "prospect-review:non-actionable" as ItemId,
      kind: "task",
      status: "done",
    });
    const missingId = "prospect-review:missing" as ItemId;
    let requests = 0;
    return notify({ spaceId, itemIds: [crossSpace.id, nonActionable.id, missingId] }).pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error.results).toMatchObject([
            { itemId: crossSpace.id, status: "failed", reason: "item_space_mismatch" },
            { itemId: nonActionable.id, status: "failed", reason: "item_not_actionable" },
            { itemId: missingId, status: "failed", reason: "item_not_found" },
          ]);
          expect(requests).toBe(0);
        }),
      ),
      Effect.provide(
        layer(
          () => {
            requests += 1;
            return Effect.die("non-actionable item reached HTTP");
          },
          { queryItems: () => Effect.succeed({ items: [crossSpace, nonActionable] }) },
        ),
      ),
    );
  });

  it.effect("skips a valid producer Item after human review without issuing HTTP", () => {
    const alreadyReviewed = prospectItem({
      id: "prospect-review:already-reviewed" as ItemId,
      status: "done",
    });
    let requests = 0;
    return notify({ spaceId, itemIds: [alreadyReviewed.id] }).pipe(
      Effect.tap((results) =>
        Effect.sync(() => {
          expect(results).toEqual([
            { itemId: alreadyReviewed.id, status: "skipped", reason: "already_reviewed" },
          ]);
          expect(requests).toBe(0);
        }),
      ),
      Effect.provide(
        layer(
          () => {
            requests += 1;
            return Effect.die("already-reviewed item reached HTTP");
          },
          { items: [alreadyReviewed] },
        ),
      ),
    );
  });

  it.effect("rejects malformed marker provenance before status handling", () => {
    const invalid = prospectItem({
      id: "prospect-review:invalid-marker" as ItemId,
      status: "done",
      description: `Visible body\n\n${marker(evaluation({ observationRecorded: false }))}`,
    });
    return notify({ spaceId, itemIds: [invalid.id] }).pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error.results).toMatchObject([
            { itemId: invalid.id, status: "failed", reason: "evaluation_provenance_invalid" },
          ]);
        }),
      ),
      Effect.provide(
        layer(() => Effect.die("malformed marker reached HTTP"), { items: [invalid] }),
      ),
    );
  });

  it.effect(
    "keeps item-plus-evaluation idempotency stable and exposes partial batch failure",
    () => {
      const missingId = "prospect-review:missing" as ItemId;
      return Effect.gen(function* () {
        const first = yield* notify(request);
        const second = yield* notify(request);
        const firstResult = first[0];
        const secondResult = second[0];
        if (firstResult?.status !== "queued" || secondResult?.status !== "queued") {
          throw new Error("Expected both notifications to be queued.");
        }
        expect(firstResult.idempotencyKey).toBe(secondResult.idempotencyKey);
        const partial = yield* notify({ spaceId, itemIds: [request.itemIds[0], missingId] }).pipe(
          Effect.flip,
        );
        expect(partial.results).toMatchObject([
          { itemId: request.itemIds[0], status: "queued", evaluationId: fingerprint },
          { itemId: missingId, status: "failed", reason: "item_not_found" },
        ]);
      }).pipe(Effect.provide(layer((httpRequest) => Effect.succeed(queuedResponse(httpRequest)))));
    },
  );

  it.effect("fails the Effect on relay timeout without reporting the Item queued", () =>
    Effect.gen(function* () {
      const requestStarted = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const fiber = yield* notify(request).pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(requestStarted);
        yield* TestClock.adjust(ProspectNotificationRelay.PROSPECT_NOTIFICATION_RELAY_TIMEOUT_MS);
        expect(yield* Fiber.join(fiber)).toMatchObject({
          results: [{ itemId: request.itemIds[0], status: "failed", reason: "timed_out" }],
        });
      }).pipe(
        Effect.provide(
          layer(() =>
            Deferred.succeed(requestStarted, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        ),
      );
    }),
  );

  it.effect("fails the Effect on an HTTP failure", () =>
    notify(request).pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error).toMatchObject({
            results: [{ itemId: request.itemIds[0], status: "failed", reason: "request_failed" }],
          });
        }),
      ),
      Effect.provide(
        layer((httpRequest) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(httpRequest, new Response(null, { status: 503 })),
          ),
        ),
      ),
    ),
  );
});
