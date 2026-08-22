import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PortSchema,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

const shortText = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const detailText = TrimmedNonEmptyString.check(Schema.isMaxLength(16_384));
const gitObjectId = TrimmedNonEmptyString.check(Schema.isPattern(/^[0-9a-f]{40,64}$/i));
const percentage = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 }));
const boundedPortCount = NonNegativeInt.check(Schema.isLessThanOrEqualTo(256));

export const SandboxId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("SandboxId"),
);
export type SandboxId = typeof SandboxId.Type;

export const SandboxRuntime = Schema.Literals(["docker", "podman", "microvm"]);
export type SandboxRuntime = typeof SandboxRuntime.Type;

export const SandboxLifecycle = Schema.Literals([
  "unprovisioned",
  "provisioning",
  "ready",
  "pausing",
  "paused",
  "stopping",
  "stopped",
  "expired",
  "failed",
  "deleted",
]);
export type SandboxLifecycle = typeof SandboxLifecycle.Type;

export const SandboxPauseReason = Schema.Literals([
  "human-takeover",
  "user-request",
  "idle",
  "capacity",
  "shutdown",
]);
export type SandboxPauseReason = typeof SandboxPauseReason.Type;

export const SandboxResourceLimits = Schema.Struct({
  cpuCount: Schema.Number.check(Schema.isBetween({ minimum: 0.1, maximum: 256 })),
  memoryBytes: PositiveInt.check(Schema.isLessThanOrEqualTo(1_125_899_906_842_624)),
  diskBytes: PositiveInt.check(Schema.isLessThanOrEqualTo(1_125_899_906_842_624)),
  processCount: PositiveInt.check(Schema.isLessThanOrEqualTo(1_048_576)),
  idleTimeoutSeconds: PositiveInt.check(Schema.isLessThanOrEqualTo(31_536_000)),
  maximumLifetimeSeconds: PositiveInt.check(Schema.isLessThanOrEqualTo(31_536_000)),
});
export type SandboxResourceLimits = typeof SandboxResourceLimits.Type;

export const DEFAULT_SANDBOX_RESOURCE_LIMITS: SandboxResourceLimits = {
  cpuCount: 2,
  memoryBytes: 4 * 1024 ** 3,
  diskBytes: 20 * 1024 ** 3,
  processCount: 512,
  idleTimeoutSeconds: 60 * 60,
  maximumLifetimeSeconds: 8 * 60 * 60,
};

export const SandboxDesktopConfig = Schema.Struct({
  width: PositiveInt.check(Schema.isLessThanOrEqualTo(7680)),
  height: PositiveInt.check(Schema.isLessThanOrEqualTo(4320)),
  webRtcEnabled: Schema.Boolean,
});
export type SandboxDesktopConfig = typeof SandboxDesktopConfig.Type;

export const DEFAULT_SANDBOX_DESKTOP_CONFIG: SandboxDesktopConfig = {
  width: 1440,
  height: 900,
  webRtcEnabled: true,
};

export const SandboxConfig = Schema.Struct({
  runtime: Schema.optionalKey(SandboxRuntime),
  limits: Schema.optionalKey(SandboxResourceLimits),
  desktop: Schema.optionalKey(SandboxDesktopConfig),
  setupTimeoutSeconds: Schema.optionalKey(PositiveInt.check(Schema.isLessThanOrEqualTo(86_400))),
  teardownTimeoutSeconds: Schema.optionalKey(PositiveInt.check(Schema.isLessThanOrEqualTo(86_400))),
});
export type SandboxConfig = typeof SandboxConfig.Type;

export const SandboxBranchProvenance = Schema.Struct({
  branchName: shortText,
  baseCommit: gitObjectId,
  parentThreadId: Schema.optionalKey(ThreadId),
  inheritedCommit: Schema.optionalKey(gitObjectId),
  inheritedPatchSha256: Schema.optionalKey(
    TrimmedNonEmptyString.check(Schema.isPattern(/^[0-9a-f]{64}$/i)),
  ),
});
export type SandboxBranchProvenance = typeof SandboxBranchProvenance.Type;

export const SandboxResourceUsage = Schema.Struct({
  cpuPercent: percentage,
  memoryBytes: NonNegativeInt,
  diskBytes: NonNegativeInt,
  processCount: NonNegativeInt,
  sampledAt: IsoDateTime,
});
export type SandboxResourceUsage = typeof SandboxResourceUsage.Type;

export const SandboxServiceHealth = Schema.Struct({
  name: shortText,
  status: Schema.Literals(["starting", "healthy", "degraded", "unhealthy", "stopped"]),
  internalPort: Schema.optionalKey(PortSchema),
  previewRoute: Schema.optionalKey(shortText),
  checkedAt: IsoDateTime,
  message: Schema.optionalKey(detailText),
});
export type SandboxServiceHealth = typeof SandboxServiceHealth.Type;

export const SandboxDesktopReadiness = Schema.Struct({
  status: Schema.Literals(["unavailable", "starting", "ready", "failed"]),
  resolution: Schema.optionalKey(SandboxDesktopConfig),
  sessionId: Schema.optionalKey(shortText),
  streamPath: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isPattern(/^\//))),
  readyAt: Schema.optionalKey(IsoDateTime),
  failure: Schema.optionalKey(detailText),
});
export type SandboxDesktopReadiness = typeof SandboxDesktopReadiness.Type;

export const SandboxController = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({ kind: Schema.Literal("agent"), runId: shortText }),
  Schema.Struct({
    kind: Schema.Literal("human"),
    leaseId: shortText,
    sessionId: shortText,
    acquiredAt: IsoDateTime,
  }),
]);
export type SandboxController = typeof SandboxController.Type;

export const SandboxFailure = Schema.Struct({
  stage: Schema.Literals([
    "capacity",
    "provision",
    "repository",
    "setup",
    "desktop",
    "runtime",
    "reconcile",
    "teardown",
    "export",
  ]),
  code: shortText,
  message: detailText,
  retryable: Schema.Boolean,
  occurredAt: IsoDateTime,
});
export type SandboxFailure = typeof SandboxFailure.Type;

/**
 * The branch bundle written by the most recent export, so a sandbox that was
 * torn down can be re-provisioned with the thread's work instead of at its base
 * commit. The digest is recorded here, in the event log, rather than read back
 * from the artifact directory -- a bundle that verifies only against a manifest
 * sitting beside it verifies against nothing.
 */
export const SandboxBranchExport = Schema.Struct({
  branchName: shortText,
  headCommit: gitObjectId,
  artifactId: TrimmedNonEmptyString.check(Schema.isPattern(/^[0-9a-f]{64}$/i)),
  bundleSha256: TrimmedNonEmptyString.check(Schema.isPattern(/^[0-9a-f]{64}$/i)),
  /**
   * Digest of the provider conversation store archived alongside the bundle,
   * when one was captured.
   *
   * Optional because a store is best-effort: it is absent for exports written
   * before stores were captured at all, and skipped for a store that exceeds
   * the size ceiling or fails to archive. A restore without it simply starts
   * the provider fresh, which is what happened for every export until now.
   */
  storeSha256: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isPattern(/^[0-9a-f]{64}$/i))),
  exportedAt: IsoDateTime,
});
export type SandboxBranchExport = typeof SandboxBranchExport.Type;

export const SandboxState = Schema.Struct({
  lifecycle: SandboxLifecycle,
  sandboxId: Schema.optionalKey(SandboxId),
  runtime: Schema.optionalKey(SandboxRuntime),
  runtimeRef: Schema.optionalKey(shortText),
  branch: SandboxBranchProvenance,
  limits: SandboxResourceLimits,
  usage: Schema.optionalKey(SandboxResourceUsage),
  desktop: SandboxDesktopReadiness,
  services: Schema.Array(SandboxServiceHealth).check(Schema.isMaxLength(256)),
  controller: SandboxController,
  pauseReason: Schema.optionalKey(SandboxPauseReason),
  failure: Schema.optionalKey(SandboxFailure),
  lastExport: Schema.optionalKey(SandboxBranchExport),
  createdAt: IsoDateTime,
  lastActiveAt: IsoDateTime,
  expiresAt: Schema.optionalKey(IsoDateTime),
});
export type SandboxState = typeof SandboxState.Type;

const commandBase = { threadId: ThreadId } as const;
export const SandboxCommand = Schema.Union([
  Schema.Struct({
    ...commandBase,
    type: Schema.Literal("sandbox.provision"),
    config: SandboxConfig,
  }),
  Schema.Struct({
    ...commandBase,
    type: Schema.Literal("sandbox.pause"),
    reason: SandboxPauseReason,
  }),
  Schema.Struct({
    ...commandBase,
    type: Schema.Literal("sandbox.takeover"),
    sessionId: shortText,
  }),
  Schema.Struct({
    ...commandBase,
    type: Schema.Literal("sandbox.resume"),
    leaseId: Schema.optionalKey(shortText),
    takeoverSummary: Schema.optionalKey(detailText),
  }),
  Schema.Struct({ ...commandBase, type: Schema.Literal("sandbox.stop") }),
  Schema.Struct({ ...commandBase, type: Schema.Literal("sandbox.expire") }),
  Schema.Struct({ ...commandBase, type: Schema.Literal("sandbox.reconcile") }),
  Schema.Struct({
    ...commandBase,
    type: Schema.Literal("sandbox.export-branch"),
    expectedHead: gitObjectId,
  }),
]);
export type SandboxCommand = typeof SandboxCommand.Type;

const eventBase = {
  threadId: ThreadId,
  occurredAt: IsoDateTime,
} as const;
export const SandboxEvent = Schema.Union([
  Schema.Struct({ ...eventBase, type: Schema.Literal("sandbox.provisioning-started") }),
  Schema.Struct({
    ...eventBase,
    type: Schema.Literal("sandbox.ready"),
    sandboxId: SandboxId,
    runtime: SandboxRuntime,
    runtimeRef: shortText,
  }),
  Schema.Struct({ ...eventBase, type: Schema.Literal("sandbox.failed"), failure: SandboxFailure }),
  Schema.Struct({
    ...eventBase,
    type: Schema.Literal("sandbox.paused"),
    reason: SandboxPauseReason,
  }),
  Schema.Struct({
    ...eventBase,
    type: Schema.Literal("sandbox.takeover-requested"),
    sessionId: shortText,
  }),
  Schema.Struct({
    ...eventBase,
    type: Schema.Literal("sandbox.takeover-acquired"),
    controller: SandboxController,
  }),
  Schema.Struct({ ...eventBase, type: Schema.Literal("sandbox.resumed"), summary: detailText }),
  Schema.Struct({
    ...eventBase,
    type: Schema.Literal("sandbox.stopping"),
    expired: Schema.Boolean,
  }),
  Schema.Struct({ ...eventBase, type: Schema.Literal("sandbox.expired") }),
  Schema.Struct({ ...eventBase, type: Schema.Literal("sandbox.stopped") }),
  Schema.Struct({
    ...eventBase,
    type: Schema.Literal("sandbox.reconciled"),
    disposition: Schema.Literals(["matched", "missing", "adopted", "orphan-removed"]),
  }),
  Schema.Struct({
    ...eventBase,
    type: Schema.Literal("sandbox.branch-exported"),
    branchName: shortText,
    headCommit: gitObjectId,
    artifactId: TrimmedNonEmptyString.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    bundleSha256: TrimmedNonEmptyString.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    /** Digest of the archived provider conversation store, when one was captured. */
    storeSha256: Schema.optionalKey(
      TrimmedNonEmptyString.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    ),
  }),
]);
export type SandboxEvent = typeof SandboxEvent.Type;

export const SandboxSpawnWorkerInput = Schema.Struct({
  parentThreadId: ThreadId,
  task: detailText,
  inheritedCommit: gitObjectId,
  inheritedPatch: Schema.optionalKey(
    Schema.Struct({
      sha256: TrimmedNonEmptyString.check(Schema.isPattern(/^[0-9a-f]{64}$/i)),
      sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(50 * 1024 * 1024)),
      content: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(50 * 1024 * 1024))),
    }),
  ),
  config: Schema.optionalKey(SandboxConfig),
});
export type SandboxSpawnWorkerInput = typeof SandboxSpawnWorkerInput.Type;

export const SandboxWorkerRef = Schema.Struct({
  parentThreadId: ThreadId,
  childThreadId: ThreadId,
  sandboxId: Schema.optionalKey(SandboxId),
  runId: shortText,
  branchName: shortText,
  inheritedCommit: gitObjectId,
});
export type SandboxWorkerRef = typeof SandboxWorkerRef.Type;

export const SandboxWorkerStatus = Schema.Struct({
  worker: SandboxWorkerRef,
  state: Schema.Literals(["creating", "running", "waiting", "completed", "failed", "stopped"]),
  sandbox: Schema.optionalKey(Schema.NullOr(SandboxState)),
  latestMessage: Schema.optionalKey(detailText),
  updatedAt: IsoDateTime,
});
export type SandboxWorkerStatus = typeof SandboxWorkerStatus.Type;

export const SandboxWorkerOperation = Schema.Union([
  Schema.Struct({ type: Schema.Literal("sandbox.worker-status"), childThreadId: ThreadId }),
  Schema.Struct({
    type: Schema.Literal("sandbox.worker-message"),
    childThreadId: ThreadId,
    message: detailText,
  }),
  Schema.Struct({
    type: Schema.Literal("sandbox.worker-stop"),
    childThreadId: ThreadId,
    reason: Schema.optionalKey(shortText),
  }),
]);
export type SandboxWorkerOperation = typeof SandboxWorkerOperation.Type;

export const SandboxPreviewPorts = Schema.Array(PortSchema).check(Schema.isMaxLength(256));
export type SandboxPreviewPorts = typeof SandboxPreviewPorts.Type;
export const SandboxPreviewPortCount = boundedPortCount;
