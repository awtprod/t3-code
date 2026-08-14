import { describe, expect, it } from "@effect/vitest";

import { isLocalExecutionOverride, LOCAL_EXECUTION_ONCE_SWITCH } from "./primaryBackend.ts";

describe("primary backend launch override", () => {
  it("requires the explicit one-launch switch", () => {
    expect(isLocalExecutionOverride(["command-center.exe"])).toBe(false);
    expect(isLocalExecutionOverride(["command-center.exe", LOCAL_EXECUTION_ONCE_SWITCH])).toBe(
      true,
    );
  });

  it("does not treat similar arguments as a local override", () => {
    expect(isLocalExecutionOverride(["command-center.exe", "--local-execution"])).toBe(false);
    expect(
      isLocalExecutionOverride(["command-center.exe", `${LOCAL_EXECUTION_ONCE_SWITCH}=true`]),
    ).toBe(false);
  });
});
