import { describe, expect, it } from "@effect/vitest";

import {
  automationDefinitionFitsScope,
  automationDefinitionIsSafeForAuthoring,
  automationReplacementFitsScope,
  automationSaveRequiresRunCapability,
  filterAutomationsForScope,
  filterRunsAndApprovalsForScope,
  memoryWriteOperationForScope,
  memoryVisibleToScope,
  resolveProposedMemoryRepository,
  resolveRunStartScope,
} from "./handlers.ts";

describe("Command Center MCP repository scopes", () => {
  it("shows Space Memory plus only the credential's exact repository Memory", () => {
    const scope = { spaceId: "space-a", repositoryId: "repo-a" };
    expect(memoryVisibleToScope({ spaceId: "space-a" }, scope)).toBe(true);
    expect(memoryVisibleToScope({ spaceId: "space-a", repositoryId: "repo-a" }, scope)).toBe(true);
    expect(memoryVisibleToScope({ spaceId: "space-a", repositoryId: "repo-b" }, scope)).toBe(false);
    expect(memoryVisibleToScope({ spaceId: "space-b" }, scope)).toBe(false);
  });

  it("does not expose repository Memory to a Space-only credential", () => {
    const scope = { spaceId: "space-a" };
    expect(memoryVisibleToScope({ spaceId: "space-a" }, scope)).toBe(true);
    expect(memoryVisibleToScope({ spaceId: "space-a", repositoryId: "repo-a" }, scope)).toBe(false);
  });

  it("binds proposals to the credential repository and denies cross-repository targets", () => {
    expect(resolveProposedMemoryRepository(undefined, "repo-a")).toEqual({
      allowed: true,
      repositoryId: "repo-a",
    });
    expect(resolveProposedMemoryRepository("repo-a", "repo-a")).toEqual({
      allowed: true,
      repositoryId: "repo-a",
    });
    expect(resolveProposedMemoryRepository("repo-b", "repo-a")).toEqual({ allowed: false });
    expect(resolveProposedMemoryRepository("repo-a", undefined)).toEqual({ allowed: false });
  });

  it("rejects host paths and credential-shaped fields from authoring input", () => {
    expect(
      automationDefinitionIsSafeForAuthoring({
        nodes: [{ config: { template: "weekly summary", repositoryId: "repo-a" } }],
      }),
    ).toBe(true);
    expect(
      automationDefinitionIsSafeForAuthoring({
        nodes: [{ config: { nested: { api_key: "do-not-store" } } }],
      }),
    ).toBe(false);
    expect(
      automationDefinitionIsSafeForAuthoring({
        nodes: [{ config: { source: ["", "home", "operator", "private.txt"].join("/") } }],
      }),
    ).toBe(false);
  });

  it("checks repository ids embedded anywhere in an authored graph", () => {
    const exact = {
      nodes: [
        { kind: "agent.run", config: { repositoryId: "repo-a" } },
        { kind: "transform", config: { template: "safe" } },
      ],
    };
    const crossRepository = {
      nodes: [
        { kind: "agent.run", config: { repositoryId: "repo-a" } },
        { kind: "connector.read", config: { nested: { repositoryId: "repo-b" } } },
      ],
    };
    const scope = { repositoryId: "repo-a", spaceRepositoryIds: ["repo-a", "repo-b"] };
    expect(automationDefinitionFitsScope(exact, scope)).toBe(true);
    expect(automationDefinitionFitsScope(crossRepository, scope)).toBe(false);
  });

  it("requires exact agent repository binding and rejects scoped shell authority", () => {
    const scope = { repositoryId: "repo-a", spaceRepositoryIds: ["repo-a"] };
    expect(
      automationDefinitionFitsScope(
        { nodes: [{ kind: "transform", config: { template: "Space-wide" } }] },
        scope,
      ),
    ).toBe(false);
    expect(
      automationDefinitionFitsScope(
        { nodes: [{ kind: "agent.run", config: { prompt: "work" } }] },
        scope,
      ),
    ).toBe(false);
    expect(
      automationDefinitionFitsScope(
        { nodes: [{ kind: "agent.run", config: { repositoryId: "repo-a" } }] },
        scope,
      ),
    ).toBe(true);
    expect(
      automationDefinitionFitsScope(
        { nodes: [{ kind: "shell.scoped", config: { commandId: "safe-command" } }] },
        scope,
      ),
    ).toBe(false);
  });

  it("allows only repositories that belong to the selected Space for Space-only credentials", () => {
    const scope = { repositoryId: undefined, spaceRepositoryIds: ["repo-a"] };
    expect(
      automationDefinitionFitsScope(
        { nodes: [{ kind: "agent.run", config: { repositoryId: "repo-a" } }] },
        scope,
      ),
    ).toBe(true);
    expect(
      automationDefinitionFitsScope(
        { nodes: [{ kind: "agent.run", config: { repositoryId: "repo-b" } }] },
        scope,
      ),
    ).toBe(false);
  });

  it("requires separate run authority for every save that leaves execution enabled", () => {
    expect(automationSaveRequiresRunCapability(false, true)).toBe(true);
    expect(automationSaveRequiresRunCapability(false, false)).toBe(false);
    expect(automationSaveRequiresRunCapability(true, true)).toBe(true);
    expect(automationSaveRequiresRunCapability(true, false)).toBe(false);
  });

  it("does not list unbound, shell, or another repository's automations", () => {
    const automations = [
      {
        id: "repo-a-flow",
        spaceId: "space-a",
        nodes: [{ kind: "agent", config: { repositoryId: "repo-a" } }],
      },
      {
        id: "repo-b-flow",
        spaceId: "space-a",
        nodes: [{ kind: "agent", config: { repositoryId: "repo-b" } }],
      },
      {
        id: "space-flow",
        spaceId: "space-a",
        nodes: [{ kind: "transform", config: {} }],
      },
      {
        id: "shell-flow",
        spaceId: "space-a",
        nodes: [
          { kind: "transform", config: { repositoryId: "repo-a" } },
          { kind: "shell.scoped", config: {} },
        ],
      },
    ];
    expect(
      filterAutomationsForScope(automations, {
        spaceId: "space-a",
        repositoryId: "repo-a",
        spaceRepositoryIds: ["repo-a", "repo-b"],
      }).map((automation) => automation.id),
    ).toEqual(["repo-a-flow"]);
  });

  it("cannot replace repository B automation content with repository A content", () => {
    const scope = { repositoryId: "repo-a", spaceRepositoryIds: ["repo-a", "repo-b"] };
    expect(
      automationReplacementFitsScope(
        { nodes: [{ kind: "agent.run", config: { repositoryId: "repo-b" } }] },
        { nodes: [{ kind: "agent.run", config: { repositoryId: "repo-a" } }] },
        scope,
      ),
    ).toBe(false);
  });

  it("lists only exact-repository Runs and their Approvals", () => {
    const visible = filterRunsAndApprovalsForScope(
      [
        { id: "run-a", spaceId: "space-a", repositoryId: "repo-a" },
        { id: "run-b", spaceId: "space-a", repositoryId: "repo-b" },
        { id: "run-space", spaceId: "space-a" },
        { id: "run-other", spaceId: "space-b", repositoryId: "repo-a" },
      ],
      [
        { id: "approval-a", runId: "run-a", spaceId: "space-a" },
        { id: "approval-b", runId: "run-b", spaceId: "space-a" },
        { id: "approval-space", runId: "run-space", spaceId: "space-a" },
        { id: "approval-orphan", runId: "missing", spaceId: "space-a" },
      ],
      { spaceId: "space-a", repositoryId: "repo-a" },
    );
    expect(visible.runs.map((run) => run.id)).toEqual(["run-a"]);
    expect(visible.approvals.map((approval) => approval.id)).toEqual(["approval-a"]);
  });

  it("binds child Runs to the credential Space and repository", () => {
    expect(
      resolveRunStartScope({
        scopedSpaceId: "space-a",
        scopedRepositoryId: "repo-a",
      }),
    ).toEqual({ allowed: true, spaceId: "space-a", repositoryId: "repo-a" });
    expect(
      resolveRunStartScope({
        requestedSpaceId: "space-b",
        scopedSpaceId: "space-a",
      }),
    ).toEqual({ allowed: false });
    expect(
      resolveRunStartScope({
        requestedRepositoryId: "repo-b",
        scopedSpaceId: "space-a",
        scopedRepositoryId: "repo-a",
      }),
    ).toEqual({ allowed: false });
    expect(
      resolveRunStartScope({
        requestedProjectId: "project-bypass",
        scopedSpaceId: "space-a",
        scopedRepositoryId: "repo-a",
      }),
    ).toEqual({ allowed: false });
  });
});

describe("credential-bound Memory writes", () => {
  it("allows only a server-issued remember mode to promote governed Memory", () => {
    expect(memoryWriteOperationForScope({ memoryWriteMode: "remember" })).toBe("remember");
    expect(memoryWriteOperationForScope({ memoryWriteMode: "propose" })).toBe("propose");
    expect(memoryWriteOperationForScope({})).toBe("propose");
  });
});
