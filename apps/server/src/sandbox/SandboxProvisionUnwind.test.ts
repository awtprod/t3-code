// @effect-diagnostics nodeBuiltinImport:off - derives the expected container names from the thread id.
import { describe, expect, it, vi } from "@effect/vitest";
import { afterEach } from "vite-plus/test";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";

import { desktopGateway } from "./DesktopGatewayService.ts";
import { makeSandboxRuntimeManager } from "./SandboxRuntimeManager.ts";
import type { ThreadServiceDeclaration } from "./ThreadServiceStack.ts";
import type {
  SandboxCommand,
  SandboxCommandExecutor,
  SandboxCommandResult,
  SandboxProvisionInput,
} from "./types.ts";

const PREVIEW_IMAGE = `preview@sha256:${"a".repeat(64)}`;
const SANDBOX_IMAGE = `sandbox@sha256:${"b".repeat(64)}`;
const THREAD_ID = "thread-unwind";
const PROJECT_ID = "project-1";
const CONTAINER_NAME = `t3-thread-${NodeCrypto.createHash("sha256")
  .update(`${PROJECT_ID}\0${THREAD_ID}`)
  .digest("hex")
  .slice(0, 32)}`;

class FakeExecutor implements SandboxCommandExecutor {
  readonly commands: SandboxCommand[] = [];
  readonly #override: (command: SandboxCommand) => SandboxCommandResult | undefined;
  constructor(override?: (command: SandboxCommand) => SandboxCommandResult | undefined) {
    this.#override = override ?? (() => undefined);
  }
  async run(command: SandboxCommand): Promise<SandboxCommandResult> {
    this.commands.push(command);
    const overridden = this.#override(command);
    if (overridden !== undefined) return overridden;
    if (command.args[0] === "info") return { exitCode: 0, stdout: '["name=rootless"]', stderr: "" };
    if (command.args[0] === "inspect" && command.args.length === 2)
      return { exitCode: 1, stdout: "", stderr: "missing" };
    if (command.args[0] === "volume" && command.args[1] === "inspect") {
      const name = command.args.at(-1) ?? "";
      if (name.startsWith("t3-cache-")) return { exitCode: 1, stdout: "", stderr: "missing" };
      const bytes = name.startsWith("t3-desktop-")
        ? Math.max(256 * 1024 ** 2, Math.floor(20 * 1024 ** 3 * 0.1))
        : Math.floor(20 * 1024 ** 3 * 0.9);
      return { exitCode: 0, stdout: `size=${bytes}\n`, stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

type ProvisionRequest = SandboxProvisionInput & {
  services?: ReadonlyArray<ThreadServiceDeclaration>;
};

const provisionInput = (overrides: Partial<ProvisionRequest> = {}): ProvisionRequest => ({
  bootstrap: {
    threadId: THREAD_ID,
    projectId: PROJECT_ID,
    repositoryUrl: "https://example.test/repository.git",
    baseCommit: "a".repeat(40),
    branchName: `thread/${THREAD_ID}`,
  },
  image: SANDBOX_IMAGE,
  ...overrides,
});

const MUTATED_ENV = [
  "T3_SANDBOX_DESKTOP",
  "T3_SANDBOX_PREVIEW_PROXY_IMAGE",
  "T3_SANDBOX_CREDENTIAL_PROXY_IMAGE",
] as const;
const originalEnv = new Map(MUTATED_ENV.map((key) => [key, process.env[key]] as const));

afterEach(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
  desktopGateway.removeThread(THREAD_ID);
});

/** Every `rm --force <name>` the executor saw, in order. */
const forcedRemovals = (executor: FakeExecutor) =>
  executor.commands
    .filter((command) => command.args[0] === "rm" && command.args[1] === "--force")
    .map((command) => command.args.at(-1));

describe("provision failure unwinds", () => {
  it.effect("clears gateway routes, grants, and proxies when desktop start fails", () =>
    Effect.gen(function* () {
      // The failure point is AFTER setServiceStatus, setServiceCredentialGrants,
      // setPreviewProxy, and registerPreviewRoute have all run -- the exact
      // window where a failed provision used to leave live preview routes and
      // readable credential grants pointing at destroyed containers.
      delete process.env.T3_SANDBOX_DESKTOP;
      process.env.T3_SANDBOX_PREVIEW_PROXY_IMAGE = PREVIEW_IMAGE;
      delete process.env.T3_SANDBOX_CREDENTIAL_PROXY_IMAGE;
      const executor = new FakeExecutor((command) =>
        // Fail the desktop capability probe for `code`; every other probe and
        // container command succeeds, so provisioning reaches desktop.start
        // with services, grants, and preview state fully registered.
        command.args[0] === "exec" && command.args.at(-1) === "code"
          ? { exitCode: 1, stdout: "", stderr: "not found" }
          : undefined,
      );
      const manager = makeSandboxRuntimeManager(undefined, "linux", executor);

      const failure = yield* manager
        .provision(
          provisionInput({
            previewPorts: [3000],
            services: [
              {
                name: "database",
                image: `postgres@sha256:${"c".repeat(64)}`,
                generatedEnvironment: [{ key: "POSTGRES_PASSWORD", kind: "password" }],
              },
            ],
          }),
        )
        .pipe(Effect.flip);

      expect(failure._tag).toBe("SandboxManagerError");
      expect(failure.message).toContain("missing required capabilities");
      // The gateway holds nothing for the thread anymore: no routes, no
      // grants (token values were readable through the status endpoint), no
      // service status, no per-thread preview proxy.
      const status = desktopGateway.status(THREAD_ID);
      expect(status.previewRoutes).toEqual([]);
      expect(status.serviceCredentialGrants).toEqual([]);
      expect(status.services).toEqual([]);
      expect(status.ready).toBe(false);
      expect(desktopGateway.previewProxy(THREAD_ID)).toBeNull();
      // ...and the containers were torn down: workspace, service, and the
      // preview sidecar all removed.
      const removed = forcedRemovals(executor);
      expect(removed).toContain(CONTAINER_NAME);
      expect(removed.some((name) => name?.startsWith("t3-svc-"))).toBe(true);
      expect(removed.some((name) => name?.startsWith("t3-preview-"))).toBe(true);
    }),
  );

  it.effect("turns a sync throw while issuing service grants into a typed, unwound failure", () =>
    Effect.gen(function* () {
      // A bare `throw` inside the provision generator is a defect that skips
      // every tapError unwind, leaking the workspace container and services.
      // The grant-issuing block must fail typed and still tear everything down.
      process.env.T3_SANDBOX_DESKTOP = "disabled";
      process.env.T3_SANDBOX_PREVIEW_PROXY_IMAGE = PREVIEW_IMAGE;
      delete process.env.T3_SANDBOX_CREDENTIAL_PROXY_IMAGE;
      const issue = vi.spyOn(desktopGateway.credentials, "issue").mockImplementation(() => {
        throw new Error("generated service credential database:POSTGRES_PASSWORD is missing");
      });
      const executor = new FakeExecutor();
      const manager = makeSandboxRuntimeManager(undefined, "linux", executor);

      const failure = yield* manager
        .provision(
          provisionInput({
            services: [
              {
                name: "database",
                image: `postgres@sha256:${"c".repeat(64)}`,
                generatedEnvironment: [{ key: "POSTGRES_PASSWORD", kind: "password" }],
              },
            ],
          }),
        )
        .pipe(Effect.flip);

      expect(issue).toHaveBeenCalled();
      // Typed failure, not a defect: `Effect.flip` above only succeeds for the
      // error channel; a defect would have crashed the test instead.
      expect(failure._tag).toBe("SandboxManagerError");
      expect(failure.message).toContain("generated service credential");
      // The unwind ran: workspace container and service container removed,
      // and no gateway state survives.
      const removed = forcedRemovals(executor);
      expect(removed).toContain(CONTAINER_NAME);
      expect(removed.some((name) => name?.startsWith("t3-svc-"))).toBe(true);
      const status = desktopGateway.status(THREAD_ID);
      expect(status.services).toEqual([]);
      expect(status.serviceCredentialGrants).toEqual([]);
    }),
  );
});
