import { Automation, AutomationId, AutomationNodeId, SpaceId } from "@command-center/core";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { AutomationRuns, type AutomationRunsShape } from "../AutomationRuns.ts";
import { CommandCenterService, type CommandCenterServiceShape } from "../Service.ts";
import {
  AutomationTriggerCoordinator,
  layer,
  normalizeWebhookRoute,
  parseCronExpression,
  scheduleMatches,
  webhookIdempotencyKey,
} from "./TriggerCoordinator.ts";

const now = "2026-07-20T12:00:00.000Z";
const commit = "1234567890abcdef1234567890abcdef12345678";
const digest = `sha256:${"a".repeat(64)}`;
const decodeAutomation = Schema.decodeUnknownSync(Automation);

function automation(
  id: string,
  trigger:
    | { readonly type: "schedule"; readonly expression: string; readonly timezone: string }
    | { readonly type: "webhook"; readonly route: string },
) {
  return decodeAutomation({
    id,
    spaceId: "space-a",
    name: id,
    version: 1,
    enabled: true,
    trigger,
    nodes: [
      {
        id: AutomationNodeId.make("transform"),
        kind: "transform",
        config: { output: true },
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
    definitionDigest: digest,
    configCommit: commit,
    createdAt: now,
    updatedAt: now,
  });
}

it("validates five-field cron safely and matches in the configured timezone", () => {
  expect(parseCronExpression("*/20 8-17 * * 1-5")).toBeDefined();
  expect(parseCronExpression("* * * *")).toBeUndefined();
  expect(parseCronExpression("* 25 * * *")).toBeUndefined();
  expect(scheduleMatches("0 8 * * 1-5", "America/New_York", "2026-07-20T12:00:00Z")).toBe(true);
  expect(scheduleMatches("0 8 * * 1-5", "Invalid/Timezone", now)).toBe(false);
});

it("normalizes only local webhook routes", () => {
  expect(normalizeWebhookRoute(" /hooks//weekly/ ")).toBe("/hooks/weekly");
  expect(normalizeWebhookRoute("https://outside.test/hook")).toBeUndefined();
  expect(normalizeWebhookRoute("/hooks/../admin")).toBeUndefined();
  expect(normalizeWebhookRoute("/hooks/work?write=true")).toBeUndefined();
});

it("binds webhook replay identity to the authenticated source, Space, route, and delivery", () => {
  const base = {
    admissionSource: "credential:sample-hook",
    spaceId: SpaceId.make("space-a"),
    route: "/hooks/weekly",
    deliveryId: "delivery-1",
  };
  const first = webhookIdempotencyKey(base);
  expect(webhookIdempotencyKey(base)).toBe(first);
  expect(webhookIdempotencyKey({ ...base, admissionSource: "credential:other-hook" })).not.toBe(
    first,
  );
  expect(webhookIdempotencyKey({ ...base, spaceId: SpaceId.make("space-b") })).not.toBe(first);
  expect(webhookIdempotencyKey({ ...base, route: "/hooks/other" })).not.toBe(first);
  expect(webhookIdempotencyKey({ ...base, deliveryId: "delivery-2" })).not.toBe(first);
});

it.effect("admits due schedules and exact Space-scoped webhook routes at committed digests", () => {
  const scheduled = automation("scheduled", {
    type: "schedule",
    expression: "0 12 * * *",
    timezone: "UTC",
  });
  const webhook = automation("webhook", { type: "webhook", route: "/hooks/weekly" });
  const starts: Array<Record<string, unknown>> = [];
  const service = CommandCenterService.of({
    queryAutomations: () => Effect.succeed({ automations: [scheduled, webhook] }),
  } as unknown as CommandCenterServiceShape);
  const runs = AutomationRuns.of({
    start: (input) => {
      starts.push(input);
      return Effect.succeed({
        id: `execution-${starts.length}`,
        automationId: input.automationId,
        idempotencyKey: input.idempotencyKey,
        spaceId: input.spaceId,
        configCommitSha: input.expectedConfigCommitSha,
        definitionDigest: input.expectedDefinitionDigest,
        state: "succeeded",
        input: input.input ?? {},
        lease: null,
        checkpoints: [],
        output: null,
        error: null,
        createdAt: now,
        updatedAt: now,
        finishedAt: now,
      });
    },
    get: () => Effect.die("unused"),
    recoverDue: () => Effect.die("unused"),
    decideApproval: () => Effect.die("unused"),
  } satisfies AutomationRunsShape);
  const testLayer = layer.pipe(
    Layer.provide(Layer.succeed(CommandCenterService, service)),
    Layer.provide(Layer.succeed(AutomationRuns, runs)),
  );

  return Effect.gen(function* () {
    const coordinator = yield* AutomationTriggerCoordinator;
    const schedule = yield* coordinator.admitSchedule({
      automationId: AutomationId.make("scheduled"),
      spaceId: SpaceId.make("space-a"),
      scheduledFor: "2026-07-20T12:00:42.000Z",
    });
    const hook = yield* coordinator.admitWebhook({
      admissionSource: "paired-rpc",
      spaceId: SpaceId.make("space-a"),
      route: "/hooks//weekly/",
      deliveryId: "delivery-1",
      payload: { readOnly: true },
    });

    expect(schedule.idempotencyKey).toBe("schedule:scheduled:2026-07-20T12:00:00.000Z");
    expect(hook.idempotencyKey).toBe(
      webhookIdempotencyKey({
        admissionSource: "paired-rpc",
        spaceId: SpaceId.make("space-a"),
        route: "/hooks/weekly",
        deliveryId: "delivery-1",
      }),
    );
    expect(starts).toEqual([
      expect.objectContaining({
        expectedConfigCommitSha: commit,
        expectedDefinitionDigest: digest,
      }),
      expect.objectContaining({
        expectedConfigCommitSha: commit,
        expectedDefinitionDigest: digest,
      }),
    ]);
  }).pipe(Effect.provide(testLayer));
});
