import { describe, expect, it } from "vite-plus/test";

import packageJson from "./package.json" with { type: "json" };
import { shouldBundleCliDependency } from "./vite.config.ts";

describe("server bundle dependencies", () => {
  it("bundles private Command Center workspace packages", () => {
    expect(shouldBundleCliDependency("@command-center/core")).toBe(true);
    expect(shouldBundleCliDependency("@command-center/core/domain")).toBe(true);
  });

  it("bundles registry runtime dependencies under the inverted scheme", () => {
    // Upstream inverted the bundling scheme: everything is inlined except the
    // packages in scripts/lib/cli-external-packages.ts that genuinely cannot be.
    expect(shouldBundleCliDependency("effect")).toBe(true);
    expect(shouldBundleCliDependency("@effect/platform-node")).toBe(true);
    expect(shouldBundleCliDependency("node-pty")).toBe(false);
    expect(shouldBundleCliDependency("node:fs")).toBe(false);
  });

  it("does not expose private workspace packages as runtime dependencies", () => {
    const workspaceRuntimeDependencies = Object.entries(packageJson.dependencies).filter(
      ([, dependencySpec]) => dependencySpec.startsWith("workspace:"),
    );

    expect(workspaceRuntimeDependencies).toEqual([]);
  });
});
