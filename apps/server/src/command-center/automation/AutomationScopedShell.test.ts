import * as NodeProcess from "node:process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { CAPABILITY_NAMES, Space } from "@command-center/core";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { CommandCenterConfig, type LoadedCommandCenterConfig } from "../Config.ts";
import {
  AUTOMATION_SCOPED_SHELL_MANIFEST_FILE,
  automationScopedShellIdempotencyKey,
  automationScopedShellRepositoryDigest,
  makeAutomationScopedShell,
} from "./AutomationScopedShell.ts";
import {
  VerifiedLinuxScopedShell,
  type VerifiedScopedShellExecuteInput,
} from "./VerifiedScopedShell.ts";

const now = "2026-01-01T00:00:00.000Z";
const repositoryARemote = "https://example.invalid/sample/repository-a.git";
const repositoryBRemote = "https://example.invalid/sample/repository-b.git";
const repositoryACanonicalRemote = normalizeGitRemoteUrl(repositoryARemote);
const repositoryBCanonicalRemote = normalizeGitRemoteUrl(repositoryBRemote);
const decodeSpace = Schema.decodeUnknownSync(Space);
const encodeJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);
const space = decodeSpace({
  id: "space-a",
  slug: "space-a",
  displayName: "Space A",
  kind: "business",
  instructions: "Use the selected Space.",
  policy: {
    allowedCapabilities: CAPABILITY_NAMES,
    autoRunRiskLevels: ["low", "reversible"],
  },
  connectionIds: [],
  repositories: [
    {
      id: "repo-a",
      displayName: "Sample repository A",
      remoteRef: repositoryARemote,
      aliases: [],
    },
    {
      id: "repo-b",
      displayName: "Sample repository B",
      remoteRef: repositoryBRemote,
      aliases: [],
    },
  ],
  aliases: [],
  lifecycle: "active",
  createdAt: now,
  updatedAt: now,
});

const loadedConfig: LoadedCommandCenterConfig = {
  spaces: [space],
  connections: [],
  automations: [],
  timezone: "Etc/UTC",
  routing: {
    mode: "auto",
    showPreview: true,
    explicitSelectionWins: true,
    providerFallback: "first-healthy-compatible",
  },
  health: { status: "loaded", configDirectory: "/private/config" },
};

const manifestEntry = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  allowlistId: "repo.status",
  spaceId: "space-a",
  repositoryId: "repo-a",
  executable: "/usr/bin/git",
  argv: ["status", "--short"],
  access: "read",
  cwd: "/srv/worktrees/sample",
  timeoutMs: 5_000,
  stdoutMaxBytes: 8_192,
  stderrMaxBytes: 8_192,
  retryable: true,
  idempotent: true,
  allowedRoots: [{ canonicalPath: "/srv/worktrees", access: "read" }],
  ...overrides,
});

function testLayer(calls: VerifiedScopedShellExecuteInput[]) {
  const configLayer = Layer.succeed(
    CommandCenterConfig,
    CommandCenterConfig.of({
      configDirectory: "/private/config",
      load: Effect.succeed(loadedConfig),
      resolveGoogleAccount: () => Effect.die("Google is not used by scoped-shell tests."),
    }),
  );
  const verifiedLayer = Layer.succeed(
    VerifiedLinuxScopedShell,
    VerifiedLinuxScopedShell.of({
      execute: (input) => {
        calls.push(input);
        return Effect.succeed({
          allowlistId: input.policy.allowlistId,
          exitCode: 0,
          stdout: "clean\n",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          retryable: input.policy.retryable,
          idempotent: input.policy.idempotent,
          ...(input.policy.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: input.policy.idempotencyKey }),
        });
      },
    }),
  );
  const repositoryIdentityLayer = Layer.succeed(
    RepositoryIdentityResolver.RepositoryIdentityResolver,
    RepositoryIdentityResolver.RepositoryIdentityResolver.of({
      resolve: (cwd) => {
        const match = [
          ["repo-a", repositoryARemote, repositoryACanonicalRemote],
          ["repo-b", repositoryBRemote, repositoryBCanonicalRemote],
        ] as const;
        const selected = match.find(([repositoryId, , canonicalRemote]) =>
          cwd.endsWith(
            automationScopedShellRepositoryDigest({
              spaceId: "space-a",
              repositoryId,
              canonicalRemote,
            }).slice(0, 40),
          ),
        );
        return Effect.succeed(
          selected === undefined
            ? null
            : {
                canonicalKey: selected[2],
                locator: {
                  source: "git-remote" as const,
                  remoteName: "origin",
                  remoteUrl: selected[1],
                },
                rootPath: cwd,
              },
        );
      },
    }),
  );
  return Layer.mergeAll(
    ServerConfig.layerTest(NodeProcess.cwd(), { prefix: "cc-shell-manifest-" }),
    configLayer,
    verifiedLayer,
    repositoryIdentityLayer,
    SqlitePersistenceMemory,
  ).pipe(Layer.provideMerge(NodeServices.layer));
}

const prepareRepository = Effect.fn("AutomationScopedShell.test.prepareRepository")(function* (
  repositoryId: "repo-a" | "repo-b",
  remoteRef: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const canonicalRemote = normalizeGitRemoteUrl(remoteRef);
  const digest = automationScopedShellRepositoryDigest({
    spaceId: "space-a",
    repositoryId,
    canonicalRemote,
  });
  const repositoriesDir = path.join(config.baseDir, "repositories");
  const repositoryRoot = path.join(repositoriesDir, digest.slice(0, 40));
  yield* fs.makeDirectory(path.join(repositoryRoot, ".git"), { recursive: true });
  yield* fs.writeFileString(
    path.join(repositoryRoot, ".git", "config"),
    "[core]\n\trepositoryformatversion = 0\n\tbare = false\n",
  );
  return repositoryRoot;
});

const prepareLinkedWorktree = Effect.fn("AutomationScopedShell.test.prepareLinkedWorktree")(
  function* (repositoryRoot: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const worktreeRoot = path.join(config.worktreesDir, "repository-a", "execution-a");
    const gitDirectory = path.join(repositoryRoot, ".git", "worktrees", "execution-a");
    yield* fs.makeDirectory(worktreeRoot, { recursive: true });
    yield* fs.makeDirectory(gitDirectory, { recursive: true });
    yield* fs.writeFileString(path.join(worktreeRoot, ".git"), `gitdir: ${gitDirectory}\n`);
    yield* fs.writeFileString(path.join(gitDirectory, "commondir"), "../..\n");
    yield* fs.writeFileString(path.join(gitDirectory, "gitdir"), `${worktreeRoot}/.git\n`);
    return worktreeRoot;
  },
);

const seedCheckpoint = Effect.fn("AutomationScopedShell.test.seedCheckpoint")(function* (input: {
  readonly executionId: string;
  readonly nodeId: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT OR IGNORE INTO command_center_spaces (
      id, slug, name, kind, created_at, updated_at
    ) VALUES (
      'space-a', 'space-a', 'Space A', 'business', ${now}, ${now}
    )
  `;
  yield* sql`
    INSERT INTO command_center_automation_executions (
      id, automation_id, idempotency_key, space_id, config_commit_sha,
      definition_digest, definition_json, input_json, state, created_at, updated_at
    ) VALUES (
      ${input.executionId}, 'automation-a', ${`request:${input.executionId}`}, 'space-a',
      '1234567890abcdef1234567890abcdef12345678',
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '{}', '{}', 'running', ${now}, ${now}
    )
  `;
  yield* sql`
    INSERT INTO command_center_automation_node_checkpoints (
      execution_id, node_id, node_kind, state, max_attempts, updated_at
    ) VALUES (
      ${input.executionId}, ${input.nodeId}, 'shell.scoped', 'running', 3, ${now}
    )
  `;
});

const writeManifest = Effect.fn("AutomationScopedShell.test.writeManifest")(function* (
  manifest: unknown,
  mode = 0o600,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  yield* fs.makeDirectory(config.secretsDir, { recursive: true });
  yield* fs.chmod(config.secretsDir, 0o700);
  const manifestPath = path.join(config.secretsDir, AUTOMATION_SCOPED_SHELL_MANIFEST_FILE);
  yield* fs.writeFileString(manifestPath, `${encodeJson(manifest)}\n`);
  yield* fs.chmod(manifestPath, mode);
  return manifestPath;
});

it.effect("resolves exact owner policy and derives attempt-stable idempotency", () => {
  const calls: VerifiedScopedShellExecuteInput[] = [];
  return Effect.gen(function* () {
    const request = {
      executionId: "execution-1",
      nodeId: "node-1",
      spaceId: "space-a",
      allowlistId: "repo.status",
    } as const;
    const repositoryRoot = yield* prepareRepository("repo-a", repositoryARemote);
    yield* seedCheckpoint(request);
    yield* writeManifest({
      schemaVersion: 1,
      entries: [
        manifestEntry({
          cwd: repositoryRoot,
          allowedRoots: [{ canonicalPath: repositoryRoot, access: "read" }],
        }),
      ],
    });
    const shell = yield* makeAutomationScopedShell;
    const result = yield* shell.execute(request);
    const replay = yield* shell.execute(request);

    expect(result).toMatchObject({
      allowlistId: "repo.status",
      spaceId: "space-a",
      repositoryId: "repo-a",
      access: "read",
      exitCode: 0,
      policyDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(replay.idempotencyKey).toBe(result.idempotencyKey);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      policy: {
        allowlistId: "repo.status",
        executable: "/usr/bin/git",
        argv: ["status", "--short"],
        access: "read",
        cwd: repositoryRoot,
        timeoutMs: 5_000,
        stdoutMaxBytes: 8_192,
        stderrMaxBytes: 8_192,
        retryable: true,
        idempotent: true,
        idempotencyKey: automationScopedShellIdempotencyKey(request),
      },
      runtime: {
        allowedRoots: [{ canonicalPath: repositoryRoot, access: "read" }],
      },
    });
    const sql = yield* SqlClient.SqlClient;
    const checkpoints = yield* sql<{ readonly digest: string | null }>`
      SELECT scoped_shell_policy_digest AS digest
      FROM command_center_automation_node_checkpoints
      WHERE execution_id = ${request.executionId} AND node_id = ${request.nodeId}
    `;
    expect(checkpoints).toEqual([{ digest: result.policyDigest }]);
  }).pipe(Effect.provide(testLayer(calls)));
});

it.effect("stays disabled when the owner manifest is absent", () => {
  const calls: VerifiedScopedShellExecuteInput[] = [];
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    yield* fs.makeDirectory(config.secretsDir, { recursive: true });
    yield* fs.chmod(config.secretsDir, 0o700);
    const shell = yield* makeAutomationScopedShell;
    const failure = yield* shell
      .execute({
        executionId: "execution-1",
        nodeId: "node-1",
        spaceId: "space-a",
        allowlistId: "repo.status",
      })
      .pipe(Effect.flip);

    expect(failure.code).toBe("manifest-unavailable");
    expect(calls).toEqual([]);
  }).pipe(Effect.provide(testLayer(calls)));
});

it.effect("accepts a linked worktree only when its Git metadata maps to the bound checkout", () => {
  const calls: VerifiedScopedShellExecuteInput[] = [];
  const request = {
    executionId: "execution-linked-worktree",
    nodeId: "node-linked-worktree",
    spaceId: "space-a",
    allowlistId: "repo.status",
  } as const;
  return Effect.gen(function* () {
    const repositoryRoot = yield* prepareRepository("repo-a", repositoryARemote);
    const worktreeRoot = yield* prepareLinkedWorktree(repositoryRoot);
    yield* seedCheckpoint(request);
    yield* writeManifest({
      schemaVersion: 1,
      entries: [
        manifestEntry({
          cwd: worktreeRoot,
          allowedRoots: [
            { canonicalPath: worktreeRoot, access: "read" },
            { canonicalPath: repositoryRoot, access: "read" },
          ],
        }),
      ],
    });

    const shell = yield* makeAutomationScopedShell;
    expect(yield* shell.execute(request)).toMatchObject({
      repositoryId: "repo-a",
      policyDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(calls[0]?.policy.cwd).toBe(worktreeRoot);
    expect(calls[0]?.runtime.allowedRoots).toEqual([
      { canonicalPath: worktreeRoot, access: "read" },
      { canonicalPath: repositoryRoot, access: "read" },
    ]);
    expect(calls[0]?.runtime.gitMetadata).toEqual({
      dotGitPath: `${worktreeRoot}/.git`,
      commonGitDir: `${repositoryRoot}/.git`,
    });
  }).pipe(Effect.provide(testLayer(calls)));
});

it.effect("permits writes only in a resolver-proven disposable managed worktree", () => {
  const calls: VerifiedScopedShellExecuteInput[] = [];
  return Effect.gen(function* () {
    const repositoryRoot = yield* prepareRepository("repo-a", repositoryARemote);
    const worktreeRoot = yield* prepareLinkedWorktree(repositoryRoot);
    const shell = yield* makeAutomationScopedShell;

    const primaryRequest = {
      executionId: "execution-primary-write",
      nodeId: "node-primary-write",
      spaceId: "space-a",
      allowlistId: "repo.status",
    } as const;
    yield* seedCheckpoint(primaryRequest);
    yield* writeManifest({
      schemaVersion: 1,
      entries: [
        manifestEntry({
          access: "write",
          cwd: repositoryRoot,
          allowedRoots: [{ canonicalPath: repositoryRoot, access: "write" }],
        }),
      ],
    });
    const denied = yield* shell.execute(primaryRequest).pipe(Effect.flip);
    expect(denied.code).toBe("scope-denied");
    expect(denied.message).toContain("disposable managed worktree");
    expect(calls).toEqual([]);

    const worktreeRequest = {
      executionId: "execution-worktree-write",
      nodeId: "node-worktree-write",
      spaceId: "space-a",
      allowlistId: "repo.status",
    } as const;
    yield* seedCheckpoint(worktreeRequest);
    yield* writeManifest({
      schemaVersion: 1,
      entries: [
        manifestEntry({
          access: "write",
          cwd: worktreeRoot,
          allowedRoots: [
            { canonicalPath: worktreeRoot, access: "write" },
            { canonicalPath: repositoryRoot, access: "read" },
          ],
        }),
      ],
    });
    yield* shell.execute(worktreeRequest);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.policy).toMatchObject({ access: "write", cwd: worktreeRoot });
    expect(calls[0]?.runtime).toEqual({
      allowedRoots: [
        { canonicalPath: worktreeRoot, access: "write" },
        { canonicalPath: repositoryRoot, access: "read" },
      ],
      gitMetadata: {
        dotGitPath: `${worktreeRoot}/.git`,
        commonGitDir: `${repositoryRoot}/.git`,
      },
    });
  }).pipe(Effect.provide(testLayer(calls)));
});

it.effect("rejects writable worktrees whose local Git config can select callbacks", () => {
  const calls: VerifiedScopedShellExecuteInput[] = [];
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repositoryRoot = yield* prepareRepository("repo-a", repositoryARemote);
    const worktreeRoot = yield* prepareLinkedWorktree(repositoryRoot);
    const commonConfigPath = path.join(repositoryRoot, ".git", "config");
    const worktreeConfigPath = path.join(
      repositoryRoot,
      ".git",
      "worktrees",
      "execution-a",
      "config.worktree",
    );
    const markerPath = path.join(worktreeRoot, "callback-marker");
    const callbackPath = path.join(worktreeRoot, "configured-callback");
    yield* fs.writeFileString(callbackPath, `#!/bin/sh\nprintf ran > '${markerPath}'\n`, {
      mode: 0o700,
    });
    yield* fs.writeFileString(
      path.join(worktreeRoot, ".gitattributes"),
      "* filter=fixture diff=fixture merge=fixture\n",
    );
    const safeConfig = "[core]\n\trepositoryformatversion = 0\n\tbare = false\n";
    const fixtures = [
      {
        suffix: "filter",
        target: commonConfigPath,
        contents: `${safeConfig}[filter "fixture"]\n\tprocess = ${callbackPath}\n`,
        key: "filter.*.process",
      },
      {
        suffix: "diff",
        target: commonConfigPath,
        contents: `${safeConfig}[diff "fixture"]\n\tcommand = ${callbackPath}\n`,
        key: "diff.*.command",
      },
      {
        suffix: "merge",
        target: commonConfigPath,
        contents: `${safeConfig}[merge "fixture"]\n\tdriver = ${callbackPath} %O %A %B\n`,
        key: "merge.*.driver",
      },
      {
        suffix: "include",
        target: commonConfigPath,
        contents: `${safeConfig}[include]\n\tpath = ${callbackPath}\n`,
        key: "include.path",
      },
      {
        suffix: "worktree-credential",
        target: worktreeConfigPath,
        contents: `[credential]\n\thelper = !${callbackPath}\n`,
        key: "credential.*.helper",
      },
    ] as const;
    const shell = yield* makeAutomationScopedShell;

    for (const fixture of fixtures) {
      yield* fs.writeFileString(commonConfigPath, safeConfig);
      yield* fs.remove(worktreeConfigPath, { force: true });
      yield* fs.writeFileString(fixture.target, fixture.contents);
      const request = {
        executionId: `execution-config-${fixture.suffix}`,
        nodeId: `node-config-${fixture.suffix}`,
        spaceId: "space-a",
        allowlistId: "repo.status",
      } as const;
      yield* seedCheckpoint(request);
      yield* writeManifest({
        schemaVersion: 1,
        entries: [
          manifestEntry({
            access: "write",
            cwd: worktreeRoot,
            allowedRoots: [
              { canonicalPath: worktreeRoot, access: "write" },
              { canonicalPath: repositoryRoot, access: "read" },
            ],
          }),
        ],
      });
      const denied = yield* shell.execute(request).pipe(Effect.flip);
      expect(denied.code).toBe("scope-denied");
      expect(denied.message).toContain(fixture.key);
      expect(yield* fs.exists(markerPath)).toBe(false);
    }

    expect(calls).toEqual([]);
  }).pipe(Effect.provide(testLayer(calls)));
});

it.effect("rejects pre-existing hardlink aliases to writable Git control files", () => {
  const calls: VerifiedScopedShellExecuteInput[] = [];
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repositoryRoot = yield* prepareRepository("repo-a", repositoryARemote);
    const worktreeRoot = yield* prepareLinkedWorktree(repositoryRoot);
    const commonConfigPath = path.join(repositoryRoot, ".git", "config");
    const configAlias = path.join(worktreeRoot, "config-alias");
    yield* fs.link(commonConfigPath, configAlias);
    const shell = yield* makeAutomationScopedShell;
    const configRequest = {
      executionId: "execution-config-hardlink",
      nodeId: "node-config-hardlink",
      spaceId: "space-a",
      allowlistId: "repo.status",
    } as const;
    yield* seedCheckpoint(configRequest);
    yield* writeManifest({
      schemaVersion: 1,
      entries: [
        manifestEntry({
          access: "write",
          cwd: worktreeRoot,
          allowedRoots: [{ canonicalPath: worktreeRoot, access: "write" }],
        }),
      ],
    });
    const configDenied = yield* shell.execute(configRequest).pipe(Effect.flip);
    expect(configDenied.code).toBe("scope-denied");
    expect(configDenied.message).toContain("single-link regular file");
    expect(calls).toEqual([]);

    yield* fs.remove(configAlias);
    const pointerAlias = path.join(worktreeRoot, "dot-git-alias");
    yield* fs.link(path.join(worktreeRoot, ".git"), pointerAlias);
    const pointerRequest = {
      executionId: "execution-pointer-hardlink",
      nodeId: "node-pointer-hardlink",
      spaceId: "space-a",
      allowlistId: "repo.status",
    } as const;
    yield* seedCheckpoint(pointerRequest);
    const pointerDenied = yield* shell.execute(pointerRequest).pipe(Effect.flip);
    expect(pointerDenied.code).toBe("scope-denied");
    expect(pointerDenied.message).toContain("worktree binding is invalid");
    expect(calls).toEqual([]);
  }).pipe(Effect.provide(testLayer(calls)));
});

it.effect("rejects cross-Space, unknown-repository, and self-authored policy", () => {
  const calls: VerifiedScopedShellExecuteInput[] = [];
  return Effect.gen(function* () {
    yield* writeManifest({
      schemaVersion: 1,
      entries: [manifestEntry({ repositoryId: "missing-repository" })],
    });
    const shell = yield* makeAutomationScopedShell;
    const crossSpace = yield* shell
      .execute({
        executionId: "execution-1",
        nodeId: "node-1",
        spaceId: "space-b",
        allowlistId: "repo.status",
      })
      .pipe(Effect.flip);
    const missingRepository = yield* shell
      .execute({
        executionId: "execution-1",
        nodeId: "node-1",
        spaceId: "space-a",
        allowlistId: "repo.status",
      })
      .pipe(Effect.flip);
    expect(crossSpace.code).toBe("scope-denied");
    expect(missingRepository.code).toBe("scope-denied");
    expect(calls).toEqual([]);
  }).pipe(Effect.provide(testLayer(calls)));
});

it.effect("binds cwd and roots to the exact server-managed repository", () => {
  const calls: VerifiedScopedShellExecuteInput[] = [];
  const request = {
    executionId: "execution-repository-binding",
    nodeId: "node-repository-binding",
    spaceId: "space-a",
    allowlistId: "repo.status",
  } as const;
  return Effect.gen(function* () {
    const repositoryA = yield* prepareRepository("repo-a", repositoryARemote);
    const repositoryB = yield* prepareRepository("repo-b", repositoryBRemote);
    yield* seedCheckpoint(request);
    const shell = yield* makeAutomationScopedShell;

    yield* writeManifest({
      schemaVersion: 1,
      entries: [
        manifestEntry({
          repositoryId: "repo-a",
          cwd: repositoryB,
          allowedRoots: [{ canonicalPath: repositoryB, access: "read" }],
        }),
      ],
    });
    const wrongCwd = yield* shell.execute(request).pipe(Effect.flip);
    expect(wrongCwd.code).toBe("scope-denied");

    yield* writeManifest({
      schemaVersion: 1,
      entries: [
        manifestEntry({
          repositoryId: "repo-a",
          cwd: repositoryA,
          allowedRoots: [{ canonicalPath: repositoryB, access: "read" }],
        }),
      ],
    });
    const wrongRoot = yield* shell.execute(request).pipe(Effect.flip);
    expect(wrongRoot.code).toBe("scope-denied");
    expect(calls).toEqual([]);
  }).pipe(Effect.provide(testLayer(calls)));
});

it.effect("pins policy before execution and rejects allowlist drift", () => {
  const calls: VerifiedScopedShellExecuteInput[] = [];
  const request = {
    executionId: "execution-policy-drift",
    nodeId: "node-policy-drift",
    spaceId: "space-a",
    allowlistId: "repo.status",
  } as const;
  return Effect.gen(function* () {
    const repositoryRoot = yield* prepareRepository("repo-a", repositoryARemote);
    yield* seedCheckpoint(request);
    const entry = manifestEntry({
      cwd: repositoryRoot,
      allowedRoots: [{ canonicalPath: repositoryRoot, access: "read" }],
    });
    yield* writeManifest({ schemaVersion: 1, entries: [entry] });
    const shell = yield* makeAutomationScopedShell;
    const first = yield* shell.execute(request);

    yield* writeManifest({
      schemaVersion: 1,
      entries: [{ ...entry, argv: ["status", "--porcelain=v2"] }],
    });
    const drift = yield* shell.execute(request).pipe(Effect.flip);
    expect(drift.code).toBe("policy-drift");
    expect(calls).toHaveLength(1);

    const sql = yield* SqlClient.SqlClient;
    const checkpoint = yield* sql<{ readonly digest: string | null }>`
      SELECT scoped_shell_policy_digest AS digest
      FROM command_center_automation_node_checkpoints
      WHERE execution_id = ${request.executionId} AND node_id = ${request.nodeId}
    `;
    expect(checkpoint).toEqual([{ digest: first.policyDigest }]);
  }).pipe(Effect.provide(testLayer(calls)));
});

it.effect("requires the exact running durable checkpoint before process start", () => {
  const calls: VerifiedScopedShellExecuteInput[] = [];
  const request = {
    executionId: "execution-without-checkpoint",
    nodeId: "node-without-checkpoint",
    spaceId: "space-a",
    allowlistId: "repo.status",
  } as const;
  return Effect.gen(function* () {
    const repositoryRoot = yield* prepareRepository("repo-a", repositoryARemote);
    yield* writeManifest({
      schemaVersion: 1,
      entries: [
        manifestEntry({
          cwd: repositoryRoot,
          allowedRoots: [{ canonicalPath: repositoryRoot, access: "read" }],
        }),
      ],
    });
    const shell = yield* makeAutomationScopedShell;
    const failure = yield* shell.execute(request).pipe(Effect.flip);
    expect(failure.code).toBe("scope-denied");
    expect(calls).toEqual([]);
  }).pipe(Effect.provide(testLayer(calls)));
});

it.effect("rejects permissive, symlinked, duplicate, and unsafe-retry manifests", () => {
  const calls: VerifiedScopedShellExecuteInput[] = [];
  const request = {
    executionId: "execution-1",
    nodeId: "node-1",
    spaceId: "space-a",
    allowlistId: "repo.status",
  } as const;
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const permissivePath = yield* writeManifest(
      { schemaVersion: 1, entries: [manifestEntry()] },
      0o644,
    );
    const shell = yield* makeAutomationScopedShell;
    expect((yield* shell.execute(request).pipe(Effect.flip)).code).toBe("manifest-untrusted");

    yield* fs.remove(permissivePath);
    const target = path.join(config.secretsDir, "owner-policy.json");
    yield* fs.writeFileString(target, encodeJson({ schemaVersion: 1, entries: [manifestEntry()] }));
    yield* fs.chmod(target, 0o600);
    yield* fs.symlink(target, permissivePath);
    expect((yield* shell.execute(request).pipe(Effect.flip)).code).toBe("manifest-untrusted");

    yield* fs.remove(permissivePath);
    yield* writeManifest({
      schemaVersion: 1,
      entries: [manifestEntry(), manifestEntry()],
    });
    expect((yield* shell.execute(request).pipe(Effect.flip)).code).toBe("manifest-invalid");

    yield* writeManifest({
      schemaVersion: 1,
      entries: [manifestEntry({ retryable: false, idempotent: false })],
    });
    const nonIdempotent = yield* shell.execute(request).pipe(Effect.flip);
    expect(nonIdempotent.code).toBe("manifest-invalid");
    expect(nonIdempotent.message).toContain("must be idempotent in v1");

    const { repositoryId: _repositoryId, ...missingRepositoryId } = manifestEntry();
    yield* writeManifest({ schemaVersion: 1, entries: [missingRepositoryId] });
    const missingBinding = yield* shell.execute(request).pipe(Effect.flip);
    expect(missingBinding.code).toBe("manifest-invalid");

    yield* writeManifest({
      schemaVersion: 1,
      entries: [manifestEntry({ command: "/bin/sh" })],
    });
    const unknownField = yield* shell.execute(request).pipe(Effect.flip);
    expect(unknownField.code).toBe("manifest-invalid");
    expect(unknownField.message).toContain("unsupported field 'command'");
    expect(calls).toEqual([]);
  }).pipe(Effect.provide(testLayer(calls)));
});
