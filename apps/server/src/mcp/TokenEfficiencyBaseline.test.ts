import { expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import {
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "../provider/CodexDeveloperInstructions.ts";
import { COMMAND_CENTER_CONTEXT_LIMITS } from "../command-center/RunDispatcher.ts";
import { CommandCenterToolkit } from "./toolkits/command-center/tools.ts";
import { PreviewToolkit } from "./toolkits/preview/tools.ts";
import { SupabaseToolkit } from "./toolkits/supabase/tools.ts";

it("records the committed static-context baseline", () => {
  const groups = [PreviewToolkit, CommandCenterToolkit, SupabaseToolkit];
  const tools = groups.flatMap((group) => Object.values(group.tools));
  const baseline = {
    collaborationInstructions: {
      defaultBytes: Buffer.byteLength(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS),
      planBytes: Buffer.byteLength(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS),
    },
    mcp: {
      toolCount: tools.length,
      schemaBytes: tools.reduce(
        (total, tool) => total + Buffer.byteLength(JSON.stringify(Tool.getJsonSchema(tool))),
        0,
      ),
      toolkitCounts: groups.map((group) => Object.keys(group.tools).length),
    },
    commandCenter: {
      previousPerEntryBudgetBytes: 6_000,
      previousEntryLimit: 6,
      previousWorstCaseBytes: 36_000,
      spaceInstructionsPreviouslyBounded: false,
    },
  };
  expect(baseline).toEqual({
    collaborationInstructions: { defaultBytes: 2_071, planBytes: 10_302 },
    mcp: { toolCount: 36, schemaBytes: 23_519, toolkitCounts: [14, 13, 9] },
    commandCenter: {
      previousPerEntryBudgetBytes: 6_000,
      previousEntryLimit: 6,
      previousWorstCaseBytes: 36_000,
      spaceInstructionsPreviouslyBounded: false,
    },
  });
  const previewOnlySchemaBytes = Object.values(PreviewToolkit.tools).reduce(
    (total, tool) => total + Buffer.byteLength(JSON.stringify(Tool.getJsonSchema(tool))),
    0,
  );
  const representativeSpaceInstructionsBytes = 8_000;
  const previousRepresentativeBytes =
    baseline.collaborationInstructions.defaultBytes +
    baseline.mcp.schemaBytes +
    baseline.commandCenter.previousWorstCaseBytes +
    representativeSpaceInstructionsBytes;
  const boundedRepresentativeBytes =
    baseline.collaborationInstructions.defaultBytes +
    previewOnlySchemaBytes +
    COMMAND_CENTER_CONTEXT_LIMITS.priorContextChars +
    COMMAND_CENTER_CONTEXT_LIMITS.spaceInstructionsChars;
  expect(boundedRepresentativeBytes).toBeLessThanOrEqual(previousRepresentativeBytes / 2);
});
