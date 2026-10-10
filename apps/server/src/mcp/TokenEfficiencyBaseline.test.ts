import { expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import {
  codexDefaultModeDeveloperInstructions,
  codexPlanModeDeveloperInstructions,
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
      defaultBytes: Buffer.byteLength(codexDefaultModeDeveloperInstructions(true)),
      planBytes: Buffer.byteLength(codexPlanModeDeveloperInstructions(true)),
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
    // 2026-09: +94 bytes to route default-mode questions through
    // `request_user_input` when the tool is listed (plain-text fallback
    // remains for the tool-unavailable case).
    // 2026-10: -2 bytes from upstream v0.0.45 joining the tool blocks with
    // "\n\n" (tools now ride turn additionalContext; baseline measures both).
    collaborationInstructions: { defaultBytes: 2_163, planBytes: 10_300 },
    // 2026-09: +1,938 bytes for the optional `database` selector on the nine
    // Supabase tools (multi-database projects).
    // 2026-09: +76 bytes for the `prospect.evaluate`/`prospect.notify`
    // automation node configs (review-only prospect queue).
    // 2026-09: +396 bytes for scoped correction evidence, expiry, and
    // contradiction fields on the existing memory proposal tool.
    // 2026-09: +40 bytes for the `repository.checks` source-node configuration.
    // 2026-10: effect rc.112 JSON Schema output plus object-root input schemas
    // for cc_spaces_list and cc_google_read (upstream catch-up sync); main's
    // +512 bytes above (prospect, memory correction, repository.checks) on top.
    // 2026-10: +117 bytes for the read-only `cc_space_brief` Space agent tool.
    // 2026-10: +271 bytes for the read-only `cc_space_activity` feed tool.
    // 2026-10: +560 bytes for `cc_items_update` (status/title/description only).
    // 2026-10: +3 bytes net from the upstream v0.0.45 sync (preview_snapshot
    // `save` text, effect rc.115 and shared contract schema changes).
    mcp: { toolCount: 39, schemaBytes: 26_816, toolkitCounts: [14, 16, 9] },
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
