import { assert, it } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import { buildCodexInitializeParams } from "../../provider/CodexProvider.ts";
import { rebrandRecordedCodexClientInfo } from "./ReplayRuntimeInstructions.ts";

it("rebrands only the recorded Codex initialize clientInfo", () => {
  const recorded = {
    scenario: "acme",
    entries: [
      {
        type: "expect_outbound",
        label: "initialize",
        frame: {
          id: 1,
          method: "initialize",
          params: {
            capabilities: { experimentalApi: true },
            clientInfo: { name: "T3 Code", title: "T3 Code", version: "0.0.44" },
          },
        },
      },
      {
        type: "expect_outbound",
        label: "turn/start",
        frame: { id: 2, method: "turn/start", params: { text: "T3 Code", clientInfo: "T3 Code" } },
      },
      { type: "emit_inbound", label: "reply", frame: { id: 1, result: { name: "T3 Code" } } },
    ],
  } as unknown as ProviderReplayTranscript;

  const rebranded = rebrandRecordedCodexClientInfo(recorded);
  const { name, title } = buildCodexInitializeParams().clientInfo;
  assert.deepEqual(rebranded.entries[0], {
    type: "expect_outbound",
    label: "initialize",
    frame: {
      id: 1,
      method: "initialize",
      params: {
        capabilities: { experimentalApi: true },
        clientInfo: { name, title, version: "0.0.44" },
      },
    },
  } as unknown as ProviderReplayTranscript["entries"][number]);
  // Everything else stays exactly as recorded.
  assert.strictEqual(rebranded.entries[1], recorded.entries[1]);
  assert.strictEqual(rebranded.entries[2], recorded.entries[2]);
});
