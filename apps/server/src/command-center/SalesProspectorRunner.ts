import type {
  CommandCenterSalesProspectCycleInput,
  CommandCenterSalesProspectCycleResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ProcessRunner, type ProcessRunError } from "../processRunner.ts";

export const PROSPECTOR_RUNNER_ENV = "COMMAND_CENTER_SALES_PROSPECTOR_RUNNER";
export const PROSPECTOR_DB_ENV = "COMMAND_CENTER_SALES_PROSPECTOR_DB";

const RunnerResult = Schema.Struct({
  cycleId: Schema.String,
  discovered: Schema.Int,
  enriched: Schema.Int,
  qualified: Schema.Int,
  researched: Schema.Int,
  skipped: Schema.Int,
  held: Schema.Int,
  quota: Schema.Int,
  botWall: Schema.Int,
});
const RunnerRequest = Schema.Struct({
  version: Schema.Literal(1),
  cycleId: Schema.String,
  database: Schema.String,
  discoveryLimit: Schema.Int,
  qualificationLimit: Schema.Int,
});
const encodeRunnerRequest = Schema.encodeEffect(Schema.fromJsonString(RunnerRequest));
const decodeRunnerResult = Schema.decodeUnknownEffect(Schema.fromJsonString(RunnerResult));

export class SalesProspectorRunnerError extends Schema.TaggedErrorClass<SalesProspectorRunnerError>()(
  "SalesProspectorRunnerError",
  {
    reason: Schema.Literals(["configuration", "process", "output"]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

type RawRunnerResult = typeof RunnerResult.Type;

export interface SalesProspectorRunnerShape {
  readonly cycle: (
    input: CommandCenterSalesProspectCycleInput,
  ) => Effect.Effect<RawRunnerResult, SalesProspectorRunnerError>;
}

export class SalesProspectorRunner extends Context.Service<
  SalesProspectorRunner,
  SalesProspectorRunnerShape
>()("@awtprod/command-center/command-center/SalesProspectorRunner") {}

const processFailure = (cause: ProcessRunError) =>
  new SalesProspectorRunnerError({
    reason: "process",
    message: "The configured sales Prospector runner could not be started.",
    cause,
  });

export const layer = Layer.effect(
  SalesProspectorRunner,
  Effect.gen(function* () {
    const runner = yield* ProcessRunner;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const resolveConfiguredFile = Effect.fn("SalesProspectorRunner.resolveConfiguredFile")(
      function* (environmentName: string) {
        const configured = process.env[environmentName]?.trim();
        if (
          configured === undefined ||
          !path.isAbsolute(configured) ||
          path.resolve(configured) !== configured
        ) {
          return yield* new SalesProspectorRunnerError({
            reason: "configuration",
            message: `${environmentName} must be an exact absolute file path.`,
          });
        }
        const canonical = yield* fs.realPath(configured).pipe(
          Effect.mapError(
            (cause) =>
              new SalesProspectorRunnerError({
                reason: "configuration",
                message: `${environmentName} is unavailable.`,
                cause,
              }),
          ),
        );
        const info = yield* fs.stat(canonical).pipe(
          Effect.mapError(
            (cause) =>
              new SalesProspectorRunnerError({
                reason: "configuration",
                message: `${environmentName} cannot be inspected.`,
                cause,
              }),
          ),
        );
        if (info.type !== "File") {
          return yield* new SalesProspectorRunnerError({
            reason: "configuration",
            message: `${environmentName} must identify a regular file.`,
          });
        }
        return canonical;
      },
    );

    const cycle: SalesProspectorRunnerShape["cycle"] = Effect.fn("SalesProspectorRunner.cycle")(
      function* (input) {
        const executable = yield* resolveConfiguredFile(PROSPECTOR_RUNNER_ENV);
        const database = yield* resolveConfiguredFile(PROSPECTOR_DB_ENV);
        const now = DateTime.formatIso(yield* DateTime.now);
        const requestJson = yield* encodeRunnerRequest({
          version: 1,
          cycleId: `cc-${now.slice(0, 13)}`,
          database,
          discoveryLimit: input.discoveryLimit ?? 20,
          qualificationLimit: input.qualificationLimit ?? 20,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new SalesProspectorRunnerError({
                reason: "output",
                message: "The bounded Prospector request could not be encoded.",
                cause,
              }),
          ),
        );
        const result = yield* runner
          .run({
            command: executable,
            args: [],
            stdin: requestJson,
            env: {
              PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
              ...(process.env.YOUTUBE_API_KEY === undefined
                ? {}
                : { YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY }),
            },
            extendEnv: false,
            timeout: "20 minutes",
            maxOutputBytes: 4 * 1024 * 1024,
          })
          .pipe(Effect.mapError(processFailure));
        if (result.code !== 0) {
          return yield* new SalesProspectorRunnerError({
            reason: "process",
            message: result.stderr.trim() || "The sales Prospector cycle failed.",
          });
        }
        return yield* decodeRunnerResult(result.stdout).pipe(
          Effect.mapError(
            (cause) =>
              new SalesProspectorRunnerError({
                reason: "output",
                message: "The sales Prospector runner returned an invalid result.",
                cause,
              }),
          ),
        );
      },
    );

    return SalesProspectorRunner.of({ cycle });
  }),
);

export const completeCycleResult = (
  runner: RawRunnerResult,
  imported: { readonly proposed: number; readonly duplicates: number },
): CommandCenterSalesProspectCycleResult => ({
  ...runner,
  imported: imported.proposed,
  duplicates: imported.duplicates,
});
