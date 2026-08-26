import { describe, expect, it } from "@effect/vitest";
import { runBinary } from "./support.ts";

/**
 * The container builds smoke-test every binary with `--help`
 * (deploy/openclaw/sandbox-image/Containerfile.*), so a non-zero exit or an
 * empty stdout here breaks the image build rather than a runtime path.
 */
describe.each([
  ["t3-preview-bridge", "usage: t3-preview-bridge"],
  ["t3-egress-proxy", "usage: t3-egress-proxy"],
  ["t3-credential-proxy", "usage: t3-credential-proxy"],
  ["gh", "gh pr create"],
] as const)("%s --help", (binary, expected) => {
  it("prints usage to stdout and exits 0", async () => {
    const result = await runBinary(binary, ["--help"], "");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(expected);
  });
});
