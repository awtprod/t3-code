// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeProcess from "node:process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as TestClock from "effect/testing/TestClock";
import { describe } from "vite-plus/test";

import {
  type VerifiedScopedShellPolicyEntry,
  VERIFIED_SCOPED_SHELL_RESOURCE_LIMITS,
  __testing as VerifiedScopedShellTesting,
  buildVerifiedScopedShellBwrapArguments,
  buildVerifiedScopedShellPrlimitArguments,
  makeVerifiedLinuxScopedShell,
  verifiedScopedShellWritableFilesystemLimitExceeded,
} from "./VerifiedScopedShell.ts";

const basePolicy = (
  overrides: Partial<VerifiedScopedShellPolicyEntry> = {},
): VerifiedScopedShellPolicyEntry => ({
  allowlistId: "test.exact-command",
  executable: "/nonexistent/executable",
  argv: [],
  access: "read",
  cwd: "/nonexistent/workspace",
  timeoutMs: 5_000,
  stdoutMaxBytes: 4_096,
  stderrMaxBytes: 4_096,
  retryable: true,
  idempotent: true,
  idempotencyKey: "test-idempotency-key",
  ...overrides,
});

describe("Verified scoped shell launch construction", () => {
  it("uses a fixed Bubblewrap boundary and preserves argv without shell interpolation", () => {
    const literalArguments = ["$(touch /tmp/not-executed)", ";", "two words", "*.json"];
    const args = buildVerifiedScopedShellBwrapArguments({
      executableFd: 3,
      argv: literalArguments,
      cwdFd: 4,
      access: "write",
    });

    NodeAssert.ok(args.includes("--unshare-all"));
    NodeAssert.ok(args.includes("--unshare-user"));
    NodeAssert.ok(args.includes("--disable-userns"));
    NodeAssert.equal(args.includes("--new-session"), false);
    NodeAssert.ok(args.includes("--clearenv"));
    NodeAssert.ok(args.includes("--proc"));
    const tmpfsIndex = args.indexOf("--tmpfs");
    NodeAssert.deepStrictEqual(args.slice(tmpfsIndex - 2, tmpfsIndex + 2), [
      "--size",
      String(VERIFIED_SCOPED_SHELL_RESOURCE_LIMITS.maxPrivateTmpfsBytes),
      "--tmpfs",
      "/tmp",
    ]);
    NodeAssert.equal(args.includes("--share-net"), false);
    NodeAssert.equal(args.includes("--bind-fd"), true);
    NodeAssert.equal(args.includes("--ro-bind-fd"), true);
    NodeAssert.equal(args.includes("/opt/verified/tool"), false);
    NodeAssert.equal(args.includes("/runtime/worktrees/repository/run"), false);
    NodeAssert.equal(args.includes("/home"), false);
    const commandBoundary = args.lastIndexOf("--");
    NodeAssert.deepStrictEqual(args.slice(commandBoundary + 1), ["/command", ...literalArguments]);
  });

  it("mounts a read policy cwd read-only", () => {
    const args = buildVerifiedScopedShellBwrapArguments({
      executableFd: 3,
      argv: [],
      cwdFd: 4,
      access: "read",
    });
    const cwdBindIndex = args.lastIndexOf("--ro-bind-fd");
    NodeAssert.deepStrictEqual(args.slice(cwdBindIndex, cwdBindIndex + 3), [
      "--ro-bind-fd",
      "4",
      "/workspace",
    ]);
  });

  it("overlays linked-worktree Git metadata read-only", () => {
    const args = buildVerifiedScopedShellBwrapArguments({
      executableFd: 3,
      argv: [],
      cwdFd: 4,
      access: "write",
      gitMetadata: {
        dotGitFd: 7,
        commonGitDirFd: 8,
        commonGitDirPath: "/runtime/repositories/repository/.git",
      },
    });
    const commonGitDirIndex = args.indexOf("/runtime/repositories/repository/.git");
    NodeAssert.deepStrictEqual(args.slice(commonGitDirIndex - 4, commonGitDirIndex + 4), [
      "--dir",
      "/runtime/repositories/repository",
      "--ro-bind-fd",
      "8",
      "/runtime/repositories/repository/.git",
      "--ro-bind-fd",
      "7",
      "/workspace/.git",
    ]);
  });

  it("executes pinned Bubblewrap behind exact hard Linux resource limits", () => {
    const bwrapArguments = ["--unshare-all", "--", "/command", "literal argument"];
    const args = buildVerifiedScopedShellPrlimitArguments({
      bwrapFd: 5,
      bwrapArguments,
      timeoutMs: 4_500,
      maxProcesses: 73,
    });

    NodeAssert.ok(args.includes("--nproc=73:73"));
    NodeAssert.ok(args.includes("--cpu=5:5"));
    NodeAssert.ok(
      args.includes(
        `--as=${VERIFIED_SCOPED_SHELL_RESOURCE_LIMITS.maxAddressSpaceBytes}:${VERIFIED_SCOPED_SHELL_RESOURCE_LIMITS.maxAddressSpaceBytes}`,
      ),
    );
    NodeAssert.ok(
      args.includes(
        `--fsize=${VERIFIED_SCOPED_SHELL_RESOURCE_LIMITS.maxFileSizeBytes}:${VERIFIED_SCOPED_SHELL_RESOURCE_LIMITS.maxFileSizeBytes}`,
      ),
    );
    NodeAssert.ok(
      args.includes(
        `--nofile=${VERIFIED_SCOPED_SHELL_RESOURCE_LIMITS.maxOpenFiles}:${VERIFIED_SCOPED_SHELL_RESOURCE_LIMITS.maxOpenFiles}`,
      ),
    );
    NodeAssert.ok(args.includes("--core=0:0"));
    const commandBoundary = args.indexOf("--");
    NodeAssert.deepStrictEqual(args.slice(commandBoundary + 1), [
      "/proc/self/fd/5",
      ...bwrapArguments,
    ]);
  });

  it("enforces both writable-growth and free-space reserve thresholds", () => {
    const limits = VERIFIED_SCOPED_SHELL_RESOURCE_LIMITS;
    const baseline = BigInt(
      limits.minWritableFilesystemAvailableBytes + limits.maxWritableFilesystemDeltaBytes + 1_024,
    );
    NodeAssert.equal(
      verifiedScopedShellWritableFilesystemLimitExceeded({
        baselineAvailableBytes: baseline,
        currentAvailableBytes: baseline - BigInt(limits.maxWritableFilesystemDeltaBytes),
      }),
      false,
    );
    NodeAssert.equal(
      verifiedScopedShellWritableFilesystemLimitExceeded({
        baselineAvailableBytes: baseline,
        currentAvailableBytes: baseline - BigInt(limits.maxWritableFilesystemDeltaBytes) - 1n,
      }),
      true,
    );
    NodeAssert.equal(
      verifiedScopedShellWritableFilesystemLimitExceeded({
        baselineAvailableBytes: baseline,
        currentAvailableBytes: BigInt(limits.minWritableFilesystemAvailableBytes) - 1n,
      }),
      true,
    );
  });
});

it.layer(NodeServices.layer)("Verified scoped shell admission", (it) => {
  it.effect("fails closed on unsupported platforms before inspecting paths", () =>
    Effect.gen(function* () {
      const service = yield* makeVerifiedLinuxScopedShell().pipe(
        Effect.provideService(HostProcessPlatform, "darwin"),
      );
      const error = yield* service
        .execute({
          policy: basePolicy(),
          runtime: {
            allowedRoots: [{ canonicalPath: "/nonexistent", access: "read" }],
          },
        })
        .pipe(Effect.flip);
      NodeAssert.equal(error.code, "unsupported-platform");
    }),
  );

  it.effect("rejects malformed argv and unsafe retry metadata", () =>
    Effect.gen(function* () {
      const service = yield* makeVerifiedLinuxScopedShell();
      const malformedArgv = yield* service
        .execute({
          policy: basePolicy({ argv: ["bad\0argument"] }),
          runtime: {
            allowedRoots: [{ canonicalPath: "/nonexistent", access: "read" }],
          },
        })
        .pipe(Effect.flip);
      NodeAssert.equal(malformedArgv.code, "invalid-policy");

      const unsafeRetry = yield* service
        .execute({
          policy: basePolicy({ retryable: true, idempotent: false }),
          runtime: {
            allowedRoots: [{ canonicalPath: "/nonexistent", access: "read" }],
          },
        })
        .pipe(Effect.flip);
      NodeAssert.equal(unsafeRetry.code, "invalid-policy");
      NodeAssert.match(unsafeRetry.message, /must be idempotent/u);
    }),
  );

  it.effect("rejects executable and cwd symlink paths", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cc-scoped-symlink-" });
      const realCwd = path.join(root, "real-cwd");
      const linkedCwd = path.join(root, "linked-cwd");
      const linkedExecutable = path.join(root, "linked-executable");
      yield* fileSystem.makeDirectory(realCwd);
      yield* fileSystem.symlink(realCwd, linkedCwd);
      yield* fileSystem.symlink(NodeProcess.execPath, linkedExecutable);
      const service = yield* makeVerifiedLinuxScopedShell();

      const executableError = yield* service
        .execute({
          policy: basePolicy({ executable: linkedExecutable, cwd: realCwd }),
          runtime: { allowedRoots: [{ canonicalPath: root, access: "read" }] },
        })
        .pipe(Effect.flip);
      NodeAssert.equal(executableError.code, "path-not-canonical");

      const cwdError = yield* service
        .execute({
          policy: basePolicy({
            executable: yield* fileSystem.realPath(NodeProcess.execPath),
            cwd: linkedCwd,
          }),
          runtime: { allowedRoots: [{ canonicalPath: root, access: "read" }] },
        })
        .pipe(Effect.flip);
      NodeAssert.equal(cwdError.code, "path-not-canonical");
    }),
  );

  it.effect("rejects cwd outside roots and runtime binaries under writable roots", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cc-scoped-roots-" });
      const cwd = path.join(root, "cwd");
      const outsideRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "cc-scoped-outside-",
      });
      yield* fileSystem.makeDirectory(cwd);
      const executable = yield* fileSystem.realPath(NodeProcess.execPath);
      const service = yield* makeVerifiedLinuxScopedShell();

      const outsideError = yield* service
        .execute({
          policy: basePolicy({ executable, cwd }),
          runtime: { allowedRoots: [{ canonicalPath: outsideRoot, access: "read" }] },
        })
        .pipe(Effect.flip);
      NodeAssert.equal(outsideError.code, "path-outside-roots");

      const unsafeRuntime = yield* service
        .execute({
          policy: basePolicy({ executable, cwd, access: "write" }),
          runtime: { allowedRoots: [{ canonicalPath: "/", access: "write" }] },
        })
        .pipe(Effect.flip);
      NodeAssert.equal(unsafeRuntime.code, "invalid-policy", unsafeRuntime.message);
      NodeAssert.match(unsafeRuntime.message, /requires pinned linked-worktree Git metadata/u);
    }),
  );
});

const RUN_LIVE_BWRAP =
  NodeProcess.platform === "linux" && NodeProcess.env.CC_SCOPED_SHELL_LIVE === "1";

describe.runIf(RUN_LIVE_BWRAP).sequential("Verified scoped shell live Bubblewrap boundary", () => {
  it.layer(NodeServices.layer)("live execution", (it) => {
    const prepare = Effect.fn("VerifiedScopedShell.test.prepare")(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cc-scoped-live-" });
      const cwd = path.join(root, "workspace");
      const commonGitDir = path.join(root, "repository.git");
      const perWorktreeGitDir = path.join(commonGitDir, "worktrees", "live");
      yield* fileSystem.makeDirectory(cwd);
      yield* fileSystem.makeDirectory(perWorktreeGitDir, { recursive: true });
      yield* fileSystem.makeDirectory(path.join(commonGitDir, "hooks"));
      yield* fileSystem.writeFileString(
        path.join(commonGitDir, "config"),
        "[core]\n\trepositoryformatversion = 0\n",
      );
      const dotGitPath = path.join(cwd, ".git");
      yield* fileSystem.writeFileString(dotGitPath, `gitdir: ${perWorktreeGitDir}\n`);
      return {
        fileSystem,
        path,
        root,
        cwd,
        dotGitPath,
        commonGitDir,
        runtime: (access: "read" | "write") => ({
          allowedRoots: [{ canonicalPath: cwd, access }],
          gitMetadata: { dotGitPath, commonGitDir },
        }),
        executable: yield* fileSystem.realPath("/usr/bin/python3"),
        service: yield* makeVerifiedLinuxScopedShell(),
      } as const;
    });

    it.effect("keeps a permit until a SIGTERM-stubborn detached group is killed and reaped", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "cc-scoped-reap-",
        });
        const readyPath = path.join(directory, "ready");
        const termPath = path.join(directory, "term");
        const child = NodeChildProcess.spawn(
          "/usr/bin/python3",
          [
            "-c",
            [
              "import pathlib, signal, sys, time",
              "ready = pathlib.Path(sys.argv[1])",
              "term = pathlib.Path(sys.argv[2])",
              'def ignore_term(_signal, _frame): term.write_text("seen", encoding="utf-8")',
              "signal.signal(signal.SIGTERM, ignore_term)",
              'ready.write_text("ready", encoding="utf-8")',
              "while True: time.sleep(0.05)",
            ].join("\n"),
            readyPath,
            termPath,
          ],
          { detached: true, stdio: "ignore" },
        );
        child.on("error", () => undefined);
        yield* Effect.addFinalizer(() =>
          VerifiedScopedShellTesting.terminateProcessGroupAndReap(child, "immediate"),
        );

        let started = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          started = yield* fileSystem.exists(readyPath);
          if (started) break;
          yield* Effect.sleep("10 millis");
        }
        NodeAssert.equal(started, true, "the stubborn detached child did not start");

        const slots = yield* Semaphore.make(1);
        const cleanupStartedAt = yield* Clock.currentTimeMillis;
        const cleanup = yield* slots
          .withPermits(1)(
            VerifiedScopedShellTesting.terminateProcessGroupAndReap(child, "graceful"),
          )
          .pipe(Effect.forkScoped);
        let termObserved = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          termObserved = yield* fileSystem.exists(termPath);
          if (termObserved) break;
          yield* Effect.sleep("10 millis");
        }
        NodeAssert.equal(termObserved, true, "the stubborn child did not observe SIGTERM");

        const replacementDuringReap = yield* slots.withPermitsIfAvailable(1)(Effect.void);
        NodeAssert.equal(Option.isNone(replacementDuringReap), true);
        yield* Fiber.join(cleanup);
        NodeAssert.ok(
          (yield* Clock.currentTimeMillis) - cleanupStartedAt >= 900,
          "SIGKILL escalation ran too early",
        );
        NodeAssert.equal(child.signalCode, "SIGKILL");
        NodeAssert.equal(
          VerifiedScopedShellTesting.processGroupIsAlive(child.pid!),
          false,
          "the terminator returned while its process group was still alive",
        );
        const replacementAfterReap = yield* slots.withPermitsIfAvailable(1)(Effect.void);
        NodeAssert.equal(Option.isSome(replacementAfterReap), true);
      }).pipe(TestClock.withLive),
    );

    it.effect("joins a spawned process when acquisition itself is interrupted", () =>
      Effect.gen(function* () {
        const fixture = yield* prepare();
        const service = yield* VerifiedScopedShellTesting.makeWithSpawnSettlementDelay(1_000);
        const execute = (allowlistId: string, script: string) =>
          service.execute({
            policy: basePolicy({
              allowlistId,
              executable: fixture.executable,
              cwd: fixture.cwd,
              argv: ["-c", script],
              access: "write",
              timeoutMs: 4_000,
              stderrMaxBytes: 512,
            }),
            runtime: fixture.runtime("write"),
          });
        const acquiring = yield* execute(
          "live.acquire-interrupt",
          [
            "import pathlib, subprocess, sys, time",
            'pathlib.Path("acquire.ready").write_text("ready", encoding="utf-8")',
            "subprocess.Popen([sys.executable, '-c', 'import pathlib,time; time.sleep(0.5); pathlib.Path(\"acquire-leak\").write_text(\"bad\")'])",
            "time.sleep(0.5)",
            'pathlib.Path("acquire-parent-leak").write_text("bad", encoding="utf-8")',
            "time.sleep(4.5)",
          ].join("\n"),
        ).pipe(Effect.forkScoped);

        let spawnedBeforeSettlement = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          spawnedBeforeSettlement = yield* fixture.fileSystem.exists(
            fixture.path.join(fixture.cwd, "acquire.ready"),
          );
          if (spawnedBeforeSettlement) break;
          yield* Effect.sleep("10 millis");
        }
        NodeAssert.equal(
          spawnedBeforeSettlement,
          true,
          "the delayed acquisition did not spawn its process",
        );
        yield* Fiber.interrupt(acquiring);
        yield* Effect.sleep("700 millis");
        NodeAssert.equal(
          yield* fixture.fileSystem.exists(fixture.path.join(fixture.cwd, "acquire-parent-leak")),
          false,
          "acquisition interruption did not terminate the sandbox command",
        );
        NodeAssert.equal(
          yield* fixture.fileSystem.exists(fixture.path.join(fixture.cwd, "acquire-leak")),
          false,
          "acquisition interruption returned before its descendant was gone",
        );

        const first = yield* execute(
          "live.acquire-slot-one",
          'import pathlib,time; pathlib.Path("slot-one.ready").write_text("ready", encoding="utf-8"); time.sleep(1.5)',
        ).pipe(Effect.forkScoped);
        const second = yield* execute(
          "live.acquire-slot-two",
          'import pathlib,time; pathlib.Path("slot-two.ready").write_text("ready", encoding="utf-8"); time.sleep(1.5)',
        ).pipe(Effect.forkScoped);
        let bothReplacementSlotsStarted = false;
        for (let attempt = 0; attempt < 150; attempt += 1) {
          bothReplacementSlotsStarted =
            (yield* fixture.fileSystem.exists(fixture.path.join(fixture.cwd, "slot-one.ready"))) &&
            (yield* fixture.fileSystem.exists(fixture.path.join(fixture.cwd, "slot-two.ready")));
          if (bothReplacementSlotsStarted) break;
          yield* Effect.sleep("10 millis");
        }
        NodeAssert.equal(
          bothReplacementSlotsStarted,
          true,
          "acquisition cleanup failed to restore both execution slots",
        );
        NodeAssert.equal((yield* Fiber.join(first)).exitCode, 0);
        NodeAssert.equal((yield* Fiber.join(second)).exitCode, 0);
      }).pipe(TestClock.withLive),
    );

    it.effect(
      "hides host env/proc/home, denies network, and permits a bounded workspace write",
      () =>
        Effect.gen(function* () {
          const fixture = yield* prepare();
          const script = [
            "import glob, os, socket, sys",
            'blocked = (b"CODEX_HOME=", b"SSH_AUTH_SOCK=", b"T3_MCP_BEARER_TOKEN=", b"OPENAI_API_KEY=")',
            'for environment_file in glob.glob("/proc/[0-9]*/environ"):',
            "    try:",
            '        data = open(environment_file, "rb").read()',
            "    except OSError:",
            "        continue",
            "    if any(name in data for name in blocked):",
            "        sys.exit(80)",
            "if os.getppid() != 1:",
            "    sys.exit(81)",
            'if os.path.exists("/home"):',
            "    sys.exit(82)",
            "probe = socket.socket()",
            "probe.settimeout(0.5)",
            "try:",
            '    probe.connect(("1.1.1.1", 53))',
            "except OSError:",
            "    pass",
            "else:",
            "    sys.exit(83)",
            "finally:",
            "    probe.close()",
            'open("created.txt", "w", encoding="utf-8").write("ok\\n")',
            'print("isolated-ok")',
          ].join("\n");
          const result = yield* fixture.service.execute({
            policy: basePolicy({
              allowlistId: "live.write-probe",
              executable: fixture.executable,
              cwd: fixture.cwd,
              argv: ["-c", script],
              access: "write",
              stdoutMaxBytes: 64,
              stderrMaxBytes: 512,
            }),
            runtime: fixture.runtime("write"),
          });

          NodeAssert.equal(result.exitCode, 0, result.stderr);
          NodeAssert.equal(result.stdout, "isolated-ok\n");
          NodeAssert.equal(result.stdoutTruncated, false);
          NodeAssert.equal(
            yield* fixture.fileSystem.readFileString(fixture.path.join(fixture.cwd, "created.txt")),
            "ok\n",
          );
        }).pipe(TestClock.withLive),
    );

    it.effect("keeps linked-worktree Git metadata immutable inside a writable sandbox", () =>
      Effect.gen(function* () {
        const fixture = yield* prepare();
        const originalPointer = yield* fixture.fileSystem.readFileString(fixture.dotGitPath);
        const script = [
          "import errno, os, pathlib, sys",
          'dot_git = pathlib.Path(".git")',
          "common = pathlib.Path(sys.argv[1])",
          'target = pathlib.Path(dot_git.read_text(encoding="utf-8").strip().split(":", 1)[1].strip())',
          "if not target.is_dir() or common not in target.parents:",
          "    sys.exit(100)",
          "def must_fail(action):",
          "    try:",
          "        action()",
          "    except OSError as error:",
          "        if error.errno not in (errno.EACCES, errno.EBUSY, errno.EPERM, errno.EROFS, errno.EXDEV):",
          "            raise",
          "    else:",
          "        sys.exit(101)",
          'must_fail(lambda: dot_git.write_text("gitdir: /tmp/replacement\\n", encoding="utf-8"))',
          "must_fail(lambda: dot_git.unlink())",
          'must_fail(lambda: dot_git.rename(".git-replaced"))',
          'must_fail(lambda: (common / "config").write_text("[core]\\nfsmonitor = configured-callback\\n", encoding="utf-8"))',
          'must_fail(lambda: (common / "hooks" / "post-checkout").write_text("#!/bin/sh\\n", encoding="utf-8"))',
          'must_fail(lambda: os.link(common / "config", pathlib.Path("metadata-config-link")))',
          'pathlib.Path("ordinary-write").write_text("ok\\n", encoding="utf-8")',
          'print("git-metadata-read-only")',
        ].join("\n");
        const result = yield* fixture.service.execute({
          policy: basePolicy({
            allowlistId: "live.git-metadata-integrity",
            executable: fixture.executable,
            cwd: fixture.cwd,
            argv: ["-c", script, fixture.commonGitDir],
            access: "write",
            stdoutMaxBytes: 64,
            stderrMaxBytes: 512,
          }),
          runtime: fixture.runtime("write"),
        });

        NodeAssert.equal(result.exitCode, 0, result.stderr);
        NodeAssert.equal(result.stdout, "git-metadata-read-only\n");
        NodeAssert.equal(
          yield* fixture.fileSystem.readFileString(fixture.dotGitPath),
          originalPointer,
        );
        NodeAssert.equal(
          yield* fixture.fileSystem.exists(fixture.path.join(fixture.cwd, ".git-replaced")),
          false,
        );
        NodeAssert.equal(
          yield* fixture.fileSystem.readFileString(
            fixture.path.join(fixture.commonGitDir, "config"),
          ),
          "[core]\n\trepositoryformatversion = 0\n",
        );
        NodeAssert.equal(
          yield* fixture.fileSystem.exists(fixture.path.join(fixture.cwd, "metadata-config-link")),
          false,
        );
        NodeAssert.equal(
          yield* fixture.fileSystem.exists(
            fixture.path.join(fixture.commonGitDir, "hooks", "post-checkout"),
          ),
          false,
        );
        NodeAssert.equal(
          yield* fixture.fileSystem.readFileString(
            fixture.path.join(fixture.cwd, "ordinary-write"),
          ),
          "ok\n",
        );
      }).pipe(TestClock.withLive),
    );

    it.effect("mounts read workspaces read-only", () =>
      Effect.gen(function* () {
        const fixture = yield* prepare();
        const script = [
          "import errno, pathlib, sys",
          "try:",
          '    pathlib.Path("must-not-exist").write_text("blocked", encoding="utf-8")',
          "except OSError as error:",
          "    if error.errno not in (errno.EACCES, errno.EROFS):",
          "        raise",
          '    print("read-only-ok")',
          "else:",
          "    sys.exit(90)",
        ].join("\n");
        const result = yield* fixture.service.execute({
          policy: basePolicy({
            allowlistId: "live.read-probe",
            executable: fixture.executable,
            cwd: fixture.cwd,
            argv: ["-c", script],
            access: "read",
          }),
          runtime: fixture.runtime("read"),
        });

        NodeAssert.equal(result.exitCode, 0, result.stderr);
        NodeAssert.equal(result.stdout, "read-only-ok\n");
        NodeAssert.equal(
          yield* fixture.fileSystem.exists(fixture.path.join(fixture.cwd, "must-not-exist")),
          false,
        );
      }).pipe(TestClock.withLive),
    );

    it.effect("inherits hard CPU, task, address-space, file, descriptor, and core limits", () =>
      Effect.gen(function* () {
        const fixture = yield* prepare();
        const limits = VERIFIED_SCOPED_SHELL_RESOURCE_LIMITS;
        const script = [
          "import errno, mmap, pathlib, resource, sys",
          `expected = {"cpu": 5, "as": ${limits.maxAddressSpaceBytes}, "fsize": ${limits.maxFileSizeBytes}, "nofile": ${limits.maxOpenFiles}, "core": 0}`,
          "checks = ((resource.RLIMIT_CPU, expected['cpu']), (resource.RLIMIT_AS, expected['as']), (resource.RLIMIT_FSIZE, expected['fsize']), (resource.RLIMIT_NOFILE, expected['nofile']), (resource.RLIMIT_CORE, expected['core']))",
          "for kind, expected_value in checks:",
          "    soft, hard = resource.getrlimit(kind)",
          "    if (soft, hard) != (expected_value, expected_value):",
          "        sys.exit(91)",
          "process_soft, process_hard = resource.getrlimit(resource.RLIMIT_NPROC)",
          "if process_soft != process_hard or not (1 <= process_soft <= 16384):",
          "    sys.exit(92)",
          "try:",
          "    allocation = mmap.mmap(-1, expected['as'] * 2)",
          "except (MemoryError, OSError, OverflowError):",
          "    pass",
          "else:",
          "    allocation.close()",
          "    sys.exit(93)",
          'target = pathlib.Path("oversized-sparse-file")',
          "try:",
          '    with target.open("wb") as handle:',
          "        handle.seek(expected['fsize'])",
          '        handle.write(b"x")',
          "        handle.flush()",
          "except OSError as error:",
          "    if error.errno != errno.EFBIG:",
          "        raise",
          "else:",
          "    sys.exit(94)",
          'print("resource-limits-ok")',
        ].join("\n");
        const result = yield* fixture.service.execute({
          policy: basePolicy({
            allowlistId: "live.resource-limits",
            executable: fixture.executable,
            cwd: fixture.cwd,
            argv: ["-c", script],
            access: "write",
            timeoutMs: 5_000,
            stdoutMaxBytes: 64,
            stderrMaxBytes: 512,
          }),
          runtime: fixture.runtime("write"),
        });

        NodeAssert.equal(result.exitCode, 0, result.stderr);
        NodeAssert.equal(result.stdout, "resource-limits-ok\n");
        const oversizedPath = fixture.path.join(fixture.cwd, "oversized-sparse-file");
        NodeAssert.equal(yield* fixture.fileSystem.exists(oversizedPath), true);
        NodeAssert.ok(
          (yield* fixture.fileSystem.stat(oversizedPath)).size <=
            BigInt(VERIFIED_SCOPED_SHELL_RESOURCE_LIMITS.maxFileSizeBytes),
        );
      }).pipe(TestClock.withLive),
    );

    it.effect("kernel-bounds private temporary storage and keeps HOME inside it", () =>
      Effect.gen(function* () {
        const fixture = yield* prepare();
        const limits = VERIFIED_SCOPED_SHELL_RESOURCE_LIMITS;
        const script = [
          "import errno, os, pathlib, sys",
          `expected = ${limits.maxPrivateTmpfsBytes}`,
          'home = pathlib.Path(os.environ.get("HOME", ""))',
          'if home != pathlib.Path("/tmp/home") or not home.is_dir():',
          "    sys.exit(95)",
          "stats = os.statvfs('/tmp')",
          "capacity = stats.f_blocks * stats.f_frsize",
          "if capacity <= 0 or capacity > expected:",
          "    sys.exit(96)",
          "chunk = b'x' * (1024 * 1024)",
          "written = 0",
          "blocked = False",
          "for index in range(1024):",
          "    try:",
          "        with open(f'/tmp/fill-{index}', 'wb') as handle:",
          "            handle.write(chunk)",
          "            handle.flush()",
          "        written += len(chunk)",
          "    except OSError as error:",
          "        if error.errno != errno.ENOSPC:",
          "            raise",
          "        blocked = True",
          "        break",
          "if not blocked or written > expected:",
          "    sys.exit(97)",
          'print("tmpfs-cap-ok")',
        ].join("\n");
        const result = yield* fixture.service.execute({
          policy: basePolicy({
            allowlistId: "live.tmpfs-limit",
            executable: fixture.executable,
            cwd: fixture.cwd,
            argv: ["-c", script],
            access: "write",
            timeoutMs: 5_000,
            stdoutMaxBytes: 64,
            stderrMaxBytes: 512,
          }),
          runtime: fixture.runtime("write"),
        });

        NodeAssert.equal(result.exitCode, 0, result.stderr);
        NodeAssert.equal(result.stdout, "tmpfs-cap-ok\n");
      }).pipe(TestClock.withLive),
    );

    it.effect("fails fast instead of queueing beyond the global execution capacity", () =>
      Effect.gen(function* () {
        const fixture = yield* prepare();
        const hold = (name: string) =>
          fixture.service.execute({
            policy: basePolicy({
              allowlistId: `live.capacity-${name}`,
              executable: fixture.executable,
              cwd: fixture.cwd,
              argv: [
                "-c",
                `import pathlib,time; pathlib.Path("${name}.ready").write_text("ready", encoding="utf-8"); time.sleep(2)`,
              ],
              access: "write",
              timeoutMs: 5_000,
            }),
            runtime: fixture.runtime("write"),
          });
        const first = yield* hold("first").pipe(Effect.forkScoped);
        const second = yield* hold("second").pipe(Effect.forkScoped);

        let bothStarted = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          bothStarted =
            (yield* fixture.fileSystem.exists(fixture.path.join(fixture.cwd, "first.ready"))) &&
            (yield* fixture.fileSystem.exists(fixture.path.join(fixture.cwd, "second.ready")));
          if (bothStarted) break;
          yield* Effect.sleep("20 millis");
        }
        NodeAssert.equal(bothStarted, true, "both capacity-holding commands did not start");

        const saturated = yield* fixture.service
          .execute({
            policy: basePolicy({
              allowlistId: "live.capacity-denied",
              executable: fixture.executable,
              cwd: fixture.cwd,
            }),
            runtime: fixture.runtime("read"),
          })
          .pipe(Effect.flip);
        NodeAssert.equal(saturated.code, "spawn-failed");
        NodeAssert.match(saturated.message, /concurrency is at capacity/u);

        NodeAssert.equal((yield* Fiber.join(first)).exitCode, 0);
        NodeAssert.equal((yield* Fiber.join(second)).exitCode, 0);
        const afterRelease = yield* fixture.service.execute({
          policy: basePolicy({
            allowlistId: "live.capacity-released",
            executable: fixture.executable,
            cwd: fixture.cwd,
            argv: ["-c", 'print("capacity-released")'],
          }),
          runtime: fixture.runtime("read"),
        });
        NodeAssert.equal(afterRelease.exitCode, 0, afterRelease.stderr);
        NodeAssert.equal(afterRelease.stdout, "capacity-released\n");
      }).pipe(TestClock.withLive),
    );

    it.effect("interrupts a running sandbox only after its descendants are gone", () =>
      Effect.gen(function* () {
        const fixture = yield* prepare();
        const interrupted = yield* fixture.service
          .execute({
            policy: basePolicy({
              allowlistId: "live.interrupt-descendants",
              executable: fixture.executable,
              cwd: fixture.cwd,
              argv: [
                "-c",
                [
                  "import pathlib, subprocess, sys, time",
                  'pathlib.Path("interrupt.ready").write_text("ready", encoding="utf-8")',
                  "subprocess.Popen([sys.executable, '-c', 'import pathlib,time; time.sleep(0.5); pathlib.Path(\"interrupt-leak\").write_text(\"bad\")'])",
                  "time.sleep(5)",
                ].join("\n"),
              ],
              access: "write",
              timeoutMs: 6_000,
              stderrMaxBytes: 512,
            }),
            runtime: fixture.runtime("write"),
          })
          .pipe(Effect.forkScoped);

        let started = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          started = yield* fixture.fileSystem.exists(
            fixture.path.join(fixture.cwd, "interrupt.ready"),
          );
          if (started) break;
          yield* Effect.sleep("10 millis");
        }
        NodeAssert.equal(started, true, "the interrupt target did not start");
        yield* Fiber.interrupt(interrupted);
        yield* Effect.sleep("700 millis");
        NodeAssert.equal(
          yield* fixture.fileSystem.exists(fixture.path.join(fixture.cwd, "interrupt-leak")),
          false,
          "an interrupted sandbox descendant survived finalization",
        );

        const replacement = yield* fixture.service.execute({
          policy: basePolicy({
            allowlistId: "live.interrupt-replacement",
            executable: fixture.executable,
            cwd: fixture.cwd,
            argv: ["-c", 'print("replacement-ok")'],
          }),
          runtime: fixture.runtime("read"),
        });
        NodeAssert.equal(replacement.exitCode, 0, replacement.stderr);
        NodeAssert.equal(replacement.stdout, "replacement-ok\n");
      }).pipe(TestClock.withLive),
    );

    it.effect("rejects an executable controlled by the server user", () =>
      Effect.gen(function* () {
        const fixture = yield* prepare();
        const executable = fixture.path.join(fixture.root, "user-owned-command");
        yield* fixture.fileSystem.writeFileString(executable, "#!/bin/sh\nexit 0\n");
        yield* fixture.fileSystem.chmod(executable, 0o700);

        const denied = yield* fixture.service
          .execute({
            policy: basePolicy({
              allowlistId: "live.user-owned-executable",
              executable,
              cwd: fixture.cwd,
            }),
            runtime: fixture.runtime("read"),
          })
          .pipe(Effect.flip);

        NodeAssert.equal(denied.code, "unsafe-runtime-location");
        NodeAssert.match(denied.message, /root-owned/u);
      }),
    );

    it.effect("truncates output and enforces the policy timeout", () =>
      Effect.gen(function* () {
        const fixture = yield* prepare();
        const truncated = yield* fixture.service.execute({
          policy: basePolicy({
            allowlistId: "live.output-cap",
            executable: fixture.executable,
            cwd: fixture.cwd,
            argv: ["-c", 'print("x" * 10_000)'],
            stdoutMaxBytes: 32,
          }),
          runtime: fixture.runtime("read"),
        });
        NodeAssert.equal(truncated.exitCode, 0, truncated.stderr);
        NodeAssert.equal(Buffer.byteLength(truncated.stdout), 32);
        NodeAssert.equal(truncated.stdoutTruncated, true);

        const timeout = yield* fixture.service
          .execute({
            policy: basePolicy({
              allowlistId: "live.timeout",
              executable: fixture.executable,
              cwd: fixture.cwd,
              argv: [
                "-c",
                [
                  "import subprocess, sys, time",
                  "subprocess.Popen([sys.executable, '-c', 'import pathlib,time; time.sleep(0.5); pathlib.Path(\"timeout-leak\").write_text(\"bad\")'])",
                  "time.sleep(5)",
                ].join("\n"),
              ],
              access: "write",
              timeoutMs: 100,
            }),
            runtime: fixture.runtime("write"),
          })
          .pipe(Effect.flip);
        NodeAssert.equal(timeout.code, "timeout");
        yield* Effect.sleep("700 millis");
        NodeAssert.equal(
          yield* fixture.fileSystem.exists(fixture.path.join(fixture.cwd, "timeout-leak")),
          false,
          "a timed-out sandbox descendant survived process-group cleanup",
        );
      }).pipe(TestClock.withLive),
    );
  });
});
