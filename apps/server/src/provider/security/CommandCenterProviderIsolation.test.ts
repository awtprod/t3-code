import * as NodeAssert from "node:assert/strict";
import * as NodeProcess from "node:process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  COMMAND_CENTER_CODEX_READ_PERMISSION_PROFILE,
  COMMAND_CENTER_CODEX_WRITE_PERMISSION_PROFILE,
  commandCenterExecutionClass,
  commandCenterCodexIsolation,
  commandCenterProviderEnvironment,
  commandCenterProviderIsolationIssue,
  commandCenterProviderPlatformIssue,
  isCommandCenterThreadId,
  prepareCommandCenterCodexHome,
  resolveCommandCenterCodexRuntimeExecutable,
  resolveCommandCenterManagedGitMetadata,
} from "./CommandCenterProviderIsolation.ts";

describe("CommandCenterProviderIsolation", () => {
  it("recognizes only durable Command Center thread ids", () => {
    NodeAssert.equal(isCommandCenterThreadId("cc:run-1"), true);
    NodeAssert.equal(isCommandCenterThreadId("thread-1"), false);
  });

  it("admits native interactive chats while keeping unattended runs Linux-only", () => {
    NodeAssert.equal(commandCenterExecutionClass("cc:interactive:run-1"), "interactive");
    NodeAssert.equal(commandCenterExecutionClass("cc:automation:run-1"), "automation");
    NodeAssert.equal(commandCenterExecutionClass("cc:run-1"), "legacy");
    NodeAssert.equal(commandCenterExecutionClass("thread-1"), undefined);

    NodeAssert.equal(commandCenterProviderPlatformIssue("linux", "cc:run-1"), undefined);
    NodeAssert.equal(
      commandCenterProviderPlatformIssue("darwin", "cc:interactive:run-1"),
      undefined,
    );
    NodeAssert.equal(
      commandCenterProviderPlatformIssue("win32", "cc:interactive:run-1"),
      undefined,
    );
    NodeAssert.match(
      commandCenterProviderPlatformIssue("darwin", "cc:automation:run-1") ?? "",
      /requires a verified Linux host/u,
    );
    NodeAssert.match(
      commandCenterProviderPlatformIssue("win32", "cc:run-1") ?? "",
      /requires a verified Linux host/u,
    );
  });

  it("fails closed for unverified providers and full-access sessions", () => {
    NodeAssert.match(
      commandCenterProviderIsolationIssue({
        threadId: "cc:run-1",
        provider: "claude-code",
        runtimeMode: "approval-required",
      }) ?? "",
      /require Codex or a verified native Kimi provider/u,
    );
    NodeAssert.match(
      commandCenterProviderIsolationIssue({
        threadId: "cc:run-1",
        provider: "codex",
        runtimeMode: "full-access",
      }) ?? "",
      /cannot use full-access/u,
    );
    NodeAssert.equal(
      commandCenterProviderIsolationIssue({
        threadId: "thread-1",
        provider: "claude-code",
        runtimeMode: "full-access",
      }),
      undefined,
    );
    NodeAssert.equal(
      commandCenterProviderIsolationIssue({
        threadId: "cc:run-1",
        provider: "kimi",
        runtimeMode: "approval-required",
      }),
      undefined,
    );
    NodeAssert.equal(
      commandCenterProviderIsolationIssue({
        threadId: "cc:run-1",
        provider: "codex",
        runtimeMode: "approval-required",
      }),
      undefined,
    );
  });

  it("builds deny-by-default read and write profiles with tool network disabled", () => {
    const codexHome = {
      homePath: "/runtime/provider-homes/codex",
      helperBinPath: "/runtime/provider-homes/codex/provider-bin",
    };
    const read = commandCenterCodexIsolation(
      "approval-required",
      undefined,
      "/runtime/codex",
      codexHome,
    );
    const write = commandCenterCodexIsolation(
      "auto-accept-edits",
      undefined,
      "/runtime/codex",
      codexHome,
    );
    NodeAssert.ok(read);
    NodeAssert.ok(write);
    const auto = commandCenterCodexIsolation("auto", undefined, "/runtime/codex", codexHome);
    const windowsElevated = commandCenterCodexIsolation(
      "approval-required",
      undefined,
      "C:\\runtime\\codex.exe",
      codexHome,
      "win32",
    );
    NodeAssert.ok(auto);
    NodeAssert.ok(windowsElevated);

    NodeAssert.equal(read.permissionProfile, COMMAND_CENTER_CODEX_READ_PERMISSION_PROFILE);
    NodeAssert.equal(write.permissionProfile, COMMAND_CENTER_CODEX_WRITE_PERMISSION_PROFILE);
    NodeAssert.equal(auto.permissionProfile, COMMAND_CENTER_CODEX_WRITE_PERMISSION_PROFILE);

    const readConfig = read.appServerArgs.join(" ");
    NodeAssert.match(readConfig, /--strict-config/u);
    NodeAssert.match(readConfig, /default_permissions="command-center-isolated-read-v1"/u);
    NodeAssert.match(readConfig, /":root"="deny"/u);
    NodeAssert.match(readConfig, /":minimal"="read"/u);
    NodeAssert.match(readConfig, /":workspace_roots"=\{"\."="read"\}/u);
    NodeAssert.match(readConfig, /\/provider-homes\/codex"="deny"/u);
    NodeAssert.match(readConfig, /\/provider-homes\/codex\/provider-bin"="read"/u);
    NodeAssert.match(readConfig, /network=\{enabled=false\}/u);
    NodeAssert.match(readConfig, /mcp_servers=\{\}/u);
    NodeAssert.match(readConfig, /hooks=\{\}/u);
    NodeAssert.match(readConfig, /plugins=\{\}/u);
    NodeAssert.match(readConfig, /marketplaces=\{\}/u);
    NodeAssert.match(readConfig, /notify=\[\]/u);
    NodeAssert.match(readConfig, /shell_environment_policy=/u);
    NodeAssert.match(readConfig, /include_only=/u);
    NodeAssert.match(readConfig, /GIT_OPTIONAL_LOCKS="0"/u);
    NodeAssert.doesNotMatch(readConfig, /OPENAI_API_KEY/u);
    NodeAssert.match(readConfig, /--disable apps/u);
    NodeAssert.match(readConfig, /--disable hooks/u);
    NodeAssert.match(readConfig, /--disable browser_use/u);

    const writeConfig = write.appServerArgs.join(" ");
    NodeAssert.match(writeConfig, /default_permissions="command-center-isolated-write-v1"/u);
    NodeAssert.match(writeConfig, /":workspace_roots"=\{"\."="write"\}/u);
    NodeAssert.doesNotMatch(writeConfig, /network=\{enabled=true\}/u);
    NodeAssert.match(windowsElevated.appServerArgs.join(" "), /windows\.sandbox="elevated"/u);
    NodeAssert.doesNotMatch(windowsElevated.appServerArgs.join(" "), /unelevated/u);
  });

  it.runIf(NodeProcess.platform === "linux")(
    "passes only allowlisted launch state and the scoped MCP credential to the parent",
    () => {
      const environment = commandCenterProviderEnvironment({
        source: {
          PATH: "./node_modules/.bin::/workspace/node_modules/.bin:/usr/bin",
          SHELL: "/bin/sh",
          LANG: "C.UTF-8",
          OPENAI_API_KEY: "test-openai-key",
          CC_PROVIDER_ISOLATION_SENTINEL: "caller-must-not-control-this",
          GENERIC_BUSINESS_SECRET: "must-not-pass",
          GITHUB_TOKEN: "must-not-pass",
          SSH_AUTH_SOCK: "/private/agent.sock",
          HTTP_PROXY: "http://proxy.invalid",
          HTTPS_PROXY: "http://proxy.invalid",
          ALL_PROXY: "socks5://proxy.invalid",
          NO_PROXY: "internal.invalid",
          OPENAI_BASE_URL: "https://untrusted.invalid",
          NODE_EXTRA_CA_CERTS: "/private/ca.pem",
        },
        homePath: "/runtime/codex-home",
        helperBinPath: "/runtime/codex-home/provider-bin",
        tempPath: "/runtime/codex-home/tmp",
        xdgConfigPath: "/runtime/codex-home/xdg-config",
        xdgCachePath: "/runtime/codex-home/xdg-cache",
        xdgDataPath: "/runtime/codex-home/xdg-data",
        appDataPath: "/runtime/codex-home/app-data",
        localAppDataPath: "/runtime/codex-home/local-app-data",
        writableRoots: ["/workspace"],
        mcpBearerToken: "scoped-mcp-token",
      });

      NodeAssert.equal(environment.PATH, "/runtime/codex-home/provider-bin:/usr/bin");
      NodeAssert.equal(environment.CODEX_HOME, "/runtime/codex-home");
      NodeAssert.equal(environment.HOME, "/runtime/codex-home");
      NodeAssert.equal(environment.GIT_OPTIONAL_LOCKS, "0");
      NodeAssert.equal(environment.T3_MCP_BEARER_TOKEN, "scoped-mcp-token");
      for (const blocked of [
        "OPENAI_API_KEY",
        "CC_PROVIDER_ISOLATION_SENTINEL",
        "GENERIC_BUSINESS_SECRET",
        "GITHUB_TOKEN",
        "SSH_AUTH_SOCK",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "OPENAI_BASE_URL",
        "NODE_EXTRA_CA_CERTS",
      ]) {
        NodeAssert.equal(blocked in environment, false, `${blocked} must not pass to Codex`);
      }
    },
  );

  it.runIf(NodeProcess.platform === "linux")(
    "does not re-enable cwd lookup when every inherited PATH entry is rejected",
    () => {
      const environment = commandCenterProviderEnvironment({
        source: { PATH: "./node_modules/.bin::/workspace/node_modules/.bin" },
        homePath: "/runtime/codex-home",
        helperBinPath: "/runtime/codex-home/provider-bin",
        tempPath: "/runtime/codex-home/tmp",
        xdgConfigPath: "/runtime/codex-home/xdg-config",
        xdgCachePath: "/runtime/codex-home/xdg-cache",
        xdgDataPath: "/runtime/codex-home/xdg-data",
        appDataPath: "/runtime/codex-home/app-data",
        localAppDataPath: "/runtime/codex-home/local-app-data",
        writableRoots: ["/workspace"],
      });

      NodeAssert.equal(environment.PATH, "/runtime/codex-home/provider-bin");
      NodeAssert.equal(environment.PATH?.includes("::"), false);
      NodeAssert.equal(environment.PATH?.endsWith(":"), false);
    },
  );
});

it.layer(NodeServices.layer)("CommandCenter provider runtime isolation", (it) => {
  const writeFile = Effect.fn("CommandCenterProviderIsolation.test.writeFile")(function* (
    filePath: string,
    contents: string,
  ) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fileSystem.writeFileString(filePath, contents);
  });

  const makeLayout = Effect.fn("CommandCenterProviderIsolation.test.makeLayout")(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const temporaryBaseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "cc-isolation-",
    });
    const baseDir = yield* fileSystem.realPath(temporaryBaseDir);
    const worktreesDir = path.join(baseDir, "worktrees");
    const repositoriesDir = path.join(baseDir, "repositories");
    yield* fileSystem.makeDirectory(worktreesDir, { recursive: true });
    yield* fileSystem.makeDirectory(repositoriesDir, { recursive: true });
    return { baseDir, worktreesDir, repositoriesDir } as const;
  });

  it.effect("copies only auth.json into a private per-thread Codex home", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cc-codex-home-" });
      const stateDir = path.join(root, "state");
      const sourceHomePath = path.join(root, "source-home");
      yield* fileSystem.makeDirectory(stateDir, { recursive: true });
      yield* fileSystem.makeDirectory(sourceHomePath, { recursive: true });
      yield* writeFile(path.join(sourceHomePath, "auth.json"), '{"token":"test-only"}\n');
      yield* writeFile(path.join(sourceHomePath, "config.toml"), 'model = "ambient"\n');
      yield* writeFile(path.join(sourceHomePath, "plugins", "ambient", "plugin.json"), "{}\n");
      yield* writeFile(path.join(sourceHomePath, "skills", "ambient", "SKILL.md"), "ambient\n");
      yield* writeFile(path.join(sourceHomePath, "sessions", "ambient.jsonl"), "ambient\n");

      const isolated = yield* prepareCommandCenterCodexHome({
        stateDir,
        sourceHomePath,
        threadId: "cc:thread-home-test",
        fileSystem,
        path,
        crypto,
        runtimeExecutablePath: NodeProcess.execPath,
        platform: NodeProcess.platform,
        writableRoots: [root],
      });
      const targetAuthPath = path.join(isolated.homePath, "auth.json");
      const arg0BlockerPath = path.join(isolated.tempPath, "arg0");
      NodeAssert.equal(yield* fileSystem.readFileString(targetAuthPath), '{"token":"test-only"}\n');
      const aliases =
        NodeProcess.platform === "win32"
          ? ["apply_patch.bat", "applypatch.bat"]
          : NodeProcess.platform === "darwin"
            ? ["apply_patch", "applypatch", "codex-execve-wrapper"]
            : ["codex-linux-sandbox", "apply_patch", "applypatch", "codex-execve-wrapper"];
      for (const alias of aliases) {
        const helperPath = path.join(isolated.helperBinPath, alias);
        const helper = yield* fileSystem.readFileString(helperPath);
        if (NodeProcess.platform === "win32") {
          NodeAssert.match(helper, /--codex-run-as-apply-patch/u);
        } else {
          NodeAssert.match(helper, /exec \/usr\/bin\/env -i/u);
          NodeAssert.equal(helper.includes(`exec -a ${alias}`), true);
        }
        NodeAssert.doesNotMatch(helper, /T3_MCP_BEARER_TOKEN|OPENAI_API_KEY/u);
        if (NodeProcess.platform !== "win32") {
          NodeAssert.equal((yield* fileSystem.stat(helperPath)).mode & 0o777, 0o500);
        }
      }
      NodeAssert.equal(
        yield* fileSystem.exists(path.join(isolated.homePath, "config.toml")),
        false,
      );
      NodeAssert.equal(yield* fileSystem.exists(path.join(isolated.homePath, "plugins")), false);
      NodeAssert.equal(yield* fileSystem.exists(path.join(isolated.homePath, "skills")), false);
      NodeAssert.equal(yield* fileSystem.exists(path.join(isolated.homePath, "sessions")), false);
      NodeAssert.equal(
        (yield* fileSystem.readDirectory(isolated.homePath)).some(
          (entry) => entry.startsWith(".auth-") && entry.endsWith(".tmp"),
        ),
        false,
      );
      NodeAssert.ok(Option.isNone(yield* fileSystem.readLink(targetAuthPath).pipe(Effect.option)));
      if (NodeProcess.platform !== "win32") {
        NodeAssert.equal((yield* fileSystem.stat(targetAuthPath)).mode & 0o777, 0o600);
        NodeAssert.equal((yield* fileSystem.stat(isolated.homePath)).mode & 0o777, 0o700);
        NodeAssert.equal((yield* fileSystem.stat(arg0BlockerPath)).mode & 0o777, 0o000);
      }
    }),
  );

  it.effect("fails closed if an isolated Codex home gains ambient config", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cc-codex-home-taint-" });
      const stateDir = path.join(root, "state");
      const sourceHomePath = path.join(root, "source-home");
      yield* fileSystem.makeDirectory(stateDir, { recursive: true });
      yield* fileSystem.makeDirectory(sourceHomePath, { recursive: true });
      const input = {
        stateDir,
        sourceHomePath,
        threadId: "cc:thread-tainted-home",
        fileSystem,
        path,
        crypto,
        runtimeExecutablePath: NodeProcess.execPath,
        platform: NodeProcess.platform,
        writableRoots: [root],
      } as const;
      const isolated = yield* prepareCommandCenterCodexHome(input);
      yield* writeFile(path.join(isolated.homePath, "config.toml"), "[mcp_servers.ambient]\n");

      const error = yield* prepareCommandCenterCodexHome(input).pipe(Effect.flip);
      NodeAssert.match(error.issue, /refuses an isolated Codex home containing 'config\.toml'/u);
    }),
  );

  it.effect("reuses an isolated Codex home that Codex repopulated with a plugin cache", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cc-codex-home-reuse-" });
      const stateDir = path.join(root, "state");
      const sourceHomePath = path.join(root, "source-home");
      yield* fileSystem.makeDirectory(stateDir, { recursive: true });
      yield* fileSystem.makeDirectory(sourceHomePath, { recursive: true });
      const input = {
        stateDir,
        sourceHomePath,
        threadId: "cc:thread-reused-home",
        fileSystem,
        path,
        crypto,
        runtimeExecutablePath: NodeProcess.execPath,
        platform: NodeProcess.platform,
        writableRoots: [root],
      } as const;
      const isolated = yield* prepareCommandCenterCodexHome(input);
      // Codex 0.144.x syncs a curated-plugin cache (with MCP defs) into CODEX_HOME
      // on startup, so a reused per-thread home always contains `plugins/` (and can
      // contain `marketplaces/`) on the next session. These must be tolerated —
      // loading is disabled by the isolation appServerArgs + sandbox.
      yield* writeFile(
        path.join(isolated.homePath, "plugins", "cache", "openai-curated-remote", "x", ".mcp.json"),
        '{"mcpServers":{}}\n',
      );
      yield* writeFile(path.join(isolated.homePath, "marketplaces", "openai-curated.json"), "{}\n");

      const reused = yield* prepareCommandCenterCodexHome(input);
      NodeAssert.equal(reused.homePath, isolated.homePath);

      // config.toml still fails closed even alongside the tolerated plugin cache.
      yield* writeFile(path.join(isolated.homePath, "config.toml"), "[mcp_servers.ambient]\n");
      const error = yield* prepareCommandCenterCodexHome(input).pipe(Effect.flip);
      NodeAssert.match(error.issue, /refuses an isolated Codex home containing 'config\.toml'/u);
    }),
  );

  it.effect("rejects script launchers and runtimes under provider-writable roots", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cc-codex-runtime-" });
      const stateDir = path.join(root, "state");
      const sourceHomePath = path.join(root, "source-home");
      const scriptPath = path.join(root, "codex-script");
      yield* fileSystem.makeDirectory(stateDir, { recursive: true });
      yield* fileSystem.makeDirectory(sourceHomePath, { recursive: true });
      yield* fileSystem.writeFileString(scriptPath, "#!/usr/bin/env node\n");
      yield* fileSystem.chmod(scriptPath, 0o700);

      const scriptError = yield* prepareCommandCenterCodexHome({
        stateDir,
        sourceHomePath,
        threadId: "cc:script-runtime",
        fileSystem,
        path,
        crypto,
        runtimeExecutablePath: scriptPath,
        platform: NodeProcess.platform,
        writableRoots: [],
      }).pipe(Effect.flip);
      NodeAssert.match(scriptError.issue, /requires a native Codex runtime/u);

      const writableRuntimeError = yield* prepareCommandCenterCodexHome({
        stateDir,
        sourceHomePath,
        threadId: "cc:writable-runtime",
        fileSystem,
        path,
        crypto,
        runtimeExecutablePath: NodeProcess.execPath,
        platform: NodeProcess.platform,
        writableRoots: [path.dirname(NodeProcess.execPath)],
      }).pipe(Effect.flip);
      NodeAssert.match(
        writableRuntimeError.issue,
        /runtime located under a provider-writable root/u,
      );
    }),
  );

  it.effect("shares only Windows sandbox control state while keeping thread state separate", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cc-windows-home-" });
      const stateDir = path.join(root, "state");
      const sourceHomePath = path.join(root, "source-home");
      const runtimePath = path.join(root, "codex.exe");
      yield* fileSystem.makeDirectory(stateDir, { recursive: true });
      yield* fileSystem.makeDirectory(sourceHomePath, { recursive: true });
      yield* fileSystem.writeFile(runtimePath, Uint8Array.from([0x4d, 0x5a, 0x00, 0x00]));

      const makeHome = (threadId: string) =>
        prepareCommandCenterCodexHome({
          stateDir,
          sourceHomePath,
          threadId,
          fileSystem,
          path,
          crypto,
          runtimeExecutablePath: runtimePath,
          platform: "win32",
          writableRoots: [],
        });
      const first = yield* makeHome("cc:interactive:first");
      const second = yield* makeHome("cc:interactive:second");

      NodeAssert.equal(first.homePath, second.homePath);
      NodeAssert.notEqual(first.tempPath, second.tempPath);
      NodeAssert.match(
        yield* fileSystem.readFileString(path.join(first.helperBinPath, "apply_patch.bat")),
        /--codex-run-as-apply-patch/u,
      );
    }),
  );

  it.effect("resolves current and legacy native executables behind a Windows npm launcher", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cc-windows-runtime-" });
      const commandPath = path.join(root, "codex.cmd");
      const packageRoot = path.join(root, "node_modules", "@openai", "codex");
      const platformPackageRoot = path.join(
        packageRoot,
        "node_modules",
        "@openai",
        "codex-win32-x64",
      );
      const platformVendorRoot = path.join(platformPackageRoot, "vendor", "x86_64-pc-windows-msvc");
      const currentNativePath = path.join(platformVendorRoot, "bin", "codex.exe");
      const legacyNativePath = path.join(platformVendorRoot, "codex", "codex.exe");
      yield* writeFile(commandPath, "@echo off\r\n");
      yield* writeFile(path.join(packageRoot, "bin", "codex.js"), "// launcher\n");
      yield* writeFile(
        path.join(platformPackageRoot, "package.json"),
        '{"name":"@openai/codex-win32-x64","version":"0.0.0"}\n',
      );
      yield* fileSystem.makeDirectory(path.dirname(currentNativePath), { recursive: true });
      yield* fileSystem.makeDirectory(path.dirname(legacyNativePath), { recursive: true });
      yield* fileSystem.writeFile(currentNativePath, Uint8Array.from([0x4d, 0x5a, 0x00, 0x00]));
      yield* fileSystem.writeFile(legacyNativePath, Uint8Array.from([0x4d, 0x5a, 0x00, 0x00]));

      NodeAssert.equal(
        yield* resolveCommandCenterCodexRuntimeExecutable({
          commandPath,
          platform: "win32",
          architecture: "x64",
          fileSystem,
          path,
        }),
        yield* fileSystem.realPath(currentNativePath),
      );

      yield* fileSystem.remove(currentNativePath);
      NodeAssert.equal(
        yield* resolveCommandCenterCodexRuntimeExecutable({
          commandPath,
          platform: "win32",
          architecture: "x64",
          fileSystem,
          path,
        }),
        yield* fileSystem.realPath(legacyNativePath),
      );
    }),
  );

  it.effect(
    "grants read-only access to the exact pointer and common metadata for a valid worktree",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const layout = yield* makeLayout();
        const cwd = path.join(layout.worktreesDir, "repo-digest", "run-1");
        const commonGitDir = path.join(layout.repositoriesDir, "repo-digest", ".git");
        const gitDir = path.join(commonGitDir, "worktrees", "run-1");
        const dotGitPath = path.join(cwd, ".git");
        yield* fileSystem.makeDirectory(cwd, { recursive: true });
        yield* fileSystem.makeDirectory(gitDir, { recursive: true });
        yield* writeFile(dotGitPath, `gitdir: ${gitDir}\n`);
        yield* writeFile(path.join(gitDir, "commondir"), "../..\n");
        yield* writeFile(path.join(gitDir, "gitdir"), `${dotGitPath}\n`);
        yield* writeFile(
          path.join(commonGitDir, "config"),
          "[core]\n\trepositoryformatversion = 0\n",
        );

        const resolved = yield* resolveCommandCenterManagedGitMetadata({
          ...layout,
          cwd,
          fileSystem,
          path,
        });
        NodeAssert.deepStrictEqual(resolved, {
          dotGitPath,
          worktreeGitDir: gitDir,
          commonGitDir,
        });

        const runtimeExecutablePath = path.join(layout.baseDir, "runtime", "codex");
        const isolation = commandCenterCodexIsolation(
          "auto-accept-edits",
          resolved,
          runtimeExecutablePath,
          {
            homePath: path.join(layout.baseDir, "provider-home"),
            helperBinPath: path.join(layout.baseDir, "provider-home", "provider-bin"),
          },
        );
        NodeAssert.ok(isolation);
        const config = isolation.appServerArgs.join(" ");
        const quoteTomlPath = (value: string) =>
          `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
        NodeAssert.equal(config.includes(`${quoteTomlPath(dotGitPath)}="read"`), true);
        NodeAssert.equal(config.includes(`${quoteTomlPath(commonGitDir)}="read"`), true);
        NodeAssert.equal(config.includes(`${quoteTomlPath(dotGitPath)}="write"`), false);
        NodeAssert.equal(config.includes(`${quoteTomlPath(commonGitDir)}="write"`), false);
        NodeAssert.equal(config.includes(`${quoteTomlPath(runtimeExecutablePath)}="read"`), true);
        NodeAssert.equal(
          config.includes(`${quoteTomlPath(layout.repositoriesDir)}="write"`),
          false,
        );
      }),
  );

  it.effect("denies executable or included config for provider-writable sessions", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const layout = yield* makeLayout();
      const cases = [
        {
          name: "common-callback",
          target: "common",
          contents: '[filter "provider"]\n\tprocess = ./workspace-callback\n',
          expected: /filter\.\*\.process/u,
        },
        {
          name: "worktree-include",
          target: "worktree",
          contents: "[include]\n\tpath = ../provider-controlled-config\n",
          expected: /include\.path/u,
        },
        {
          name: "common-hardlink",
          target: "common",
          contents: "[core]\n\trepositoryformatversion = 0\n",
          expected: /single-link regular file/u,
          hardlink: "common",
        },
        {
          name: "worktree-hardlink",
          target: "worktree",
          contents: "[core]\n\tbare = false\n",
          expected: /single-link regular file/u,
          hardlink: "worktree",
        },
      ] as const;

      for (const fixture of cases) {
        const cwd = path.join(layout.worktreesDir, fixture.name, "run-1");
        const commonGitDir = path.join(layout.repositoriesDir, fixture.name, ".git");
        const gitDir = path.join(commonGitDir, "worktrees", "run-1");
        const dotGitPath = path.join(cwd, ".git");
        yield* fileSystem.makeDirectory(cwd, { recursive: true });
        yield* fileSystem.makeDirectory(gitDir, { recursive: true });
        yield* writeFile(dotGitPath, `gitdir: ${gitDir}\n`);
        yield* writeFile(path.join(gitDir, "commondir"), "../..\n");
        yield* writeFile(path.join(gitDir, "gitdir"), `${dotGitPath}\n`);
        yield* writeFile(
          path.join(commonGitDir, "config"),
          fixture.target === "common"
            ? fixture.contents
            : "[core]\n\trepositoryformatversion = 0\n",
        );
        if (fixture.target === "worktree") {
          yield* writeFile(path.join(gitDir, "config.worktree"), fixture.contents);
        }
        if ("hardlink" in fixture) {
          const hardlinkTarget =
            fixture.hardlink === "common"
              ? path.join(commonGitDir, "config")
              : path.join(gitDir, "config.worktree");
          yield* fileSystem.link(hardlinkTarget, path.join(cwd, "config-hardlink-alias"));
        }

        const error = yield* resolveCommandCenterManagedGitMetadata({
          ...layout,
          cwd,
          fileSystem,
          path,
        }).pipe(Effect.flip);
        NodeAssert.match(error.issue, fixture.expected);
      }
    }),
  );

  it.effect("denies hardlink aliases for every linked-worktree control pointer", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const layout = yield* makeLayout();

      for (const control of ["dot-git", "commondir", "gitdir"] as const) {
        const suffix = `run-${control}`;
        const cwd = path.join(layout.worktreesDir, "repo-digest", suffix);
        const commonGitDir = path.join(layout.repositoriesDir, "repo-digest", ".git");
        const gitDir = path.join(commonGitDir, "worktrees", suffix);
        const dotGitPath = path.join(cwd, ".git");
        const commonDirPath = path.join(gitDir, "commondir");
        const reversePointerPath = path.join(gitDir, "gitdir");
        yield* fileSystem.makeDirectory(cwd, { recursive: true });
        yield* fileSystem.makeDirectory(gitDir, { recursive: true });
        yield* writeFile(dotGitPath, `gitdir: ${gitDir}\n`);
        yield* writeFile(commonDirPath, "../..\n");
        yield* writeFile(reversePointerPath, `${dotGitPath}\n`);
        const selected =
          control === "dot-git"
            ? dotGitPath
            : control === "commondir"
              ? commonDirPath
              : reversePointerPath;
        yield* fileSystem.link(selected, path.join(cwd, `${control}-alias`));

        const error = yield* resolveCommandCenterManagedGitMetadata({
          ...layout,
          cwd,
          fileSystem,
          path,
        }).pipe(Effect.flip);
        NodeAssert.match(error.issue, /single-link regular file/u);
      }
    }),
  );

  it.effect("denies a traversing worktree pointer into metadata outside managed repositories", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const layout = yield* makeLayout();
      const cwd = path.join(layout.worktreesDir, "repo-digest", "run-1");
      const outsideCommonGitDir = path.join(layout.baseDir, "outside", ".git");
      const outsideGitDir = path.join(outsideCommonGitDir, "worktrees", "run-1");
      const dotGitPath = path.join(cwd, ".git");
      yield* fileSystem.makeDirectory(cwd, { recursive: true });
      yield* fileSystem.makeDirectory(outsideGitDir, { recursive: true });
      yield* writeFile(dotGitPath, `gitdir: ${path.relative(cwd, outsideGitDir)}\n`);
      yield* writeFile(path.join(outsideGitDir, "commondir"), "../..\n");
      yield* writeFile(path.join(outsideGitDir, "gitdir"), `${dotGitPath}\n`);

      const error = yield* resolveCommandCenterManagedGitMetadata({
        ...layout,
        cwd,
        fileSystem,
        path,
      }).pipe(Effect.flip);
      NodeAssert.match(error.issue, /outside its managed repository checkout/u);
    }),
  );

  it.effect("denies a symlink that redirects managed Git metadata outside the runtime base", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const layout = yield* makeLayout();
      const cwd = path.join(layout.worktreesDir, "repo-digest", "run-1");
      const repositoryDir = path.join(layout.repositoriesDir, "repo-digest");
      const commonGitLink = path.join(repositoryDir, ".git");
      const outsideCommonGitDir = path.join(layout.baseDir, "outside", ".git");
      const outsideGitDir = path.join(outsideCommonGitDir, "worktrees", "run-1");
      const dotGitPath = path.join(cwd, ".git");
      yield* fileSystem.makeDirectory(cwd, { recursive: true });
      yield* fileSystem.makeDirectory(repositoryDir, { recursive: true });
      yield* fileSystem.makeDirectory(outsideGitDir, { recursive: true });
      yield* fileSystem.symlink(outsideCommonGitDir, commonGitLink);
      yield* writeFile(dotGitPath, `gitdir: ${path.join(commonGitLink, "worktrees", "run-1")}\n`);
      yield* writeFile(path.join(outsideGitDir, "commondir"), "../..\n");
      yield* writeFile(path.join(outsideGitDir, "gitdir"), `${dotGitPath}\n`);

      const error = yield* resolveCommandCenterManagedGitMetadata({
        ...layout,
        cwd,
        fileSystem,
        path,
      }).pipe(Effect.flip);
      NodeAssert.match(error.issue, /symlink escape/u);
    }),
  );

  it.effect("denies linked Git metadata for a workspace outside managed worktrees", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const layout = yield* makeLayout();
      const cwd = path.join(layout.baseDir, "unmanaged-worktree");
      yield* fileSystem.makeDirectory(cwd, { recursive: true });
      yield* writeFile(path.join(cwd, ".git"), "gitdir: /outside/repository/.git/worktrees/one\n");

      const error = yield* resolveCommandCenterManagedGitMetadata({
        ...layout,
        cwd,
        fileSystem,
        path,
      }).pipe(Effect.flip);
      NodeAssert.match(error.issue, /outside its managed worktree directory/u);
    }),
  );
});
