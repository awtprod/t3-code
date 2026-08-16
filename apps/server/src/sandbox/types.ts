import type { SandboxConfig, SandboxResourceLimits, SandboxRuntime } from "@t3tools/contracts";

export type SandboxCommand = {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin?: string;
  readonly timeoutMs: number;
};

export type SandboxCommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export interface SandboxCommandExecutor {
  readonly run: (command: SandboxCommand) => Promise<SandboxCommandResult>;
}

export type SandboxCache = {
  /** A content-addressed, runtime-managed volume name. Host paths are not accepted. */
  readonly digest: string;
  readonly target: string;
};

export type SandboxHook = {
  readonly executable: string;
  readonly args?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
};

export type SandboxBootstrap = {
  readonly threadId: string;
  readonly projectId: string;
  readonly repositoryUrl: string;
  readonly baseCommit: string;
  readonly branchName: string;
  readonly parentThreadId?: string;
  readonly inheritedPatch?: string;
  /** Manager-generated verified bundle path; never a user-supplied mount. */
  readonly repositoryBundlePath?: string;
};

export type SandboxProvisionInput = {
  readonly bootstrap: SandboxBootstrap;
  readonly config?: SandboxConfig;
  readonly image: string;
  readonly caches?: ReadonlyArray<SandboxCache>;
  readonly setup?: ReadonlyArray<SandboxHook>;
  readonly teardown?: ReadonlyArray<SandboxHook>;
  /**
   * Proxy URL used for public traffic. Direct egress is disabled when omitted.
   * The proxy is a trusted boundary and must reject private, link-local,
   * metadata, loopback, and cross-sandbox destinations.
   */
  readonly egressProxyUrl?: string;
  readonly egressProxyImage?: string;
  readonly previewPorts?: ReadonlyArray<number>;
};

export type SandboxReady = {
  readonly sandboxId: string;
  readonly runtime: SandboxRuntime;
  readonly containerName: string;
  readonly networkName: string;
  readonly workspaceVolumeName: string;
  readonly desktopVolumeName: string;
  readonly egressProxyContainerName?: string;
  readonly egressNetworkName?: string;
  readonly branchName: string;
  readonly limits: SandboxResourceLimits;
};

export type SandboxExecInput = {
  readonly executable: string;
  readonly args?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly stdin?: string;
};

export type SandboxExport = {
  readonly commit: string;
  readonly patch: string;
};
export type SandboxArtifactExport = SandboxExport & {
  readonly artifactId: string;
  readonly bundleSha256: string;
};
export type SandboxUsageSample = {
  readonly cpuPercent: number;
  readonly memoryBytes: number;
  readonly diskBytes: number;
  readonly processCount: number;
};

export type SandboxReconcileInput = {
  readonly expectedThreadIds: ReadonlySet<string>;
  readonly removeOrphans?: boolean;
};

export type SandboxReconcileResult = {
  readonly activeThreadIds: ReadonlyArray<string>;
  readonly missingThreadIds: ReadonlyArray<string>;
  readonly orphanThreadIds: ReadonlyArray<string>;
  readonly removedRuntimeRefs: ReadonlyArray<string>;
};

export interface ThreadSandboxBackend {
  readonly runtime: SandboxRuntime;
  readonly ensureReady: (input: SandboxProvisionInput) => Promise<SandboxReady>;
  readonly exec: (threadId: string, input: SandboxExecInput) => Promise<SandboxCommandResult>;
  readonly exportBranch: (threadId: string) => Promise<SandboxExport>;
  readonly sampleUsage: (threadId: string) => Promise<SandboxUsageSample>;
  readonly stop: (threadId: string, teardown?: ReadonlyArray<SandboxHook>) => Promise<void>;
  readonly reconcile: (input: SandboxReconcileInput) => Promise<SandboxReconcileResult>;
}
