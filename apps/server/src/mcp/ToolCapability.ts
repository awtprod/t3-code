import type { CapabilityName } from "@command-center/core";
import * as Context from "effect/Context";
import * as Fiber from "effect/Fiber";
import { McpSchema, Tool } from "effect/unstable/ai";

import * as McpInvocationContext from "./McpInvocationContext.ts";
import type { McpCapability } from "./McpInvocationContext.ts";

export const REQUIRED_CAPABILITY_META_KEY = "t3.requiredCapability";

/**
 * Whether a credential holding `capabilities` may see and use a tool that
 * requires `required`. A tool with no required capability is open to every
 * credential. Holding any `cc.connections.google.*` scope satisfies the
 * `cc.connections.google.read` gate, since a granted Google connection implies
 * read access to that surface.
 *
 * Single source of truth for `tools/list` visibility (the `EnabledWhen`
 * predicate below) and for `toolVisibleToCapabilities` in McpHttpServer.
 */
export const capabilitiesAllow = (
  required: McpCapability | undefined,
  capabilities: ReadonlySet<McpCapability>,
): boolean => {
  if (required === undefined) return true;
  if (required === "cc.connections.google.read") {
    return (
      capabilities.has(required) ||
      Array.from(capabilities).some((capability) =>
        capability.startsWith("cc.connections.google."),
      )
    );
  }
  return capabilities.has(required);
};

export const requireCapability = <T extends Tool.Any>(tool: T, capability: McpCapability): T =>
  tool
    .annotate(Tool.Meta, {
      ...Context.getOrUndefined(tool.annotations, Tool.Meta),
      [REQUIRED_CAPABILITY_META_KEY]: capability,
    })
    // effect rc.112 removed the request-scoped `McpServer.McpListToolFilter`,
    // so per-credential `tools/list` visibility now rides on this per-tool
    // `EnabledWhen` predicate, which the MCP server evaluates when it answers a
    // `tools/list`. It reads the bearer credential the auth middleware resolved
    // for the request off the running fiber (the same channel the call handlers
    // use) and hides the tool from any credential that lacks its capability.
    // The call path stays independently gated in McpInvocationContext, so a
    // hidden tool cannot be invoked either.
    .annotate(McpSchema.EnabledWhen, () => {
      const fiber = Fiber.getCurrent();
      if (fiber === undefined) return false;
      const invocation = Context.getOrUndefined(
        fiber.context,
        McpInvocationContext.McpInvocationContext,
      );
      return invocation !== undefined && capabilitiesAllow(capability, invocation.capabilities);
    }) as T;

export const requiredCapabilityFromMeta = (
  meta: Readonly<Record<string, unknown>> | undefined,
): McpCapability | undefined => {
  const capability = meta?.[REQUIRED_CAPABILITY_META_KEY];
  return typeof capability === "string" ? (capability as McpCapability) : undefined;
};

export const commandCenterCapability = <T extends Tool.Any>(
  tool: T,
  capability: CapabilityName,
): T => requireCapability(tool, capability);
