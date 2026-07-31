import {
  CommandCenterMcpCapabilityUnavailableError,
  type EnvironmentId,
  PreviewAutomationUnavailableError,
  type ProjectId,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import type { CapabilityName, RepositoryId, SpaceId } from "@command-center/core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export type McpCapability = "preview" | CapabilityName;
export type McpMemoryWriteMode = "propose" | "remember";

export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  /** Local project owning the thread, when issued through project orchestration. */
  readonly projectId?: ProjectId;
  /** Effective provider working directory used to resolve project-scoped tools. */
  readonly cwd?: string;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly spaceId?: SpaceId;
  readonly repositoryId?: RepositoryId;
  /** Server-issued policy. Tool input cannot promote proposal-only credentials. */
  readonly memoryWriteMode?: McpMemoryWriteMode;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("@awtprod/command-center/mcp/McpInvocationContext") {}

export const requirePreviewCapability = Effect.fn("mcp.requirePreviewCapability")(function* () {
  const invocation = yield* McpInvocationContext;
  if (!invocation.capabilities.has("preview")) {
    return yield* new PreviewAutomationUnavailableError({
      capability: "preview",
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    });
  }
  return invocation;
});

export const requireCommandCenterCapability = Effect.fn("mcp.requireCommandCenterCapability")(
  function* (capability: CapabilityName) {
    const invocation = yield* McpInvocationContext;
    if (!invocation.capabilities.has(capability)) {
      return yield* new CommandCenterMcpCapabilityUnavailableError({
        capability,
        threadId: invocation.threadId,
        providerSessionId: invocation.providerSessionId,
      });
    }
    return invocation;
  },
);

export const requireMcpCapability = (capability: McpCapability) =>
  capability === "preview"
    ? requirePreviewCapability()
    : requireCommandCenterCapability(capability);
