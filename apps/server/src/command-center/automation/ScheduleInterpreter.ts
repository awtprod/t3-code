import type {
  CommandCenterAutomationScheduleInterpretInput,
  CommandCenterAutomationScheduleInterpretResult,
} from "@t3tools/contracts";
import { CommandCenterError } from "@t3tools/contracts";
import {
  describeAutomationSchedule,
  isValidAutomationTimeZone,
  nextAutomationScheduleOccurrences,
  parseAutomationCronExpression,
} from "@t3tools/shared/automationSchedule";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";

export interface AutomationScheduleInterpreterShape {
  readonly interpret: (
    input: CommandCenterAutomationScheduleInterpretInput,
  ) => Effect.Effect<CommandCenterAutomationScheduleInterpretResult, CommandCenterError>;
}

export class AutomationScheduleInterpreter extends Context.Service<
  AutomationScheduleInterpreter,
  AutomationScheduleInterpreterShape
>()(
  "@awtprod/command-center/command-center/automation/ScheduleInterpreter/AutomationScheduleInterpreter",
) {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;

  const interpret = Effect.fn("AutomationScheduleInterpreter.interpret")(function* (
    input: CommandCenterAutomationScheduleInterpretInput,
  ) {
    if (!isValidAutomationTimeZone(input.timezone)) {
      return yield* new CommandCenterError({
        reason: "validation",
        message: "Choose a valid timezone before interpreting this schedule.",
      });
    }
    const currentSettings = yield* settings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new CommandCenterError({
            reason: "routing",
            message: "The text-generation model setting could not be loaded.",
            cause,
          }),
      ),
    );
    const generated = yield* textGeneration
      .generateAutomationSchedule({
        cwd: config.cwd,
        text: input.text,
        timezone: input.timezone,
        modelSelection: currentSettings.textGenerationModelSelection,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new CommandCenterError({
              reason: "routing",
              message: "The configured model could not interpret this schedule.",
              cause,
            }),
        ),
      );
    if (generated.status === "needs_clarification") {
      return {
        status: "needs_clarification",
        message: generated.message.trim() || "Please describe the recurrence more precisely.",
      } as const;
    }
    const expression = generated.expression.trim();
    if (parseAutomationCronExpression(expression) === undefined) {
      return yield* new CommandCenterError({
        reason: "validation",
        message: "The model returned a schedule this environment does not support.",
      });
    }
    const nextOccurrences = nextAutomationScheduleOccurrences(expression, input.timezone, {
      count: 3,
      maxDays: 740,
    });
    if (nextOccurrences.length === 0) {
      return yield* new CommandCenterError({
        reason: "validation",
        message: "The interpreted schedule has no upcoming occurrence in the preview window.",
      });
    }
    return {
      status: "interpreted",
      trigger: { kind: "schedule", expression, timezone: input.timezone },
      summary: describeAutomationSchedule(expression),
      nextOccurrences,
    } as const;
  });

  return AutomationScheduleInterpreter.of({ interpret });
});

export const layer = Layer.effect(AutomationScheduleInterpreter, make);
