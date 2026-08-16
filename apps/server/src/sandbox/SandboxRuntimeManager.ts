// @effect-diagnostics nodeBuiltinImport:off - artifact export is an explicit Node filesystem boundary.
import type {
  SandboxProvisionInput,
  SandboxReady,
  SandboxArtifactExport,
  SandboxReconcileResult,
  SandboxUsageSample,
  SandboxExecInput,
  SandboxCommandResult,
} from "./types.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ContainerSandboxBackend } from "./ContainerSandboxBackend.ts";
import { NodeSandboxCommandExecutor } from "./NodeSandboxCommandExecutor.ts";
import { ThreadDesktopRuntime } from "./ThreadDesktopRuntime.ts";
import { ThreadServiceStackRuntime, type ThreadServiceDeclaration } from "./ThreadServiceStack.ts";
import { ThreadCredentialBroker } from "./CredentialBroker.ts";
import { desktopGateway } from "./DesktopGatewayService.ts";
import { ThreadPreviewProxy } from "./ThreadPreviewProxy.ts";
import { ServerConfig } from "../config.ts";

const credentialBroker = new ThreadCredentialBroker();

/** One-shot credential boundary used immediately before provider process spawn. */
export function redeemSandboxProviderEnvironment(
  threadId: string,
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const redeemed: Record<string, string> = {};
  for (const [scope, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    const grant = credentialBroker.issue({ threadId, scope, value, ttlMs: 60_000 });
    const result = credentialBroker.redeem({ ...grant, threadId, scope });
    if (result === null) throw new Error(`credential grant for ${scope} was denied`);
    redeemed[scope] = result;
  }
  return redeemed;
}

export type ManagedSandboxReady = SandboxReady & {
  readonly desktopSessionId: string;
  readonly desktopStreamPath: string;
  readonly services: ReadonlyArray<{
    readonly name: string;
    readonly internalPorts: ReadonlyArray<number>;
  }>;
};

export interface SandboxRuntimeManagerShape {
  readonly exec?: (
    runtime: "docker" | "podman",
    threadId: string,
    input: SandboxExecInput,
  ) => Effect.Effect<SandboxCommandResult, SandboxManagerError>;
  readonly provision: (
    input: SandboxProvisionInput & { services?: ReadonlyArray<ThreadServiceDeclaration> },
  ) => Effect.Effect<ManagedSandboxReady, SandboxManagerError>;
  readonly exportBranch: (
    runtime: "docker" | "podman",
    threadId: string,
  ) => Effect.Effect<SandboxArtifactExport, SandboxManagerError>;
  readonly stop: (
    runtime: "docker" | "podman",
    threadId: string,
  ) => Effect.Effect<void, SandboxManagerError>;
  readonly reconcile: (
    runtime: "docker" | "podman",
    expectedThreadIds: ReadonlySet<string>,
  ) => Effect.Effect<SandboxReconcileResult, SandboxManagerError>;
  readonly sampleUsage: (
    runtime: "docker" | "podman",
    threadId: string,
  ) => Effect.Effect<SandboxUsageSample, SandboxManagerError>;
  readonly recoverPreview: (
    runtime: "docker" | "podman",
    threadId: string,
    hostname: string,
    ports: ReadonlyArray<number>,
  ) => Effect.Effect<boolean, SandboxManagerError>;
  readonly revokeCredentials: (threadId: string) => Effect.Effect<number>;
}

export class SandboxManagerError extends Schema.TaggedErrorClass<SandboxManagerError>()(
  "SandboxManagerError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

const makeManager = (artifactRoot: string | undefined): SandboxRuntimeManagerShape => {
  const executor = new NodeSandboxCommandExecutor();
  const runtimes = new Map<
    "docker" | "podman",
    {
      backend: ContainerSandboxBackend;
      desktop: ThreadDesktopRuntime;
      services: ThreadServiceStackRuntime;
      previews: ThreadPreviewProxy;
    }
  >();
  const teardownHooks = new Map<string, NonNullable<SandboxProvisionInput["teardown"]>>();
  const get = (runtime: "docker" | "podman") => {
    const existing = runtimes.get(runtime);
    if (existing) return existing;
    const backend = new ContainerSandboxBackend(runtime, executor);
    const value = {
      backend,
      desktop: new ThreadDesktopRuntime(backend),
      services: new ThreadServiceStackRuntime(runtime, executor),
      previews: new ThreadPreviewProxy(runtime, executor, desktopGateway.previews),
    };
    runtimes.set(runtime, value);
    return value;
  };
  const attempt = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        new SandboxManagerError({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });
  return {
    exec: Effect.fn("SandboxRuntimeManager.exec")(function* (runtime, threadId, input) {
      return yield* attempt(() => get(runtime).backend.exec(threadId, input));
    }),
    provision: Effect.fn("SandboxRuntimeManager.provision")(function* (input) {
      const previewImage = process.env.T3_SANDBOX_PREVIEW_PROXY_IMAGE?.trim();
      if (!previewImage)
        return yield* new SandboxManagerError({
          message:
            "T3_SANDBOX_PREVIEW_PROXY_IMAGE is required for the internal desktop signaling sidecar",
        });
      const runtime = input.config?.runtime ?? "docker";
      if (runtime !== "docker" && runtime !== "podman")
        return yield* new SandboxManagerError({
          message: `unsupported sandbox runtime: ${runtime}`,
        });
      const trustedCaches = new Set(
        (process.env.T3_SANDBOX_TRUSTED_CACHE_DIGESTS ?? "")
          .split(",")
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean),
      );
      for (const cache of input.caches ?? []) {
        if (!trustedCaches.has(cache.digest.toLowerCase())) {
          return yield* new SandboxManagerError({
            message: `cache ${cache.digest} is absent from the server-trusted cache manifest`,
          });
        }
      }
      const managed = get(runtime);
      let provisionInput = input;
      let seedBundle: string | undefined;
      if (!/^(?:https|ssh):\/\//i.test(input.bootstrap.repositoryUrl)) {
        if (artifactRoot === undefined)
          return yield* new SandboxManagerError({
            message: "local repository seeding requires configured server artifact storage",
          });
        const seedRoot = resolve(artifactRoot, "seeds");
        yield* attempt(() => mkdir(seedRoot, { recursive: true, mode: 0o700 }));
        seedBundle = resolve(
          seedRoot,
          `.${createHash("sha256").update(input.bootstrap.threadId).digest("hex")}.${process.pid}.bundle`,
        );
        yield* attempt(async () => {
          const created = await executor.run({
            executable: "git",
            args: [
              "-C",
              input.bootstrap.repositoryUrl,
              "bundle",
              "create",
              seedBundle!,
              input.bootstrap.baseCommit,
            ],
            timeoutMs: 120_000,
          });
          if (created.exitCode !== 0)
            throw new Error(created.stderr || "failed to create local repository seed bundle");
          const verified = await executor.run({
            executable: "git",
            args: ["bundle", "verify", seedBundle!],
            timeoutMs: 60_000,
          });
          if (verified.exitCode !== 0)
            throw new Error(verified.stderr || "local repository seed bundle failed verification");
        });
        provisionInput = {
          ...input,
          bootstrap: { ...input.bootstrap, repositoryBundlePath: seedBundle },
        };
      }
      const ready = yield* attempt(() => managed.backend.ensureReady(provisionInput)).pipe(
        Effect.ensuring(
          seedBundle === undefined
            ? Effect.void
            : Effect.promise(() => rm(seedBundle!, { force: true })),
        ),
      );
      teardownHooks.set(input.bootstrap.threadId, input.teardown ?? []);
      const services = yield* attempt(() =>
        managed.services.start(input.bootstrap.threadId, input.services ?? [], ready.networkName),
      ).pipe(
        Effect.tapError(() =>
          Effect.promise(async () => {
            teardownHooks.delete(input.bootstrap.threadId);
            await managed.backend.stop(input.bootstrap.threadId).catch(() => undefined);
          }),
        ),
      );
      desktopGateway.setServiceStatus(
        input.bootstrap.threadId,
        services.map((service) => ({ name: service.hostname, healthy: true })),
      );
      const serviceGrants = services.flatMap((service) => {
        const declaration = input.services?.find(
          (candidate) => candidate.name === service.hostname,
        );
        return (declaration?.generatedEnvironment ?? []).map((entry) => {
          const value = service.environment[entry.key];
          if (value === undefined)
            throw new Error(
              `generated service credential ${service.hostname}:${entry.key} is missing`,
            );
          const scope = `service:${service.hostname}:${entry.key}`;
          return {
            ...desktopGateway.credentials.issue({
              threadId: input.bootstrap.threadId,
              scope,
              value,
              ttlMs: 15 * 60_000,
            }),
            scope,
          };
        });
      });
      desktopGateway.setServiceCredentialGrants(input.bootstrap.threadId, serviceGrants);
      managed.services.redactCredentials(input.bootstrap.threadId);
      yield* attempt(() =>
        managed.previews.start(input.bootstrap.threadId, ready.networkName, previewImage),
      ).pipe(
        Effect.tapError(() =>
          Effect.promise(async () => {
            await managed.previews.stop(input.bootstrap.threadId);
            await managed.services.stop(input.bootstrap.threadId);
            teardownHooks.delete(input.bootstrap.threadId);
            await managed.backend.stop(input.bootstrap.threadId).catch(() => undefined);
          }),
        ),
      );
      desktopGateway.setPreviewProxy(managed.previews);
      for (const port of input.previewPorts ?? []) {
        desktopGateway.registerPreviewRoute({
          routeId: `${createHash("sha256").update(`${input.bootstrap.threadId}\0${port}`).digest("hex").slice(0, 24)}`,
          threadId: input.bootstrap.threadId,
          hostname: ready.containerName,
          internalPort: port,
          token: randomBytes(32).toString("base64url"),
        });
      }
      const desktop = yield* attempt(() =>
        managed.desktop.start(
          input.bootstrap.threadId,
          desktopGateway.bridge(input.bootstrap.threadId),
          managed.previews.internalSignalingOrigin(input.bootstrap.threadId),
        ),
      ).pipe(
        Effect.tapError(() =>
          Effect.promise(async () => {
            await managed.services.stop(input.bootstrap.threadId);
            await managed.previews.stop(input.bootstrap.threadId);
            teardownHooks.delete(input.bootstrap.threadId);
            await managed.backend.stop(input.bootstrap.threadId).catch(() => undefined);
          }),
        ),
      );
      const automation = managed.desktop.automationTarget(input.bootstrap.threadId);
      desktopGateway.setAutomationTarget(
        input.bootstrap.threadId,
        ready.containerName,
        automation.profilePath,
      );
      return {
        ...ready,
        desktopSessionId: desktop.sessionId,
        desktopStreamPath: desktop.signalingPath,
        services: services.map((service) => ({
          name: service.hostname,
          internalPorts: service.internalPorts,
        })),
      };
    }),
    exportBranch: (runtime, threadId) =>
      attempt(async () => {
        if (artifactRoot === undefined)
          throw new Error("sandbox artifact storage requires the configured server runtime layer");
        await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
        const name = createHash("sha256").update(threadId).digest("hex");
        const bundleTemporary = resolve(artifactRoot, `.${name}.${process.pid}.bundle.tmp`);
        const bundleDestination = resolve(artifactRoot, `${name}.bundle`);
        const manifestTemporary = resolve(artifactRoot, `.${name}.${process.pid}.json.tmp`);
        const manifestDestination = resolve(artifactRoot, `${name}.json`);
        try {
          const result = await get(runtime).backend.exportBranch(threadId);
          await get(runtime).backend.exportBundle(threadId, bundleTemporary);
          const bundleSha256 = createHash("sha256")
            .update(await readFile(bundleTemporary))
            .digest("hex");
          await writeFile(
            manifestTemporary,
            JSON.stringify({ threadId, bundle: `${name}.bundle`, bundleSha256, ...result }),
            { mode: 0o600, flag: "wx" },
          );
          await rename(bundleTemporary, bundleDestination);
          await rename(manifestTemporary, manifestDestination);
          return { ...result, artifactId: name, bundleSha256 };
        } finally {
          await Promise.all([
            rm(bundleTemporary, { force: true }),
            rm(manifestTemporary, { force: true }),
          ]);
        }
      }),
    stop: Effect.fn("SandboxRuntimeManager.stop")(function* (runtime, threadId) {
      const managed = get(runtime);
      yield* Effect.promise(() => managed.desktop.stop(threadId));
      yield* Effect.promise(() => managed.previews.stop(threadId));
      yield* Effect.promise(() => managed.services.stop(threadId));
      credentialBroker.revokeThread(threadId);
      desktopGateway.removeThread(threadId);
      yield* attempt(() => managed.backend.stop(threadId, teardownHooks.get(threadId) ?? []));
      teardownHooks.delete(threadId);
    }),
    reconcile: (runtime, expectedThreadIds) =>
      attempt(async () => {
        const managed = get(runtime);
        const result = await managed.backend.reconcile({ expectedThreadIds, removeOrphans: true });
        for (const threadId of result.activeThreadIds) {
          const desktop = await managed.desktop.recover(threadId);
          if (desktop === null) {
            desktopGateway.setCapabilityFailure(threadId, ["desktop-session"]);
          } else {
            const automation = managed.desktop.automationTarget(threadId);
            const runtimeRef = managed.backend.runtimeRef(threadId);
            desktopGateway.setAutomationTarget(
              threadId,
              runtimeRef ?? automation.endpoint,
              automation.profilePath,
            );
          }
        }
        return result;
      }),
    sampleUsage: (runtime, threadId) => attempt(() => get(runtime).backend.sampleUsage(threadId)),
    recoverPreview: (runtime, threadId, hostname, ports) =>
      attempt(async () => {
        if (ports.length === 0) return false;
        const previews = get(runtime).previews;
        if (!(await previews.recover(threadId))) return false;
        desktopGateway.setPreviewProxy(previews);
        for (const port of ports)
          desktopGateway.registerPreviewRoute({
            routeId: createHash("sha256").update(`${threadId}\0${port}`).digest("hex").slice(0, 24),
            threadId,
            hostname,
            internalPort: port,
            token: randomBytes(32).toString("base64url"),
          });
        return true;
      }),
    revokeCredentials: (threadId) => Effect.sync(() => credentialBroker.revokeThread(threadId)),
  };
};

const configuredArtifactRoot = process.env.T3_SANDBOX_ARTIFACT_DIR;
const defaultManager = makeManager(
  configuredArtifactRoot === undefined ? undefined : resolve(configuredArtifactRoot),
);
export class SandboxRuntimeManager extends Context.Reference<SandboxRuntimeManagerShape>(
  "@awtprod/command-center/sandbox/SandboxRuntimeManager",
  { defaultValue: () => defaultManager },
) {}

export const SandboxRuntimeManagerLive = Layer.effect(
  SandboxRuntimeManager,
  Effect.map(ServerConfig, (config) => makeManager(resolve(config.stateDir, "sandbox-artifacts"))),
);
