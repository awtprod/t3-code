// @effect-diagnostics nodeBuiltinImport:off - compiles real source files on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { transform } from "oxc-transform-react";
import { describe, expect, it } from "vite-plus/test";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../..",
);

// Command Center debt: fork-only files inside the lint-debt override in vite.config.ts; fix and remove.
const knownBailouts = new Set([
  "apps/web/src/command-center/automation/AutomationEditor.tsx",
  "apps/web/src/command-center/inbox/InboxScreen.tsx",
  "apps/web/src/command-center/space-agent/SpaceAgentThreadControls.tsx",
  "apps/web/src/command-center/space-agent/useSpaceAgents.ts",
  "apps/web/src/components/SidebarV2.tsx",
  "apps/web/src/routes/_chat.automations.tsx",
  "apps/web/src/routes/_chat.lessons.tsx",
  "apps/web/src/routes/_chat.observations.tsx",
  "apps/web/src/routes/_chat.prospects.tsx",
  "apps/web/src/routes/_chat.responsibilities.tsx",
  "apps/web/src/routes/_chat.sprint-plan.tsx",
]);

const webSourceFiles = NodeFS.readdirSync(NodePath.join(repoRoot, "apps/web/src"), {
  recursive: true,
})
  .map(String)
  .filter((file) => /\.tsx?$/.test(file) && !/\.(test|browser)\.tsx?$/.test(file))
  .filter((file) => !file.endsWith(".gen.ts"))
  .map((file) => `apps/web/src/${file}`)
  .filter((file) => !knownBailouts.has(file));

// ChatView is ~9k lines. Compiling it takes ~9s on a fast machine and can pass the
// 15s project limit on loaded CI runners, so slow files get a 60s limit below.
const slowFiles = new Set(["apps/web/src/components/ChatView.tsx"]);

const compile = async (file: string) => {
  const absolute = NodePath.join(repoRoot, file);
  const result = await transform(absolute, NodeFS.readFileSync(absolute, "utf8"), {
    jsx: { runtime: "automatic", development: false, refresh: false },
    reactCompiler: { reportDiagnostics: true },
  });
  const bailouts = result.errors.map((error) => error.codeframe ?? error.message);
  expect(bailouts).toEqual([]);
};

// Lint reports most compiler bailouts, but not every one (try/finally, throw
// inside try). A skipped file still builds, just unmemoized, so check the output.
describe("React Compiler coverage", () => {
  it.each(webSourceFiles.filter((file) => !slowFiles.has(file)))("compiles %s", compile);
  // oxlint-disable-next-line t3code/no-test-timeout-or-unreasoned-skip -- CPU-bound compile of a huge file, not a hidden wait.
  it.each([...slowFiles])("compiles %s", compile, 60_000);
});
