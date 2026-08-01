import * as NodeAssert from "node:assert/strict";
import * as NodeProcess from "node:process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, KimiSettings, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { probeKimiCommandCenterIsolation } from "../Layers/KimiProvider.ts";

import {
  buildKimiAutomationBwrapArgs,
  prepareKimiCommandCenterLaunch,
  sanitizeKimiAutomationConfig,
} from "./KimiCommandCenterIsolation.ts";

const decodeKimiSettings = Schema.decodeEffect(KimiSettings);

describe("KimiCommandCenterIsolation", () => {
  it("retains credentials and models while dropping ambient executable configuration", () => {
    const config = sanitizeKimiAutomationConfig(
      [
        'default_model = "unsafe"',
        'extra_agent_dirs = ["/tmp/agents"]',
        '[providers."managed:kimi-code"]',
        'type = "kimi"',
        'api_key = "secret"',
        'command = "touch /tmp/provider-escaped"',
        '[providers."managed:kimi-code".hooks]',
        'command = "touch /tmp/nested-provider-escaped"',
        '[models."kimi-code/k3"]',
        'provider = "managed:kimi-code"',
        'model = "k3"',
        "max_context_size = 1048576",
        "[[hooks]]",
        'command = "touch /tmp/escaped"',
        "[services.moonshot_search]",
        'api_key = "web-secret"',
      ].join("\n"),
      "kimi-code/k3",
    );
    NodeAssert.match(config, /api_key = "secret"/u);
    NodeAssert.match(config, /default_model = "kimi-code\/k3"/u);
    NodeAssert.match(config, /mcp__t3-code__\*/u);
    NodeAssert.doesNotMatch(config, /touch \/tmp\/escaped/u);
    NodeAssert.doesNotMatch(config, /web-secret/u);
    NodeAssert.doesNotMatch(config, /extra_agent_dirs/u);
    NodeAssert.doesNotMatch(config, /provider-escaped/u);
    NodeAssert.doesNotMatch(config, /nested-provider-escaped/u);
  });

  it("mounts only the managed workspace and private home while sharing provider network", () => {
    const readOnly = buildKimiAutomationBwrapArgs({
      executablePath: "/opt/kimi/kimi",
      hostHomePath: "/state/kimi/thread",
      workspacePath: "/worktrees/run",
      writable: false,
    });
    NodeAssert.ok(readOnly.includes("--unshare-user"));
    NodeAssert.ok(!readOnly.includes("--unshare-net"));
    NodeAssert.deepStrictEqual(readOnly.slice(-2), ["--", "/command"]);
    const workspaceIndex = readOnly.indexOf("/worktrees/run");
    NodeAssert.equal(readOnly[workspaceIndex - 1], "--ro-bind");
    NodeAssert.ok(readOnly.includes("/workspace/.kimi-code"));
    NodeAssert.ok(readOnly.includes("/tmp/kimi-home/plugins"));

    const writable = buildKimiAutomationBwrapArgs({
      executablePath: "/opt/kimi/kimi",
      hostHomePath: "/state/kimi/thread",
      workspacePath: "/worktrees/run",
      writable: true,
    });
    const writableWorkspaceIndex = writable.indexOf("/worktrees/run");
    NodeAssert.equal(writable[writableWorkspaceIndex - 1], "--bind");
  });
});

it.layer(NodeServices.layer)("Kimi Command Center executable qualification", (it) => {
  it.effect("rejects executable script shims before automation dispatch", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kimi-isolation-" });
      const executable = path.join(root, "kimi");
      const stateDir = path.join(root, "state");
      const workspace = path.join(root, "workspace");
      const sourceHome = path.join(root, "home");
      yield* Effect.forEach(
        [stateDir, workspace, sourceHome],
        (directory) => fileSystem.makeDirectory(directory, { recursive: true }),
        { discard: true },
      );
      yield* fileSystem.writeFileString(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      yield* fileSystem.chmod(executable, 0o700);

      const failure = yield* Effect.flip(
        prepareKimiCommandCenterLaunch({
          binaryPath: executable,
          sourceHomePath: sourceHome,
          stateDir,
          threadId: ThreadId.make("cc:kimi-script-test"),
          runtimeMode: "approval-required",
          cwd: workspace,
          model: "kimi-code/k3",
          environment: { PATH: NodeProcess.env.PATH },
          mcp: {
            environmentId: EnvironmentId.make("local"),
            threadId: ThreadId.make("cc:kimi-script-test"),
            providerSessionId: "provider-session",
            providerInstanceId: ProviderInstanceId.make("kimi-primary"),
            endpoint: "http://127.0.0.1:4321/mcp",
            authorizationHeader: "Bearer test-only",
          },
        }),
      );
      NodeAssert.match(failure.detail, /native ELF executable/u);
      const settings = yield* decodeKimiSettings({
        enabled: true,
        binaryPath: executable,
      });
      NodeAssert.equal(
        yield* probeKimiCommandCenterIsolation(settings, { PATH: NodeProcess.env.PATH }),
        false,
      );
    }),
  );
});
