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
        storeSha256?: string;
        storeBytes?: number;
      };
      expect(manifest.store).toBe(`${ARTIFACT_ID}.store.tar`);
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
});
