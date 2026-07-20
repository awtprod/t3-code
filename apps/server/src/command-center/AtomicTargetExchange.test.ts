import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeTimersPromises from "node:timers/promises";

import * as ProcessRunner from "../processRunner.ts";
import { makeAtomicTargetExchange } from "./AtomicTargetExchange.ts";

const makeFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.make();
  const exchange = yield* makeAtomicTargetExchange().pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
  );
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "command-center-atomic-exchange-" });
  const targetDirectory = path.join(root, "automations");
  const recoveryDirectory = path.join(root, "recovery");
  const targetPath = path.join(targetDirectory, "sample.json");
  const recoveryPath = path.join(recoveryDirectory, "authored");
  const originalContents = '{"version":"original"}\n';
  const authoredContents = '{"version":"authored"}\n';
  yield* fs.makeDirectory(targetDirectory);
  yield* fs.makeDirectory(recoveryDirectory);
  yield* fs.chmod(recoveryDirectory, 0o700);
  yield* fs.writeFileString(targetPath, originalContents);
  yield* fs.writeFileString(recoveryPath, authoredContents, { mode: 0o600 });

  const targetDirectoryIdentity = yield* exchange.captureDirectory(targetDirectory);
  const recoveryDirectoryIdentity = yield* exchange.captureDirectory(recoveryDirectory);
  const originalIdentity = yield* exchange.captureFile(targetPath);
  const authoredIdentity = yield* exchange.captureFile(recoveryPath);
  const publishInput = {
    operation: "publish" as const,
    manifestId: "publish",
    targetDirectory,
    targetName: "sample.json",
    recoveryDirectory,
    recoveryName: "authored",
    expectedTargetDirectory: targetDirectoryIdentity,
    expectedRecoveryDirectory: recoveryDirectoryIdentity,
    expectedTarget: originalIdentity,
    expectedRecovery: authoredIdentity,
  };

  return {
    fs,
    path,
    runner,
    exchange,
    root,
    targetDirectory,
    recoveryDirectory,
    targetPath,
    recoveryPath,
    originalContents,
    authoredContents,
    originalIdentity,
    authoredIdentity,
    publishInput,
  };
});

const waitForPath = Effect.fn("AtomicTargetExchangeTest.waitForPath")(function* (
  fs: FileSystem.FileSystem,
  filePath: string,
) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false))) return;
    yield* Effect.promise(() => NodeTimersPromises.setTimeout(5));
  }
  return yield* Effect.die(new Error(`Timed out waiting for ${filePath}`));
});

it.layer(NodeServices.layer)("atomic target exchange", (it) => {
  it.effect("fsyncs only a pinned canonical directory", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const identity = yield* fixture.exchange.captureDirectory(fixture.targetDirectory);
      yield* fixture.exchange.syncDirectory(fixture.targetDirectory, identity);

      const movedDirectory = fixture.path.join(fixture.root, "durability-opened");
      yield* fixture.fs.rename(fixture.targetDirectory, movedDirectory);
      yield* fixture.fs.makeDirectory(fixture.targetDirectory);
      const failure = yield* fixture.exchange
        .syncDirectory(fixture.targetDirectory, identity)
        .pipe(Effect.flip);

      expect(failure).toMatchObject({ _tag: "CommandCenterError", reason: "conflict" });
      expect(
        yield* fixture.fs.readFileString(fixture.path.join(movedDirectory, "sample.json")),
      ).toBe(fixture.originalContents);
    }),
  );

  it.effect("preserves a newly created file with a durable identity-bound move", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const recoveredPath = fixture.path.join(fixture.recoveryDirectory, "created");
      const recovered = yield* fixture.exchange.preserveCreated({
        manifestId: "preserve-created",
        sourceDirectory: fixture.targetDirectory,
        sourceName: "sample.json",
        recoveryDirectory: fixture.recoveryDirectory,
        recoveryName: "created",
        expectedSourceDirectory: fixture.publishInput.expectedTargetDirectory,
        expectedRecoveryDirectory: fixture.publishInput.expectedRecoveryDirectory,
        expectedSource: fixture.originalIdentity,
      });

      expect(yield* fixture.fs.exists(fixture.targetPath)).toBe(false);
      expect(yield* fixture.fs.readFileString(recoveredPath)).toBe(fixture.originalContents);
      expect(recovered).toEqual(fixture.originalIdentity);
      expect(
        yield* fixture.fs.readFileString(
          fixture.path.join(fixture.recoveryDirectory, "backup.preserve-created.source"),
        ),
      ).toBe(fixture.originalContents);
      expect(
        yield* fixture.fs.readFileString(
          fixture.path.join(fixture.recoveryDirectory, "manifest.preserve-created.complete.json"),
        ),
      ).toContain('"operation":"preserve-created"');
    }),
  );

  it.effect(
    "never moves a replacement introduced immediately before created-file preservation",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const readyPath = fixture.path.join(fixture.root, "preserve-ready");
        const continuePath = fixture.path.join(fixture.root, "preserve-continue");
        const originalPath = fixture.path.join(fixture.targetDirectory, "original.json");
        const externalContents = '{"version":"external"}\n';
        const controlled = yield* makeAtomicTargetExchange({
          testControl: { pauseAt: "before_preserve_last_check", readyPath, continuePath },
        }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, fixture.runner));
        const fiber = yield* controlled
          .preserveCreated({
            manifestId: "preserve-created",
            sourceDirectory: fixture.targetDirectory,
            sourceName: "sample.json",
            recoveryDirectory: fixture.recoveryDirectory,
            recoveryName: "created",
            expectedSourceDirectory: fixture.publishInput.expectedTargetDirectory,
            expectedRecoveryDirectory: fixture.publishInput.expectedRecoveryDirectory,
            expectedSource: fixture.originalIdentity,
          })
          .pipe(Effect.forkChild({ startImmediately: true }));

        yield* waitForPath(fixture.fs, readyPath);
        yield* fixture.fs.rename(fixture.targetPath, originalPath);
        yield* fixture.fs.writeFileString(fixture.targetPath, externalContents, { flag: "wx" });
        yield* fixture.fs.writeFileString(continuePath, "continue\n", { flag: "wx" });
        const failure = yield* Fiber.join(fiber).pipe(Effect.flip);

        expect(failure).toMatchObject({ _tag: "CommandCenterError", reason: "conflict" });
        expect(yield* fixture.fs.readFileString(fixture.targetPath)).toBe(externalContents);
        expect(yield* fixture.fs.readFileString(originalPath)).toBe(fixture.originalContents);
        expect(
          yield* fixture.fs.readFileString(
            fixture.path.join(fixture.recoveryDirectory, "backup.preserve-created.source"),
          ),
        ).toBe(fixture.originalContents);
        expect(
          yield* fixture.fs.exists(fixture.path.join(fixture.recoveryDirectory, "created")),
        ).toBe(false);
        expect(
          yield* fixture.fs.readFileString(
            fixture.path.join(fixture.recoveryDirectory, "manifest.preserve-created.conflict.json"),
          ),
        ).toContain('"phase":"last_identity_check"');
      }),
  );

  it.effect("allocates recovery transactions beneath a pinned private Git directory", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const gitDirectory = fixture.path.join(fixture.root, ".git");
      yield* fixture.fs.makeDirectory(gitDirectory);
      const expectedGitDirectory = yield* fixture.exchange.captureDirectory(gitDirectory);
      const recovery = yield* fixture.exchange.prepareRecoveryDirectory({
        gitDirectory,
        expectedGitDirectory,
        rootName: "command-center-recovery",
        transactionPrefix: "sample.",
      });

      expect(recovery.recoveryDirectory.startsWith(`${recovery.recoveryRoot}/sample.`)).toBe(true);
      expect((yield* fixture.fs.stat(recovery.recoveryRoot)).mode & 0o777).toBe(0o700);
      expect((yield* fixture.fs.stat(recovery.recoveryDirectory)).mode & 0o777).toBe(0o700);
      expect(yield* fixture.exchange.captureDirectory(recovery.recoveryDirectory)).toEqual(
        recovery.recoveryDirectoryIdentity,
      );
    }),
  );

  it.effect("never allocates through a recovery root swapped after it is pinned", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const gitDirectory = fixture.path.join(fixture.root, ".git");
      const recoveryRoot = fixture.path.join(gitDirectory, "command-center-recovery");
      const movedRoot = fixture.path.join(gitDirectory, "recovery-opened");
      const sentinel = fixture.path.join(recoveryRoot, "external.txt");
      const readyPath = fixture.path.join(fixture.root, "recovery-root-ready");
      const continuePath = fixture.path.join(fixture.root, "recovery-root-continue");
      yield* fixture.fs.makeDirectory(gitDirectory);
      const expectedGitDirectory = yield* fixture.exchange.captureDirectory(gitDirectory);
      const controlled = yield* makeAtomicTargetExchange({
        testControl: { pauseAt: "after_recovery_root_open", readyPath, continuePath },
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, fixture.runner));
      const fiber = yield* controlled
        .prepareRecoveryDirectory({
          gitDirectory,
          expectedGitDirectory,
          rootName: "command-center-recovery",
          transactionPrefix: "sample.",
        })
        .pipe(Effect.forkChild({ startImmediately: true }));

      yield* waitForPath(fixture.fs, readyPath);
      yield* fixture.fs.rename(recoveryRoot, movedRoot);
      yield* fixture.fs.makeDirectory(recoveryRoot, { mode: 0o700 });
      yield* fixture.fs.writeFileString(sentinel, "external recovery\n", { flag: "wx" });
      yield* fixture.fs.writeFileString(continuePath, "continue\n", { flag: "wx" });
      const failure = yield* Fiber.join(fiber).pipe(Effect.flip);

      expect(failure).toMatchObject({ _tag: "CommandCenterError", reason: "conflict" });
      expect(yield* fixture.fs.readFileString(sentinel)).toBe("external recovery\n");
      expect(yield* fixture.fs.readDirectory(movedRoot)).toEqual([]);
    }),
  );

  it.effect("never publishes create bytes through a swapped target parent", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const readyPath = fixture.path.join(fixture.root, "create-parent-ready");
      const continuePath = fixture.path.join(fixture.root, "create-parent-continue");
      const movedDirectory = fixture.path.join(fixture.root, "automations-before-create");
      const externalPath = fixture.path.join(fixture.targetDirectory, "external.txt");
      const targetName = "new.json";
      const contents = Buffer.from('{"private":"service-owned"}\n', "utf8");
      const controlled = yield* makeAtomicTargetExchange({
        testControl: { pauseAt: "before_mutation", readyPath, continuePath },
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, fixture.runner));
      const fiber = yield* controlled
        .publishContents({
          mode: "create",
          manifestId: "publish-create",
          targetDirectory: fixture.targetDirectory,
          targetName,
          recoveryDirectory: fixture.recoveryDirectory,
          recoveryName: "create-authored",
          expectedTargetDirectory: fixture.publishInput.expectedTargetDirectory,
          expectedRecoveryDirectory: fixture.publishInput.expectedRecoveryDirectory,
          contents,
        })
        .pipe(Effect.forkChild({ startImmediately: true }));

      yield* waitForPath(fixture.fs, readyPath);
      yield* fixture.fs.rename(fixture.targetDirectory, movedDirectory);
      yield* fixture.fs.makeDirectory(fixture.targetDirectory);
      yield* fixture.fs.writeFileString(externalPath, "external parent\n", { flag: "wx" });
      yield* fixture.fs.writeFileString(continuePath, "continue\n", { flag: "wx" });
      const failure = yield* Fiber.join(fiber).pipe(Effect.flip);

      expect(failure).toMatchObject({ _tag: "CommandCenterError", reason: "conflict" });
      expect(yield* fixture.fs.readFileString(externalPath)).toBe("external parent\n");
      expect(yield* fixture.fs.exists(fixture.path.join(fixture.targetDirectory, targetName))).toBe(
        false,
      );
      expect(yield* fixture.fs.exists(fixture.path.join(movedDirectory, targetName))).toBe(false);
      expect(
        yield* fixture.fs.readFileString(
          fixture.path.join(fixture.recoveryDirectory, "backup.publish-create.authored"),
        ),
      ).toBe(contents.toString("utf8"));
    }),
  );

  it.effect("finishes a target publication when interrupted after its rename", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const readyPath = fixture.path.join(fixture.root, "create-published-ready");
      const continuePath = fixture.path.join(fixture.root, "create-published-continue");
      const targetName = "interrupt.json";
      const targetPath = fixture.path.join(fixture.targetDirectory, targetName);
      const contents = Buffer.from('{"version":"interrupt-safe"}\n', "utf8");
      const controlled = yield* makeAtomicTargetExchange({
        testControl: { pauseAt: "after_target_mutation", readyPath, continuePath },
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, fixture.runner));
      const publication = yield* controlled
        .publishContents({
          mode: "create",
          manifestId: "interrupt-create",
          targetDirectory: fixture.targetDirectory,
          targetName,
          recoveryDirectory: fixture.recoveryDirectory,
          recoveryName: "interrupt-authored",
          expectedTargetDirectory: fixture.publishInput.expectedTargetDirectory,
          expectedRecoveryDirectory: fixture.publishInput.expectedRecoveryDirectory,
          contents,
        })
        .pipe(Effect.forkChild({ startImmediately: true }));

      yield* waitForPath(fixture.fs, readyPath);
      const interrupter = yield* Fiber.interrupt(publication).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* fixture.fs.writeFileString(continuePath, "continue\n", { flag: "wx" });
      yield* Fiber.join(interrupter);

      expect(yield* fixture.fs.readFileString(targetPath)).toBe(contents.toString("utf8"));
      expect(
        yield* fixture.fs.readFileString(
          fixture.path.join(fixture.recoveryDirectory, "manifest.interrupt-create.complete.json"),
        ),
      ).toContain('"state":"complete"');
    }),
  );

  it.effect("never overwrites a concurrent index replacement after exchange", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const gitDirectory = fixture.path.join(fixture.root, "index-git");
      const recoveryDirectory = fixture.path.join(fixture.root, "index-recovery");
      const indexPath = fixture.path.join(gitDirectory, "index");
      const authoredAside = fixture.path.join(gitDirectory, "authored-aside");
      const replacementTemp = fixture.path.join(gitDirectory, "replacement.tmp");
      const readyPath = fixture.path.join(fixture.root, "index-exchanged-ready");
      const continuePath = fixture.path.join(fixture.root, "index-exchanged-continue");
      const original = Buffer.from("original-index\n", "utf8");
      const authored = Buffer.from("authored-index\n", "utf8");
      const external = Buffer.from("external-index\n", "utf8");
      yield* fixture.fs.makeDirectory(gitDirectory);
      yield* fixture.fs.makeDirectory(recoveryDirectory, { mode: 0o700 });
      yield* fixture.fs.writeFile(indexPath, original, { mode: 0o600 });
      const expectedGitDirectory = yield* fixture.exchange.captureDirectory(gitDirectory);
      const expectedRecoveryDirectory = yield* fixture.exchange.captureDirectory(recoveryDirectory);
      const expectedIndex = yield* fixture.exchange.captureFile(indexPath);
      const controlled = yield* makeAtomicTargetExchange({
        testControl: { pauseAt: "after_index_exchange", readyPath, continuePath },
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, fixture.runner));
      const publication = yield* controlled
        .publishIndex({
          manifestId: "publish-index",
          gitDirectory,
          recoveryDirectory,
          indexName: "index",
          lockName: "index.lock",
          expectedGitDirectory,
          expectedRecoveryDirectory,
          expectedIndex,
          contents: authored,
        })
        .pipe(Effect.forkChild({ startImmediately: true }));

      yield* waitForPath(fixture.fs, readyPath);
      yield* fixture.fs.rename(indexPath, authoredAside);
      yield* fixture.fs.writeFile(replacementTemp, external, { flag: "wx", mode: 0o600 });
      yield* fixture.fs.rename(replacementTemp, indexPath);
      yield* fixture.fs.writeFileString(continuePath, "continue\n", { flag: "wx" });
      const failure = yield* Fiber.join(publication).pipe(Effect.flip);

      expect(failure).toMatchObject({ _tag: "CommandCenterError", reason: "conflict" });
      expect(yield* fixture.fs.readFile(indexPath)).toEqual(external);
      expect(yield* fixture.fs.readFile(authoredAside)).toEqual(authored);
      expect(yield* fixture.fs.exists(fixture.path.join(gitDirectory, "index.lock"))).toBe(false);
      expect(
        yield* fixture.fs.readFile(
          fixture.path.join(recoveryDirectory, "backup.publish-index.index"),
        ),
      ).toEqual(original);
      expect(
        yield* fixture.fs.readFile(
          fixture.path.join(recoveryDirectory, "backup.publish-index.authored-index"),
        ),
      ).toEqual(authored);
      expect(
        yield* fixture.fs.readFileString(
          fixture.path.join(recoveryDirectory, "manifest.publish-index.conflict.json"),
        ),
      ).toContain('"state":"conflict"');
    }),
  );

  it.effect("restores a target replacement that wins after the final update check", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const readyPath = fixture.path.join(fixture.root, "update-last-check-ready");
      const continuePath = fixture.path.join(fixture.root, "update-last-check-continue");
      const originalAside = fixture.path.join(fixture.targetDirectory, "original-aside.json");
      const replacementTemp = fixture.path.join(fixture.targetDirectory, "replacement.tmp");
      const externalContents = '{"version":"concurrent-winner"}\n';
      const controlled = yield* makeAtomicTargetExchange({
        testControl: { pauseAt: "after_target_last_check", readyPath, continuePath },
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, fixture.runner));
      const publication = yield* controlled
        .publishContents({
          mode: "update",
          manifestId: "raced-update",
          targetDirectory: fixture.targetDirectory,
          targetName: "sample.json",
          recoveryDirectory: fixture.recoveryDirectory,
          recoveryName: "raced-authored",
          expectedTargetDirectory: fixture.publishInput.expectedTargetDirectory,
          expectedRecoveryDirectory: fixture.publishInput.expectedRecoveryDirectory,
          expectedTarget: fixture.originalIdentity,
          contents: Buffer.from(fixture.authoredContents, "utf8"),
        })
        .pipe(Effect.forkChild({ startImmediately: true }));

      yield* waitForPath(fixture.fs, readyPath);
      yield* fixture.fs.rename(fixture.targetPath, originalAside);
      yield* fixture.fs.writeFileString(replacementTemp, externalContents, { flag: "wx" });
      yield* fixture.fs.rename(replacementTemp, fixture.targetPath);
      yield* fixture.fs.writeFileString(continuePath, "continue\n", { flag: "wx" });
      const failure = yield* Fiber.join(publication).pipe(Effect.flip);

      expect(failure).toMatchObject({ _tag: "CommandCenterError", reason: "conflict" });
      expect(yield* fixture.fs.readFileString(fixture.targetPath)).toBe(externalContents);
      expect(yield* fixture.fs.readFileString(originalAside)).toBe(fixture.originalContents);
      expect(
        yield* fixture.fs.readFileString(
          fixture.path.join(fixture.recoveryDirectory, "backup.raced-update.target"),
        ),
      ).toBe(fixture.originalContents);
    }),
  );

  it.effect("restores an index replacement that wins after the final index check", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const gitDirectory = fixture.path.join(fixture.root, "last-check-git");
      const recoveryDirectory = fixture.path.join(fixture.root, "last-check-recovery");
      const indexPath = fixture.path.join(gitDirectory, "index");
      const originalAside = fixture.path.join(gitDirectory, "original-aside");
      const replacementTemp = fixture.path.join(gitDirectory, "replacement.tmp");
      const readyPath = fixture.path.join(fixture.root, "index-last-check-ready");
      const continuePath = fixture.path.join(fixture.root, "index-last-check-continue");
      const original = Buffer.from("original-index\n", "utf8");
      const authored = Buffer.from("authored-index\n", "utf8");
      const external = Buffer.from("concurrent-index\n", "utf8");
      yield* fixture.fs.makeDirectory(gitDirectory);
      yield* fixture.fs.makeDirectory(recoveryDirectory, { mode: 0o700 });
      yield* fixture.fs.writeFile(indexPath, original, { mode: 0o600 });
      const expectedGitDirectory = yield* fixture.exchange.captureDirectory(gitDirectory);
      const expectedRecoveryDirectory = yield* fixture.exchange.captureDirectory(recoveryDirectory);
      const expectedIndex = yield* fixture.exchange.captureFile(indexPath);
      const controlled = yield* makeAtomicTargetExchange({
        testControl: { pauseAt: "after_index_last_check", readyPath, continuePath },
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, fixture.runner));
      const publication = yield* controlled
        .publishIndex({
          manifestId: "raced-index",
          gitDirectory,
          recoveryDirectory,
          indexName: "index",
          lockName: "index.lock",
          expectedGitDirectory,
          expectedRecoveryDirectory,
          expectedIndex,
          contents: authored,
        })
        .pipe(Effect.forkChild({ startImmediately: true }));

      yield* waitForPath(fixture.fs, readyPath);
      yield* fixture.fs.rename(indexPath, originalAside);
      yield* fixture.fs.writeFile(replacementTemp, external, { flag: "wx", mode: 0o600 });
      yield* fixture.fs.rename(replacementTemp, indexPath);
      yield* fixture.fs.writeFileString(continuePath, "continue\n", { flag: "wx" });
      const failure = yield* Fiber.join(publication).pipe(Effect.flip);

      expect(failure).toMatchObject({ _tag: "CommandCenterError", reason: "conflict" });
      expect(yield* fixture.fs.readFile(indexPath)).toEqual(external);
      expect(yield* fixture.fs.readFile(originalAside)).toEqual(original);
      expect(yield* fixture.fs.exists(fixture.path.join(gitDirectory, "index.lock"))).toBe(false);
      expect(
        yield* fixture.fs.readFile(
          fixture.path.join(recoveryDirectory, "backup.raced-index.index"),
        ),
      ).toEqual(original);
    }),
  );

  it.effect("restores a target winner introduced after the compensating final check", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const readyPath = fixture.path.join(fixture.root, "target-compensation-ready");
      const continuePath = fixture.path.join(fixture.root, "target-compensation-continue");
      const authoredAside = fixture.path.join(fixture.targetDirectory, "authored-aside.json");
      const replacementTemp = fixture.path.join(fixture.targetDirectory, "replacement.tmp");
      const externalContents = '{"version":"compensation-winner"}\n';
      const controlled = yield* makeAtomicTargetExchange({
        testControl: {
          pauseAt: "after_compensating_target_last_check",
          readyPath,
          continuePath,
          failAfterTargetMutation: true,
        },
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, fixture.runner));
      const publication = yield* controlled
        .publishContents({
          mode: "update",
          manifestId: "target-compensation",
          targetDirectory: fixture.targetDirectory,
          targetName: "sample.json",
          recoveryDirectory: fixture.recoveryDirectory,
          recoveryName: "compensation-authored",
          expectedTargetDirectory: fixture.publishInput.expectedTargetDirectory,
          expectedRecoveryDirectory: fixture.publishInput.expectedRecoveryDirectory,
          expectedTarget: fixture.originalIdentity,
          contents: Buffer.from(fixture.authoredContents, "utf8"),
        })
        .pipe(Effect.forkChild({ startImmediately: true }));

      yield* waitForPath(fixture.fs, readyPath);
      yield* fixture.fs.rename(fixture.targetPath, authoredAside);
      yield* fixture.fs.writeFileString(replacementTemp, externalContents, { flag: "wx" });
      yield* fixture.fs.rename(replacementTemp, fixture.targetPath);
      yield* fixture.fs.writeFileString(continuePath, "continue\n", { flag: "wx" });
      const failure = yield* Fiber.join(publication).pipe(Effect.flip);

      expect(failure).toMatchObject({ _tag: "CommandCenterError", reason: "conflict" });
      expect(yield* fixture.fs.readFileString(fixture.targetPath)).toBe(externalContents);
      expect(yield* fixture.fs.readFileString(authoredAside)).toBe(fixture.authoredContents);
      expect(
        yield* fixture.fs.readFileString(
          fixture.path.join(fixture.recoveryDirectory, "compensation-authored"),
        ),
      ).toBe(fixture.originalContents);
      expect(
        yield* fixture.fs.readFileString(
          fixture.path.join(
            fixture.recoveryDirectory,
            "manifest.target-compensation.conflict.json",
          ),
        ),
      ).toContain('"state":"conflict"');
    }),
  );

  it.effect("restores a created-target winner introduced after the compensating final check", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const readyPath = fixture.path.join(fixture.root, "create-compensation-ready");
      const continuePath = fixture.path.join(fixture.root, "create-compensation-continue");
      const targetPath = fixture.path.join(fixture.targetDirectory, "created.json");
      const authoredAside = fixture.path.join(
        fixture.targetDirectory,
        "created-authored-aside.json",
      );
      const replacementTemp = fixture.path.join(fixture.targetDirectory, "created-replacement.tmp");
      const recoveryName = "create-compensation-authored";
      const externalContents = '{"version":"create-compensation-winner"}\n';
      const controlled = yield* makeAtomicTargetExchange({
        testControl: {
          pauseAt: "after_compensating_target_last_check",
          readyPath,
          continuePath,
          failAfterTargetMutation: true,
        },
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, fixture.runner));
      const publication = yield* controlled
        .publishContents({
          mode: "create",
          manifestId: "create-compensation",
          targetDirectory: fixture.targetDirectory,
          targetName: "created.json",
          recoveryDirectory: fixture.recoveryDirectory,
          recoveryName,
          expectedTargetDirectory: fixture.publishInput.expectedTargetDirectory,
          expectedRecoveryDirectory: fixture.publishInput.expectedRecoveryDirectory,
          contents: Buffer.from(fixture.authoredContents, "utf8"),
        })
        .pipe(Effect.forkChild({ startImmediately: true }));

      yield* waitForPath(fixture.fs, readyPath);
      yield* fixture.fs.rename(targetPath, authoredAside);
      yield* fixture.fs.writeFileString(replacementTemp, externalContents, { flag: "wx" });
      yield* fixture.fs.rename(replacementTemp, targetPath);
      yield* fixture.fs.writeFileString(continuePath, "continue\n", { flag: "wx" });
      const failure = yield* Fiber.join(publication).pipe(Effect.flip);

      expect(failure).toMatchObject({ _tag: "CommandCenterError", reason: "conflict" });
      expect(yield* fixture.fs.readFileString(targetPath)).toBe(externalContents);
      expect(yield* fixture.fs.readFileString(authoredAside)).toBe(fixture.authoredContents);
      expect(
        yield* fixture.fs.exists(fixture.path.join(fixture.recoveryDirectory, recoveryName)),
      ).toBe(false);
      expect(
        yield* fixture.fs.readFileString(
          fixture.path.join(fixture.recoveryDirectory, "backup.create-compensation.authored"),
        ),
      ).toBe(fixture.authoredContents);
      expect(
        yield* fixture.fs.readFileString(
          fixture.path.join(
            fixture.recoveryDirectory,
            "manifest.create-compensation.conflict.json",
          ),
        ),
      ).toContain('"state":"conflict"');
    }),
  );

  it.effect("restores a recovery winner introduced after the compensating final check", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const readyPath = fixture.path.join(fixture.root, "preserve-compensation-ready");
      const continuePath = fixture.path.join(fixture.root, "preserve-compensation-continue");
      const preservedAside = fixture.path.join(fixture.recoveryDirectory, "preserved-aside");
      const replacementTemp = fixture.path.join(fixture.recoveryDirectory, "replacement.tmp");
      const preservedPath = fixture.path.join(fixture.recoveryDirectory, "preserved-created");
      const externalContents = '{"version":"preserve-winner"}\n';
      const controlled = yield* makeAtomicTargetExchange({
        testControl: {
          pauseAt: "after_compensating_move_last_check",
          readyPath,
          continuePath,
          failAfterPreserveMove: true,
        },
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, fixture.runner));
      const preservation = yield* controlled
        .preserveCreated({
          manifestId: "preserve-compensation",
          sourceDirectory: fixture.targetDirectory,
          sourceName: "sample.json",
          recoveryDirectory: fixture.recoveryDirectory,
          recoveryName: "preserved-created",
          expectedSourceDirectory: fixture.publishInput.expectedTargetDirectory,
          expectedRecoveryDirectory: fixture.publishInput.expectedRecoveryDirectory,
          expectedSource: fixture.originalIdentity,
        })
        .pipe(Effect.forkChild({ startImmediately: true }));

      yield* waitForPath(fixture.fs, readyPath);
      yield* fixture.fs.rename(preservedPath, preservedAside);
      yield* fixture.fs.writeFileString(replacementTemp, externalContents, { flag: "wx" });
      yield* fixture.fs.rename(replacementTemp, preservedPath);
      yield* fixture.fs.writeFileString(continuePath, "continue\n", { flag: "wx" });
      const failure = yield* Fiber.join(preservation).pipe(Effect.flip);

      expect(failure).toMatchObject({ _tag: "CommandCenterError", reason: "conflict" });
      expect(yield* fixture.fs.exists(fixture.targetPath)).toBe(false);
      expect(yield* fixture.fs.readFileString(preservedPath)).toBe(externalContents);
      expect(yield* fixture.fs.readFileString(preservedAside)).toBe(fixture.originalContents);
      expect(
        yield* fixture.fs.readFileString(
          fixture.path.join(
            fixture.recoveryDirectory,
            "manifest.preserve-compensation.conflict.json",
          ),
        ),
      ).toContain('"state":"conflict"');
    }),
  );

  it.effect("restores an index winner introduced after the compensating final check", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const gitDirectory = fixture.path.join(fixture.root, "compensation-index-git");
      const recoveryDirectory = fixture.path.join(fixture.root, "compensation-index-recovery");
      const indexPath = fixture.path.join(gitDirectory, "index");
      const authoredAside = fixture.path.join(gitDirectory, "authored-aside");
      const replacementTemp = fixture.path.join(gitDirectory, "replacement.tmp");
      const readyPath = fixture.path.join(fixture.root, "index-compensation-ready");
      const continuePath = fixture.path.join(fixture.root, "index-compensation-continue");
      const original = Buffer.from("compensation-original-index\n", "utf8");
      const authored = Buffer.from("compensation-authored-index\n", "utf8");
      const external = Buffer.from("compensation-index-winner\n", "utf8");
      yield* fixture.fs.makeDirectory(gitDirectory);
      yield* fixture.fs.makeDirectory(recoveryDirectory, { mode: 0o700 });
      yield* fixture.fs.writeFile(indexPath, original, { mode: 0o600 });
      const expectedGitDirectory = yield* fixture.exchange.captureDirectory(gitDirectory);
      const expectedRecoveryDirectory = yield* fixture.exchange.captureDirectory(recoveryDirectory);
      const expectedIndex = yield* fixture.exchange.captureFile(indexPath);
      const controlled = yield* makeAtomicTargetExchange({
        testControl: {
          pauseAt: "after_compensating_index_last_check",
          readyPath,
          continuePath,
          failAfterIndexExchange: true,
        },
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, fixture.runner));
      const publication = yield* controlled
        .publishIndex({
          manifestId: "index-compensation",
          gitDirectory,
          recoveryDirectory,
          indexName: "index",
          lockName: "index.lock",
          expectedGitDirectory,
          expectedRecoveryDirectory,
          expectedIndex,
          contents: authored,
        })
        .pipe(Effect.forkChild({ startImmediately: true }));

      yield* waitForPath(fixture.fs, readyPath);
      yield* fixture.fs.rename(indexPath, authoredAside);
      yield* fixture.fs.writeFile(replacementTemp, external, { flag: "wx", mode: 0o600 });
      yield* fixture.fs.rename(replacementTemp, indexPath);
      yield* fixture.fs.writeFileString(continuePath, "continue\n", { flag: "wx" });
      const failure = yield* Fiber.join(publication).pipe(Effect.flip);

      expect(failure).toMatchObject({ _tag: "CommandCenterError", reason: "conflict" });
      expect(yield* fixture.fs.readFile(indexPath)).toEqual(external);
      expect(yield* fixture.fs.readFile(authoredAside)).toEqual(authored);
      expect(yield* fixture.fs.readFile(fixture.path.join(gitDirectory, "index.lock"))).toEqual(
        original,
      );
      expect(
        yield* fixture.fs.readFile(
          fixture.path.join(recoveryDirectory, "backup.index-compensation.index"),
        ),
      ).toEqual(original);
      expect(
        yield* fixture.fs.readFileString(
          fixture.path.join(recoveryDirectory, "manifest.index-compensation.conflict.json"),
        ),
      ).toContain('"state":"conflict"');
    }),
  );

  it.effect("restores an index-lock winner introduced after the cleanup final check", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const gitDirectory = fixture.path.join(fixture.root, "cleanup-index-git");
      const recoveryDirectory = fixture.path.join(fixture.root, "cleanup-index-recovery");
      const indexPath = fixture.path.join(gitDirectory, "index");
      const lockPath = fixture.path.join(gitDirectory, "index.lock");
      const authoredAside = fixture.path.join(gitDirectory, "authored-lock-aside");
      const replacementTemp = fixture.path.join(gitDirectory, "replacement-lock.tmp");
      const readyPath = fixture.path.join(fixture.root, "lock-cleanup-ready");
      const continuePath = fixture.path.join(fixture.root, "lock-cleanup-continue");
      const original = Buffer.from("cleanup-original-index\n", "utf8");
      const authored = Buffer.from("cleanup-authored-index\n", "utf8");
      const external = Buffer.from("cleanup-lock-winner\n", "utf8");
      yield* fixture.fs.makeDirectory(gitDirectory);
      yield* fixture.fs.makeDirectory(recoveryDirectory, { mode: 0o700 });
      yield* fixture.fs.writeFile(indexPath, original, { mode: 0o600 });
      const expectedGitDirectory = yield* fixture.exchange.captureDirectory(gitDirectory);
      const expectedRecoveryDirectory = yield* fixture.exchange.captureDirectory(recoveryDirectory);
      const expectedIndex = yield* fixture.exchange.captureFile(indexPath);
      const controlled = yield* makeAtomicTargetExchange({
        testControl: {
          pauseAt: "after_compensating_lock_last_check",
          readyPath,
          continuePath,
          failAfterIndexExchange: true,
        },
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, fixture.runner));
      const publication = yield* controlled
        .publishIndex({
          manifestId: "lock-cleanup",
          gitDirectory,
          recoveryDirectory,
          indexName: "index",
          lockName: "index.lock",
          expectedGitDirectory,
          expectedRecoveryDirectory,
          expectedIndex,
          contents: authored,
        })
        .pipe(Effect.forkChild({ startImmediately: true }));

      yield* waitForPath(fixture.fs, readyPath);
      yield* fixture.fs.rename(lockPath, authoredAside);
      yield* fixture.fs.writeFile(replacementTemp, external, { flag: "wx", mode: 0o600 });
      yield* fixture.fs.rename(replacementTemp, lockPath);
      yield* fixture.fs.writeFileString(continuePath, "continue\n", { flag: "wx" });
      const failure = yield* Fiber.join(publication).pipe(Effect.flip);

      expect(failure).toMatchObject({ _tag: "CommandCenterError", reason: "conflict" });
      expect(yield* fixture.fs.readFile(indexPath)).toEqual(original);
      expect(yield* fixture.fs.readFile(lockPath)).toEqual(external);
      expect(yield* fixture.fs.readFile(authoredAside)).toEqual(authored);
      expect(
        yield* fixture.fs.exists(fixture.path.join(recoveryDirectory, "abandoned-index-lock")),
      ).toBe(false);
      expect(
        yield* fixture.fs.readFile(
          fixture.path.join(recoveryDirectory, "backup.lock-cleanup.index"),
        ),
      ).toEqual(original);
      expect(
        yield* fixture.fs.readFileString(
          fixture.path.join(recoveryDirectory, "manifest.lock-cleanup.conflict.json"),
        ),
      ).toContain('"state":"conflict"');
    }),
  );

  it.effect("keeps target recovery bytes immutable when the displaced inode is mutated", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const held = yield* fixture.fs.open(fixture.targetPath, { flag: "r+" });
      const readyPath = fixture.path.join(fixture.root, "held-target-ready");
      const continuePath = fixture.path.join(fixture.root, "held-target-continue");
      const controlled = yield* makeAtomicTargetExchange({
        testControl: { pauseAt: "after_target_mutation", readyPath, continuePath },
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, fixture.runner));
      const publication = yield* controlled
        .publishContents({
          mode: "update",
          manifestId: "held-target",
          targetDirectory: fixture.targetDirectory,
          targetName: "sample.json",
          recoveryDirectory: fixture.recoveryDirectory,
          recoveryName: "held-authored",
          expectedTargetDirectory: fixture.publishInput.expectedTargetDirectory,
          expectedRecoveryDirectory: fixture.publishInput.expectedRecoveryDirectory,
          expectedTarget: fixture.originalIdentity,
          contents: Buffer.from(fixture.authoredContents, "utf8"),
        })
        .pipe(Effect.forkChild({ startImmediately: true }));

      yield* waitForPath(fixture.fs, readyPath);
      yield* held.truncate(0);
      yield* held.writeAll(Buffer.from("mutated-through-held-fd\n", "utf8"));
      yield* held.sync;
      yield* fixture.fs.writeFileString(continuePath, "continue\n", { flag: "wx" });
      yield* Fiber.join(publication).pipe(Effect.flip);

      expect(
        yield* fixture.fs.readFileString(
          fixture.path.join(fixture.recoveryDirectory, "backup.held-target.target"),
        ),
      ).toBe(fixture.originalContents);
    }),
  );

  it.effect("keeps preservation recovery bytes immutable across a held-fd mutation", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const held = yield* fixture.fs.open(fixture.targetPath, { flag: "r+" });
      const readyPath = fixture.path.join(fixture.root, "held-preserve-ready");
      const continuePath = fixture.path.join(fixture.root, "held-preserve-continue");
      const controlled = yield* makeAtomicTargetExchange({
        testControl: { pauseAt: "after_preserve_move", readyPath, continuePath },
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, fixture.runner));
      const preservation = yield* controlled
        .preserveCreated({
          manifestId: "held-preserve",
          sourceDirectory: fixture.targetDirectory,
          sourceName: "sample.json",
          recoveryDirectory: fixture.recoveryDirectory,
          recoveryName: "held-created",
          expectedSourceDirectory: fixture.publishInput.expectedTargetDirectory,
          expectedRecoveryDirectory: fixture.publishInput.expectedRecoveryDirectory,
          expectedSource: fixture.originalIdentity,
        })
        .pipe(Effect.forkChild({ startImmediately: true }));

      yield* waitForPath(fixture.fs, readyPath);
      yield* held.truncate(0);
      yield* held.writeAll(Buffer.from("mutated-preserved-inode\n", "utf8"));
      yield* held.sync;
      yield* fixture.fs.writeFileString(continuePath, "continue\n", { flag: "wx" });
      yield* Fiber.join(preservation).pipe(Effect.flip);

      expect(
        yield* fixture.fs.readFileString(
          fixture.path.join(fixture.recoveryDirectory, "backup.held-preserve.source"),
        ),
      ).toBe(fixture.originalContents);
    }),
  );

  it.effect("keeps index recovery bytes immutable when the displaced index inode is mutated", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const gitDirectory = fixture.path.join(fixture.root, "held-index-git");
      const recoveryDirectory = fixture.path.join(fixture.root, "held-index-recovery");
      const indexPath = fixture.path.join(gitDirectory, "index");
      const readyPath = fixture.path.join(fixture.root, "held-index-ready");
      const continuePath = fixture.path.join(fixture.root, "held-index-continue");
      const original = Buffer.from("held-original-index\n", "utf8");
      const authored = Buffer.from("held-authored-index\n", "utf8");
      yield* fixture.fs.makeDirectory(gitDirectory);
      yield* fixture.fs.makeDirectory(recoveryDirectory, { mode: 0o700 });
      yield* fixture.fs.writeFile(indexPath, original, { mode: 0o600 });
      const held = yield* fixture.fs.open(indexPath, { flag: "r+" });
      const expectedGitDirectory = yield* fixture.exchange.captureDirectory(gitDirectory);
      const expectedRecoveryDirectory = yield* fixture.exchange.captureDirectory(recoveryDirectory);
      const expectedIndex = yield* fixture.exchange.captureFile(indexPath);
      const controlled = yield* makeAtomicTargetExchange({
        testControl: { pauseAt: "after_index_exchange", readyPath, continuePath },
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, fixture.runner));
      const publication = yield* controlled
        .publishIndex({
          manifestId: "held-index",
          gitDirectory,
          recoveryDirectory,
          indexName: "index",
          lockName: "index.lock",
          expectedGitDirectory,
          expectedRecoveryDirectory,
          expectedIndex,
          contents: authored,
        })
        .pipe(Effect.forkChild({ startImmediately: true }));

      yield* waitForPath(fixture.fs, readyPath);
      yield* held.truncate(0);
      yield* held.writeAll(Buffer.from("mutated-held-index\n", "utf8"));
      yield* held.sync;
      yield* fixture.fs.writeFileString(continuePath, "continue\n", { flag: "wx" });
      yield* Fiber.join(publication).pipe(Effect.flip);

      expect(
        yield* fixture.fs.readFile(fixture.path.join(recoveryDirectory, "backup.held-index.index")),
      ).toEqual(original);
    }),
  );

  it.effect("never rolls back after terminal marker publication or output loss", () =>
    Effect.gen(function* () {
      for (const control of [
        { failTerminalAt: "after_link" as const },
        { crashAt: "after_complete_manifest" as const },
      ]) {
        const fixture = yield* makeFixture;
        const controlled = yield* makeAtomicTargetExchange({ testControl: control }).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, fixture.runner),
        );
        const targetName = `terminal-${Object.keys(control)[0]}.json`;
        const targetPath = fixture.path.join(fixture.targetDirectory, targetName);
        const failure = yield* controlled
          .publishContents({
            mode: "create",
            manifestId: "terminal-create",
            targetDirectory: fixture.targetDirectory,
            targetName,
            recoveryDirectory: fixture.recoveryDirectory,
            recoveryName: "terminal-authored",
            expectedTargetDirectory: fixture.publishInput.expectedTargetDirectory,
            expectedRecoveryDirectory: fixture.publishInput.expectedRecoveryDirectory,
            contents: Buffer.from(fixture.authoredContents, "utf8"),
          })
          .pipe(Effect.flip);

        expect(failure).toMatchObject({ _tag: "CommandCenterError" });
        expect(yield* fixture.fs.readFileString(targetPath)).toBe(fixture.authoredContents);
        expect(
          yield* fixture.fs.exists(
            fixture.path.join(fixture.recoveryDirectory, "manifest.terminal-create.conflict.json"),
          ),
        ).toBe(false);
      }
    }),
  );

  it.effect("fails closed on an unsupported platform or helper before mutating either file", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const unsupported = yield* makeAtomicTargetExchange({ platform: "darwin" }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, fixture.runner),
      );
      const publication = {
        mode: "create" as const,
        manifestId: "unsupported",
        targetDirectory: fixture.targetDirectory,
        targetName: "unsupported.json",
        recoveryDirectory: fixture.recoveryDirectory,
        recoveryName: "unsupported-authored",
        expectedTargetDirectory: fixture.publishInput.expectedTargetDirectory,
        expectedRecoveryDirectory: fixture.publishInput.expectedRecoveryDirectory,
        contents: Buffer.from(fixture.authoredContents, "utf8"),
      };
      const failure = yield* unsupported.publishContents(publication).pipe(Effect.flip);
      const untrusted = yield* makeAtomicTargetExchange({
        platform: "linux",
        pythonEntrypoint: fixture.targetPath,
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, fixture.runner));
      const helperFailure = yield* untrusted.publishContents(publication).pipe(Effect.flip);

      expect(failure).toMatchObject({ _tag: "CommandCenterError", reason: "config" });
      expect(helperFailure).toMatchObject({ _tag: "CommandCenterError", reason: "config" });
      expect(yield* fixture.fs.readFileString(fixture.targetPath)).toBe(fixture.originalContents);
      expect(yield* fixture.fs.readFileString(fixture.recoveryPath)).toBe(fixture.authoredContents);
      expect(
        yield* fixture.fs.exists(fixture.path.join(fixture.targetDirectory, "unsupported.json")),
      ).toBe(false);
    }),
  );
});
