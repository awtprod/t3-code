const NIGHTLY_SERVER_VERSION_PATTERN = /^[^-+]+-(?:nightly|preview)\.\d{8}\.\d+$/;

export function formatAppDisplayName(input: {
  readonly baseName: string;
  readonly stageLabel: string;
}): string {
  if (input.stageLabel.trim().toLowerCase() === "latest") {
    return input.baseName;
  }

  return `${input.baseName} (${input.stageLabel})`;
}

/**
 * Whether the sidebar v2 beta is on by default for a build stage.
 *
 * Sidebar V2 is the Command Center default on every desktop/web channel. The
 * legacy setting remains available as a one-release rollback switch.
 */
export function resolveSidebarV2Default(stageLabel: string): boolean {
  void stageLabel;
  return true;
}

/**
 * Resolved sidebar v2 state: an explicit user choice, else the build-stage default.
 * A stored `enabled: true` counts as explicit even without the companion flag
 * (`true` was never the schema default). While `settingsHydrated` is false the
 * snapshot is schema defaults, so hold v1 to avoid remounting the tree.
 */
export function resolveSidebarV2Enabled(input: {
  readonly enabled: boolean;
  readonly configuredByUser: boolean;
  readonly settingsHydrated: boolean;
  readonly stageLabel: string;
}): boolean {
  if (!input.settingsHydrated) {
    return false;
  }

  return input.configuredByUser || input.enabled
    ? input.enabled
    : resolveSidebarV2Default(input.stageLabel);
}

export function resolveServerBackedAppStageLabel(input: {
  readonly primaryServerVersion: string | null | undefined;
  readonly fallbackStageLabel: string;
}): string {
  return input.primaryServerVersion &&
    NIGHTLY_SERVER_VERSION_PATTERN.test(input.primaryServerVersion)
    ? "Nightly"
    : input.fallbackStageLabel;
}

export function resolveServerBackedAppDisplayName(input: {
  readonly baseName: string;
  readonly fallbackDisplayName: string;
  readonly fallbackStageLabel: string;
  readonly primaryServerVersion: string | null | undefined;
}): string {
  const stageLabel = resolveServerBackedAppStageLabel({
    primaryServerVersion: input.primaryServerVersion,
    fallbackStageLabel: input.fallbackStageLabel,
  });

  return stageLabel === input.fallbackStageLabel
    ? input.fallbackDisplayName
    : formatAppDisplayName({ baseName: input.baseName, stageLabel });
}
