// @effect-diagnostics nodeBuiltinImport:off - artifact export is an explicit Node filesystem boundary.
import type {
  SandboxAdoptionHint,
  SandboxProvisionInput,
  SandboxReady,
  SandboxArtifactExport,
  SandboxReconcileResult,
  SandboxUsageSample,
  SandboxExecInput,
  SandboxCommandResult,
  SandboxCommandExecutor,
} from "./types.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { ContainerSandboxBackend } from "./ContainerSandboxBackend.ts";
import { NodeSandboxCommandExecutor } from "./NodeSandboxCommandExecutor.ts";
import { ThreadDesktopRuntime } from "./ThreadDesktopRuntime.ts";
import { ThreadServiceStackRuntime, type ThreadServiceDeclaration } from "./ThreadServiceStack.ts";
import { ThreadCredentialBroker } from "./CredentialBroker.ts";
import { desktopGateway } from "./DesktopGatewayService.ts";
import { ThreadPreviewProxy } from "./ThreadPreviewProxy.ts";
import {
  resolveSandboxCredentialProxyImage,
  ThreadCredentialProxySidecar,
} from "./SandboxCredentialProxy.ts";
import { ServerConfig } from "../config.ts";

const credentialBroker = new ThreadCredentialBroker();

/**
 * Resolves the sandbox container image for a project: the `.t3` project file's
 * `sandbox.image` wins over the `T3_SANDBOX_IMAGE` environment default.
 * Returns undefined when sandboxing is not configured for this deployment.
 */
export function resolveSandboxImage(
  projectFile: { readonly sandbox?: { readonly image?: string } } | undefined,
): string | undefined {
  const image = projectFile?.sandbox?.image ?? process.env.T3_SANDBOX_IMAGE?.trim();
  return image ? image : undefined;
}

/** Resolves the preview-proxy sidecar image required by sandbox provisioning. */
export function resolveSandboxPreviewProxyImage(): string | undefined {
  const image = process.env.T3_SANDBOX_PREVIEW_PROXY_IMAGE?.trim();
  return image ? image : undefined;
}

/**
 * Deployment default for the container runtime binary.
 *
 * `sandboxConfig.runtime` is a valid contract field but no client populates it,
 * so without this the reactor's `?? "docker"` fallback is the only reachable
 * value and a podman-only host can never be selected. Returns the raw value
 * rather than narrowing it: the caller's existing docker/podman check then
 * rejects a typo loudly instead of silently routing threads at the wrong
 * runtime. Unset yields "docker", so nothing changes by default.
 */
export function resolveSandboxRuntime(): string {
  const configured = process.env.T3_SANDBOX_RUNTIME?.trim().toLowerCase();
  return configured ? configured : "docker";
}

/**
 * Deployment-level desktop gate. `T3_SANDBOX_DESKTOP=disabled` runs sandboxes
 * headless: no X server, no WebRTC streaming, no automation target. Defaults to
 * "enabled" so nothing changes for deployments that never set the variable.
 *
 * This is intentionally an env var rather than `sandboxConfig.desktop`, which
 * is declared in contracts but read by nothing — the choice is a property of
 * the host image, not of a project.
 */
export function resolveSandboxDesktopMode(): "enabled" | "disabled" {
  return process.env.T3_SANDBOX_DESKTOP?.trim().toLowerCase() === "disabled"
    ? "disabled"
    : "enabled";
}

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
  /** Absent when the deployment runs headless (`T3_SANDBOX_DESKTOP=disabled`). */
  readonly desktopSessionId?: string;
  readonly desktopStreamPath?: string;
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
  /**
   * `hint` lets export and teardown reach a sandbox this manager generation
   * never provisioned -- a server restart empties the backend's per-thread
   * records, which otherwise strands the thread's commits in its volume.
   */
  readonly exportBranch: (
    runtime: "docker" | "podman",
    threadId: string,
    hint?: SandboxAdoptionHint,
  ) => Effect.Effect<SandboxArtifactExport, SandboxManagerError>;
  readonly stop: (
    runtime: "docker" | "podman",
    threadId: string,
    hint?: SandboxAdoptionHint,
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

/**
 * Builds a manager over a command executor. Tests supply their own executor to
 * observe the exact runtime invocations without launching containers.
 */
export const makeSandboxRuntimeManager = (
  artifactRoot: string | undefined,
  platform: NodeJS.Platform,
  commandExecutor?: SandboxCommandExecutor,
): SandboxRuntimeManagerShape => {
  const executor = commandExecutor ?? new NodeSandboxCommandExecutor(platform);
  const runtimes = new Map<
    "docker" | "podman",
    {
      backend: ContainerSandboxBackend;
      desktop: ThreadDesktopRuntime;
      services: ThreadServiceStackRuntime;
      previews: ThreadPreviewProxy;
      credentials: ThreadCredentialProxySidecar;
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
      credentials: new ThreadCredentialProxySidecar(runtime, executor),
    };
    runtimes.set(runtime, value);
    return value;
  };
  /**
   * Bootstrap fields that seed a sandbox from the branch bundle a previous
   * teardown exported, or `undefined` when this is not a restore.
   *
   * A missing or tampered artifact is not fatal: the thread still gets a
   * sandbox, seeded the ordinary way at its recorded base commit. Losing the
   * previous session's commits is bad, but refusing to provision at all would
   * leave the user with a thread they cannot use either way.
   */
  const resolveRestoreBootstrap = Effect.fn("SandboxRuntimeManager.resolveRestoreBootstrap")(
    function* (input: SandboxProvisionInput) {
      const restore = input.restore;
      if (restore === undefined || artifactRoot === undefined) return undefined;
      if (!/^[a-f0-9]{64}$/i.test(restore.artifactId)) {
        yield* Effect.logWarning("sandbox restore artifact id is malformed", {
          threadId: input.bootstrap.threadId,
        });
        return undefined;
      }
      const bundle = NodePath.resolve(artifactRoot, `${restore.artifactId}.bundle`);
      const digest = yield* Effect.tryPromise(async () =>
        NodeCrypto.createHash("sha256")
          .update(await NodeFSP.readFile(bundle))
          .digest("hex"),
      ).pipe(Effect.orElseSucceed(() => undefined));
      if (digest === undefined) {
        yield* Effect.logWarning("sandbox restore bundle is missing; seeding from base commit", {
          threadId: input.bootstrap.threadId,
          bundle,
        });
        return undefined;
      }
      if (digest !== restore.bundleSha256.toLowerCase()) {
        yield* Effect.logWarning("sandbox restore bundle failed its digest check", {
          threadId: input.bootstrap.threadId,
          bundle,
        });
        return undefined;
      }
      return {
        ...input.bootstrap,
        repositoryBundlePath: bundle,
        // `exportBundle` writes `git bundle create --all`, so the thread branch
        // is in there under its ordinary heads ref -- the seeding fetch has to
        // name it, since a bundle fetch takes no default refspec.
        repositoryBundleRef: `refs/heads/${restore.branchName}`,
        restoreCommit: restore.headCommit,
      };
    },
  );

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
      const previewImage = resolveSandboxPreviewProxyImage();
      if (!previewImage)
        return yield* new SandboxManagerError({
          message:
            "T3_SANDBOX_PREVIEW_PROXY_IMAGE is required for the internal desktop signaling sidecar",
        });
      // Per-thread config wins, then the deployment default. Callers validate the
      // runtime before dispatching but pass `config` through verbatim, so the
      // deployment default has to be applied here or a podman-only host runs
      // docker.
      const runtime = input.config?.runtime ?? resolveSandboxRuntime();
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
      const restored = yield* resolveRestoreBootstrap(input);
      if (restored !== undefined) {
        provisionInput = { ...input, bootstrap: restored };
      } else if (!/^(?:https|ssh):\/\//i.test(input.bootstrap.repositoryUrl)) {
        if (artifactRoot === undefined)
          return yield* new SandboxManagerError({
            message: "local repository seeding requires configured server artifact storage",
          });
        const seedRoot = NodePath.resolve(artifactRoot, "seeds");
        yield* attempt(() => NodeFSP.mkdir(seedRoot, { recursive: true, mode: 0o700 }));
        const seedHash = NodeCrypto.createHash("sha256")
          .update(input.bootstrap.threadId)
          .digest("hex");
        seedBundle = NodePath.resolve(seedRoot, `.${seedHash}.${process.pid}.bundle`);
        // `git bundle create` refuses a bare commit SHA ("Refusing to create empty
        // bundle") because a bundle records named refs, not anonymous commits. Pin a
        // throwaway ref at the base commit so the bundle has something to name, then
        // remove it once the bundle is written.
        const seedRef = `refs/t3-sandbox-seed/${seedHash}.${process.pid}`;
        yield* attempt(async () => {
          const refUpdated = await executor.run({
            executable: "git",
            args: [
              "-C",
              input.bootstrap.repositoryUrl,
              "update-ref",
              seedRef,
              input.bootstrap.baseCommit,
            ],
            timeoutMs: 30_000,
          });
          if (refUpdated.exitCode !== 0)
            throw new Error(refUpdated.stderr || "failed to pin local repository seed ref");
          try {
            const created = await executor.run({
              executable: "git",
              args: ["-C", input.bootstrap.repositoryUrl, "bundle", "create", seedBundle!, seedRef],
              timeoutMs: 120_000,
            });
            if (created.exitCode !== 0)
              throw new Error(created.stderr || "failed to create local repository seed bundle");
            // `bundle verify` resolves the bundle's prerequisites against a
            // repository, so it needs `-C` even though the bundle names a full
            // history; without it git exits with "need a repository to verify a
            // bundle" wherever the server happens to be running.
            const verified = await executor.run({
              executable: "git",
              args: ["-C", input.bootstrap.repositoryUrl, "bundle", "verify", seedBundle!],
              timeoutMs: 60_000,
            });
            if (verified.exitCode !== 0)
              throw new Error(
                verified.stderr || "local repository seed bundle failed verification",
              );
          } finally {
            await executor.run({
              executable: "git",
              args: ["-C", input.bootstrap.repositoryUrl, "update-ref", "-d", seedRef],
              timeoutMs: 30_000,
            });
          }
        });
        provisionInput = {
          ...input,
          bootstrap: {
            ...input.bootstrap,
            repositoryBundlePath: seedBundle,
            repositoryBundleRef: seedRef,
          },
        };
      }
      const ready = yield* attempt(() => managed.backend.ensureReady(provisionInput)).pipe(
        Effect.ensuring(
          seedBundle === undefined
            ? Effect.void
            : Effect.promise(() => NodeFSP.rm(seedBundle!, { force: true })),
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
      const credentialImage = resolveSandboxCredentialProxyImage();
      if (credentialImage !== undefined) {
        yield* attempt(() =>
          managed.credentials.start(
            input.bootstrap.threadId,
            ready.networkName,
            credentialImage,
            input.egressProxyImage !== undefined || input.egressProxyUrl !== undefined,
          ),
        ).pipe(
          Effect.tapError(() =>
            Effect.promise(async () => {
              await managed.credentials.stop(input.bootstrap.threadId);
              await managed.previews.stop(input.bootstrap.threadId);
              await managed.services.stop(input.bootstrap.threadId);
              teardownHooks.delete(input.bootstrap.threadId);
              await managed.backend.stop(input.bootstrap.threadId).catch(() => undefined);
            }),
          ),
        );
      }
      for (const port of input.previewPorts ?? []) {
        desktopGateway.registerPreviewRoute({
          routeId: `${NodeCrypto.createHash("sha256").update(`${input.bootstrap.threadId}\0${port}`).digest("hex").slice(0, 24)}`,
          threadId: input.bootstrap.threadId,
          hostname: ready.containerName,
          internalPort: port,
          token: NodeCrypto.randomBytes(32).toString("base64url"),
        });
      }
      // Headless deployments stop here: no desktop runtime, no automation
      // target. The preview sidecar above still runs, since preview routing is
      // independent of the streamed desktop.
      const desktop =
        resolveSandboxDesktopMode() === "disabled"
          ? undefined
          : yield* attempt(() =>
              managed.desktop.start(
                input.bootstrap.threadId,
                desktopGateway.bridge(input.bootstrap.threadId),
                managed.previews.internalSignalingOrigin(input.bootstrap.threadId),
              ),
            ).pipe(
              Effect.tapError(() =>
                Effect.promise(async () => {
                  await managed.credentials.stop(input.bootstrap.threadId);
                  await managed.services.stop(input.bootstrap.threadId);
                  await managed.previews.stop(input.bootstrap.threadId);
                  teardownHooks.delete(input.bootstrap.threadId);
                  await managed.backend.stop(input.bootstrap.threadId).catch(() => undefined);
                }),
              ),
            );
      if (desktop !== undefined) {
        const automation = managed.desktop.automationTarget(input.bootstrap.threadId);
        desktopGateway.setAutomationTarget(
          input.bootstrap.threadId,
          ready.containerName,
          automation.profilePath,
        );
      }
      return {
        ...ready,
        ...(desktop === undefined
          ? {}
          : { desktopSessionId: desktop.sessionId, desktopStreamPath: desktop.signalingPath }),
        services: services.map((service) => ({
          name: service.hostname,
          internalPorts: service.internalPorts,
        })),
      };
    }),
    exportBranch: (runtime, threadId, hint) =>
      attempt(async () => {
        if (artifactRoot === undefined)
          throw new Error("sandbox artifact storage requires the configured server runtime layer");
        await NodeFSP.mkdir(artifactRoot, { recursive: true, mode: 0o700 });
        const name = NodeCrypto.createHash("sha256").update(threadId).digest("hex");
        const bundleTemporary = NodePath.resolve(
          artifactRoot,
          `.${name}.${process.pid}.bundle.tmp`,
        );
        const bundleDestination = NodePath.resolve(artifactRoot, `${name}.bundle`);
        const manifestTemporary = NodePath.resolve(
          artifactRoot,
          `.${name}.${process.pid}.json.tmp`,
        );
        const manifestDestination = NodePath.resolve(artifactRoot, `${name}.json`);
        try {
          const result = await get(runtime).backend.exportBranch(threadId, hint);
          await get(runtime).backend.exportBundle(threadId, bundleTemporary, hint);
          const bundleSha256 = NodeCrypto.createHash("sha256")
            .update(await NodeFSP.readFile(bundleTemporary))
            .digest("hex");
          await NodeFSP.writeFile(
            manifestTemporary,
            JSON.stringify({ threadId, bundle: `${name}.bundle`, bundleSha256, ...result }),
            { mode: 0o600, flag: "wx" },
          );
          await NodeFSP.rename(bundleTemporary, bundleDestination);
          await NodeFSP.rename(manifestTemporary, manifestDestination);
          return { ...result, artifactId: name, bundleSha256 };
        } finally {
          await Promise.all([
            NodeFSP.rm(bundleTemporary, { force: true }),
            NodeFSP.rm(manifestTemporary, { force: true }),
          ]);
        }
      }),
    stop: Effect.fn("SandboxRuntimeManager.stop")(function* (runtime, threadId, hint) {
      const managed = get(runtime);
      if (resolveSandboxDesktopMode() !== "disabled")
        yield* Effect.promise(() => managed.desktop.stop(threadId));
      yield* Effect.promise(() => managed.credentials.stop(threadId));
      yield* Effect.promise(() => managed.previews.stop(threadId));
      yield* Effect.promise(() => managed.services.stop(threadId));
      credentialBroker.revokeThread(threadId);
      desktopGateway.removeThread(threadId);
      yield* attempt(() => managed.backend.stop(threadId, teardownHooks.get(threadId) ?? [], hint));
      teardownHooks.delete(threadId);
    }),
    reconcile: (runtime, expectedThreadIds) =>
      attempt(async () => {
        const managed = get(runtime);
        const result = await managed.backend.reconcile({ expectedThreadIds, removeOrphans: true });
        const headless = resolveSandboxDesktopMode() === "disabled";
        for (const threadId of result.activeThreadIds) {
          await managed.credentials.recover(threadId);
          // Headless threads have no desktop to recover, and marking them as
          // capability failures would report a desktop that was never started.
          if (headless) {
            await managed.previews.recover(threadId);
            continue;
          }
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
            routeId: NodeCrypto.createHash("sha256")
              .update(`${threadId}\0${port}`)
              .digest("hex")
              .slice(0, 24),
            threadId,
            hostname,
            internalPort: port,
            token: NodeCrypto.randomBytes(32).toString("base64url"),
          });
        return true;
      }),
    revokeCredentials: (threadId) => Effect.sync(() => credentialBroker.revokeThread(threadId)),
  };
};

const configuredArtifactRoot = process.env.T3_SANDBOX_ARTIFACT_DIR;
const defaultManager = makeSandboxRuntimeManager(
  configuredArtifactRoot === undefined ? undefined : NodePath.resolve(configuredArtifactRoot),
  Effect.runSync(HostProcessPlatform),
);
export class SandboxRuntimeManager extends Context.Reference<SandboxRuntimeManagerShape>(
  "@awtprod/command-center/sandbox/SandboxRuntimeManager",
  { defaultValue: () => defaultManager },
) {}

export const SandboxRuntimeManagerLive = Layer.effect(
  SandboxRuntimeManager,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const platform = yield* HostProcessPlatform;
    return makeSandboxRuntimeManager(
      NodePath.resolve(config.stateDir, "sandbox-artifacts"),
      platform,
    );
  }),
);
