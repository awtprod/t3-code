import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { CAPABILITY_NAMES, Space } from "@command-center/core";
import {
  CommandCenterAutomationDefinitionCreateInput,
  CommandCenterAutomationDefinitionGetInput,
  CommandCenterAutomationDefinitionSaveInput,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import {
  make as makeAutomationDefinitionConfig,
  matchesAutomationRelativePath,
} from "./AutomationDefinitionConfig.ts";
import { CommandCenterConfig, type LoadedCommandCenterConfig } from "./Config.ts";

const decodeSpace = Schema.decodeUnknownSync(Space);
const decodeGet = Schema.decodeUnknownSync(CommandCenterAutomationDefinitionGetInput);
const decodeCreate = Schema.decodeUnknownSync(CommandCenterAutomationDefinitionCreateInput);
const decodeSave = Schema.decodeUnknownSync(CommandCenterAutomationDefinitionSaveInput);
const encodeUnknownJsonString = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);
const decodeUnknownJsonString = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);

const fixtureSpace = decodeSpace({
  id: "sample-space",
  slug: "sample-space",
  displayName: "Sample Space",
  kind: "business",
  instructions: "",
  policy: {
    allowedCapabilities: CAPABILITY_NAMES,
    autoRunRiskLevels: ["low", "reversible"],
  },
  connectionIds: [],
  repositories: [],
  aliases: [],
  lifecycle: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const sourceDefinition = {
  $schema: "../schemas/automation.schema.json",
  schemaVersion: 1,
  id: "sample-flow",
  name: "Sample flow",
  spaceId: "sample-space",
  enabled: false,
  trigger: { kind: "manual" },
  nodes: [{ id: "start", kind: "transform", config: { source: "sample" } }],
  edges: [],
  layout: { nodes: { start: { x: 80, y: 120 } } },
  policy: { requireApprovalForExternalWrites: true },
} as const;

const getInput = decodeGet({ automationId: "sample-flow", spaceId: "sample-space" });
const createInput = decodeCreate({
  requestId: "create-weekly-brief-1",
  spaceId: "sample-space",
  preferredAutomationId: "weekly-brief",
  name: "Weekly brief",
  enabled: false,
  trigger: { kind: "schedule", expression: "0 9 * * 1", timezone: "Etc/UTC" },
  nodes: [{ id: "prepare", kind: "transform", config: { template: "Prepare weekly brief" } }],
  edges: [],
  layout: { nodes: { prepare: { x: 80, y: 120 } } },
});

it("compares Git paths with Windows relative paths without weakening escape checks", () => {
  expect(
    matchesAutomationRelativePath(
      "automations\\sample-flow.json",
      "automations/sample-flow.json",
      "\\",
      false,
    ),
  ).toBe(true);
  expect(
    matchesAutomationRelativePath(
      "..\\outside\\sample-flow.json",
      "automations/sample-flow.json",
      "\\",
      false,
    ),
  ).toBe(false);
  expect(
    matchesAutomationRelativePath(
      "C:\\private\\automations\\sample-flow.json",
      "automations/sample-flow.json",
      "\\",
      true,
    ),
  ).toBe(false);
});

const makeFixtureWithOptions = Effect.fn("AutomationDefinitionConfigTest.makeFixture")(function* (
  options: {
    readonly automationFileName?: string;
    readonly detachedHead?: boolean;
    readonly hostPlatform?: NodeJS.Platform;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.make();
  const storeEvents: string[] = [];
  const storeResults: Array<{
    readonly args: ReadonlyArray<string>;
    readonly stdin?: string;
    readonly stdout: string;
  }> = [];
  const storeControl: {
    beforeRun?: (input: ProcessRunner.ProcessRunInput) => Effect.Effect<void>;
    run?: (
      input: ProcessRunner.ProcessRunInput,
    ) => Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>;
  } = {};
  const configDirectory = yield* fs.makeTempDirectoryScoped({
    prefix: "command-center-automation-config-",
  });
  const automationsDirectory = path.join(configDirectory, "automations");
  const automationFileName = options.automationFileName ?? "sample-flow.json";
  const automationPath = path.join(automationsDirectory, automationFileName);
  yield* fs.makeDirectory(automationsDirectory, { recursive: true });
  yield* fs.writeFileString(automationPath, `${encodeUnknownJsonString(sourceDefinition)}\n`);

  const git = Effect.fn("AutomationDefinitionConfigTest.git")(function* (
    args: ReadonlyArray<string>,
  ) {
    const result = yield* runner.run({
      command: "git",
      args: ["-C", configDirectory, ...args],
      timeout: "10 seconds",
    });
    if (result.code !== 0) {
      return yield* Effect.die(new Error(`Fixture Git command failed: ${args[0] ?? "unknown"}`));
    }
    return result.stdout;
  });

  yield* git(["init", "--quiet"]);
  yield* git(["add", "--", `automations/${automationFileName}`]);
  yield* git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture",
    "commit",
    "--quiet",
    "-m",
    "Initial fixture",
  ]);
  if (options.detachedHead === true) {
    yield* git(["checkout", "--quiet", "--detach", "HEAD"]);
  }

  const loadedConfig = {
    spaces: [fixtureSpace],
    connections: [],
    automations: [],
    timezone: "Etc/UTC",
    routing: {
      mode: "auto",
      showPreview: true,
      explicitSelectionWins: true,
      providerFallback: "first-healthy-compatible",
    },
    health: { status: "loaded", configDirectory },
  } satisfies LoadedCommandCenterConfig;
  const configService = CommandCenterConfig.of({
    configDirectory,
    load: Effect.succeed(loadedConfig),
    resolveGoogleAccount: () => Effect.die("Not used by automation config tests."),
  });
  const dependencies = Layer.mergeAll(
    Layer.succeed(CommandCenterConfig, configService),
    Layer.succeed(HostProcessPlatform, options.hostPlatform ?? "linux"),
    Layer.succeed(
      ProcessRunner.ProcessRunner,
      ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.sync(() => storeEvents.push(`git:${input.args.join(" ")}`)).pipe(
            Effect.andThen(Effect.suspend(() => storeControl.beforeRun?.(input) ?? Effect.void)),
            Effect.andThen(Effect.suspend(() => storeControl.run?.(input) ?? runner.run(input))),
            Effect.tap((result) =>
              Effect.sync(() =>
                storeResults.push({
                  args: input.args,
                  ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
                  stdout: result.stdout,
                }),
              ),
            ),
          ),
      }),
    ),
  );
  const store = yield* makeAutomationDefinitionConfig.pipe(Effect.provide(dependencies));

  return {
    fs,
    git,
    runner,
    configDirectory,
    automationPath,
    store,
    storeEvents,
    storeResults,
    storeControl,
  };
});
const makeFixture = makeFixtureWithOptions();

it.layer(NodeServices.layer)("automation private config editing", (it) => {
  it.effect("creates one disabled committed definition and replays the request idempotently", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const initialCommit = (yield* fixture.git(["rev-parse", "HEAD"])).trim();
      const audits: unknown[] = [];
      const created = yield* fixture.store.create(createInput, (audit) =>
        Effect.sync(() => {
          fixture.storeEvents.push("audit");
          audits.push(audit);
        }),
      );
      const updateRefEvent = fixture.storeEvents.findIndex((event) =>
        event.includes("update-ref refs/heads/"),
      );
      expect(updateRefEvent).toBeGreaterThan(fixture.storeEvents.indexOf("audit"));
      const replayed = yield* fixture.store.create(createInput, (audit) =>
        Effect.sync(() => audits.push(audit)),
      );

      expect(created.automationId).toBe("weekly-brief");
      expect(created.definition.enabled).toBe(false);
      expect(created.definition.policy).toEqual({ requireApprovalForExternalWrites: true });
      expect(created.configCommitSha).not.toBe(initialCommit);
      expect(replayed).toEqual(created);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        operation: "created",
        requestId: createInput.requestId,
        previousConfigCommitSha: initialCommit,
        previousDefinitionDigest: null,
        configCommitSha: created.configCommitSha,
      });
      expect(yield* fixture.git(["status", "--porcelain=v1"])).toBe("");
      expect(
        (yield* fixture.git(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])).trim(),
      ).toBe("automations/weekly-brief.json");
      const authoringGitInvocations = fixture.storeResults.filter((result) =>
        result.args.includes("core.fsyncMethod=fsync"),
      );
      expect(authoringGitInvocations.length).toBeGreaterThan(0);
      for (const invocation of authoringGitInvocations) {
        expect(invocation.args).toContain("core.fsync=all");
        expect(invocation.args).toContain("core.fsyncMethod=fsync");
        expect(invocation.args).toContain("core.fsmonitor=false");
        expect(invocation.args).toContain("core.untrackedCache=false");
      }
    }),
  );

  it.effect("allocates a deterministic collision id and rejects changed replay input", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const automatic = decodeCreate({
        ...createInput,
        requestId: "create-colliding-flow-1",
        preferredAutomationId: undefined,
        name: "Sample flow",
      });
      const created = yield* fixture.store.create(automatic, () => Effect.void);
      expect(created.automationId).toMatch(/^sample-flow-[a-f0-9]{10}$/u);

      const changed = yield* Effect.flip(
        fixture.store.create(
          decodeCreate({
            ...automatic,
            name: "Changed request",
            preferredAutomationId: created.automationId,
          }),
          () => Effect.void,
        ),
      );
      expect(changed).toMatchObject({ _tag: "CommandCenterError", reason: "conflict" });
      expect((yield* fixture.git(["rev-parse", "HEAD"])).trim()).toBe(created.configCommitSha);
    }),
  );

  it.effect("loads an exact source whose committed filename differs from its automation id", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixtureWithOptions({
        automationFileName: "legacy-sample-name.json",
      });
      const loaded = yield* fixture.store.get(getInput);

      expect(loaded.automationId).toBe("sample-flow");
      expect(loaded.definition.name).toBe("Sample flow");
      expect(loaded.definitionDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(loaded.configCommitSha).toBe((yield* fixture.git(["rev-parse", "HEAD"])).trim());
    }),
  );

  it.effect("keeps committed definitions readable from a detached checkout", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixtureWithOptions({ detachedHead: true });
      const loaded = yield* fixture.store.get(getInput);

      expect(loaded.definition.name).toBe("Sample flow");
      expect(loaded.authoringHealth).toMatchObject({
        status: "unavailable",
        message: expect.stringContaining("detached HEAD"),
      });
    }),
  );

  it.effect("keeps committed definitions readable when Git is too old for authoring", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      fixture.storeControl.run = (input) =>
        input.args.at(-1) === "--version"
          ? Effect.succeed({
              stdout: "git version 2.35.0\n",
              stderr: "",
              code: 0 as ProcessRunner.ProcessRunOutput["code"],
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
            })
          : fixture.runner.run(input);

      const loaded = yield* fixture.store.get(getInput);
      expect(loaded.definition.name).toBe("Sample flow");
      expect(loaded.authoringHealth).toMatchObject({
        status: "unavailable",
        message: expect.stringContaining("Git 2.36 or newer"),
      });
    }),
  );

  it.effect("reports Windows authoring as unavailable without blocking definition reads", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixtureWithOptions({ hostPlatform: "win32" });
      const loaded = yield* fixture.store.get(getInput);

      expect(loaded.definition.name).toBe("Sample flow");
      expect(yield* fixture.store.authoringHealth).toMatchObject({
        status: "unavailable",
        message: expect.stringContaining("Linux renameat2 support is required"),
      });
    }),
  );

  it.effect("binds a create request id across every automation path in its Space", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const audits: unknown[] = [];
      const created = yield* fixture.store.create(createInput, (audit) =>
        Effect.sync(() => audits.push(audit)),
      );
      const changedPath = decodeCreate({
        ...createInput,
        preferredAutomationId: "another-weekly-brief",
      });
      const failure = yield* Effect.flip(
        fixture.store.create(changedPath, (audit) => Effect.sync(() => audits.push(audit))),
      );

      expect(failure).toMatchObject({ _tag: "CommandCenterError", reason: "conflict" });
      expect((yield* fixture.git(["rev-parse", "HEAD"])).trim()).toBe(created.configCommitSha);
      expect(audits).toHaveLength(1);
      expect(
        yield* fixture.fs.exists(
          `${fixture.configDirectory}/automations/another-weekly-brief.json`,
        ),
      ).toBe(false);
    }),
  );

  it.effect("never overwrites an untracked file or symbolic-link target", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const untrackedPath = `${fixture.configDirectory}/automations/weekly-brief.json`;
      yield* fixture.fs.writeFileString(untrackedPath, "leave me\n");
      const untracked = yield* Effect.flip(fixture.store.create(createInput, () => Effect.void));
      expect(untracked).toMatchObject({ _tag: "CommandCenterError", reason: "conflict" });
      expect(yield* fixture.fs.readFileString(untrackedPath)).toBe("leave me\n");

      yield* fixture.fs.remove(untrackedPath);
      const outside = `${fixture.configDirectory}/outside.json`;
      yield* fixture.fs.writeFileString(outside, "outside\n");
      yield* fixture.fs.symlink(outside, untrackedPath);
      const symlink = yield* Effect.flip(fixture.store.create(createInput, () => Effect.void));
      expect(symlink).toMatchObject({ _tag: "CommandCenterError", reason: "conflict" });
      expect(yield* fixture.fs.readFileString(outside)).toBe("outside\n");
      expect((yield* fixture.git(["rev-parse", "HEAD"])).trim()).toMatch(/^[a-f0-9]{40,64}$/u);
    }),
  );

  it.effect("rejects credential-shaped config and host paths before writing", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const initialCommit = (yield* fixture.git(["rev-parse", "HEAD"])).trim();
      for (const config of [
        { api_token: "not-for-git" },
        { source: ["", "home", "operator", "private.txt"].join("/") },
      ]) {
        const rejected = yield* Effect.flip(
          fixture.store.create(
            decodeCreate({
              ...createInput,
              requestId: `unsafe-${Object.keys(config)[0]}`,
              nodes: [{ id: "prepare", kind: "transform", config }],
            }),
            () => Effect.void,
          ),
        );
        expect(rejected).toMatchObject({ _tag: "CommandCenterError", reason: "validation" });
      }
      expect((yield* fixture.git(["rev-parse", "HEAD"])).trim()).toBe(initialCommit);
      expect(yield* fixture.git(["status", "--porcelain=v1"])).toBe("");
    }),
  );

  it.effect(
    "rolls back the new file, index, and commit into durable recovery when auditing fails",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const initialCommit = (yield* fixture.git(["rev-parse", "HEAD"])).trim();
        let headDuringAudit: string | undefined;
        const failure = yield* Effect.flip(
          fixture.store.create(createInput, () =>
            Effect.gen(function* () {
              headDuringAudit = (yield* fixture.git(["rev-parse", "HEAD"])).trim();
              return yield* Effect.fail("audit unavailable" as const);
            }),
          ),
        );

        expect(failure).toBe("audit unavailable");
        expect(headDuringAudit).toBe(initialCommit);
        expect(fixture.storeEvents.some((event) => event.includes("update-ref refs/heads/"))).toBe(
          false,
        );
        expect((yield* fixture.git(["rev-parse", "HEAD"])).trim()).toBe(initialCommit);
        expect(yield* fixture.git(["status", "--porcelain=v1"])).toBe("");
        expect(
          yield* fixture.fs.exists(`${fixture.configDirectory}/automations/weekly-brief.json`),
        ).toBe(false);
        const recoveryRoot = `${fixture.configDirectory}/.git/command-center-recovery`;
        const recoveryTransactions = yield* fixture.fs.readDirectory(recoveryRoot);
        let recoveredCreatedPath: string | undefined;
        for (const transaction of recoveryTransactions) {
          const candidate = `${recoveryRoot}/${transaction}/created`;
          if (yield* fixture.fs.exists(candidate)) recoveredCreatedPath = candidate;
        }
        expect(recoveredCreatedPath).toBeDefined();
        expect(yield* fixture.fs.readFileString(recoveredCreatedPath!)).toContain(
          '"id": "weekly-brief"',
        );
        expect((yield* fixture.fs.stat(recoveryRoot)).mode & 0o777).toBe(0o700);
      }),
  );

  it.effect("does not remove a concurrently replaced target during rollback", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const initialCommit = (yield* fixture.git(["rev-parse", "HEAD"])).trim();
      const targetPath = `${fixture.configDirectory}/automations/weekly-brief.json`;
      const replacementPath = `${fixture.configDirectory}/automations/external-replacement.tmp`;
      const externalContents = '{"external":"preserve-me"}\n';

      const failure = yield* Effect.flip(
        fixture.store.create(createInput, () =>
          Effect.gen(function* () {
            yield* fixture.fs.writeFileString(replacementPath, externalContents);
            yield* fixture.fs.rename(replacementPath, targetPath);
            return yield* Effect.fail("audit unavailable" as const);
          }),
        ),
      );

      expect(failure).toMatchObject({ _tag: "CommandCenterError", reason: "conflict" });
      expect(yield* fixture.fs.readFileString(targetPath)).toBe(externalContents);
      expect(
        yield* fixture.git(["ls-files", "--stage", "--", "automations/weekly-brief.json"]),
      ).toBe("");
      expect((yield* fixture.git(["rev-parse", "HEAD"])).trim()).toBe(initialCommit);
    }),
  );

  it.effect("does not overwrite a concurrently changed index entry during rollback", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const initialCommit = (yield* fixture.git(["rev-parse", "HEAD"])).trim();
      const externalPath = `${fixture.configDirectory}/external-index-contents.json`;
      yield* fixture.fs.writeFileString(externalPath, '{"external":"index"}\n');
      let externalBlob = "";
      const audits: unknown[] = [];

      const failure = yield* Effect.flip(
        fixture.store.create(createInput, (audit) =>
          Effect.gen(function* () {
            audits.push(audit);
            externalBlob = (yield* fixture.git(["hash-object", "-w", "--", externalPath])).trim();
            yield* fixture.git([
              "update-index",
              "--add",
              "--cacheinfo",
              `100644,${externalBlob},automations/weekly-brief.json`,
            ]);
          }),
        ),
      );

      expect(failure).toMatchObject({ _tag: "CommandCenterError", reason: "conflict" });
      expect(
        yield* fixture.git(["ls-files", "--stage", "--", "automations/weekly-brief.json"]),
      ).toBe(`100644 ${externalBlob} 0\tautomations/weekly-brief.json\n`);
      expect(
        yield* fixture.fs.readFileString(
          `${fixture.configDirectory}/automations/weekly-brief.json`,
        ),
      ).toContain('"name": "Weekly brief"');
      expect((yield* fixture.git(["rev-parse", "HEAD"])).trim()).toBe(initialCommit);
      expect(audits).toHaveLength(1);
    }),
  );

  it.effect("keeps authored state for manual recovery when the pinned branch advances", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const initialCommit = (yield* fixture.git(["rev-parse", "HEAD"])).trim();
      const audits: Array<{ readonly configCommitSha: string }> = [];
      let concurrentCommit: string | undefined;

      const failure = yield* Effect.flip(
        fixture.store.create(createInput, (audit) =>
          Effect.gen(function* () {
            audits.push(audit);
            yield* fixture.fs.writeFileString(
              `${fixture.configDirectory}/concurrent.txt`,
              "concurrent change\n",
            );
            yield* fixture.git(["add", "--", "concurrent.txt"]);
            yield* fixture.git([
              "-c",
              "user.name=Fixture",
              "-c",
              "user.email=fixture",
              "commit",
              "--quiet",
              "-m",
              "Concurrent config change",
            ]);
            concurrentCommit = (yield* fixture.git(["rev-parse", "HEAD"])).trim();
          }),
        ),
      );

      expect(failure).toMatchObject({ _tag: "CommandCenterError", reason: "conflict" });
      expect(concurrentCommit).not.toBe(initialCommit);
      expect((yield* fixture.git(["rev-parse", "HEAD"])).trim()).toBe(concurrentCommit);
      expect(audits).toHaveLength(1);
      expect(yield* fixture.git(["cat-file", "-t", audits[0]!.configCommitSha])).toBe("commit\n");
      expect(audits[0]!.configCommitSha).not.toBe(concurrentCommit);
      expect(yield* fixture.git(["status", "--porcelain=v1"])).toBe(
        "?? automations/weekly-brief.json\n",
      );
      expect(
        yield* fixture.fs.exists(`${fixture.configDirectory}/automations/weekly-brief.json`),
      ).toBe(true);
    }),
  );

  it.effect("ignores ambient signing and never executes checkout-local Git callbacks", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const hookPath = `${fixture.configDirectory}/.git/hooks/pre-commit`;
      const hookMarker = `${fixture.configDirectory}/hook-executed`;
      const fsmonitorPath = `${fixture.configDirectory}/.git/configured-fsmonitor`;
      const fsmonitorMarker = `${fixture.configDirectory}/fsmonitor-executed`;
      yield* fixture.fs.writeFileString(
        hookPath,
        `#!/bin/sh\nprintf unsafe > '${hookMarker}'\nexit 1\n`,
      );
      yield* fixture.fs.chmod(hookPath, 0o700);
      yield* fixture.fs.writeFileString(
        fsmonitorPath,
        `#!/bin/sh\nprintf unsafe > '${fsmonitorMarker}'\nexit 1\n`,
      );
      yield* fixture.fs.chmod(fsmonitorPath, 0o700);
      yield* fixture.git(["config", "commit.gpgSign", "true"]);
      yield* fixture.git(["config", "core.fsmonitor", fsmonitorPath]);

      const created = yield* fixture.store.create(createInput, () => Effect.void);
      expect(created.automationId).toBe("weekly-brief");
      expect(yield* fixture.fs.exists(hookMarker)).toBe(false);
      expect(yield* fixture.fs.exists(fsmonitorMarker)).toBe(false);
      expect(yield* fixture.git(["-c", "core.fsmonitor=false", "status", "--porcelain=v1"])).toBe(
        "",
      );
    }),
  );

  it.effect("rejects detached HEAD before allocating an automation path", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      yield* fixture.git(["checkout", "--detach", "--quiet"]);
      const failure = yield* Effect.flip(fixture.store.create(createInput, () => Effect.void));

      expect(failure).toMatchObject({ _tag: "CommandCenterError", reason: "config" });
      expect(
        yield* fixture.fs.exists(`${fixture.configDirectory}/automations/weekly-brief.json`),
      ).toBe(false);
    }),
  );

  it.effect("never advances a newly selected branch when the checkout switches after audit", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const initialCommit = (yield* fixture.git(["rev-parse", "HEAD"])).trim();
      const initialBranch = (yield* fixture.git(["symbolic-ref", "HEAD"])).trim();
      yield* fixture.git(["branch", "switched-during-authoring", initialCommit]);
      const audits: unknown[] = [];

      const failure = yield* Effect.flip(
        fixture.store.create(createInput, (audit) =>
          Effect.gen(function* () {
            audits.push(audit);
            yield* fixture.git(["symbolic-ref", "HEAD", "refs/heads/switched-during-authoring"]);
          }),
        ),
      );

      expect(failure).toMatchObject({ _tag: "CommandCenterError", reason: "conflict" });
      expect((yield* fixture.git(["symbolic-ref", "HEAD"])).trim()).toBe(
        "refs/heads/switched-during-authoring",
      );
      expect((yield* fixture.git(["rev-parse", initialBranch])).trim()).toBe(initialCommit);
      expect(
        (yield* fixture.git(["rev-parse", "refs/heads/switched-during-authoring"])).trim(),
      ).toBe(initialCommit);
      expect(audits).toHaveLength(1);
      expect(
        yield* fixture.fs.exists(`${fixture.configDirectory}/automations/weekly-brief.json`),
      ).toBe(true);
    }),
  );

  it.effect("accepts an update-ref timeout only after authoritative new-ref readback", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      let intercepted = false;
      fixture.storeControl.run = (input) => {
        const updateIndex = input.args.lastIndexOf("update-ref");
        if (intercepted || updateIndex < 0) return fixture.runner.run(input);
        intercepted = true;
        return fixture.runner.run(input).pipe(
          Effect.andThen(
            Effect.fail(
              new ProcessRunner.ProcessTimeoutError({
                command: input.command,
                argumentCount: input.args.length,
                timeoutMs: 1,
              }),
            ),
          ),
        );
      };

      const created = yield* fixture.store.create(createInput, () => Effect.void);

      expect(intercepted).toBe(true);
      expect((yield* fixture.git(["rev-parse", "HEAD"])).trim()).toBe(created.configCommitSha);
      expect(yield* fixture.git(["status", "--porcelain=v1"])).toBe("");
    }),
  );

  it.effect("finishes create publication when interrupted after target publication", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const initialCommit = (yield* fixture.git(["rev-parse", "HEAD"])).trim();
      const auditEntered = yield* Deferred.make<void>();
      const releaseAudit = yield* Deferred.make<void>();
      const creation = yield* fixture.store
        .create(createInput, () =>
          Deferred.succeed(auditEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseAudit)),
          ),
        )
        .pipe(Effect.forkChild({ startImmediately: true }));

      yield* Deferred.await(auditEntered);
      const interrupter = yield* Fiber.interrupt(creation).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.succeed(releaseAudit, undefined);
      yield* Fiber.join(interrupter);

      expect((yield* fixture.git(["rev-parse", "HEAD"])).trim()).not.toBe(initialCommit);
      expect(yield* fixture.git(["status", "--porcelain=v1"])).toBe("");
      expect(
        yield* fixture.fs.exists(`${fixture.configDirectory}/automations/weekly-brief.json`),
      ).toBe(true);
    }),
  );

  it.effect("finishes save publication when interrupted after index publication", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const initial = yield* fixture.store.get(getInput);
      const initialIndex = yield* fixture.git([
        "ls-files",
        "--stage",
        "--",
        "automations/sample-flow.json",
      ]);
      const updateRefEntered = yield* Deferred.make<void>();
      const releaseUpdateRef = yield* Deferred.make<void>();
      let intercepted = false;
      fixture.storeControl.beforeRun = (input) => {
        if (intercepted || !input.args.includes("update-ref")) return Effect.void;
        intercepted = true;
        return Deferred.succeed(updateRefEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseUpdateRef)),
        );
      };
      const saving = yield* fixture.store
        .save(
          decodeSave({
            automationId: "sample-flow",
            spaceId: "sample-space",
            expectedDefinitionDigest: initial.definitionDigest,
            definition: { ...initial.definition, name: "Interrupted after index" },
          }),
          () => Effect.void,
        )
        .pipe(Effect.forkChild({ startImmediately: true }));

      yield* Deferred.await(updateRefEntered);
      expect(
        yield* fixture.git(["ls-files", "--stage", "--", "automations/sample-flow.json"]),
      ).not.toBe(initialIndex);
      const interrupter = yield* Fiber.interrupt(saving).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.succeed(releaseUpdateRef, undefined);
      yield* Fiber.join(interrupter);

      expect(intercepted).toBe(true);
      expect(yield* fixture.git(["status", "--porcelain=v1"])).toBe("");
      expect((yield* fixture.store.get(getInput)).definition.name).toBe("Interrupted after index");
    }),
  );

  it.effect("preserves authored state when update-ref readback finds a third commit", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      let thirdCommit: string | undefined;
      fixture.storeControl.run = (input) => {
        const updateIndex = input.args.lastIndexOf("update-ref");
        if (thirdCommit !== undefined || updateIndex < 0) return fixture.runner.run(input);
        const branchRef = input.args[updateIndex + 1]!;
        const parentCommit = input.args[updateIndex + 3]!;
        return Effect.gen(function* () {
          const tree = (yield* fixture.git(["rev-parse", `${parentCommit}^{tree}`])).trim();
          thirdCommit = (yield* fixture.git([
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture",
            "commit-tree",
            tree,
            "-p",
            parentCommit,
            "-m",
            "Concurrent ref winner",
          ])).trim();
          yield* fixture.git(["update-ref", branchRef, thirdCommit, parentCommit]);
          return yield* fixture.runner.run(input);
        });
      };

      const failure = yield* fixture.store.create(createInput, () => Effect.void).pipe(Effect.flip);

      expect(failure).toMatchObject({ _tag: "CommandCenterError", reason: "conflict" });
      expect((yield* fixture.git(["rev-parse", "HEAD"])).trim()).toBe(thirdCommit);
      expect(
        yield* fixture.fs.exists(`${fixture.configDirectory}/automations/weekly-brief.json`),
      ).toBe(true);
      expect(
        yield* fixture.git(["ls-files", "--stage", "--", "automations/weekly-brief.json"]),
      ).toMatch(/^100644 [a-f0-9]{40,64} 0\tautomations\/weekly-brief\.json\n$/u);
    }),
  );

  it.effect("bypasses malicious Git clean filters for create and save commits", () =>
    Effect.gen(function* () {
      const createFixture = yield* makeFixture;
      const installHostileFilter = Effect.fn("installHostileFilter")(function* (
        fixture: typeof createFixture,
        markerPath: string,
      ) {
        yield* fixture.fs.writeFileString(
          `${fixture.configDirectory}/.gitattributes`,
          "automations/*.json filter=command-center-test\n",
        );
        yield* fixture.git(["add", "--", ".gitattributes"]);
        yield* fixture.git([
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture",
          "commit",
          "--quiet",
          "-m",
          "Add hostile attributes",
        ]);
        yield* fixture.git([
          "config",
          "filter.command-center-test.clean",
          `sh -c 'printf unsafe > "${markerPath}"; cat'`,
        ]);
      });

      const createMarker = `${createFixture.configDirectory}/create-filter-executed`;
      yield* installHostileFilter(createFixture, createMarker);
      yield* createFixture.store.create(createInput, () => Effect.void);
      expect(yield* createFixture.fs.exists(createMarker)).toBe(false);

      const saveFixture = yield* makeFixture;
      const saveMarker = `${saveFixture.configDirectory}/save-filter-executed`;
      yield* installHostileFilter(saveFixture, saveMarker);
      const initial = yield* saveFixture.store.get(getInput);
      yield* saveFixture.store.save(
        decodeSave({
          automationId: "sample-flow",
          spaceId: "sample-space",
          expectedDefinitionDigest: initial.definitionDigest,
          definition: {
            ...initial.definition,
            name: "Changed without a clean filter",
          },
        }),
        () => Effect.void,
      );
      expect(yield* saveFixture.fs.exists(saveMarker)).toBe(false);
    }),
  );

  it.effect("hashes exact service bytes even when the target is concurrently replaced", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const initialCommit = (yield* fixture.git(["rev-parse", "HEAD"])).trim();
      const targetPath = `${fixture.configDirectory}/automations/weekly-brief.json`;
      const replacementPath = `${fixture.configDirectory}/automations/replacement.tmp`;
      const sentinel = '{"api_token":"must-never-be-committed"}\n';
      let replaced = false;
      fixture.storeControl.beforeRun = (input) => {
        if (replaced || !input.args.includes("hash-object")) return Effect.void;
        replaced = true;
        return Effect.gen(function* () {
          yield* fixture.fs.writeFileString(replacementPath, sentinel);
          yield* fixture.fs.rename(replacementPath, targetPath);
        }).pipe(Effect.orDie);
      };
      const audits: unknown[] = [];

      const failure = yield* Effect.flip(
        fixture.store.create(createInput, (audit) => Effect.sync(() => audits.push(audit))),
      );
      const hashInvocation = fixture.storeResults.find((result) =>
        result.args.includes("hash-object"),
      );
      const commitInvocation = fixture.storeResults.find((result) =>
        result.args.includes("commit-tree"),
      );
      const orphanCommit = commitInvocation?.stdout.trim();

      expect(failure).toMatchObject({ _tag: "CommandCenterError", reason: "conflict" });
      expect(hashInvocation?.stdin).toBeDefined();
      expect(orphanCommit).toMatch(/^[a-f0-9]{40,64}$/u);
      expect(yield* fixture.git(["show", `${orphanCommit}:automations/weekly-brief.json`])).toBe(
        hashInvocation!.stdin,
      );
      expect(hashInvocation!.stdin).not.toContain("api_token");
      expect(yield* fixture.fs.readFileString(targetPath)).toBe(sentinel);
      expect((yield* fixture.git(["rev-parse", "HEAD"])).trim()).toBe(initialCommit);
      expect(audits).toHaveLength(0);
    }),
  );

  it.effect("loads exact source and commits only the selected file while preserving policy", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const initial = yield* fixture.store.get(getInput);
      const initialCommit = initial.configCommitSha;
      const audits: unknown[] = [];
      expect(initial.definition.$schema).toBe("../schemas/automation.schema.json");
      expect(initial.definition.policy).toEqual({ requireApprovalForExternalWrites: true });
      expect(initial.authoringHealth).toEqual({ status: "available" });

      const saved = yield* fixture.store.save(
        decodeSave({
          automationId: "sample-flow",
          spaceId: "sample-space",
          expectedDefinitionDigest: initial.definitionDigest,
          definition: {
            ...initial.definition,
            nodes: [
              ...initial.definition.nodes,
              { id: "review", kind: "approval", config: { summary: "Review sample" } },
            ],
            edges: [{ from: "start", to: "review" }],
            layout: {
              ...initial.definition.layout,
              _commandCenter: {
                requestId: "spoofed-request",
                requestDigest: "spoofed-digest",
              },
              nodes: {
                start: { x: 80, y: 120 },
                review: { x: 380, y: 120 },
              },
            },
            policy: { requireApprovalForExternalWrites: false },
          },
        }),
        (audit) =>
          Effect.sync(() => {
            fixture.storeEvents.push("audit");
            audits.push(audit);
          }),
      );

      const updateRefEvent = fixture.storeEvents.findIndex((event) =>
        event.includes("update-ref refs/heads/"),
      );
      expect(updateRefEvent).toBeGreaterThan(fixture.storeEvents.indexOf("audit"));
      expect(saved.configCommitSha).not.toBe(initialCommit);
      expect(saved.definition.policy).toEqual({ requireApprovalForExternalWrites: true });
      expect(yield* fixture.git(["status", "--porcelain=v1"])).toBe("");
      expect(
        (yield* fixture.git(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])).trim(),
      ).toBe("automations/sample-flow.json");
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        automationId: "sample-flow",
        previousConfigCommitSha: initialCommit,
        configCommitSha: saved.configCommitSha,
        previousDefinitionDigest: initial.definitionDigest,
        definitionDigest: saved.definitionDigest,
      });

      const committedFile = decodeUnknownJsonString(
        yield* fixture.fs.readFileString(fixture.automationPath),
      ) as Record<string, unknown>;
      expect(committedFile.policy).toEqual({ requireApprovalForExternalWrites: true });
      expect((committedFile.layout as Record<string, unknown>)._commandCenter).toBeUndefined();
      expect((yield* fixture.store.get(getInput)).definitionDigest).toBe(saved.definitionDigest);
    }),
  );

  it.effect("commits and reloads an incomplete action draft", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const initial = yield* fixture.store.get(getInput);
      const saved = yield* fixture.store.save(
        decodeSave({
          automationId: "sample-flow",
          spaceId: "sample-space",
          expectedDefinitionDigest: initial.definitionDigest,
          definition: {
            ...initial.definition,
            nodes: [{ id: "start", kind: "agent.run", config: {} }],
          },
        }),
        () => Effect.void,
      );

      expect(saved.definition.nodes).toEqual([{ id: "start", kind: "agent.run", config: {} }]);
      expect((yield* fixture.store.get(getInput)).definition).toEqual(saved.definition);
      expect(yield* fixture.git(["status", "--porcelain=v1"])).toBe("");
    }),
  );

  it.effect("serializes only decoded service-owned source fields", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const initial = yield* fixture.store.get(getInput);
      const definitionWithUnknownKey = {
        ...initial.definition,
        name: "Service-owned serialization",
        api_token: "must-never-reach-git",
      };
      const saved = yield* fixture.store.save(
        {
          automationId: getInput.automationId,
          spaceId: getInput.spaceId,
          expectedDefinitionDigest: initial.definitionDigest,
          definition: definitionWithUnknownKey,
        },
        () => Effect.void,
      );
      const committed = yield* fixture.git([
        "show",
        `${saved.configCommitSha}:automations/sample-flow.json`,
      ]);

      expect(committed).toContain('"name": "Service-owned serialization"');
      expect(committed).not.toContain("api_token");
      expect(committed).not.toContain("must-never-reach-git");
    }),
  );

  it.effect("refuses stale digests and a dirty target without changing either state", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const initial = yield* fixture.store.get(getInput);
      const next = decodeSave({
        automationId: "sample-flow",
        spaceId: "sample-space",
        expectedDefinitionDigest: initial.definitionDigest,
        definition: {
          ...initial.definition,
          layout: { nodes: { start: { x: 160, y: 180 } } },
        },
      });
      const saved = yield* fixture.store.save(next, () => Effect.void);

      const stale = yield* Effect.flip(fixture.store.save(next, () => Effect.void));
      expect(stale).toMatchObject({ _tag: "CommandCenterError", reason: "conflict" });
      expect((yield* fixture.git(["rev-parse", "HEAD"])).trim()).toBe(saved.configCommitSha);

      yield* fixture.fs.writeFileString(fixture.automationPath, '{"dirty":true}\n');
      const dirty = yield* Effect.flip(
        fixture.store.save(
          decodeSave({ ...next, expectedDefinitionDigest: saved.definitionDigest }),
          () => Effect.void,
        ),
      );
      expect(dirty).toMatchObject({ _tag: "CommandCenterError", reason: "conflict" });
      expect(yield* fixture.fs.readFileString(fixture.automationPath)).toBe('{"dirty":true}\n');
      expect((yield* fixture.git(["rev-parse", "HEAD"])).trim()).toBe(saved.configCommitSha);
    }),
  );

  it.effect("preserves a replacement made immediately before the target exchange", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const initial = yield* fixture.store.get(getInput);
      const initialIndex = yield* fixture.git([
        "ls-files",
        "--stage",
        "--",
        "automations/sample-flow.json",
      ]);
      const replacementPath = `${fixture.configDirectory}/automations/external-save.tmp`;
      const externalContents = '{"external":"replacement-before-exchange"}\n';
      const audits: unknown[] = [];
      let intercepted = false;
      fixture.storeControl.beforeRun = (input) => {
        if (intercepted || !input.args.includes("-I") || !input.args.includes("-S")) {
          return Effect.void;
        }
        intercepted = true;
        return Effect.gen(function* () {
          yield* fixture.fs.writeFileString(replacementPath, externalContents);
          yield* fixture.fs.rename(replacementPath, fixture.automationPath);
        }).pipe(Effect.orDie);
      };

      const failure = yield* Effect.flip(
        fixture.store.save(
          decodeSave({
            automationId: "sample-flow",
            spaceId: "sample-space",
            expectedDefinitionDigest: initial.definitionDigest,
            definition: { ...initial.definition, name: "Must not replace external bytes" },
          }),
          (audit) => Effect.sync(() => audits.push(audit)),
        ),
      );

      expect(intercepted).toBe(true);
      expect(failure).toMatchObject({ _tag: "CommandCenterError", reason: "conflict" });
      expect(yield* fixture.fs.readFileString(fixture.automationPath)).toBe(externalContents);
      expect((yield* fixture.git(["rev-parse", "HEAD"])).trim()).toBe(initial.configCommitSha);
      expect(
        yield* fixture.git(["ls-files", "--stage", "--", "automations/sample-flow.json"]),
      ).toBe(initialIndex);
      expect(audits).toHaveLength(0);
    }),
  );

  it.effect("preserves both directories when the automation parent is swapped at exchange", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const initial = yield* fixture.store.get(getInput);
      const originalContents = yield* fixture.fs.readFileString(fixture.automationPath);
      const initialIndex = yield* fixture.git([
        "ls-files",
        "--stage",
        "--",
        "automations/sample-flow.json",
      ]);
      const automationsDirectory = `${fixture.configDirectory}/automations`;
      const displacedDirectory = `${fixture.configDirectory}/automations-before-exchange`;
      const externalContents = '{"external":"parent-directory-swap"}\n';
      const audits: unknown[] = [];
      let intercepted = false;
      fixture.storeControl.beforeRun = (input) => {
        if (intercepted || !input.args.includes("-I") || !input.args.includes("-S")) {
          return Effect.void;
        }
        intercepted = true;
        return Effect.gen(function* () {
          yield* fixture.fs.rename(automationsDirectory, displacedDirectory);
          yield* fixture.fs.makeDirectory(automationsDirectory);
          yield* fixture.fs.writeFileString(fixture.automationPath, externalContents);
        }).pipe(Effect.orDie);
      };

      const failure = yield* Effect.flip(
        fixture.store.save(
          decodeSave({
            automationId: "sample-flow",
            spaceId: "sample-space",
            expectedDefinitionDigest: initial.definitionDigest,
            definition: { ...initial.definition, name: "Must not cross a parent swap" },
          }),
          (audit) => Effect.sync(() => audits.push(audit)),
        ),
      );

      expect(intercepted).toBe(true);
      expect(failure).toMatchObject({ _tag: "CommandCenterError", reason: "conflict" });
      expect(yield* fixture.fs.readFileString(fixture.automationPath)).toBe(externalContents);
      expect(yield* fixture.fs.readFileString(`${displacedDirectory}/sample-flow.json`)).toBe(
        originalContents,
      );
      expect((yield* fixture.git(["rev-parse", "HEAD"])).trim()).toBe(initial.configCommitSha);
      expect(
        yield* fixture.git(["ls-files", "--stage", "--", "automations/sample-flow.json"]),
      ).toBe(initialIndex);
      expect(audits).toHaveLength(0);
    }),
  );

  it.effect("rejects an automation id that could escape the safe config path", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const error = yield* Effect.flip(
        fixture.store.get(decodeGet({ automationId: "../outside", spaceId: "sample-space" })),
      );

      expect(error).toMatchObject({ _tag: "CommandCenterError", reason: "validation" });
      expect((yield* fixture.git(["rev-parse", "HEAD"])).trim()).toMatch(/^[a-f0-9]{40,64}$/u);
      expect(yield* fixture.git(["status", "--porcelain=v1"])).toBe("");
    }),
  );

  it.effect("rolls back the file, index, and commit when auditing fails", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const initial = yield* fixture.store.get(getInput);
      const originalContents = yield* fixture.fs.readFileString(fixture.automationPath);
      let headDuringAudit: string | undefined;
      const failure = yield* Effect.flip(
        fixture.store.save(
          decodeSave({
            automationId: "sample-flow",
            spaceId: "sample-space",
            expectedDefinitionDigest: initial.definitionDigest,
            definition: {
              ...initial.definition,
              layout: { nodes: { start: { x: 240, y: 240 } } },
            },
          }),
          () =>
            Effect.gen(function* () {
              headDuringAudit = (yield* fixture.git(["rev-parse", "HEAD"])).trim();
              return yield* Effect.fail("audit unavailable" as const);
            }),
        ),
      );

      expect(failure).toBe("audit unavailable");
      expect(headDuringAudit).toBe(initial.configCommitSha);
      expect(fixture.storeEvents.some((event) => event.includes("update-ref refs/heads/"))).toBe(
        false,
      );
      expect((yield* fixture.git(["rev-parse", "HEAD"])).trim()).toBe(initial.configCommitSha);
      expect(yield* fixture.git(["status", "--porcelain=v1"])).toBe("");
      expect(yield* fixture.fs.readFileString(fixture.automationPath)).toBe(originalContents);
    }),
  );
});
