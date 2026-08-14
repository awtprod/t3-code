import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  ExecutionEnvironmentPlatformOs,
  ModelSelection,
  ServerProvider,
} from "@t3tools/contracts";

import { DEFAULT_COMMAND_CENTER_MODEL } from "./CommandCenterHome.logic";

export interface CommandCenterEnvironmentCandidate {
  readonly id: EnvironmentId;
  readonly label: string;
  readonly isPrimary: boolean;
  readonly platformOs: ExecutionEnvironmentPlatformOs;
  readonly connected: boolean;
}

export type CommandCenterExecutionTarget = "server" | "desktop";

const DESKTOP_TARGET_PATTERNS = [
  /\b(?:this|my|local) (?:computer|desktop|laptop|machine|pc|windows|mac)\b/iu,
  /\bdesktop app\b/iu,
  /\b(?:windows|macos|system) (?:app|setting|service|process|log|registry)\b/iu,
  /\b(?:installed app|device manager|event viewer|task manager|system tray)\b/iu,
  /\b(?:bluetooth|webcam|microphone|speaker|printer|display|monitor|usb)\b/iu,
  /\b(?:youtube|chrome|edge|firefox|local browser|wi-?fi)\b/iu,
];

export function classifyCommandCenterExecutionTarget(text: string): CommandCenterExecutionTarget {
  return DESKTOP_TARGET_PATTERNS.some((pattern) => pattern.test(text)) ? "desktop" : "server";
}

export function resolveCommandCenterRouterEnvironmentId(input: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly environments: readonly CommandCenterEnvironmentCandidate[];
}): EnvironmentId | null {
  const remoteLinuxEnvironments = input.environments.filter(
    (environment) => !environment.isPrimary && environment.platformOs === "linux",
  );
  const remoteLinux =
    remoteLinuxEnvironments.find((environment) =>
      /openclaw|command[ -]?center/iu.test(environment.label),
    ) ?? remoteLinuxEnvironments[0];
  if (remoteLinux !== undefined) return remoteLinux.id;
  const connected = input.environments.filter((environment) => environment.connected);
  const primary = connected.find((environment) => environment.id === input.primaryEnvironmentId);
  return primary?.id ?? connected[0]?.id ?? null;
}

export function resolveDesktopExecutionEnvironment(
  environments: readonly CommandCenterEnvironmentCandidate[],
  routerEnvironmentId: EnvironmentId | null,
): CommandCenterEnvironmentCandidate | null {
  const desktop = environments.find(
    (environment) =>
      environment.connected &&
      environment.id !== routerEnvironmentId &&
      environment.isPrimary &&
      (environment.platformOs === "windows" || environment.platformOs === "darwin"),
  );
  return (
    desktop ??
    environments.find(
      (environment) =>
        environment.connected &&
        environment.id !== routerEnvironmentId &&
        (environment.platformOs === "windows" || environment.platformOs === "darwin"),
    ) ??
    null
  );
}

function normalizedRepositoryRef(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.git$/u, "")
    .replace(/\/$/u, "");
}

export function resolveDesktopWorkerProject(input: {
  readonly desktopEnvironmentId: EnvironmentId;
  readonly projects: readonly EnvironmentProject[];
  readonly selectedProject?: EnvironmentProject | undefined;
}): EnvironmentProject | null {
  const desktopProjects = input.projects.filter(
    (project) => project.environmentId === input.desktopEnvironmentId,
  );
  if (input.selectedProject !== undefined) {
    const selectedRef = input.selectedProject.repositoryIdentity?.canonicalKey;
    const match = desktopProjects.find(
      (project) =>
        project.id === input.selectedProject?.id ||
        (selectedRef !== undefined &&
          project.repositoryIdentity?.canonicalKey !== undefined &&
          normalizedRepositoryRef(project.repositoryIdentity.canonicalKey) ===
            normalizedRepositoryRef(selectedRef)),
    );
    if (match !== undefined) return match;
  }
  return (
    desktopProjects.find((project) => project.id === "command-center:system") ??
    desktopProjects.find((project) => /command[ -]?center|t3[ -]?code/iu.test(project.title)) ??
    null
  );
}

function usableProvider(provider: ServerProvider): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    provider.availability !== "unavailable" &&
    (provider.status === "ready" || provider.status === "warning")
  );
}

export function resolveDesktopWorkerModelSelection(input: {
  readonly project: EnvironmentProject;
  readonly providers: readonly ServerProvider[];
}): ModelSelection | null {
  const providers = input.providers.filter(usableProvider);
  const codex = providers.find((provider) => provider.driver === "codex");
  const terra = codex?.models.find((model) => model.slug === DEFAULT_COMMAND_CENTER_MODEL);
  if (codex !== undefined && terra !== undefined) {
    return {
      instanceId: codex.instanceId,
      model: terra.slug,
      options: [{ id: "reasoningEffort", value: "high" }],
    };
  }
  const projectDefault = input.project.defaultModelSelection;
  if (
    projectDefault !== null &&
    providers.some(
      (provider) =>
        provider.instanceId === projectDefault.instanceId &&
        provider.models.some((model) => model.slug === projectDefault.model),
    )
  ) {
    return projectDefault;
  }
  const provider = providers[0];
  const model = provider?.models[0];
  return provider === undefined || model === undefined
    ? null
    : { instanceId: provider.instanceId, model: model.slug };
}
