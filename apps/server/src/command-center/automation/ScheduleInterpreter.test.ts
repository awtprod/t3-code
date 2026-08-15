import { expect, it } from "@effect/vitest";
import { SpaceId } from "@command-center/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import { AutomationScheduleInterpreter, layer } from "./ScheduleInterpreter.ts";

function textGenerationLayer(
  result: TextGeneration.AutomationScheduleGenerationResult,
): Layer.Layer<TextGeneration.TextGeneration> {
  return Layer.succeed(
    TextGeneration.TextGeneration,
    TextGeneration.TextGeneration.of({
      generateCommitMessage: () => Effect.die("unused"),
      generatePrContent: () => Effect.die("unused"),
      generateBranchName: () => Effect.die("unused"),
      generateThreadTitle: () => Effect.die("unused"),
      generateAutomationSchedule: () => Effect.succeed(result),
    }),
  );
}

function testLayer(result: TextGeneration.AutomationScheduleGenerationResult) {
  return layer.pipe(
    Layer.provide(textGenerationLayer(result)),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.succeed(
        ServerConfig.ServerConfig,
        ServerConfig.ServerConfig.of({ cwd: "/tmp" } as ServerConfig.ServerConfig["Service"]),
      ),
    ),
  );
}

it.effect("validates and independently describes an interpreted schedule", () =>
  Effect.gen(function* () {
    const interpreter = yield* AutomationScheduleInterpreter;
    const result = yield* interpreter.interpret({
      spaceId: SpaceId.make("space-a"),
      text: "weekdays at nine",
      timezone: "UTC",
    });

    expect(result).toMatchObject({
      status: "interpreted",
      trigger: { kind: "schedule", timezone: "UTC" },
      summary: "Weekdays at 9:00 AM",
    });
    if (result.status === "interpreted") expect(result.nextOccurrences).toHaveLength(3);
  }).pipe(Effect.provide(testLayer({ status: "interpreted", expression: "0 9 * * 1-5" }))),
);

it.effect("returns model clarification without applying a schedule", () =>
  Effect.gen(function* () {
    const interpreter = yield* AutomationScheduleInterpreter;
    expect(
      yield* interpreter.interpret({
        spaceId: SpaceId.make("space-a"),
        text: "sometimes in the morning",
        timezone: "UTC",
      }),
    ).toEqual({ status: "needs_clarification", message: "Which days?" });
  }).pipe(Effect.provide(testLayer({ status: "needs_clarification", message: "Which days?" }))),
);

it.effect("rejects invalid provider output and invalid timezones", () =>
  Effect.gen(function* () {
    const interpreter = yield* AutomationScheduleInterpreter;
    const badExpression = yield* Effect.exit(
      interpreter.interpret({
        spaceId: SpaceId.make("space-a"),
        text: "every morning",
        timezone: "UTC",
      }),
    );
    const badTimezone = yield* Effect.exit(
      interpreter.interpret({
        spaceId: SpaceId.make("space-a"),
        text: "every morning",
        timezone: "Not/AZone",
      }),
    );

    expect(badExpression._tag).toBe("Failure");
    expect(badTimezone._tag).toBe("Failure");
  }).pipe(Effect.provide(testLayer({ status: "interpreted", expression: "every morning" }))),
);
