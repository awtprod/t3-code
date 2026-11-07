import type { ProviderDriverKind, ProviderReplayTranscript } from "@t3tools/contracts";

import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

import { buildCodexInitializeParams } from "../../provider/CodexProvider.ts";

// Upstream records its fixtures as "T3 Code"; Command Center ships its own product name
// in the runtime info, so recorded prompts are rebranded to it before exact matching.
const CURRENT_RUNTIME_INFO = buildRuntimeInstructions({ harness: "replay" });
const PRODUCT_PHRASES: ReadonlyArray<readonly [recorded: string, current: string]> = [
  [
    "you are running in T3 Code through the ",
    /you are running in .+? through the /.exec(CURRENT_RUNTIME_INFO)![0],
  ],
  [
    "open it in T3 Code's files viewer",
    /open it in .+?'s files viewer/.exec(CURRENT_RUNTIME_INFO)![0],
  ],
];

function rebrandRecordedRuntimeInfo(
  transcript: ProviderReplayTranscript,
): ProviderReplayTranscript {
  return {
    ...transcript,
    entries: transcript.entries.map((entry) => {
      if (entry.type !== "expect_outbound") return entry;
      const serialized = JSON.stringify(entry.frame);
      const rebranded = PRODUCT_PHRASES.reduce(
        (text, [recorded, current]) => text.replaceAll(recorded, current),
        serialized,
      );
      return rebranded === serialized ? entry : { ...entry, frame: JSON.parse(rebranded) };
    }),
  };
}

// Upstream's Codex fixtures also record its client name on `initialize`; Command Center
// identifies itself to Codex by its own name, so only that clientInfo name/title is rebranded.
const RECORDED_CODEX_CLIENT_NAME = "T3 Code";

/** Rewrites recorded `initialize` clientInfo name/title to the client name production sends. */
export function rebrandRecordedCodexClientInfo<
  T extends {
    readonly entries: ReadonlyArray<{ readonly type: string; readonly frame?: unknown }>;
  },
>(transcript: T): T {
  const { name, title } = buildCodexInitializeParams().clientInfo;
  return {
    ...transcript,
    entries: transcript.entries.map((entry) => {
      if (entry.type !== "expect_outbound") return entry;
      const frame = entry.frame;
      if (
        typeof frame !== "object" ||
        frame === null ||
        !("method" in frame) ||
        frame.method !== "initialize" ||
        !("params" in frame) ||
        typeof frame.params !== "object" ||
        frame.params === null ||
        !("clientInfo" in frame.params) ||
        typeof frame.params.clientInfo !== "object" ||
        frame.params.clientInfo === null
      ) {
        return entry;
      }
      const clientInfo: Record<string, unknown> = { ...frame.params.clientInfo };
      if (clientInfo.name !== RECORDED_CODEX_CLIENT_NAME) return entry;
      return {
        ...entry,
        frame: {
          ...frame,
          params: {
            ...frame.params,
            clientInfo: {
              ...clientInfo,
              name,
              ...(clientInfo.title === RECORDED_CODEX_CLIENT_NAME ? { title } : {}),
            },
          },
        },
      };
    }),
  };
}

/** Adds current runtime context to legacy prompt expectations, keeping outbound matching exact. */
export function materializeReplayTranscriptRuntimeInstructions(
  transcript: ProviderReplayTranscript,
  runtime: { readonly driver: ProviderDriverKind; readonly model: string },
): ProviderReplayTranscript {
  // Muse records the runtime info inside its turn/start input, so it must match verbatim.
  if (runtime.driver === "muse") return rebrandRecordedRuntimeInfo(transcript);
  if (runtime.driver === "codex") return rebrandRecordedCodexClientInfo(transcript);
  const harness =
    runtime.driver === "cursor"
      ? "Cursor"
      : runtime.driver === "grok"
        ? "Grok"
        : runtime.driver === "acpRegistry"
          ? "acpRegistry"
          : runtime.driver === "fx"
            ? "fx"
            : undefined;
  if (harness === undefined) return transcript;
  const instructions = buildRuntimeInstructions({ harness, model: runtime.model });

  return {
    ...transcript,
    entries: transcript.entries.map((entry) => {
      if (entry.type !== "expect_outbound") return entry;
      const frame = entry.frame;
      if (typeof frame !== "object" || frame === null) return entry;
      if (
        runtime.driver === "cursor" &&
        "type" in frame &&
        frame.type === "run.start" &&
        "message" in frame &&
        typeof frame.message === "string"
      ) {
        return frame.message.endsWith(instructions)
          ? entry
          : { ...entry, frame: { ...frame, message: `${frame.message}\n\n${instructions}` } };
      }
      if (
        "method" in frame &&
        frame.method === "session/prompt" &&
        "params" in frame &&
        typeof frame.params === "object" &&
        frame.params !== null &&
        "prompt" in frame.params &&
        Array.isArray(frame.params.prompt)
      ) {
        const prompt: ReadonlyArray<unknown> = frame.params.prompt;
        const lastPart = prompt.at(-1);
        if (
          typeof lastPart === "object" &&
          lastPart !== null &&
          "type" in lastPart &&
          lastPart.type === "text" &&
          "text" in lastPart &&
          lastPart.text === instructions
        ) {
          return entry;
        }
        return {
          ...entry,
          frame: {
            ...frame,
            params: { ...frame.params, prompt: [...prompt, { type: "text", text: instructions }] },
          },
        };
      }
      return entry;
    }),
  };
}
