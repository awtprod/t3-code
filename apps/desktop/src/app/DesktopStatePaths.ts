import * as Option from "effect/Option";

export type JoinPath = (first: string, ...segments: string[]) => string;

function normalizeConfiguredBaseDir(configuredHome: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(configuredHome)) {
    return Option.none();
  }
  const trimmed = configuredHome.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
  readonly commandCenterHome?: Option.Option<string> | undefined;
}): string {
  const configuredHome = Option.orElse(
    input.commandCenterHome ?? Option.none(),
    () => input.t3Home,
  );
  return Option.getOrElse(normalizeConfiguredBaseDir(configuredHome), () =>
    input.joinPath(input.homeDirectory, ".command-center"),
  );
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
  readonly commandCenterHome?: Option.Option<string> | undefined;
}): string {
  const configuredHome = Option.orElse(
    input.commandCenterHome ?? Option.none(),
    () => input.t3Home,
  );
  const useDevSubdir =
    input.isDevelopment && Option.isNone(normalizeConfiguredBaseDir(configuredHome));
  return input.joinPath(input.baseDir, useDevSubdir ? "dev" : "userdata");
}
