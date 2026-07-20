// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";
import {
  hardenedGitSpawningCliEnvironment,
  hardenedHostGitArguments,
  hardenedHostGitEnvironment,
  HOST_GIT_HARDENED_CONFIG_ENTRIES,
  resolveTrustedHostExecutable,
  supportsHardenedHostGitAuthoring,
  trustedHostExecutablePath,
  unsafeHostGitConfigKey,
} from "./HostGitSecurity.ts";

describe("host Git process boundary", () => {
  it("forces non-executable repository behavior before the requested command", () => {
    expect(hardenedHostGitArguments(["-C", "/workspace", "status"])).toEqual([
      "-c",
      expect.stringMatching(/^core\.hooksPath=/u),
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "-c",
      "protocol.ext.allow=never",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "tag.gpgSign=false",
      "-c",
      "log.showSignature=false",
      "-c",
      "core.sshCommand=ssh",
      "-C",
      "/workspace",
      "status",
    ]);
  });

  it("requires a Git version with safe fsmonitor and fsync semantics for authoring", () => {
    expect(supportsHardenedHostGitAuthoring("git version 2.35.1")).toBe(false);
    expect(supportsHardenedHostGitAuthoring("git version 2.36.0")).toBe(true);
    expect(supportsHardenedHostGitAuthoring("git version 3.0.0.windows.1")).toBe(true);
    expect(supportsHardenedHostGitAuthoring("unexpected output")).toBe(false);
  });

  it("drops inherited and caller-supplied Git execution and location controls", () => {
    const supplied = {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: "/tmp/callback",
      GIT_DIR: "/tmp/alternate.git",
      GIT_COMMON_DIR: "/tmp/common.git",
      GIT_WORK_TREE: "/tmp/worktree",
      GIT_INDEX_FILE: "/tmp/index",
      GIT_OBJECT_DIRECTORY: "/tmp/objects",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "/tmp/alternate",
      GIT_EXEC_PATH: "/tmp/exec",
      GIT_TEMPLATE_DIR: "/tmp/template",
      GIT_SSH: "/tmp/ssh",
      GIT_SSH_COMMAND: "/tmp/ssh-command",
      GIT_ASKPASS: "/tmp/askpass",
      SSH_ASKPASS: "/tmp/ssh-askpass",
      GIT_EXTERNAL_DIFF: "/tmp/diff",
      GIT_PAGER: "/tmp/pager",
      GIT_EDITOR: "/tmp/editor",
      GIT_SEQUENCE_EDITOR: "/tmp/sequence-editor",
      GIT_AUTHOR_NAME: "Trusted Author",
      LC_ALL: "C",
    } satisfies NodeJS.ProcessEnv;
    const environment = hardenedHostGitEnvironment([supplied]);

    expect(environment).toMatchObject({
      GIT_AUTHOR_NAME: "Trusted Author",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_EDITOR: "true",
      GIT_ASKPASS: "true",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_PAGER: "cat",
      GIT_SEQUENCE_EDITOR: "true",
      GIT_SSH_COMMAND: expect.stringMatching(/^ssh -F /u),
      SSH_ASKPASS: "true",
      SSH_ASKPASS_REQUIRE: "force",
    });
    for (const key of [
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
      "GIT_DIR",
      "GIT_COMMON_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_EXEC_PATH",
      "GIT_TEMPLATE_DIR",
      "GIT_SSH",
      "GIT_EXTERNAL_DIFF",
    ]) {
      expect(environment).not.toHaveProperty(key);
    }
    expect(hardenedHostGitEnvironment([supplied], { allowIndexFile: true }).GIT_INDEX_FILE).toBe(
      "/tmp/index",
    );
  });

  it("builds exact connector environments and rejects worktree-controlled config dirs", () => {
    const supplied = {
      GH_TOKEN: "github-token",
      GH_HOST: "github.example.test",
      GH_CONFIG_DIR: "/workspace/gh",
      GH_REPO: "must-not-pass/repository",
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_HOST: "https://gitlab.example.test",
      GLAB_CONFIG_DIR: "/workspace/glab",
      AZURE_DEVOPS_EXT_PAT: "azure-token",
      AZURE_CONFIG_DIR: "/workspace/azure",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "filter.fixture.process",
      GIT_CONFIG_VALUE_0: "/tmp/callback",
      GIT_DIR: "/tmp/alternate.git",
      GIT_EXEC_PATH: "/tmp/git-exec",
      UNRELATED_TOKEN: "must-not-pass",
    } satisfies NodeJS.ProcessEnv;
    const configEnvironment = Object.fromEntries(
      HOST_GIT_HARDENED_CONFIG_ENTRIES.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${index}`, key],
        [`GIT_CONFIG_VALUE_${index}`, value],
      ]),
    );
    const exactBase = {
      ...hardenedHostGitEnvironment(),
      ...configEnvironment,
      GIT_CONFIG_COUNT: String(HOST_GIT_HARDENED_CONFIG_ENTRIES.length),
    };

    const options = { writableRoots: ["/workspace"] } as const;
    expect(hardenedGitSpawningCliEnvironment("github", [supplied], options)).toEqual({
      ...exactBase,
      GH_TOKEN: "github-token",
      GH_HOST: "github.example.test",
    });
    expect(hardenedGitSpawningCliEnvironment("gitlab", [supplied], options)).toEqual({
      ...exactBase,
      GITLAB_TOKEN: "gitlab-token",
      GITLAB_HOST: "https://gitlab.example.test",
    });
    expect(hardenedGitSpawningCliEnvironment("azure-devops", [supplied], options)).toEqual({
      ...exactBase,
      AZURE_DEVOPS_EXT_PAT: "azure-token",
    });
  });

  it.runIf(NodeProcess.platform === "linux")(
    "drops relative, empty, and writable-root executable search paths",
    () => {
      const expected = [
        ...new Set(["/usr/bin", "/bin"].map((entry) => NodeFS.realpathSync.native(entry))),
      ].join(":");
      expect(
        trustedHostExecutablePath({
          sourceEnvironment: {
            PATH: "./node_modules/.bin::/workspace/node_modules/.bin:/usr/bin:/bin",
          },
          writableRoots: ["/workspace"],
        }),
      ).toBe(expected);
    },
  );

  it.runIf(NodeProcess.platform === "linux")(
    "rejects caller-selected absolute, writable-mode, and hardlinked tools",
    () => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cc-tool-trust-"));
      const writableBin = NodePath.join(root, "writable-bin");
      const hardlinkBin = NodePath.join(root, "hardlink-bin");
      NodeFS.mkdirSync(writableBin);
      NodeFS.mkdirSync(hardlinkBin);
      NodeFS.chmodSync(writableBin, 0o777);
      const writableTool = NodePath.join(writableBin, "cc-untrusted-tool");
      const hardlinkedTool = NodePath.join(hardlinkBin, "cc-hardlinked-tool");
      NodeFS.writeFileSync(writableTool, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      NodeFS.writeFileSync(hardlinkedTool, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      NodeFS.linkSync(hardlinkedTool, NodePath.join(root, "hardlink-alias"));
      try {
        expect(resolveTrustedHostExecutable("/tmp/git")).toBeUndefined();
        expect(
          resolveTrustedHostExecutable("cc-untrusted-tool", {
            sourceEnvironment: { PATH: writableBin },
          }),
        ).toBeUndefined();
        expect(
          resolveTrustedHostExecutable("cc-hardlinked-tool", {
            sourceEnvironment: { PATH: hardlinkBin },
          }),
        ).toBeUndefined();
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("identifies executable callbacks and includes in local Git configuration", () => {
    expect(
      unsafeHostGitConfigKey(
        '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://example.test/repo.git\n',
      ),
    ).toBeUndefined();

    const fixtures = [
      ['[filter "fixture"]\n\tprocess = ./callback\n', "filter.*.process"],
      ['[diff "fixture"]\n\tcommand = ./callback\n', "diff.*.command"],
      ['[merge "fixture"]\n\tdriver = ./callback %O %A %B\n', "merge.*.driver"],
      ['[credential "https://example.test"]\n\thelper = !./callback\n', "credential.*.helper"],
      ['[includeIf "gitdir:~/workspace/"]\n\tpath = ../callback-config\n', "includeif.path"],
      ["[core]\n\talternateRefsCommand = ./callback\n", "core.alternaterefscommand"],
      ['[remote "origin"]\n\tvcs = fixture-helper\n', "remote.*.vcs"],
      ['[submodule "fixture"]\n\tupdate = !./callback\n', "submodule.*.update"],
    ] as const;
    for (const [contents, expected] of fixtures) {
      expect(unsafeHostGitConfigKey(contents)).toBe(expected);
    }
    expect(unsafeHostGitConfigKey("not-valid-git-config\n")).toBe("<malformed>");
  });
});

describe.runIf(NodeProcess.platform === "linux")("Git-spawning CLI child policy", () => {
  const processLayer = ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer));

  it.effect("keeps configured hooks and filesystem monitors inactive in child Git", () => {
    const repository = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cc-child-git-"));
    const runSetupGit = (args: ReadonlyArray<string>) =>
      Effect.flatMap(ProcessRunner.ProcessRunner, (runner) =>
        runner.run({
          command: "git",
          args: hardenedHostGitArguments(args),
          cwd: repository,
          env: hardenedHostGitEnvironment(),
          extendEnv: false,
        }),
      ).pipe(
        Effect.tap((result) => Effect.sync(() => expect(result.code).toBe(0))),
        Effect.asVoid,
      );
    const runChildGit = (args: ReadonlyArray<string>, env: NodeJS.ProcessEnv) =>
      Effect.flatMap(ProcessRunner.ProcessRunner, (runner) =>
        runner.run({
          command: "git",
          args,
          cwd: repository,
          env,
          extendEnv: false,
        }),
      ).pipe(
        Effect.tap((result) => Effect.sync(() => expect(result.code).toBe(0))),
        Effect.asVoid,
      );

    return Effect.gen(function* () {
      yield* runSetupGit(["init", "--initial-branch=main"]);
      NodeFS.writeFileSync(NodePath.join(repository, "tracked.txt"), "initial\n");
      yield* runSetupGit(["add", "tracked.txt"]);
      yield* runSetupGit([
        "-c",
        "user.name=Command Center Test",
        "-c",
        "user.email=command-center-test",
        "commit",
        "-m",
        "Initial fixture",
      ]);

      const markerDirectory = NodePath.join(repository, ".git", "callback-markers");
      const hookMarker = NodePath.join(markerDirectory, "post-checkout");
      const fsmonitorMarker = NodePath.join(markerDirectory, "fsmonitor");
      const hooksDirectory = NodePath.join(repository, ".githooks");
      const hook = NodePath.join(hooksDirectory, "post-checkout");
      const fsmonitor = NodePath.join(repository, "configured-fsmonitor");
      NodeFS.mkdirSync(hooksDirectory);
      NodeFS.writeFileSync(
        hook,
        `#!/bin/sh\nmkdir -p '${markerDirectory}'\nprintf ran > '${hookMarker}'\n`,
        {
          mode: 0o700,
        },
      );
      NodeFS.writeFileSync(
        fsmonitor,
        `#!/bin/sh\nmkdir -p '${markerDirectory}'\nprintf ran > '${fsmonitorMarker}'\nprintf '2\\n'\n`,
        { mode: 0o700 },
      );
      yield* runSetupGit(["config", "core.hooksPath", ".githooks"]);
      yield* runSetupGit(["config", "core.fsmonitor", fsmonitor]);

      const childEnvironment = hardenedGitSpawningCliEnvironment("github", [{}]);
      yield* runChildGit(["checkout", "-b", "contained-child-git"], childEnvironment);
      yield* runChildGit(["status", "--short"], childEnvironment);

      expect(NodeFS.existsSync(hookMarker)).toBe(false);
      expect(NodeFS.existsSync(fsmonitorMarker)).toBe(false);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(repository, { recursive: true, force: true })),
      ),
      Effect.provide(processLayer),
    );
  });

  it.effect("pins host tools and keeps child Git away from worktree PATH shadows", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cc-host-tool-path-"));
    const workspace = NodePath.join(root, "workspace");
    const nestedCwd = NodePath.join(workspace, "apps", "nested");
    const maliciousBin = NodePath.join(workspace, "node_modules", ".bin");
    const rejectedBin = NodePath.join(root, "rejected-bin");
    const trustedBin = NodePath.join(root, "trusted-bin");
    NodeFS.mkdirSync(maliciousBin, { recursive: true });
    NodeFS.mkdirSync(NodePath.join(workspace, ".git"));
    NodeFS.mkdirSync(nestedCwd, { recursive: true });
    NodeFS.mkdirSync(rejectedBin, { recursive: true });
    NodeFS.mkdirSync(trustedBin, { recursive: true });
    NodeFS.chmodSync(rejectedBin, 0o755);
    NodeFS.chmodSync(trustedBin, 0o755);
    const markerPaths = new Map<string, string>();
    const rejectedChildGitMarker = NodePath.join(root, "rejected-child-git-ran");
    const rejectedChildGit = NodePath.join(rejectedBin, "git");
    NodeFS.writeFileSync(
      rejectedChildGit,
      `#!/bin/sh\nprintf ran > '${rejectedChildGitMarker}'\nexit 98\n`,
      { mode: 0o722 },
    );
    NodeFS.chmodSync(rejectedChildGit, 0o722);
    markerPaths.set("rejected-child-git", rejectedChildGitMarker);
    for (const command of ["git", "gh", "glab", "az"] as const) {
      const marker = NodePath.join(root, `${command}-shadow-ran`);
      markerPaths.set(command, marker);
      NodeFS.writeFileSync(
        NodePath.join(maliciousBin, command),
        `#!/bin/sh\nprintf ran > '${marker}'\nexit 97\n`,
        { mode: 0o700 },
      );
      if (command !== "git") {
        NodeFS.writeFileSync(
          NodePath.join(trustedBin, command),
          "#!/bin/sh\ngit --version >/dev/null\n",
          { mode: 0o700 },
        );
      }
    }
    const sourceEnvironment = {
      PATH: `${maliciousBin}:./node_modules/.bin:${rejectedBin}:${trustedBin}:/usr/bin:/bin`,
    } satisfies NodeJS.ProcessEnv;
    const options = { sourceEnvironment, writableRoots: [nestedCwd] } as const;

    const run = Effect.gen(function* () {
      const runner = yield* ProcessRunner.ProcessRunner;
      for (const command of ["git", "gh", "glab", "az"] as const) {
        if (command !== "git") {
          const trustedTool = NodeFS.statSync(NodePath.join(trustedBin, command));
          expect(trustedTool.nlink, `${command} link count`).toBe(1);
          expect(trustedTool.mode & 0o022, `${command} writable mode`).toBe(0);
          expect(trustedHostExecutablePath(options), `${command} trusted PATH`).toContain(
            trustedBin,
          );
        }
        const executable = resolveTrustedHostExecutable(command, options);
        expect(executable, command).toBeDefined();
        expect(executable?.startsWith(`${workspace}${NodePath.sep}`)).toBe(false);
        const connector =
          command === "gh" ? "github" : command === "glab" ? "gitlab" : "azure-devops";
        const result = yield* runner.run({
          command: executable!,
          args: ["--version"],
          cwd: nestedCwd,
          env:
            command === "git"
              ? hardenedHostGitEnvironment([], options)
              : hardenedGitSpawningCliEnvironment(connector, [{}], options),
          extendEnv: false,
        });
        expect(result.code).toBe(0);
      }
      for (const marker of markerPaths.values()) {
        expect(NodeFS.existsSync(marker)).toBe(false);
      }
    });

    return run.pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
      Effect.provide(processLayer),
    );
  });

  it.effect("leaves no executable PATH when only a rejected child Git exists", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cc-rejected-child-git-"));
    const workspace = NodePath.join(root, "workspace");
    const rejectedBin = NodePath.join(root, "rejected-bin");
    const marker = NodePath.join(root, "rejected-git-ran");
    NodeFS.mkdirSync(workspace);
    NodeFS.mkdirSync(rejectedBin);
    NodeFS.chmodSync(rejectedBin, 0o755);
    const rejectedChildGit = NodePath.join(rejectedBin, "git");
    NodeFS.writeFileSync(rejectedChildGit, `#!/bin/sh\nprintf ran > '${marker}'\nexit 98\n`, {
      mode: 0o722,
    });
    NodeFS.chmodSync(rejectedChildGit, 0o722);
    const options = {
      sourceEnvironment: { PATH: rejectedBin },
      writableRoots: [workspace],
    } as const;

    return Effect.gen(function* () {
      const environment = hardenedGitSpawningCliEnvironment("github", [{}], options);
      expect(environment.PATH).toBe("/dev/null");
      const runner = yield* ProcessRunner.ProcessRunner;
      const result = yield* runner.run({
        command: "/bin/sh",
        args: ["-c", "git --version"],
        cwd: workspace,
        env: environment,
        extendEnv: false,
      });
      expect(result.code).not.toBe(0);
      expect(NodeFS.existsSync(marker)).toBe(false);
    }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
      Effect.provide(processLayer),
    );
  });
});
