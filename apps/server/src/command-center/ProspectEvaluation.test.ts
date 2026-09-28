import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { CommandCenterCredentialStore } from "./CredentialStore.ts";
import {
  makeProspectEvaluationConnector,
  type ProspectEvaluationItem,
  type ProspectEvaluationItemStore,
} from "./ProspectEvaluation.ts";

const profile = {
  schemaVersion: 1,
  spaceId: "space-a",
  prospectorDbPath: "",
  gatewayApiKey: "gateway-secret",
  supabaseUrl: "https://awbefohirbesfpouwirt.supabase.co",
  supabaseServiceRoleKey: "supabase-secret",
  embedding: {
    provider: "google-gemini",
    model: "gemini-embedding-2",
    dimensions: 768,
    apiKey: "gemini-secret",
  },
} as const;

const createFixture = Effect.fn("ProspectEvaluationTest.createFixture")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "cc-prospect-evaluation-",
  });
  const path = paths.join(directory, "prospector.sqlite");
  const database = new NodeSqlite.DatabaseSync(path);
  try {
    database.exec(`
    CREATE TABLE channels (
      id INTEGER PRIMARY KEY,
      channel_id TEXT NOT NULL,
      channel_handle TEXT,
      channel_name TEXT NOT NULL,
      channel_url TEXT NOT NULL,
      subscriber_count INTEGER,
      video_count INTEGER,
      niche TEXT NOT NULL,
      niche_detail TEXT,
      is_solo_creator INTEGER,
      solo_confidence TEXT,
      solo_evidence TEXT,
      upload_frequency TEXT,
      videos_last_30d INTEGER,
      videos_last_90d INTEGER,
      monetization_notes TEXT,
      monetization_score INTEGER,
      thumbnail_tier INTEGER,
      thumbnail_notes TEXT,
      thumbnail_prompt_version TEXT,
      vision_model_id TEXT,
      pipeline_status TEXT,
      growth_trend TEXT,
      growth_rate_30d REAL,
      operator_type TEXT,
      subscriber_growth_90d_pct REAL,
      recent_view_trend REAL,
      outlier_score REAL,
      prospect_score INTEGER,
      watchlist_tier TEXT,
      watchlist_reason TEXT,
      median_views_per_video REAL,
      updated_at TEXT,
      last_contacted_at TEXT,
      skip_reason TEXT,
      extracted_email TEXT
    );
    CREATE TABLE sends (id INTEGER PRIMARY KEY, channel_id INTEGER, status TEXT);
    CREATE TABLE suppressions (email TEXT PRIMARY KEY, reason TEXT NOT NULL);
    INSERT INTO channels (
      id, channel_id, channel_handle, channel_name, channel_url, subscriber_count,
      video_count, niche, niche_detail, is_solo_creator, solo_confidence,
      solo_evidence, upload_frequency, videos_last_30d, videos_last_90d,
      monetization_notes, monetization_score, thumbnail_tier, thumbnail_notes,
      thumbnail_prompt_version, vision_model_id, pipeline_status, growth_trend,
      growth_rate_30d, operator_type, subscriber_growth_90d_pct, recent_view_trend,
      outlier_score, prospect_score, watchlist_tier, watchlist_reason,
      median_views_per_video, updated_at, extracted_email
    ) VALUES (
      1, 'UC-fixture', '@fixture', 'Fixture Creator', 'https://youtube.test/fixture', 25000,
      80, 'comedy', '', 1, 'high', 'Host appears alone in current uploads', 'weekly', 5, 14,
      'Membership visible', 2, 2, 'Inconsistent text density', 'thumb-v4', 'vision-model-a',
      'ready', 'rising', 120, 'solo', 12.5, 1.2, 1.5, 87, 'active', '', 4200,
      '2026-09-18T00:00:00Z', 'creator@example.test'
    );
    INSERT INTO channels (
      id, channel_id, channel_name, channel_url, niche, pipeline_status,
      prospect_score, updated_at
    ) VALUES
      (2, 'UC-second', 'Second Creator', 'https://youtube.test/second', 'comedy', 'ready', 86,
        '2026-09-17T00:00:00Z'),
      (3, 'UC-third', 'Third Creator', 'https://youtube.test/third', 'comedy', 'ready', 85,
        '2026-09-16T00:00:00Z');
    `);
  } finally {
    database.close();
  }
  return { path };
});

function makeCredentials(dbPath: string, override: unknown = undefined) {
  const value = new TextEncoder().encode(
    JSON.stringify(override ?? { ...profile, prospectorDbPath: dbPath }),
  );
  return CommandCenterCredentialStore.of({
    get: () => Effect.succeed(Option.some(value)),
    set: () => Effect.void,
    create: () => Effect.void,
    remove: () => Effect.void,
  });
}

function makeItems() {
  const values = new Map<string, ProspectEvaluationItem>();
  let revision = 0;
  const timestamp = () => `2026-09-19T00:00:${String(++revision).padStart(2, "0")}.000Z`;
  const store: ProspectEvaluationItemStore = {
    queryItems: ({ spaceId }) =>
      Effect.succeed({ items: [...values.values()].filter((item) => item.spaceId === spaceId) }),
    createItem: (input) => {
      const existing = values.get(input.requestId);
      if (existing !== undefined) return Effect.succeed(existing);
      const item: ProspectEvaluationItem = {
        id: input.requestId,
        spaceId: input.spaceId,
        kind: input.kind,
        status: "captured",
        priority: input.priority,
        title: input.title,
        description: input.description,
        updatedAt: timestamp(),
      };
      values.set(item.id, item);
      return Effect.succeed(item);
    },
    updateItem: (input) => {
      const current = values.get(input.itemId);
      if (current === undefined) return Effect.fail("missing Item");
      if (current.updatedAt !== input.expectedUpdatedAt) return Effect.fail("stale Item");
      const item = { ...current, ...input.patch, updatedAt: timestamp() };
      values.set(item.id, item);
      return Effect.succeed({ item, duplicate: false });
    },
  };
  return {
    store,
    values,
    humanStatus(status: ProspectEvaluationItem["status"]) {
      const item = [...values.values()][0];
      if (item === undefined) throw new Error("missing fixture Item");
      values.set(item.id, { ...item, status, updatedAt: timestamp() });
    },
  };
}

interface FetchRequest {
  readonly url: string;
  readonly body: unknown;
  readonly method: string | undefined;
  readonly headers: Readonly<Record<string, string>>;
}

interface FetchOptions {
  readonly choice?: "ignore" | "defer" | "investigate" | "review";
  readonly probabilities?: {
    readonly ignore: number;
    readonly defer: number;
    readonly investigate: number;
    readonly review: number;
  };
  readonly nextRoute?: () => {
    readonly choice: "ignore" | "defer" | "investigate" | "review";
    readonly probabilities: {
      readonly ignore: number;
      readonly defer: number;
      readonly investigate: number;
      readonly review: number;
    };
  };
  readonly memories?: ReadonlyArray<unknown>;
  readonly malformedJev?: boolean;
  readonly failEvaluate?: () => boolean;
  readonly failPatch?: () => boolean;
  readonly requests?: Array<FetchRequest>;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeFetch(options: FetchOptions = {}): typeof globalThis.fetch {
  const thoughts = new Map<string, string>();
  return (async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as unknown;
    options.requests?.push({
      url,
      body,
      method: init?.method,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    if (url.includes(":embedContent")) {
      return jsonResponse({ embedding: { values: Array.from({ length: 768 }, () => 0.25) } });
    }
    if (url.endsWith("/match_thoughts")) return jsonResponse(options.memories ?? []);
    if (url.endsWith("/v1/evaluate")) {
      if (options.failEvaluate?.()) return jsonResponse({ error: "unavailable" }, 503);
      if (options.malformedJev) return jsonResponse({ answers: { route: true } });
      const route = options.nextRoute?.();
      return jsonResponse({
        model: "typesafe-ai/jev",
        answers: {
          route: {
            type: "choice",
            choice: route?.choice ?? options.choice ?? "review",
            probabilities: route?.probabilities ??
              options.probabilities ?? {
                ignore: 0.05,
                defer: 0.05,
                investigate: 0.1,
                review: 0.8,
              },
          },
        },
        usage: { inputTokens: 120, outputTokens: 8 },
      });
    }
    if (url.endsWith("/upsert_thought")) {
      const key = JSON.stringify(body);
      let id = thoughts.get(key);
      if (id === undefined) {
        id = `00000000-0000-4000-8000-${String(thoughts.size + 1).padStart(12, "0")}`;
        thoughts.set(key, id);
      }
      return jsonResponse({ id, fingerprint: `fingerprint-${id}` });
    }
    if (url.includes("/rest/v1/thoughts?id=eq.")) {
      if (options.failPatch?.()) return jsonResponse({ error: "unavailable" }, 503);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected mock URL ${url}`);
  }) as typeof globalThis.fetch;
}

const request = {
  profile: "prospect-primary",
  limit: 1,
  spaceId: "space-a",
  executionId: "execution-1",
  nodeId: "evaluate",
} as const;

function withFixture<A, E>(use: (fixture: { readonly path: string }) => Effect.Effect<A, E>) {
  return Effect.scoped(createFixture().pipe(Effect.flatMap(use))).pipe(
    Effect.provide(NodeServices.layer),
  );
}

const decodeEvaluationMarkerState = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      executionId: Schema.String,
      nodeId: Schema.String,
      observationRecorded: Schema.Boolean,
      feedbackStatus: Schema.String,
    }),
  ),
);
const decodeUnknownJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

function evaluationMarkerState(item: ProspectEvaluationItem | undefined) {
  const encoded = item?.description?.match(/prospect-evaluation:([A-Za-z0-9_-]+)/u)?.[1];
  if (encoded === undefined) throw new Error("missing evaluation marker");
  return decodeEvaluationMarkerState(Buffer.from(encoded, "base64url").toString("utf8"));
}

it.effect(
  "uses the actual connector with read-only SQLite, 768-d embeddings, empty memory, uncertainty promotion, and same-execution replay handoff",
  () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const items = makeItems();
        const requests: FetchRequest[] = [];
        const connector = makeProspectEvaluationConnector({
          credentials: makeCredentials(fixture.path),
          items: items.store,
          fetch: makeFetch({
            choice: "ignore",
            probabilities: { ignore: 0.55, defer: 0.25, investigate: 0.1, review: 0.1 },
            requests,
          }),
        });

        const first = yield* connector.evaluate(request);
        const replay = yield* connector.evaluate(request);
        const item = [...items.values.values()][0];
        const embeddingBodies = requests
          .filter((entry) => entry.url.includes(":embedContent"))
          .map((entry) => entry.body as { readonly output_dimensionality?: number });
        const upsert = requests.find((entry) => entry.url.endsWith("/upsert_thought"));
        const vectorPatch = requests.find((entry) =>
          entry.url.includes("/rest/v1/thoughts?id=eq."),
        );

        expect(first).toMatchObject({ evaluatedCount: 1, actionableCount: 1 });
        expect(first.actionableItemIds).toEqual(first.itemIds);
        expect(replay).toMatchObject({
          evaluatedCount: 1,
          actionableCount: 1,
          itemIds: [first.itemIds[0]],
          actionableItemIds: [first.itemIds[0]],
          skippedExistingCount: 0,
        });
        expect(items.values).toHaveLength(1);
        expect(item).toMatchObject({ kind: "decision", status: "review" });
        expect(item?.description).toContain("uncertain `ignore` was promoted to `review`");
        expect(item?.description).toContain("explicitly empty memory set");
        expect(embeddingBodies.every((body) => body.output_dimensionality === 768)).toBe(true);
        expect(upsert?.body).toMatchObject({ payload: { metadata: expect.any(Object) } });
        expect(upsert?.body).not.toHaveProperty("payload.embedding");
        expect(vectorPatch).toMatchObject({
          url: "https://awbefohirbesfpouwirt.supabase.co/rest/v1/thoughts?id=eq.00000000-0000-4000-8000-000000000001",
          method: "PATCH",
          headers: {
            apikey: "supabase-secret",
            authorization: "Bearer supabase-secret",
            "content-profile": "public",
            "accept-profile": "public",
            prefer: "return=minimal",
          },
          body: { embedding: Array.from({ length: 768 }, () => 0.25) },
        });

        const verification = new NodeSqlite.DatabaseSync(fixture.path, { readOnly: true });
        try {
          expect(
            verification.prepare("SELECT thumbnail_tier AS tier FROM channels WHERE id = 1").get(),
          ).toEqual({ tier: 2 });
          expect(
            verification
              .prepare("SELECT name FROM sqlite_master WHERE name LIKE 'prospect_evaluation%'")
              .all(),
          ).toEqual([]);
        } finally {
          verification.close();
        }
      }),
    ),
);

it.effect("separates actionable IDs from mixed and all-ignore durable outcomes", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const mixedItems = makeItems();
      const routes = [
        {
          choice: "review" as const,
          probabilities: { ignore: 0.05, defer: 0.05, investigate: 0.1, review: 0.8 },
        },
        {
          choice: "ignore" as const,
          probabilities: { ignore: 0.85, defer: 0.05, investigate: 0.05, review: 0.05 },
        },
      ];
      const mixed = yield* makeProspectEvaluationConnector({
        credentials: makeCredentials(fixture.path),
        items: mixedItems.store,
        fetch: makeFetch({ nextRoute: () => routes.shift()! }),
      }).evaluate({ ...request, limit: 2 });

      expect(mixed).toMatchObject({
        evaluatedCount: 2,
        actionableCount: 1,
        noActionCount: 1,
      });
      expect(mixed.itemIds).toHaveLength(2);
      expect(mixed.actionableItemIds).toEqual([mixed.itemIds[0]]);
      expect(mixedItems.values.get(mixed.itemIds[0]!)).toMatchObject({
        kind: "decision",
        status: "review",
      });
      expect(mixedItems.values.get(mixed.itemIds[1]!)).toMatchObject({
        kind: "task",
        status: "done",
      });

      const ignoredItems = makeItems();
      const ignored = yield* makeProspectEvaluationConnector({
        credentials: makeCredentials(fixture.path),
        items: ignoredItems.store,
        fetch: makeFetch({
          choice: "ignore",
          probabilities: { ignore: 0.85, defer: 0.05, investigate: 0.05, review: 0.05 },
        }),
      }).evaluate({ ...request, limit: 2 });

      expect(ignored).toMatchObject({
        evaluatedCount: 2,
        actionableCount: 0,
        actionableItemIds: [],
        noActionCount: 2,
      });
      expect([...ignoredItems.values.values()]).toEqual([
        expect.objectContaining({ kind: "task", status: "done" }),
        expect.objectContaining({ kind: "task", status: "done" }),
      ]);
    }),
  ),
);

it.effect(
  "hands a completed partial batch back to the same checkpoint and lets a later execution advance",
  () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const items = makeItems();
        let evaluateCalls = 0;
        const connector = makeProspectEvaluationConnector({
          credentials: makeCredentials(fixture.path),
          items: items.store,
          fetch: makeFetch({
            failEvaluate: () => {
              evaluateCalls += 1;
              return evaluateCalls === 2;
            },
          }),
        });
        const batchRequest = { ...request, limit: 2 };

        const failure = yield* connector.evaluate(batchRequest).pipe(Effect.flip);
        expect(failure).toMatchObject({ retryable: true });
        expect(items.values).toHaveLength(1);
        const firstId = [...items.values.keys()][0]!;
        expect(evaluationMarkerState(items.values.get(firstId))).toMatchObject({
          executionId: request.executionId,
          nodeId: request.nodeId,
          observationRecorded: true,
        });

        items.humanStatus("waiting");
        const firstBeforeReplay = items.values.get(firstId);
        const replay = yield* connector.evaluate(batchRequest);

        expect(replay.itemIds).toHaveLength(2);
        expect(replay.itemIds[0]).toBe(firstId);
        expect(replay.actionableItemIds).toEqual(replay.itemIds);
        expect(replay.actionableCount).toBe(2);
        expect(items.values.get(firstId)).toEqual(firstBeforeReplay);
        expect(items.values.get(firstId)?.status).toBe("waiting");
        expect(evaluateCalls).toBe(3);

        const nextExecution = yield* connector.evaluate({
          ...request,
          executionId: "execution-2",
        });
        expect(nextExecution).toMatchObject({ evaluatedCount: 1, skippedExistingCount: 2 });
        expect(nextExecution.itemIds[0]).not.toBe(firstId);
        expect(items.values).toHaveLength(3);
        expect(items.values.get(firstId)?.status).toBe("waiting");
        expect(evaluateCalls).toBe(4);
      }),
    ),
);

it.effect("fails closed when an existing marker lacks replay provenance", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const items = makeItems();
      const connector = makeProspectEvaluationConnector({
        credentials: makeCredentials(fixture.path),
        items: items.store,
        fetch: makeFetch(),
      });
      yield* connector.evaluate(request);
      const item = [...items.values.values()][0]!;
      const encoded = item.description?.match(/prospect-evaluation:([A-Za-z0-9_-]+)/u)?.[1];
      if (encoded === undefined) throw new Error("missing evaluation marker");
      const marker = decodeUnknownJson(
        Buffer.from(encoded, "base64url").toString("utf8"),
      ) as Record<string, unknown>;
      delete marker.executionId;
      const malformed = Buffer.from(encodeUnknownJson(marker), "utf8").toString("base64url");
      items.values.set(item.id, {
        ...item,
        description: item.description!.replace(encoded, malformed),
      });

      const error = yield* connector
        .evaluate({ ...request, executionId: "execution-2" })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ retryable: false });
      expect(error.message).toContain("missing valid evaluation provenance");
      expect(items.values).toHaveLength(1);
    }),
  ),
);

it.effect("fails closed across Space boundaries before reading or calling HTTP", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const requests: FetchRequest[] = [];
      const connector = makeProspectEvaluationConnector({
        credentials: makeCredentials(fixture.path),
        items: makeItems().store,
        fetch: makeFetch({ requests }),
      });
      const error = yield* connector.evaluate({ ...request, spaceId: "space-b" }).pipe(Effect.flip);
      expect(error).toMatchObject({ retryable: false });
      expect(error.message).toContain("different Space");
      expect(requests).toEqual([]);
    }),
  ),
);

it.effect("does not create an Item when Jev returns malformed data", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const items = makeItems();
      const connector = makeProspectEvaluationConnector({
        credentials: makeCredentials(fixture.path),
        items: items.store,
        fetch: makeFetch({ malformedJev: true }),
      });
      const error = yield* connector.evaluate(request).pipe(Effect.flip);
      expect(error).toMatchObject({ retryable: true });
      expect(error.message).toContain("malformed choice");
      expect(items.values).toHaveLength(0);
    }),
  ),
);

it.effect("records a confident no-action outcome as a completed task", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const items = makeItems();
      const connector = makeProspectEvaluationConnector({
        credentials: makeCredentials(fixture.path),
        items: items.store,
        fetch: makeFetch({
          choice: "ignore",
          probabilities: { ignore: 0.9, defer: 0.04, investigate: 0.03, review: 0.03 },
        }),
      });
      const result = yield* connector.evaluate(request);
      expect(result).toMatchObject({ evaluatedCount: 1, actionableCount: 0 });
      expect([...items.values.values()][0]).toMatchObject({ kind: "task", status: "done" });
    }),
  ),
);

it.effect("leaves the candidate unconsumed when scoped memory retrieval fails", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const items = makeItems();
      const fetchImplementation = (async (input) => {
        const url = String(input);
        if (url.includes(":embedContent")) {
          return jsonResponse({ embedding: { values: Array.from({ length: 768 }, () => 0.25) } });
        }
        if (url.endsWith("/match_thoughts")) return jsonResponse({ error: "unavailable" }, 503);
        throw new Error(`Unexpected mock URL ${url}`);
      }) as typeof globalThis.fetch;
      const connector = makeProspectEvaluationConnector({
        credentials: makeCredentials(fixture.path),
        items: items.store,
        fetch: fetchImplementation,
      });
      const error = yield* connector.evaluate(request).pipe(Effect.flip);
      expect(error).toMatchObject({ retryable: true });
      expect(error.message).toContain("memory lookup failed");
      expect(items.values).toHaveLength(0);
    }),
  ),
);

it.effect("bounds a stalled response body, cancels it, and leaves the candidate unconsumed", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const items = makeItems();
      let abortObserved = false;
      let cancellationObserved = false;
      const fetchImplementation = (async (_input, init) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            abortObserved = true;
          },
          { once: true },
        );
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancellationObserved = true;
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof globalThis.fetch;
      const connector = makeProspectEvaluationConnector({
        credentials: makeCredentials(fixture.path),
        items: items.store,
        fetch: fetchImplementation,
        requestTimeoutMs: 5,
      });
      const error = yield* connector.evaluate(request).pipe(Effect.flip, TestClock.withLive);
      expect(error).toMatchObject({ retryable: true });
      expect(error.message).toContain("embedding provider request failed");
      expect(abortObserved).toBe(true);
      expect(cancellationObserved).toBe(true);
      expect(items.values).toHaveLength(0);
    }),
  ),
);

it.effect("retries a failed vector patch without marking the observation recorded", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const items = makeItems();
      const requests: FetchRequest[] = [];
      let failPatch = true;
      const connector = makeProspectEvaluationConnector({
        credentials: makeCredentials(fixture.path),
        items: items.store,
        fetch: makeFetch({
          requests,
          failPatch: () => {
            if (!failPatch) return false;
            failPatch = false;
            return true;
          },
        }),
      });

      const failure = yield* connector.evaluate(request).pipe(Effect.flip);
      const failedItem = [...items.values.values()][0];

      expect(failure).toMatchObject({ retryable: true });
      expect(failure.message).toContain("embedding persistence failed");
      expect(items.values).toHaveLength(1);
      expect(evaluationMarkerState(failedItem).observationRecorded).toBe(false);

      const recovered = yield* connector.evaluate(request);
      const recoveredItem = [...items.values.values()][0];
      const patchUrls = requests
        .filter((entry) => entry.method === "PATCH")
        .map((entry) => entry.url);

      expect(recovered).toMatchObject({ evaluatedCount: 1 });
      expect(items.values).toHaveLength(1);
      expect(evaluationMarkerState(recoveredItem).observationRecorded).toBe(true);
      expect(patchUrls).toEqual([
        "https://awbefohirbesfpouwirt.supabase.co/rest/v1/thoughts?id=eq.00000000-0000-4000-8000-000000000001",
        "https://awbefohirbesfpouwirt.supabase.co/rest/v1/thoughts?id=eq.00000000-0000-4000-8000-000000000001",
      ]);
    }),
  ),
);

it.effect("preserves a later human decision and retries feedback until it is recorded", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const items = makeItems();
      let failFeedback = false;
      const connector = makeProspectEvaluationConnector({
        credentials: makeCredentials(fixture.path),
        items: items.store,
        fetch: makeFetch({
          failPatch: () => {
            if (!failFeedback) return false;
            failFeedback = false;
            return true;
          },
        }),
      });
      yield* connector.evaluate(request);
      items.humanStatus("done");
      failFeedback = true;

      const nextExecutionRequest = { ...request, executionId: "execution-2" };
      const failure = yield* connector.evaluate(nextExecutionRequest).pipe(Effect.flip);
      expect(failure).toMatchObject({ retryable: true });
      expect([...items.values.values()][0]?.status).toBe("done");
      expect(evaluationMarkerState([...items.values.values()][0]).feedbackStatus).toBe("review");

      const recovered = yield* connector.evaluate(nextExecutionRequest);
      expect(recovered).toMatchObject({ feedbackCount: 1, evaluatedCount: 1 });
      expect([...items.values.values()][0]?.status).toBe("done");
      expect(evaluationMarkerState([...items.values.values()][0]).feedbackStatus).toBe("done");
      expect([...items.values.values()][0]?.description).toContain("prospect-evaluation:");
    }),
  ),
);

it.effect("rejects malformed or endpoint-overriding encrypted profiles", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const connector = makeProspectEvaluationConnector({
        credentials: makeCredentials(fixture.path, {
          ...profile,
          prospectorDbPath: fixture.path,
          gatewayUrl: "https://attacker.invalid",
        }),
        items: makeItems().store,
        fetch: makeFetch(),
      });
      const error = yield* connector.evaluate(request).pipe(Effect.flip);
      expect(error).toMatchObject({ retryable: false });
      expect(error.message).toContain("malformed or uses an unsupported endpoint/model");
    }),
  ),
);
