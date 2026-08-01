// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import type { RuntimeMode, ThreadId } from "@t3tools/contracts";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { McpProviderSessionConfig } from "../../mcp/McpProviderSession.ts";
import { KimiRuntimeError } from "../kimiRuntime.ts";
import { isSupportedKimiVersion, parseKimiVersion } from "../kimiRuntime.ts";
import { spawnAndCollect } from "../providerSnapshot.ts";

const MAX_KIMI_CONFIG_BYTES = FileSystem.Size(2 * 1024 * 1024);
const SANDBOX_HOME = "/tmp/kimi-home";
export const KIMI_SANDBOX_WORKSPACE = "/workspace";

const KIMI_AUTOMATION_TOOLS = [
  "Agent",
  "AgentSwarm",
  "TaskOutput",
  "AskUserQuestion",
  "mcp__t3-code__*",
] as const;

export interface KimiCommandCenterLaunch {
  readonly command: string;
  readonly argsPrefix: ReadonlyArray<string>;
  readonly hostHomePath: string;
  readonly daemonHomePath: string;
  readonly workspacePath: string;
  readonly environment: NodeJS.ProcessEnv;
}

function isolationError(detail: string, cause?: unknown) {
  return new KimiRuntimeError({ operation: "prepareCommandCenterIsolation", detail, cause });
}

function isWithin(path: Path.Path, candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function tomlSection(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return undefined;
  return trimmed
    .replace(/^\[\[?/u, "")
    .replace(/\]\]?$/u, "")
    .trim();
}

type RetainedKimiSection = "provider" | "model";

const PROVIDER_CONFIG_KEYS = new Set([
  "type",
  "api_key",
  "access_token",
  "token",
  "base_url",
  "endpoint",
  "organization",
  "project",
]);
const MODEL_CONFIG_KEYS = new Set(["provider", "model", "max_context_size", "context_size"]);

function retainedKimiSection(section: string): RetainedKimiSection | undefined {
  const tableName = String.raw`(?:"[^"\r\n]+"|'[^'\r\n]+'|[A-Za-z0-9_-]+)`;
  if (new RegExp(`^providers\\.${tableName}$`, "u").test(section)) return "provider";
  if (new RegExp(`^models\\.${tableName}$`, "u").test(section)) return "model";
  return undefined;
}

function safeTomlScalar(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return typeof JSON.parse(trimmed) === "string";
    } catch {
      return false;
    }
  }
  return /^'[^'\r\n]*'$/u.test(trimmed) || /^(?:true|false|[+-]?\d(?:_?\d)*)$/u.test(trimmed);
}

/** Keep only bounded scalar credentials/model aliases; executable configuration never crosses. */
export function sanitizeKimiAutomationConfig(source: string, model: string): string {
  const retained: string[] = [];
  let sectionKind: RetainedKimiSection | undefined;
  for (const line of source.split(/\r?\n/u)) {
    const section = tomlSection(line);
    if (section !== undefined) {
      sectionKind = retainedKimiSection(section);
      if (sectionKind) retained.push(line);
      continue;
    }
    if (!sectionKind || line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
    const assignment = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/u);
    if (!assignment) continue;
    const key = assignment[1]!;
    const value = assignment[2]!;
    const allowedKeys = sectionKind === "provider" ? PROVIDER_CONFIG_KEYS : MODEL_CONFIG_KEYS;
    if (allowedKeys.has(key) && safeTomlScalar(value)) retained.push(`${key} = ${value.trim()}`);
  }
  return [
    `default_model = ${JSON.stringify(model)}`,
    'default_permission_mode = "manual"',
    "default_plan_mode = false",
    "merge_all_available_skills = false",
    "telemetry = false",
    "",
    ...retained,
    "",
    "[tools]",
    `enabled = [${KIMI_AUTOMATION_TOOLS.map((tool) => JSON.stringify(tool)).join(", ")}]`,
    "",
    "[background]",
    "keep_alive_on_exit = false",
    "",
  ].join("\n");
}

function agentProfile(input: {
  readonly name: string;
  readonly description: string;
  readonly main: boolean;
}) {
  return [
    "---",
    `name: ${input.name}`,
    `description: ${input.description}`,
    "override: true",
    `tools: [${KIMI_AUTOMATION_TOOLS.map((tool) => JSON.stringify(tool)).join(", ")}]`,
    ...(input.main ? ["subagents: [coder, explore, plan]"] : ["subagents: []"]),
    "---",
    "",
    "${base_prompt}",
    "",
    input.main
      ? "Use only the T3 Code MCP workspace tools for repository access. Native filesystem, shell, terminal, web, hook, and plugin tools are unavailable."
      : "You are a subagent. Use only the T3 Code MCP workspace tools and return a self-contained result to the parent agent.",
    "",
  ].join("\n");
}

export function buildKimiAutomationBwrapArgs(input: {
  readonly executablePath: string;
  readonly hostHomePath: string;
  readonly workspacePath: string;
  readonly writable: boolean;
}): ReadonlyArray<string> {
  return [
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    "--disable-userns",
    "--die-with-parent",
    "--cap-drop",
    "ALL",
    "--hostname",
    "command-center-kimi",
    "--clearenv",
    "--setenv",
    "HOME",
    SANDBOX_HOME,
    "--setenv",
    "KIMI_CODE_HOME",
    SANDBOX_HOME,
    "--setenv",
    "PATH",
    "/usr/bin:/bin",
    "--setenv",
    "LANG",
    "C.UTF-8",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind-try",
    "/bin",
    "/bin",
    "--ro-bind-try",
    "/lib",
    "/lib",
    "--ro-bind-try",
    "/lib64",
    "/lib64",
    "--ro-bind-try",
    "/etc/ssl",
    "/etc/ssl",
    "--ro-bind-try",
    "/etc/resolv.conf",
    "/etc/resolv.conf",
    "--ro-bind-try",
    "/etc/hosts",
    "/etc/hosts",
    "--ro-bind",
    input.executablePath,
    "/command",
    "--bind",
    input.hostHomePath,
    SANDBOX_HOME,
    input.writable ? "--bind" : "--ro-bind",
    input.workspacePath,
    KIMI_SANDBOX_WORKSPACE,
    "--dir",
    `${KIMI_SANDBOX_WORKSPACE}/.kimi-code`,
    "--tmpfs",
    `${KIMI_SANDBOX_WORKSPACE}/.kimi-code`,
    "--dir",
    `${KIMI_SANDBOX_WORKSPACE}/.agents`,
    "--tmpfs",
    `${KIMI_SANDBOX_WORKSPACE}/.agents`,
    "--dir",
    `${SANDBOX_HOME}/plugins`,
    "--tmpfs",
    `${SANDBOX_HOME}/plugins`,
    "--dir",
    `${SANDBOX_HOME}/hooks`,
    "--tmpfs",
    `${SANDBOX_HOME}/hooks`,
    "--dir",
    `${SANDBOX_HOME}/skills`,
    "--tmpfs",
    `${SANDBOX_HOME}/skills`,
    "--dir",
    `${SANDBOX_HOME}/.agents`,
    "--tmpfs",
    `${SANDBOX_HOME}/.agents`,
    "--chdir",
    KIMI_SANDBOX_WORKSPACE,
    "--",
    "/command",
  ];
}

export const prepareKimiCommandCenterLaunch = Effect.fn("prepareKimiCommandCenterLaunch")(
  function* (input: {
    readonly binaryPath: string;
    readonly sourceHomePath: string;
    readonly stateDir: string;
    readonly threadId: ThreadId;
    readonly runtimeMode: RuntimeMode;
    readonly cwd: string;
    readonly model: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly mcp: McpProviderSessionConfig;
  }) {
    if (NodeProcess.platform !== "linux") {
      return yield* isolationError("Kimi Command Center isolation is supported only on Linux.");
    }
    if (input.runtimeMode === "full-access") {
      return yield* isolationError("Kimi Command Center runs cannot use full-access mode.");
    }
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const executable = yield* resolveCommandPath(input.binaryPath, {
      env: input.environment,
      extendEnv: false,
    }).pipe(
      Effect.flatMap(fileSystem.realPath),
      Effect.mapError((cause) => isolationError("Could not resolve the Kimi executable.", cause)),
    );
    const executableInfo = yield* fileSystem
      .stat(executable)
      .pipe(
        Effect.mapError((cause) => isolationError("Could not inspect the Kimi executable.", cause)),
      );
    if (
      executableInfo.type !== "File" ||
      (executableInfo.mode & 0o111) === 0 ||
      (executableInfo.mode & 0o022) !== 0 ||
      Option.getOrElse(executableInfo.nlink, () => 1) !== 1
    ) {
      return yield* isolationError(
        "Kimi automations require a single-link regular executable that is not group- or world-writable.",
      );
    }
    const header = yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem.open(executable, { flag: "r" });
        return yield* file.readAlloc(4);
      }),
    ).pipe(
      Effect.mapError((cause) =>
        isolationError("Could not inspect the Kimi executable format.", cause),
      ),
    );
    if (
      Option.isNone(header) ||
      header.value[0] !== 0x7f ||
      header.value[1] !== 0x45 ||
      header.value[2] !== 0x4c ||
      header.value[3] !== 0x46
    ) {
      return yield* isolationError(
        "Kimi automations require an immutable native ELF executable; npm and script launchers are interactive-only.",
      );
    }
    const versionOutput = yield* spawnAndCollect(
      executable,
      ChildProcess.make(executable, ["--version"], { env: input.environment }),
    ).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.scoped,
      Effect.mapError((cause) => isolationError("Could not verify the Kimi version.", cause)),
    );
    const version = parseKimiVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
    if (version === null || !isSupportedKimiVersion(version)) {
      return yield* isolationError("Kimi automations require Kimi Code 0.31.1 or newer.");
    }
    const workspacePath = yield* fileSystem
      .realPath(input.cwd)
      .pipe(
        Effect.mapError((cause) =>
          isolationError("Could not canonicalize the managed workspace.", cause),
        ),
      );
    const stateDir = yield* fileSystem
      .realPath(input.stateDir)
      .pipe(
        Effect.mapError((cause) => isolationError("Could not canonicalize runtime state.", cause)),
      );
    if (isWithin(path, executable, workspacePath) || isWithin(path, executable, stateDir)) {
      return yield* isolationError("The Kimi executable must be outside provider-writable roots.");
    }
    const bwrap = yield* fileSystem
      .realPath("/usr/bin/bwrap")
      .pipe(
        Effect.mapError((cause) =>
          isolationError("Bubblewrap is required for Kimi automations.", cause),
        ),
      );
    if (bwrap !== "/usr/bin/bwrap") {
      return yield* isolationError("Kimi automations require canonical /usr/bin/bwrap.");
    }
    const bwrapInfo = yield* fileSystem
      .stat(bwrap)
      .pipe(Effect.mapError((cause) => isolationError("Could not inspect Bubblewrap.", cause)));
    if (bwrapInfo.type !== "File" || (bwrapInfo.mode & 0o022) !== 0) {
      return yield* isolationError("Kimi automations require an immutable Bubblewrap executable.");
    }
    const digest = Encoding.encodeHex(
      yield* crypto
        .digest("SHA-256", new TextEncoder().encode(String(input.threadId)))
        .pipe(
          Effect.mapError((cause) =>
            isolationError("Could not derive the private Kimi home.", cause),
          ),
        ),
    );
    const homesRoot = NodePath.join(stateDir, "provider-homes", "kimi-command-center");
    const hostHomePath = NodePath.join(homesRoot, digest);
    const agentsPath = NodePath.join(hostHomePath, "agents");
    yield* Effect.forEach(
      [homesRoot, hostHomePath, agentsPath],
      (directory) =>
        fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 }).pipe(
          Effect.andThen(fileSystem.chmod(directory, 0o700)),
          Effect.mapError((cause) =>
            isolationError("Could not create the private Kimi home.", cause),
          ),
        ),
      { concurrency: 1, discard: true },
    );
    const canonicalHome = yield* fileSystem
      .realPath(hostHomePath)
      .pipe(
        Effect.mapError((cause) =>
          isolationError("Could not verify the private Kimi home.", cause),
        ),
      );
    if (canonicalHome !== hostHomePath || !isWithin(path, canonicalHome, homesRoot)) {
      return yield* isolationError("The private Kimi home contains a symlink escape.");
    }
    const canonicalSourceHome = yield* fileSystem
      .realPath(input.sourceHomePath)
      .pipe(
        Effect.mapError((cause) => isolationError("Could not verify the Kimi source home.", cause)),
      );
    const sourceConfigPath = NodePath.join(canonicalSourceHome, "config.toml");
    const canonicalSourceConfig = yield* fileSystem
      .realPath(sourceConfigPath)
      .pipe(
        Effect.mapError((cause) =>
          isolationError("Kimi authentication config is unavailable.", cause),
        ),
      );
    if (!isWithin(path, canonicalSourceConfig, canonicalSourceHome)) {
      return yield* isolationError("Kimi authentication config contains a symlink escape.");
    }
    const sourceConfigInfo = yield* fileSystem
      .stat(sourceConfigPath)
      .pipe(
        Effect.mapError((cause) =>
          isolationError("Kimi authentication config is unavailable.", cause),
        ),
      );
    if (sourceConfigInfo.type !== "File" || sourceConfigInfo.size > MAX_KIMI_CONFIG_BYTES) {
      return yield* isolationError("Kimi authentication config must be a bounded regular file.");
    }
    const sourceConfig = yield* fileSystem
      .readFileString(sourceConfigPath)
      .pipe(
        Effect.mapError((cause) =>
          isolationError("Could not read Kimi authentication config.", cause),
        ),
      );
    const writePrivate = (target: string, contents: string) =>
      fileSystem.writeFileString(target, contents, { mode: 0o600 }).pipe(
        Effect.andThen(fileSystem.chmod(target, 0o600)),
        Effect.mapError((cause) =>
          isolationError("Could not write isolated Kimi configuration.", cause),
        ),
      );
    yield* writePrivate(
      NodePath.join(hostHomePath, "config.toml"),
      sanitizeKimiAutomationConfig(sourceConfig, input.model),
    );
    yield* writePrivate(
      NodePath.join(hostHomePath, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          "t3-code": {
            url: input.mcp.endpoint,
            headers: { Authorization: input.mcp.authorizationHeader },
          },
        },
      }),
    );
    yield* Effect.forEach(
      [
        { name: "agent", description: "T3 Code managed main agent", main: true },
        { name: "coder", description: "T3 Code managed coding subagent", main: false },
        { name: "explore", description: "T3 Code managed exploration subagent", main: false },
        { name: "plan", description: "T3 Code managed planning subagent", main: false },
      ],
      (profile) =>
        writePrivate(NodePath.join(agentsPath, `${profile.name}.md`), agentProfile(profile)),
      {
        concurrency: 1,
        discard: true,
      },
    );
    if (!/^Bearer\s+\S+/iu.test(input.mcp.authorizationHeader)) {
      return yield* isolationError("The scoped T3 MCP credential is unavailable.");
    }
    return {
      command: bwrap,
      argsPrefix: buildKimiAutomationBwrapArgs({
        executablePath: executable,
        hostHomePath,
        workspacePath,
        writable: input.runtimeMode === "auto" || input.runtimeMode === "auto-accept-edits",
      }),
      hostHomePath,
      daemonHomePath: SANDBOX_HOME,
      workspacePath: KIMI_SANDBOX_WORKSPACE,
      environment: input.environment,
    } satisfies KimiCommandCenterLaunch;
  },
);
