import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  COMMAND_CENTER_WS_METHODS,
  CommandCenterEventEnvelope,
  CommandCenterEventReplayInput,
  CommandCenterTimelinePage,
} from "./index.ts";

const decodeReplayInput = Schema.decodeUnknownSync(CommandCenterEventReplayInput);
const decodeEvent = Schema.decodeUnknownSync(CommandCenterEventEnvelope);
const decodeTimelinePage = Schema.decodeUnknownSync(CommandCenterTimelinePage);

describe("Command Center event contracts", () => {
  it("publishes stable replay, subscription, and timeline RPC names", () => {
    expect(COMMAND_CENTER_WS_METHODS.eventsReplay).toBe("cc.events.replay");
    expect(COMMAND_CENTER_WS_METHODS.eventsSubscribe).toBe("cc.events.subscribe");
    expect(COMMAND_CENTER_WS_METHODS.timelineQuery).toBe("cc.timeline.query");
  });

  it("bounds durable replay pages", () => {
    expect(decodeReplayInput({ afterSequence: 0, limit: 500 })).toMatchObject({
      afterSequence: 0,
      limit: 500,
    });
    expect(() => decodeReplayInput({ afterSequence: 0, limit: 501 })).toThrow();
  });

  it("decodes typed route events and durable timeline pages", () => {
    const event = decodeEvent({
      _tag: "RouteSelected",
      sequence: 1,
      eventId: "event-example",
      previousHash: null,
      eventHash: "a".repeat(64),
      actorKind: "user",
      spaceId: "space-example",
      runId: "run-example",
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload: {
        commandId: "command-example",
        state: "queued",
        route: {
          commandId: "command-example",
          status: "ready",
          intent: "conversation",
          spaceId: "space-example",
          repositoryId: null,
          projectId: null,
          providerId: "provider-example",
          modelId: "model-example",
          capabilities: ["cc.runs.start"],
          actionKind: "read",
          risk: "low",
          approvalRequired: false,
          sources: {
            space: "explicit",
            repository: "unresolved",
            project: "unresolved",
            provider: "fallback",
            model: "provider-default",
          },
          reasons: [],
        },
      },
    });
    expect(event._tag).toBe("RouteSelected");
    if (event._tag !== "RouteSelected") {
      throw new Error("Expected a typed route-selected event.");
    }

    expect(
      decodeTimelinePage({
        entries: [
          {
            sequence: 1,
            runId: "run-example",
            commandId: "command-example",
            text: "Review the example",
            spaceId: "space-example",
            repositoryId: null,
            projectId: null,
            threadId: null,
            status: "queued",
            route: event.payload.route,
            response: null,
            artifacts: [],
            startedAt: "2026-01-01T00:00:00.000Z",
            finishedAt: null,
          },
        ],
        nextSequence: 1,
      }).entries,
    ).toHaveLength(1);
  });
});
