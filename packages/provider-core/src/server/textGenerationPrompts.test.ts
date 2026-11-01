import { describe, expect, it } from "vite-plus/test";

import { buildThreadTitlePrompt } from "./textGenerationPrompts.ts";
import { normalizeCliError } from "./textGenerationUtils.ts";

describe("normalizeCliError", () => {
  it("does not expose CLI failure details in the public error message", () => {
    const result = normalizeCliError(
      "codex",
      "generateCommitMessage",
      new Error("request failed with access_token=secret-token"),
      "Failed to generate a commit message",
    );

    expect(result.detail).toBe("Failed to generate a commit message");
    expect(result.message).not.toContain("secret-token");
  });
});

describe("buildThreadTitlePrompt", () => {
  it("names the product as Command Center in initial and regenerated title prompts", () => {
    const initial = buildThreadTitlePrompt({ message: "Investigate reconnect regressions" });
    expect(initial.prompt).toContain(
      "Generate a title that will help the user recognize this Command Center thread weeks later.",
    );

    const regenerated = buildThreadTitlePrompt({
      message: "USER: Investigate reconnect regressions",
      previousTitle: "Investigate reconnect regressions",
    });
    expect(regenerated.prompt).toContain(
      "Regenerate the title for an existing Command Center thread so the user can recognize it weeks later.",
    );
    expect(`${initial.prompt}${regenerated.prompt}`).not.toContain("T3 Code");
  });
});
