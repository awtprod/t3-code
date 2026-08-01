import { describe, expect, it } from "vite-plus/test";

import packageJson from "./package.json" with { type: "json" };
import { shouldBundleCliDependency } from "./vite.config.ts";

describe("server bundle dependencies", () => {
  it("bundles private Command Center workspace packages", () => {
    expect(shouldBundleCliDependency("@command-center/core")).toBe(true);
    expect(shouldBundleCliDependency("@command-center/core/domain")).toBe(true);
  });

  it("keeps registry runtime dependencies external", () => {
    expect(shouldBundleCliDependency("effect")).toBe(false);
    expect(shouldBundleCliDependency("@effect/platform-node")).toBe(false);
  });

  it("does not expose private workspace packages as runtime dependencies", () => {
    const workspaceRuntimeDependencies = Object.entries(packageJson.dependencies).filter(
      ([, dependencySpec]) => dependencySpec.startsWith("workspace:"),
    );

    expect(workspaceRuntimeDependencies).toEqual([]);
  });
});
