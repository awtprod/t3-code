import { EnvironmentId, type ServerProvider } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { describe, expect, it } from "vite-plus/test";

import {
  classifyCommandCenterExecutionTarget,
  resolveCommandCenterRouterEnvironmentId,
  resolveDesktopExecutionEnvironment,
  resolveDesktopWorkerModelSelection,
  resolveDesktopWorkerProject,
} from "./CommandCenterExecution.logic";

const serverId = EnvironmentId.make("openclaw");
const desktopId = EnvironmentId.make("desktop");
const environments = [
  {
    id: desktopId,
    label: "Desktop",
    isPrimary: true,
    platformOs: "windows" as const,
    connected: true,
  },
  {
    id: serverId,
    label: "OpenClaw",
    isPrimary: false,
    platformOs: "linux" as const,
    connected: true,
  },
];

describe("Command Center execution targeting", () => {
  it("keeps ordinary work on OpenClaw and routes machine-specific work to the desktop", () => {
    expect(classifyCommandCenterExecutionTarget("Create a coding project for the API")).toBe(
      "server",
    );
    expect(
      classifyCommandCenterExecutionTarget("Troubleshoot the desktop app on my computer"),
    ).toBe("desktop");
    expect(
      resolveCommandCenterRouterEnvironmentId({ primaryEnvironmentId: desktopId, environments }),
    ).toBe(serverId);
    expect(resolveDesktopExecutionEnvironment(environments, serverId)?.id).toBe(desktopId);
  });

  it("keeps OpenClaw pinned while disconnected instead of silently running server work locally", () => {
    expect(
      resolveCommandCenterRouterEnvironmentId({
        primaryEnvironmentId: desktopId,
        environments: environments.map((environment) =>
          environment.id === serverId ? { ...environment, connected: false } : environment,
        ),
      }),
    ).toBe(serverId);
    expect(
      resolveCommandCenterRouterEnvironmentId({
        primaryEnvironmentId: desktopId,
        environments: [environments[0]!],
      }),
    ).toBe(desktopId);
  });

  it("matches the same repository on the desktop and defaults its worker to Terra high", () => {
    const serverProject = {
      id: "server-project",
      environmentId: serverId,
      title: "Command Center",
      repositoryIdentity: { canonicalKey: "awtprod/t3-code.git" },
    } as unknown as EnvironmentProject;
    const desktopProject = {
      id: "desktop-project",
      environmentId: desktopId,
      title: "Command Center",
      defaultModelSelection: null,
      repositoryIdentity: { canonicalKey: "awtprod/t3-code" },
    } as unknown as EnvironmentProject;
    const provider = {
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      availability: "available",
      status: "ready",
      models: [{ slug: "gpt-5.6-terra", name: "GPT-5.6 Terra" }],
    } as unknown as ServerProvider;

    const project = resolveDesktopWorkerProject({
      desktopEnvironmentId: desktopId,
      projects: [serverProject, desktopProject],
      selectedProject: serverProject,
    });

    expect(project?.id).toBe("desktop-project");
    expect(
      resolveDesktopWorkerModelSelection({ project: project!, providers: [provider] }),
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.6-terra",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
  });
});
