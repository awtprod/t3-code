import {
  CommandCenterPreparationResult,
  type CommandCenterPreparationResult as PreparationResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const MAX_OUTPUT_BYTES = 64 * 1024;
const decodeOutput = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeResult = Schema.decodeUnknownSync(CommandCenterPreparationResult);

export function preparationResultFromOutput(outputJson: string | null): PreparationResult | null {
  if (outputJson === null || Buffer.byteLength(outputJson, "utf8") > MAX_OUTPUT_BYTES) {
    return null;
  }
  let output: unknown;
  try {
    output = decodeOutput(outputJson);
  } catch {
    // A malformed adapter result must not turn a completed check into claimed useful work.
    return null;
  }
  if (output === null || typeof output !== "object" || Array.isArray(output)) return null;
  const candidates = Object.values(output).filter(
    (value) =>
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      "kind" in value &&
      value.kind === "preparation-result",
  );
  if (candidates.length !== 1) return null;
  try {
    const result = decodeResult(candidates[0]);
    return Number.isFinite(Date.parse(result.source.observedAt)) ? result : null;
  } catch {
    return null;
  }
}
