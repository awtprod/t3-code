import type { OrchestrationProjectShell, OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { ProjectId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  artifactDirectoryNamesForEntries,
  groupManagedWorktrees,
  threadIsBusy,
} from "./worktreeCleanup.ts";

describe("artifactDirectoryNamesForEntries", () => {
  it("only flags a build-tool directory when its marker sibling is also present", () => {
    expect(artifactDirectoryNamesForEntries(["node_modules", "package.json", "src"])).toEqual([
      "node_modules",
    ]);
  });

  it("never flags a same-named directory without its marker", () => {
    // A "build" directory with no Gradle marker is source, not an artifact —
    // this is the exact case the marker-file rule exists to protect.
    expect(artifactDirectoryNamesForEntries(["build", "src"])).toEqual([]);
    expect(artifactDirectoryNamesForEntries(["target", "src"])).toEqual([]);
  });

  it("flags every matching rule when multiple markers are present", () => {
    expect(
      artifactDirectoryNamesForEntries([
        "node_modules",
        "package.json",
        ".venv",
        "requirements.txt",
      ]),
    ).toEqual(["node_modules", ".venv"]);
  });

  it("requires only one of several accepted markers", () => {
    expect(artifactDirectoryNamesForEntries(["target", "Cargo.toml"])).toEqual(["target"]);
    expect(artifactDirectoryNamesForEntries(["vendor", "Cargo.toml"])).toEqual(["vendor"]);
    expect(artifactDirectoryNamesForEntries(["vendor", "composer.json"])).toEqual(["vendor"]);
  });

  it("returns nothing for an empty or irrelevant entry list", () => {
    expect(artifactDirectoryNamesForEntries([])).toEqual([]);
    expect(artifactDirectoryNamesForEntries(["README.md", ".git"])).toEqual([]);
  });
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const;

function makeProject(input: {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
}): OrchestrationProjectShell {
  return {
    id: ProjectId.make(input.id),
    title: input.title,
    workspaceRoot: `/workspace/${input.id}`,
    repositoryIdentity: undefined,
    defaultModelSelection: null,
    defaultThreadEnvMode: undefined,
    faviconPath: undefined,
    scripts: [],
    createdAt: input.updatedAt,
    updatedAt: input.updatedAt,
  } as unknown as OrchestrationProjectShell;
}

function makeThread(input: {
  readonly id: string;
  readonly projectId: string;
  readonly worktreePath: string | null;
  readonly updatedAt: string;
  readonly branch?: string | null;
  readonly activeRunId?: RunId | null;
  readonly pendingBackgroundTasks?: OrchestrationV2ThreadShell["pendingBackgroundTasks"];
}): OrchestrationV2ThreadShell {
  const id = ThreadId.make(input.id);
  const updatedAt = DateTime.makeUnsafe(input.updatedAt);
  return {
    id,
    projectId: ProjectId.make(input.projectId),
    title: input.id,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: input.branch ?? null,
    worktreePath: input.worktreePath,
    createdBy: "user",
    creationSource: "web",
    activeProviderThreadId: null,
    lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    latestRunId: null,
    activeRunId: input.activeRunId ?? null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: updatedAt,
    updatedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...(input.pendingBackgroundTasks === undefined
      ? {}
      : { pendingBackgroundTasks: input.pendingBackgroundTasks }),
  };
}

describe("groupManagedWorktrees", () => {
  it("groups threads sharing a worktree path under their project", () => {
    const project = makeProject({
      id: "p1",
      title: "Project One",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const threadA = makeThread({
      id: "t1",
      projectId: "p1",
      worktreePath: "/worktrees/p1/branch-a",
      updatedAt: "2026-01-01T00:00:00.000Z",
      branch: "branch-a",
    });
    const threadB = makeThread({
      id: "t2",
      projectId: "p1",
      worktreePath: "/worktrees/p1/branch-a",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });

    const groups = groupManagedWorktrees({ projects: [project], threads: [threadA, threadB] });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.path).toBe("/worktrees/p1/branch-a");
    expect(groups[0]?.threads.map((t) => t.id)).toEqual([threadA.id, threadB.id]);
    // Most-recent thread activity wins.
    expect(groups[0]?.lastUpdatedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("skips threads with no worktree path", () => {
    const project = makeProject({
      id: "p1",
      title: "Project One",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const thread = makeThread({
      id: "t1",
      projectId: "p1",
      worktreePath: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(groupManagedWorktrees({ projects: [project], threads: [thread] })).toEqual([]);
  });

  it("drops a worktree group whose project is missing from the snapshot", () => {
    const thread = makeThread({
      id: "t1",
      projectId: "missing-project",
      worktreePath: "/worktrees/orphan",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(groupManagedWorktrees({ projects: [], threads: [thread] })).toEqual([]);
  });

  it("keeps separate worktree paths as separate groups even within one project", () => {
    const project = makeProject({
      id: "p1",
      title: "Project One",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const threadA = makeThread({
      id: "t1",
      projectId: "p1",
      worktreePath: "/worktrees/p1/a",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const threadB = makeThread({
      id: "t2",
      projectId: "p1",
      worktreePath: "/worktrees/p1/b",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const groups = groupManagedWorktrees({ projects: [project], threads: [threadA, threadB] });
    expect(groups.map((g) => g.path).toSorted()).toEqual(["/worktrees/p1/a", "/worktrees/p1/b"]);
  });
});

describe("threadIsBusy", () => {
  const idle = makeThread({
    id: "t-idle",
    projectId: "p1",
    worktreePath: "/worktrees/p1/a",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  it("treats an idle V2 thread with no terminal as not busy", () => {
    expect(threadIsBusy(idle, new Set())).toBe(false);
  });

  it("treats a running terminal, an in-flight run, or background work as busy", () => {
    expect(threadIsBusy(idle, new Set([idle.id]))).toBe(true);
    expect(
      threadIsBusy(
        makeThread({
          id: "t-run",
          projectId: "p1",
          worktreePath: "/worktrees/p1/a",
          updatedAt: "2026-01-01T00:00:00.000Z",
          activeRunId: RunId.make("run-1"),
        }),
        new Set(),
      ),
    ).toBe(true);
  });
});
