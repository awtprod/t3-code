// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";

import { VcsProcessExitError, VcsProcessSpawnError } from "@t3tools/contracts";
import * as ProcessRunner from "../processRunner.ts";
import { HOST_GIT_HARDENED_CONFIG_ARGS, inheritedGitConfigPins } from "./HostGitSecurity.ts";
import * as VcsProcess from "./VcsProcess.ts";

const encodeExitError = Schema.encodeEffect(Schema.fromJsonString(VcsProcessExitError));

const run = (input: VcsProcess.VcsProcessInput) =>
  Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    return yield* process.run(input);
  });

const layerLive = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));

const provideLive = <A, E, R>(effect: Effect.Effect<A, E, R | VcsProcess.VcsProcess>) =>
  effect.pipe(Effect.provide(layerLive));

const baseInput = {
  operation: "test.process-boundary",
  command: "git",
  args: ["status", "--short"],
  cwd: "/workspace",
} satisfies VcsProcess.VcsProcessInput;

const captureProcessResult = (
  result: Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>,
) =>
  VcsProcess.make.pipe(
    Effect.provideService(
      ProcessRunner.ProcessRunner,
      ProcessRunner.ProcessRunner.of({ run: () => result }),
    ),
    Effect.flatMap((service) => service.run(baseInput)),
    Effect.flip,
  );

const recordingService = (calls: ProcessRunner.ProcessRunInput[]) =>
  VcsProcess.make.pipe(
    Effect.provideService(
      ProcessRunner.ProcessRunner,
      ProcessRunner.ProcessRunner.of({
        run: (input) => {
          calls.push(input);
          return Effect.succeed({
            stdout: "",
            stderr: "",
            code: 0 as ProcessRunner.ProcessRunOutput["code"],
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          });
        },
      }),
    ),
  );

/** The `GIT_CONFIG_*` entries of a spawn environment, in order. */
const gitConfigEntries = (env: NodeJS.ProcessEnv | undefined) =>
  Array.from({ length: Number(env?.GIT_CONFIG_COUNT ?? "0") }, (_, index) => [
    env?.[`GIT_CONFIG_KEY_${index}`],
    env?.[`GIT_CONFIG_VALUE_${index}`],
  ]);
/** Exact pins the suite setup exports (testUtils/gitConfig.setup.ts), if honoured. */
const inheritedPins = () => inheritedGitConfigPins(process.env).map(([key, value]) => [key, value]);
/** VcsProcess appends this to every hardened Git and connector CLI environment. */
const EXPLICIT_BARE_REPOSITORY = ["safe.bareRepository", "explicit"];

const ACME_REMOTE = "https://github.com/acme/web.git";
const remoteWithUserInfo = (() => {
  const url = new URL(ACME_REMOTE);
  url.username = "acme";
  url.password = "placeholder";
  return url.href;
})();
const accessTokenHeader = (token: string) =>
  `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")}`;
const trustedHeader = (overrides: Partial<VcsProcess.VcsProcessInput["trustedConfig"]> = {}) => ({
  remoteUrl: ACME_REMOTE,
  key: `http.${ACME_REMOTE}.extraheader`,
  value: Redacted.make(accessTokenHeader("acme-token")),
  ...overrides,
});

describe("VcsProcess.run trusted Git config", () => {
  it.effect("passes a validated remote authorization header to git as GIT_CONFIG_* only", () =>
    Effect.gen(function* () {
      const calls: ProcessRunner.ProcessRunInput[] = [];
      const service = yield* recordingService(calls);
      yield* service.run({
        ...baseInput,
        args: ["fetch", "origin"],
        // Raw caller GIT_CONFIG_* never survives, even next to a trusted entry.
        env: {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.sslVerify",
          GIT_CONFIG_VALUE_0: "false",
        },
        trustedConfig: trustedHeader(),
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.extendEnv).toBe(false);
      expect(calls[0]?.env?.GIT_TERMINAL_PROMPT).toBe("0");
      expect(gitConfigEntries(calls[0]?.env)).toEqual([
        ...inheritedPins(),
        EXPLICIT_BARE_REPOSITORY,
        [`http.${ACME_REMOTE}.extraheader`, accessTokenHeader("acme-token")],
      ]);
      // The hardening -c flags still come first and win over env config.
      expect(calls[0]?.args.slice(0, HOST_GIT_HARDENED_CONFIG_ARGS.length)).toEqual([
        ...HOST_GIT_HARDENED_CONFIG_ARGS,
      ]);
    }),
  );

  it.effect.each([
    ["url insteadOf", { key: "url.https://evil.example/.insteadOf" }],
    ["http proxy", { key: "http.proxy" }],
    ["sslVerify", { key: `http.${ACME_REMOTE}.sslVerify` }],
    ["credential helper", { key: "credential.helper" }],
    ["mismatched remote URL", { key: "http.https://evil.example/acme/web.git.extraheader" }],
    [
      "non-https remote",
      {
        remoteUrl: "http://github.com/acme/web.git",
        key: "http.http://github.com/acme/web.git.extraheader",
      },
    ],
    [
      "credentials in the remote URL",
      { remoteUrl: remoteWithUserInfo, key: `http.${remoteWithUserInfo}.extraheader` },
    ],
    [
      "header that is not an access token",
      { value: Redacted.make("AUTHORIZATION: bearer acme-token") },
    ],
    [
      "header with a smuggled newline",
      { value: Redacted.make(`${accessTokenHeader("acme")}\nX-Evil: 1`) },
    ],
    ["access token with a space", { value: Redacted.make(accessTokenHeader("acme token")) }],
  ] as const)("refuses trusted config with a %s", ([, overrides]) =>
    Effect.gen(function* () {
      const calls: ProcessRunner.ProcessRunInput[] = [];
      const service = yield* recordingService(calls);
      const error = yield* Effect.flip(
        service.run({
          ...baseInput,
          args: ["fetch", "origin"],
          trustedConfig: trustedHeader(overrides),
        }),
      );
      expect(error._tag).toBe("VcsProcessSpawnError");
      expect((error as { readonly cause?: { readonly _tag?: string } }).cause?._tag).toBe(
        "HostGitTrustedConfigError",
      );
      expect(calls).toHaveLength(0);
    }),
  );

  it.effect("carries only exact inherited test pins into hardened git", () =>
    Effect.gen(function* () {
      const pins = {
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "core.autocrlf",
        GIT_CONFIG_VALUE_0: "false",
        GIT_CONFIG_KEY_1: "init.defaultBranch",
        GIT_CONFIG_VALUE_1: "main",
      };
      expect(inheritedGitConfigPins(pins)).toEqual([
        ["core.autocrlf", "false"],
        ["init.defaultBranch", "main"],
      ]);
      // Any non-pin entry, a pin with another value, or a malformed count drops the whole set.
      for (const poisoned of [
        { ...pins, GIT_CONFIG_KEY_1: "core.sshCommand", GIT_CONFIG_VALUE_1: "touch /tmp/pwned" },
        { ...pins, GIT_CONFIG_VALUE_0: "true" },
        { ...pins, GIT_CONFIG_KEY_1: "url.https://evil.example/.insteadOf" },
        { ...pins, GIT_CONFIG_COUNT: "3" },
        { ...pins, GIT_CONFIG_COUNT: "1e1" },
      ]) {
        expect(inheritedGitConfigPins(poisoned)).toEqual([]);
      }
      // The pins come from the server's own environment, never from the caller.
      const calls: ProcessRunner.ProcessRunInput[] = [];
      const service = yield* recordingService(calls);
      yield* service.run({ ...baseInput, env: pins });
      expect(gitConfigEntries(calls[0]?.env)).toEqual([
        ...inheritedPins(),
        EXPLICIT_BARE_REPOSITORY,
      ]);
    }),
  );

  it.effect("refuses trusted config on a connector CLI", () =>
    Effect.gen(function* () {
      const calls: ProcessRunner.ProcessRunInput[] = [];
      const service = yield* recordingService(calls);
      const error = yield* Effect.flip(
        service.run({
          operation: "GitHubCli.execute",
          command: "gh",
          args: ["pr", "list"],
          cwd: "/workspace",
          trustedConfig: trustedHeader(),
        }),
      );
      expect(error._tag).toBe("VcsProcessSpawnError");
      expect(calls).toHaveLength(0);
    }),
  );
});

describe("VcsProcess.run", () => {
  it.effect("applies the host Git boundary at the generic process sink", () =>
    Effect.gen(function* () {
      const calls: ProcessRunner.ProcessRunInput[] = [];
      const service = yield* VcsProcess.make.pipe(
        Effect.provideService(
          ProcessRunner.ProcessRunner,
          ProcessRunner.ProcessRunner.of({
            run: (input) => {
              calls.push(input);
              return Effect.succeed({
                stdout: "",
                stderr: "",
                code: 0 as ProcessRunner.ProcessRunOutput["code"],
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              });
            },
          }),
        ),
      );

      yield* service.run({
        ...baseInput,
        env: {
          GIT_CONFIG_COUNT: "1",
          GIT_DIR: "/tmp/alternate.git",
          GIT_INDEX_FILE: "/tmp/ordinary-index",
        },
      });
      yield* service.run({
        ...baseInput,
        operation: "GitVcsDriver.checkpoints.captureCheckpoint",
        env: { GIT_INDEX_FILE: "/tmp/checkpoint-index" },
      });
      const exactCliEnvironment = { PATH: "/usr/bin", GH_TOKEN: "trusted-token" };
      yield* service.run({
        operation: "GitHubCli.execute",
        command: "gh",
        args: ["pr", "checkout", "42"],
        cwd: "/workspace",
        env: exactCliEnvironment,
        extendEnv: false,
      });

      expect(calls[0]?.args).toEqual([
        ...HOST_GIT_HARDENED_CONFIG_ARGS,
        "-c",
        `safe.directory=${baseInput.cwd}`,
        ...baseInput.args,
      ]);
      expect(calls[0]?.extendEnv).toBe(false);
      // The caller's raw GIT_CONFIG_COUNT never survives; only inherited exact pins may.
      expect(gitConfigEntries(calls[0]?.env)).toEqual([
        ...inheritedPins(),
        EXPLICIT_BARE_REPOSITORY,
      ]);
      expect(calls[0]?.env).not.toHaveProperty("GIT_DIR");
      expect(calls[0]?.env).not.toHaveProperty("GIT_INDEX_FILE");
      expect(calls[1]?.env?.GIT_INDEX_FILE).toBe("/tmp/checkpoint-index");
      expect(calls[2]?.args).toEqual(["pr", "checkout", "42"]);
      expect(calls[2]?.env).toMatchObject({
        GH_TOKEN: "trusted-token",
        // The eight command-scope hardening entries, then safe.bareRepository=explicit.
        GIT_CONFIG_COUNT: "9",
        GIT_TERMINAL_PROMPT: "0",
      });
      expect(calls[2]?.env?.PATH?.split(NodePath.delimiter).every(NodePath.isAbsolute)).toBe(true);
      expect(NodePath.isAbsolute(calls[0]?.command ?? "")).toBe(true);
      expect(NodePath.isAbsolute(calls[2]?.command ?? "")).toBe(true);
      expect(calls[2]?.extendEnv).toBe(false);
    }),
  );

  it.effect("explains a locked Git index and allows restore after the lock is released", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-index-lock-" });
      const git = (args: readonly string[]) =>
        run({ operation: "test.checkpoint.restore", command: "git", cwd, args });
      yield* git(["init"]);
      const file = path.join(cwd, "README.md");
      yield* fs.writeFileString(file, "before\n");
      yield* git(["add", "README.md"]);
      yield* git([
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        "initial",
      ]);
      yield* fs.writeFileString(file, "after\n");
      const lock = path.join(cwd, ".git", "index.lock");
      yield* fs.writeFileString(lock, "held by another process\n");
      const restore = ["restore", "--source=HEAD", "--worktree", "--staged", "--", "README.md"];

      const error = yield* Effect.flip(git(restore));
      expect(error).toBeInstanceOf(VcsProcessExitError);
      expect(error).toMatchObject({
        exitCode: 128,
        failureKind: "command-failed",
        detail: "Git's index is locked. Wait for other Git operations to finish, then try again.",
      });
      expect(error.message).not.toContain("index.lock");
      expect(yield* fs.readFileString(file)).toBe("after\n");
      expect(yield* fs.readFileString(lock)).toBe("held by another process\n");

      yield* fs.remove(lock);
      yield* git(restore);
      expect(yield* fs.readFileString(file)).toBe("before\n");
    }).pipe(provideLive, Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.each([
    {
      stderr: "fatal: Unable to create '/private/repo/index.lock': File exists",
      retryable: true,
      detail: "Git's index is locked. Wait for other Git operations to finish, then try again.",
    },
    {
      stderr: "fatal: Unable to create 'C:\\private\\repo\\.git\\index.lock': File exists.",
      retryable: true,
      detail: "Git's index is locked. Wait for other Git operations to finish, then try again.",
    },
    {
      stderr: "fatal: Unable to create '/private/repo/.git/config.lock': File exists.",
      retryable: true,
    },
    {
      stderr: "fatal: Unable to create '/private/repo/index.lock': Permission denied",
      retryable: false,
    },
    { stderr: 'error: open("/private/repo/file"): No such file or directory', retryable: true },
    {
      stderr: "fatal: unable to stat '/private/repo/file': No such file or directory",
      retryable: true,
    },
    { stderr: 'error: open("/private/repo/file"): Permission denied', retryable: false },
    {
      stderr: "error: '/private/repo/child/' does not have a commit checked out",
      retryable: false,
    },
    { stderr: "fatal: index file corrupt", retryable: false },
  ])(
    "classifies Git exit retryability and safe detail without retaining stderr: $stderr",
    ({ stderr, retryable, detail = "Process exited with a non-zero status." }) =>
      Effect.gen(function* () {
        const error = yield* captureProcessResult(
          Effect.succeed({
            stdout: "",
            stderr,
            code: ChildProcessSpawner.ExitCode(128),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          }),
        );
        assert.instanceOf(error, VcsProcessExitError);
        expect(error.retryable === true).toBe(retryable);
        expect(error.detail).toBe(detail);
        const encoded = yield* encodeExitError(error);
        expect(encoded).not.toContain("private");
      }),
  );

  it.effect.each([
    {
      stderr: "fatal: fsync error on '.git/objects/a5/tmp_obj_Pseg66': Operation not supported",
      fsyncMethods: ["fsync", "writeout-only"],
    },
    {
      stderr:
        "fatal: update_ref failed for ref 'refs/t3/checkpoints/x': cannot update ref 'refs/t3/checkpoints/x': couldn't write '/Volumes/share/.git/refs/t3/checkpoints/x.lock'",
      fsyncMethods: ["fsync", "writeout-only"],
    },
    { stderr: "fatal: Operation not supported", fsyncMethods: ["fsync"] },
    {
      stderr:
        "fatal: update_ref failed for ref 'refs/t3/checkpoints/x': cannot update ref 'refs/t3/checkpoints/x': couldn't write '/Volumes/share/.git/refs/t3/checkpoints/x.lock': Input/output error",
      fsyncMethods: ["fsync"],
    },
    {
      stderr: "fatal: fsync error on '.git/objects/a5/tmp_obj_Pseg66': Operation not supported",
      fsyncMethods: ["fsync", "writeout-only"],
      fallbackFails: true,
    },
    {
      platform: "linux",
      stderr: "fatal: fsync error on '.git/objects/a5/tmp_obj_Pseg66': Operation not supported",
      fsyncMethods: ["fsync"],
    },
    {
      operation: baseInput.operation,
      stderr: "fatal: fsync error on '.git/objects/a5/tmp_obj_Pseg66': Operation not supported",
      fsyncMethods: ["fsync"],
    },
    {
      stderr: "fatal: fsync error on '.git/objects/bulk_fsync_Pseg66': Operation not supported",
      fsyncMethods: ["batch", "writeout-only"],
    },
    {
      stderr:
        "fatal: update_ref failed for ref 'refs/t3/checkpoints/x': cannot update ref 'refs/t3/checkpoints/x': couldn't write '/Volumes/share/.git/refs/t3/checkpoints/x.lock'",
      fsyncMethods: ["batch", "writeout-only"],
    },
  ] as const)(
    "falls back to writeout-only only for unsupported flushes on macOS ($fsyncMethods): $stderr",
    ({ stderr, fsyncMethods, ...scenario }) =>
      Effect.gen(function* () {
        const seen: Array<ReadonlyArray<string>> = [];
        const service = yield* VcsProcess.make.pipe(
          Effect.provideService(
            HostProcess.Platform,
            "platform" in scenario ? scenario.platform : "darwin",
          ),
          Effect.provideService(ProcessRunner.ProcessRunner, {
            run: (input) =>
              Effect.sync(() => {
                // Command Center: drop the hardened `-c` prefix and safe.directory pair.
                seen.push(input.args.slice(HOST_GIT_HARDENED_CONFIG_ARGS.length + 2));
                const failed =
                  input.args.includes(`core.fsyncMethod=${fsyncMethods[0]}`) ||
                  ("fallbackFails" in scenario && scenario.fallbackFails);
                return {
                  stdout: "",
                  stderr: failed ? stderr : "",
                  code: ChildProcessSpawner.ExitCode(failed ? 128 : 0),
                  timedOut: false,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  stdoutInvalidUtf8: false,
                  stderrInvalidUtf8: false,
                };
              }),
          }),
        );
        const exit = yield* service
          .run({
            ...baseInput,
            operation:
              "operation" in scenario
                ? scenario.operation
                : VcsProcess.CHECKPOINT_CAPTURE_OPERATION,
            args: [
              "-c",
              "core.fsync=objects,reference",
              "-c",
              ...(fsyncMethods[0] === "batch" ? ["core.fsyncMethod=fsync", "-c"] : []),
              `core.fsyncMethod=${fsyncMethods[0]}`,
              "add",
            ],
          })
          .pipe(Effect.exit);
        expect(seen).toEqual(
          fsyncMethods.map((method) => [
            "-c",
            "core.fsync=objects,reference",
            "-c",
            ...(fsyncMethods[0] === "batch"
              ? [`core.fsyncMethod=${method === "batch" ? "fsync" : method}`, "-c"]
              : []),
            `core.fsyncMethod=${method}`,
            "add",
          ]),
        );
        expect(Exit.isSuccess(exit)).toBe(
          fsyncMethods.length === 2 && !("fallbackFails" in scenario && scenario.fallbackFails),
        );
        if (Exit.isFailure(exit)) {
          expect(Cause.findErrorOption(exit.cause)).toMatchObject({
            _tag: "Some",
            value: { _tag: "VcsProcessExitError", exitCode: 128 },
          });
        }
      }),
  );

  it.effect("bounds a burst of processes that share a concurrency key", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const starts = yield* Queue.unbounded<number>();
      const active = yield* Ref.make(0);
      const peak = yield* Ref.make(0);
      const total = yield* Ref.make(0);
      const service = yield* VcsProcess.make.pipe(
        Effect.provideService(
          ProcessRunner.ProcessRunner,
          ProcessRunner.ProcessRunner.of({
            run: () =>
              Effect.gen(function* () {
                const count = yield* Ref.updateAndGet(active, (held) => held + 1);
                yield* Ref.update(peak, (held) => Math.max(held, count));
                yield* Ref.update(total, (held) => held + 1);
                yield* Queue.offer(starts, count);
                yield* Deferred.await(gate);
                return {
                  stdout: "",
                  stderr: "",
                  code: ChildProcessSpawner.ExitCode(0),
                  timedOut: false,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  stdoutInvalidUtf8: false,
                  stderrInvalidUtf8: false,
                };
              }).pipe(Effect.ensuring(Ref.update(active, (count) => count - 1))),
          }),
        ),
      );

      const burst = yield* Effect.all(
        Array.from({ length: 32 }, (_, index) =>
          service.run({
            operation: `synthetic.cli.${index}`,
            command: "host-cli",
            args: ["api", "user"],
            cwd: "/workspace",
            concurrency: { key: "host-cli", limit: 4 },
          }),
        ),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);

      yield* Effect.all(Array.from({ length: 4 }, () => Queue.take(starts)));
      yield* Effect.yieldNow;
      expect(yield* Queue.size(starts)).toBe(0);
      expect(yield* Ref.get(peak)).toBe(4);

      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(burst);
      expect(yield* Ref.get(total)).toBe(32);
      expect(yield* Ref.get(peak)).toBe(4);
    }),
  );

  it.effect("keeps git from opening a folder laid out as a bare repository", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-vcs-bare-" });
      yield* fileSystem.makeDirectory(path.join(cwd, "objects", "info"), { recursive: true });
      yield* fileSystem.makeDirectory(path.join(cwd, "refs", "heads"), { recursive: true });
      yield* fileSystem.writeFileString(path.join(cwd, "HEAD"), "ref: refs/heads/main\n");
      yield* fileSystem.writeFileString(
        path.join(cwd, "config"),
        '[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = .\n\tfsmonitor = "echo ran >> fsmonitor-runs; false"\n',
      );

      const result = yield* run({
        operation: "test.bare-repository",
        command: "git",
        args: ["status"],
        cwd,
        allowNonZeroExit: true,
      });

      expect(result.exitCode).not.toBe(0);
      expect(yield* fileSystem.exists(path.join(cwd, "fsmonitor-runs"))).toBe(false);
    }).pipe(Effect.scoped, provideLive, Effect.provide(NodeServices.layer)),
  );

  it.effect("classifies authentication failures without retaining stderr", () =>
    Effect.gen(function* () {
      const secretStderr = "authentication failed for token super-secret-token";
      const error = yield* run({
        operation: "test.authentication",
        command: "node",
        args: ["-e", "process.stderr.write(process.argv[1]); process.exit(1)", secretStderr],
        cwd: process.cwd(),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(VcsProcessExitError);
      expect(error).toMatchObject({
        operation: "test.authentication",
        command: "node",
        exitCode: 1,
        detail: "Authentication failed.",
        failureKind: "authentication",
        stderrLength: secretStderr.length,
        stderrTruncated: false,
      });
      expect(error.message).not.toContain(secretStderr);
      expect(error.message).not.toContain("super-secret-token");
    }).pipe(provideLive),
  );

  it.effect("classifies API rate limits without retaining provider stderr", () =>
    Effect.gen(function* () {
      const providerStderr =
        "GraphQL: API rate limit already exceeded for user ID 51714798 and token secret-value.";
      const error = yield* run({
        operation: "test.rate-limit",
        command: "node",
        args: ["-e", "process.stderr.write(process.argv[1]); process.exit(1)", providerStderr],
        cwd: process.cwd(),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(VcsProcessExitError);
      expect(error).toMatchObject({
        command: "node",
        exitCode: 1,
        detail: "API rate limit exceeded.",
        failureKind: "rate-limited",
        stderrLength: providerStderr.length,
        stderrTruncated: false,
      });
      expect(error.message).not.toContain(providerStderr);
      expect(error.message).not.toContain("secret-value");
    }).pipe(provideLive),
  );

  it.effect("reads a failure with the command's own classifier and names it in its terms", () =>
    Effect.gen(function* () {
      const fail = (input: Partial<VcsProcess.VcsProcessInput>) =>
        run({
          operation: "test.classify",
          command: "node",
          args: ["-e", "process.stderr.write('HTTP 404: 404 Not Found'); process.exit(1)"],
          cwd: process.cwd(),
          ...input,
        }).pipe(Effect.flip);

      expect(yield* fail({})).toMatchObject({
        failureKind: "command-failed",
        detail: "Process exited with a non-zero status.",
      });
      expect(
        yield* fail({
          classifyFailure: (stderr) => (stderr.includes("404") ? "not-found" : null),
          notFoundDetail: "Merge request not found.",
        }),
      ).toMatchObject({ failureKind: "not-found", detail: "Merge request not found." });
    }).pipe(provideLive),
  );

  it.effect("retains spawn causes without exposing process arguments in the error message", () =>
    Effect.gen(function* () {
      const secretArgument = "--token=super-secret-token";
      const error = yield* run({
        operation: "test.spawn",
        command: "definitely-not-a-t3code-executable",
        args: [secretArgument],
        cwd: process.cwd(),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(VcsProcessSpawnError);
      expect(error).toMatchObject({
        operation: "test.spawn",
        command: "definitely-not-a-t3code-executable",
        argumentCount: 1,
      });
      expect(error).toHaveProperty("cause");
      expect(error.message).not.toContain(secretArgument);
    }).pipe(provideLive),
  );

  it.effect("truncates output and appends the marker when requested", () =>
    Effect.gen(function* () {
      const result = yield* run({
        operation: "test.truncate-marker",
        command: "node",
        args: ["-e", "process.stdout.write('x'.repeat(2048))"],
        cwd: process.cwd(),
        maxOutputBytes: 128,
        appendTruncationMarker: true,
      });

      expect(result.stdoutTruncated).toBe(true);
      expect(result.stdout).toContain("[truncated]");
      expect(result.stderrTruncated).toBe(false);
    }).pipe(provideLive),
  );

  it.effect("fails with measured byte counts when output must not be truncated", () =>
    Effect.gen(function* () {
      const error = yield* run({
        operation: "test.output-limit",
        command: "node",
        args: ["-e", "process.stdout.write('x'.repeat(2048))"],
        cwd: yield* HostProcess.WorkingDirectory,
        maxOutputBytes: 128,
        outputMode: "error",
      }).pipe(Effect.flip);

      assert(error._tag === "VcsProcessOutputLimitError");
      expect(error.stream).toBe("stdout");
      expect(error.maxBytes).toBe(128);
      expect(error.observedBytes).toBeGreaterThan(error.maxBytes);
    }).pipe(provideLive),
  );

  it.effect("streams all stdout bytes beyond the buffered output cap", () =>
    Effect.gen(function* () {
      const chunks: Uint8Array[] = [];
      const result = yield* run({
        operation: "test.stream-output",
        command: "node",
        args: ["-e", "process.stdout.write('x'.repeat(131072) + '\\0S final\\0')"],
        cwd: process.cwd(),
        maxOutputBytes: 8,
        onStdoutChunk: (chunk) => chunks.push(chunk),
      });

      expect(result.stdout).toBe("xxxxxxxx");
      expect(result.stdoutTruncated).toBe(true);
      expect(Buffer.concat(chunks).toString()).toBe("x".repeat(131072) + "\0S final\0");
    }).pipe(provideLive),
  );
});
