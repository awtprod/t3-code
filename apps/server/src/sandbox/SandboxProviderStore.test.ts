// @effect-diagnostics nodeBuiltinImport:off - test needs a real artifact directory to round-trip the store through.
import { describe, expect, it } from "@effect/vitest";
import { afterEach } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

import { makeSandboxRuntimeManager } from "./SandboxRuntimeManager.ts";
import type {
  SandboxCommand,
  SandboxCommandExecutor,
  SandboxCommandResult,
  SandboxProvisionInput,
} from "./types.ts";

const PREVIEW_IMAGE = `preview@sha256:${"a".repeat(64)}`;
const SANDBOX_IMAGE = `sandbox@sha256:${"b".repeat(64)}`;
const THREAD_ID = "thread-store";
const ARTIFACT_ID = NodeCrypto.createHash("sha256").update(THREAD_ID).digest("hex");
const BUNDLE_CONTENTS = "bundle-bytes";
const STORE_CONTENTS = "store-bytes";

/**
 * Executor that answers a clean provision and materializes whatever `cp` moves
 * out of the container.
 *
 * The store round-trip is the thing under test, so the copies cannot be
 * no-ops: the manager hashes what lands on disk, and a `cp` that wrote nothing
 * would make every digest assertion vacuous.
 */
class FakeExecutor implements SandboxCommandExecutor {
  readonly commands: SandboxCommand[] = [];
  readonly #storeBytes: number;
  constructor(storeBytes = STORE_CONTENTS.length) {
    this.#storeBytes = storeBytes;
  }
  async run(command: SandboxCommand): Promise<SandboxCommandResult> {
    this.commands.push(command);
    const [verb] = command.args;
    if (verb === "info") return { exitCode: 0, stdout: '["name=rootless"]', stderr: "" };
    if (verb === "inspect" && command.args.length === 2)
      return { exitCode: 1, stdout: "", stderr: "missing" };
    if (verb === "volume" && command.args[1] === "inspect") {
      const name = command.args.at(-1) ?? "";
      if (name.startsWith("t3-cache-")) return { exitCode: 1, stdout: "", stderr: "missing" };
      const bytes = name.startsWith("t3-desktop-")
        ? Math.max(256 * 1024 ** 2, Math.floor(20 * 1024 ** 3 * 0.1))
        : Math.floor(20 * 1024 ** 3 * 0.9);
      return { exitCode: 0, stdout: `size=${bytes}\n`, stderr: "" };
    }
    if (verb === "exec" && command.args.includes("rev-parse"))
      return { exitCode: 0, stdout: `${"c".repeat(40)}\n`, stderr: "" };
    if (verb === "exec" && command.args.includes("stat"))
      return { exitCode: 0, stdout: `${this.#storeBytes}\n`, stderr: "" };
    if (verb === "cp") {
      const source = command.args[1] ?? "";
      const destination = command.args[2] ?? "";
      if (source.includes(":")) {
        NodeFS.writeFileSync(
          destination,
          source.endsWith(".tar") ? STORE_CONTENTS : BUNDLE_CONTENTS,
          "utf8",
        );
      }
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

const provisionInput = (overrides: Partial<SandboxProvisionInput> = {}): SandboxProvisionInput => ({
  bootstrap: {
    threadId: THREAD_ID,
    projectId: "project-1",
    repositoryUrl: "https://example.test/repository.git",
    baseCommit: "a".repeat(40),
    branchName: `thread/${THREAD_ID}`,
  },
  image: SANDBOX_IMAGE,
  ...overrides,
});

const restore = (storeSha256?: string) => ({
  artifactId: ARTIFACT_ID,
  bundleSha256: NodeCrypto.createHash("sha256").update(BUNDLE_CONTENTS).digest("hex"),
  headCommit: "c".repeat(40),
  branchName: `thread/${THREAD_ID}`,
  ...(storeSha256 === undefined ? {} : { storeSha256 }),
});

const roots: string[] = [];
const makeRoot = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-store-"));
  roots.push(root);
  return root;
};

const MUTATED_ENV = [
  "T3_SANDBOX_DESKTOP",
  "T3_SANDBOX_PREVIEW_PROXY_IMAGE",
  "T3_SANDBOX_CREDENTIAL_PROXY_IMAGE",
  "T3_SANDBOX_STORE_MAX_BYTES",
  "T3_SANDBOX_ARTIFACT_MAX_AGE_SECONDS",
] as const;
const originalEnv = new Map(MUTATED_ENV.map((key) => [key, process.env[key]] as const));

afterEach(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  while (roots.length > 0) NodeFS.rmSync(roots.pop()!, { recursive: true, force: true });
});

const headless = () => {
  process.env.T3_SANDBOX_DESKTOP = "disabled";
  process.env.T3_SANDBOX_PREVIEW_PROXY_IMAGE = PREVIEW_IMAGE;
  delete process.env.T3_SANDBOX_CREDENTIAL_PROXY_IMAGE;
};

/** The `cp` that pushes a restored store into the container, if one happened. */
const storePushed = (executor: FakeExecutor) =>
  executor.commands.find(
    (command) => command.args[0] === "cp" && (command.args[1] ?? "").endsWith(".store.tar"),
  );

describe("provider conversation store artifacts", () => {
  it.effect("writes the store beside the bundle and records its digest", () =>
    Effect.gen(function* () {
      headless();
      const root = makeRoot();
      const executor = new FakeExecutor();
      const manager = makeSandboxRuntimeManager(root, "linux", executor);
      yield* manager.provision(provisionInput());

      const exported = yield* manager.exportBranch("docker", THREAD_ID);

      // The digest travels on the export event, and is what a later restore
      // checks the artifact against -- so it has to describe the file that
      // actually landed, not the one that was in the container.
      expect(exported.storeSha256).toBe(
        NodeCrypto.createHash("sha256").update(STORE_CONTENTS).digest("hex"),
      );
      expect(NodeFS.readFileSync(NodePath.join(root, `${ARTIFACT_ID}.store.tar`), "utf8")).toBe(
        STORE_CONTENTS,
      );
      // @effect-diagnostics-next-line preferSchemaOverJson:off - asserting the raw manifest bytes on disk, not a decoded value.
      const manifest = JSON.parse(
        NodeFS.readFileSync(NodePath.join(root, `${ARTIFACT_ID}.json`), "utf8"),
      ) as {
        store?: string;
        storeServed?: boolean;
        storeSha256?: string;
        storeBytes?: number;
      };
      expect(manifest.store).toBe(`${ARTIFACT_ID}.store.tar`);
      // The artifact HTTP route serves only `bundle` and `manifest`; the
      // manifest must say so rather than advertise a 404.
      expect(manifest.storeServed).toBe(false);
      expect(manifest.storeSha256).toBe(exported.storeSha256);
      expect(manifest.storeBytes).toBe(STORE_CONTENTS.length);
    }),
  );

  it.effect("exports the branch without a store when the store is oversized", () =>
    Effect.gen(function* () {
      headless();
      process.env.T3_SANDBOX_STORE_MAX_BYTES = "1";
      const root = makeRoot();
      const executor = new FakeExecutor();
      const manager = makeSandboxRuntimeManager(root, "linux", executor);
      yield* manager.provision(provisionInput());

      const exported = yield* manager.exportBranch("docker", THREAD_ID);

      // The branch is the part that cannot be lost; the store is a bonus that
      // an unprunable artifact directory is allowed to refuse.
      expect(exported.bundleSha256).toBe(
        NodeCrypto.createHash("sha256").update(BUNDLE_CONTENTS).digest("hex"),
      );
      expect(exported.storeSha256).toBeUndefined();
      expect(() => NodeFS.readFileSync(NodePath.join(root, `${ARTIFACT_ID}.store.tar`))).toThrow();
    }),
  );

  it.effect("restores a store whose digest matches the recorded one", () =>
    Effect.gen(function* () {
      headless();
      const root = makeRoot();
      NodeFS.writeFileSync(NodePath.join(root, `${ARTIFACT_ID}.bundle`), BUNDLE_CONTENTS, "utf8");
      NodeFS.writeFileSync(NodePath.join(root, `${ARTIFACT_ID}.store.tar`), STORE_CONTENTS, "utf8");
      const executor = new FakeExecutor();
      const manager = makeSandboxRuntimeManager(root, "linux", executor);

      yield* manager.provision(
        provisionInput({
          restore: restore(NodeCrypto.createHash("sha256").update(STORE_CONTENTS).digest("hex")),
        }),
      );

      expect(storePushed(executor)).toBeDefined();
    }),
  );

  it.effect("provisions without a store when the archive fails its digest check", () =>
    Effect.gen(function* () {
      headless();
      const root = makeRoot();
      NodeFS.writeFileSync(NodePath.join(root, `${ARTIFACT_ID}.bundle`), BUNDLE_CONTENTS, "utf8");
      NodeFS.writeFileSync(NodePath.join(root, `${ARTIFACT_ID}.store.tar`), "tampered", "utf8");
      const executor = new FakeExecutor();
      const manager = makeSandboxRuntimeManager(root, "linux", executor);

      // A store that does not match its digest is dropped rather than trusted:
      // the thread still comes back, the provider just starts cold.
      yield* manager.provision(
        provisionInput({
          restore: restore(NodeCrypto.createHash("sha256").update(STORE_CONTENTS).digest("hex")),
        }),
      );

      expect(storePushed(executor)).toBeUndefined();
      expect(executor.commands.some((command) => command.args[0] === "run")).toBe(true);
    }),
  );

  it.effect("provisions without a store when the archive is missing entirely", () =>
    Effect.gen(function* () {
      headless();
      const root = makeRoot();
      NodeFS.writeFileSync(NodePath.join(root, `${ARTIFACT_ID}.bundle`), BUNDLE_CONTENTS, "utf8");
      const executor = new FakeExecutor();
      const manager = makeSandboxRuntimeManager(root, "linux", executor);

      yield* manager.provision(
        provisionInput({
          restore: restore(NodeCrypto.createHash("sha256").update(STORE_CONTENTS).digest("hex")),
        }),
      );

      expect(storePushed(executor)).toBeUndefined();
    }),
  );

  it.effect("restores the bundle of an export that predates stores", () =>
    Effect.gen(function* () {
      headless();
      const root = makeRoot();
      NodeFS.writeFileSync(NodePath.join(root, `${ARTIFACT_ID}.bundle`), BUNDLE_CONTENTS, "utf8");
      const executor = new FakeExecutor();
      const manager = makeSandboxRuntimeManager(root, "linux", executor);

      // `storeSha256` is optional precisely so exports written before stores
      // existed keep restoring their branch normally.
      yield* manager.provision(provisionInput({ restore: restore() }));

      expect(storePushed(executor)).toBeUndefined();
      expect(
        executor.commands.some(
          (command) => command.args[0] === "cp" && (command.args[1] ?? "").endsWith(".bundle"),
        ),
      ).toBe(true);
    }),
  );

  it.effect("removes every artifact of a deleted thread and only that thread's", () =>
    Effect.gen(function* () {
      // The exported bundle and provider store hold the thread's commits and
      // transcripts; thread deletion must not leave them behind on the host.
      const root = makeRoot();
      const otherId = NodeCrypto.createHash("sha256").update("thread-other").digest("hex");
      for (const name of [
        `${ARTIFACT_ID}.bundle`,
        `${ARTIFACT_ID}.json`,
        `${ARTIFACT_ID}.store.tar`,
        `${otherId}.bundle`,
      ])
        NodeFS.writeFileSync(NodePath.join(root, name), "artifact", "utf8");
      const manager = makeSandboxRuntimeManager(root, "linux", new FakeExecutor());

      yield* manager.removeThreadArtifacts(THREAD_ID);

      expect(NodeFS.readdirSync(root).sort()).toEqual([`${otherId}.bundle`]);
      // Idempotent: deleting again (nothing left) is not an error.
      yield* manager.removeThreadArtifacts(THREAD_ID);
    }),
  );

  it.effect("tolerates artifact removal without configured artifact storage", () =>
    Effect.gen(function* () {
      const manager = makeSandboxRuntimeManager(undefined, "linux", new FakeExecutor());
      yield* manager.removeThreadArtifacts(THREAD_ID);
    }),
  );
});

describe("expired artifact retention sweep", () => {
  const artifactSet = (root: string, threadId: string, ageMs: number) => {
    const name = NodeCrypto.createHash("sha256").update(threadId).digest("hex");
    // @effect-diagnostics-next-line globalDate:off - backdates real filesystem mtimes, which the sweep reads with wall-clock time.
    const mtime = new Date(Date.now() - ageMs);
    for (const file of [`${name}.bundle`, `${name}.json`, `${name}.store.tar`]) {
      const path = NodePath.join(root, file);
      NodeFS.writeFileSync(path, "artifact", "utf8");
      NodeFS.utimesSync(path, mtime, mtime);
    }
    return name;
  };
  const DAY_MS = 24 * 60 * 60 * 1000;

  it.effect("deletes sets past the age cap and keeps young ones", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const old = artifactSet(root, "thread-old", 45 * DAY_MS);
      const young = artifactSet(root, "thread-young", 5 * DAY_MS);
      const manager = makeSandboxRuntimeManager(root, "linux", new FakeExecutor());

      const removed = yield* manager.sweepExpiredArtifacts(new Set());

      expect(removed).toBe(1);
      const remaining = NodeFS.readdirSync(root).sort();
      expect(remaining).toEqual([`${young}.bundle`, `${young}.json`, `${young}.store.tar`]);
      expect(remaining.some((file) => file.startsWith(old))).toBe(false);
    }),
  );

  it.effect("a set is as young as its newest file", () =>
    Effect.gen(function* () {
      // Exports rename bundle, store, and manifest together; a set whose
      // manifest is fresh exported recently even if an older sibling survived
      // a partial overwrite. It must not be deleted piecemeal.
      const root = makeRoot();
      const name = artifactSet(root, "thread-mixed", 45 * DAY_MS);
      // @effect-diagnostics-next-line globalDateInEffect:off - freshens a real filesystem mtime, which the sweep reads with wall-clock time.
      const now = new Date();
      NodeFS.utimesSync(NodePath.join(root, `${name}.json`), now, now);
      const manager = makeSandboxRuntimeManager(root, "linux", new FakeExecutor());

      expect(yield* manager.sweepExpiredArtifacts(new Set())).toBe(0);
      expect(NodeFS.readdirSync(root)).toHaveLength(3);
    }),
  );

  it.effect("keeps a set belonging to an active thread regardless of age", () =>
    Effect.gen(function* () {
      // A non-terminal sandbox will overwrite its set on the next stop; in the
      // meantime that set may be the seed a re-provision restores from.
      const root = makeRoot();
      const kept = artifactSet(root, "thread-active", 90 * DAY_MS);
      artifactSet(root, "thread-gone", 90 * DAY_MS);
      const manager = makeSandboxRuntimeManager(root, "linux", new FakeExecutor());

      const removed = yield* manager.sweepExpiredArtifacts(new Set(["thread-active"]));

      expect(removed).toBe(1);
      expect(NodeFS.readdirSync(root).sort()).toEqual([
        `${kept}.bundle`,
        `${kept}.json`,
        `${kept}.store.tar`,
      ]);
    }),
  );

  it.effect("an explicit zero disables the sweep entirely", () =>
    Effect.gen(function* () {
      process.env.T3_SANDBOX_ARTIFACT_MAX_AGE_SECONDS = "0";
      const root = makeRoot();
      artifactSet(root, "thread-ancient", 400 * DAY_MS);
      const manager = makeSandboxRuntimeManager(root, "linux", new FakeExecutor());

      expect(yield* manager.sweepExpiredArtifacts(new Set())).toBe(0);
      expect(NodeFS.readdirSync(root)).toHaveLength(3);
    }),
  );

  it.effect("ignores in-flight export temporaries and foreign files", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      // @effect-diagnostics-next-line globalDateInEffect:off - backdates real filesystem mtimes, which the sweep reads with wall-clock time.
      const past = new Date(Date.now() - 60 * DAY_MS);
      for (const file of [`.${"a".repeat(64)}.1234.bundle.tmp`, "seeds"]) {
        const path = NodePath.join(root, file);
        NodeFS.writeFileSync(path, "not-an-artifact", "utf8");
        NodeFS.utimesSync(path, past, past);
      }
      const manager = makeSandboxRuntimeManager(root, "linux", new FakeExecutor());

      expect(yield* manager.sweepExpiredArtifacts(new Set())).toBe(0);
      expect(NodeFS.readdirSync(root)).toHaveLength(2);
    }),
  );

  it.effect("sweeps nothing without configured artifact storage or a directory", () =>
    Effect.gen(function* () {
      const unconfigured = makeSandboxRuntimeManager(undefined, "linux", new FakeExecutor());
      expect(yield* unconfigured.sweepExpiredArtifacts(new Set())).toBe(0);
      // A root that exists in config but was never written to (no exports yet).
      const missing = NodePath.join(makeRoot(), "never-created");
      const manager = makeSandboxRuntimeManager(missing, "linux", new FakeExecutor());
      expect(yield* manager.sweepExpiredArtifacts(new Set())).toBe(0);
    }),
  );
});
