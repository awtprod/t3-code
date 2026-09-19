import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

export const T3CODE_CODEX_LAUNCH_ARGS_ENV = "T3CODE_CODEX_LAUNCH_ARGS";

export const CODEX_REQUEST_USER_INPUT_FEATURE = "default_mode_request_user_input";

/**
 * Command Center implements the `item/tool/requestUserInput` protocol end to
 * end (adapter, orchestrator, and the input-required composer panel), so the
 * tool just needs to exist in Codex's default mode. Codex still ships the
 * feature off by default; without it, default-mode threads have no way to
 * surface questions and the model falls back to plain-text questions the
 * input-required screen never sees while the turn keeps running. An explicit
 * launch-args mention of the feature (`--enable`, `--disable`, or
 * `features.<name>`) wins over this default.
 */
export const codexRequestUserInputFeatureArgs = (launchArgs?: string): ReadonlyArray<string> =>
  launchArgs?.includes(CODEX_REQUEST_USER_INPUT_FEATURE)
    ? []
    : ["-c", `features.${CODEX_REQUEST_USER_INPUT_FEATURE}=true`];

export const resolveCodexLaunchArgs = (
  launchArgs?: string,
  environment: NodeJS.ProcessEnv = process.env,
) => environment[T3CODE_CODEX_LAUNCH_ARGS_ENV]?.trim() || launchArgs?.trim() || "";

export const codexLaunchArgv = (launchArgs?: string): ReadonlyArray<string> =>
  tokenizeCliArgs(launchArgs);

export const codexAppServerArgs = (launchArgs?: string) => [
  "app-server",
  ...codexLaunchArgv(launchArgs),
  ...codexRequestUserInputFeatureArgs(launchArgs),
];

export const codexExecLaunchArgs = (launchArgs?: string) => {
  const args = codexLaunchArgv(launchArgs);
  const execArgs: Array<string> = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === "--strict-config" || arg.startsWith("--config=") || arg.startsWith("-c=")) {
      execArgs.push(arg);
    } else if (arg === "--config" || arg === "-c" || arg === "--enable" || arg === "--disable") {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        execArgs.push(arg, value);
        index++;
      }
    } else if (arg.startsWith("--enable=") || arg.startsWith("--disable=")) {
      execArgs.push(arg);
    }
  }

  return execArgs;
};

export const codexSessionAppServerArgs = (
  appServerArgs: ReadonlyArray<string> | undefined,
  launchArgs: string | undefined,
) => {
  const launchAppServerArgs = codexAppServerArgs(launchArgs);
  return appServerArgs ? [...launchAppServerArgs, ...appServerArgs] : launchAppServerArgs;
};
