// @effect-diagnostics nodeBuiltinImport:off - Reads the checked-in deployment policy.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { isMap, isSeq, parseDocument } from "yaml";

const workflow = parseDocument(
  NodeFS.readFileSync(new URL("../.github/workflows/deploy-relay.yml", import.meta.url), "utf8"),
);

describe("relay deployment workflow", () => {
  it("requires an explicit opt-in on main before any deployment steps can run", () => {
    expect(workflow.errors).toEqual([]);
    expect(workflow.getIn(["jobs", "deploy_relay", "if"])).toBe(
      "${{ vars.ENABLE_RELAY_DEPLOY == 'true' && github.ref == 'refs/heads/main' }}",
    );
    // Every job must use the guarded path, including manually triggered runs.
    const jobs = workflow.get("jobs");
    expect(isMap(jobs) ? Object.keys(jobs.toJSON()) : []).toEqual(["deploy_relay"]);
  });

  it("retains main pushes and intentional manual runs without PR deployment", () => {
    const triggers = workflow.get("on");
    // Upstream lists push before workflow_dispatch; only the trigger set matters.
    expect(isMap(triggers) ? Object.keys(triggers.toJSON()).toSorted() : []).toEqual([
      "push",
      "workflow_dispatch",
    ]);
    const branches = workflow.getIn(["on", "push", "branches"]);
    expect(isSeq(branches) ? branches.toJSON() : []).toEqual(["main"]);
    expect(workflow.hasIn(["on", "workflow_dispatch"])).toBe(true);
  });
});
