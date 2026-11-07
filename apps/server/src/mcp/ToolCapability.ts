import type { CapabilityName } from "@command-center/core";
import * as Context from "effect/Context";
import * as Fiber from "effect/Fiber";
import { McpSchema, Tool } from "effect/ai";

import * as McpInvocationContext from "./McpInvocationContext.ts";
import type { McpCapability } from "./McpInvocationContext.ts";

const REQUIRED_CAPABILITY_META_KEY = "t3.requiredCapability";

/**
 * Whether a credential holding `capabilities` may see and use a tool requiring `required`; a tool
 * with none is open to every credential. Any `cc.connections.google.*` scope satisfies the
 * `cc.connections.google.read` gate. Single source of truth for `tools/list` visibility (the
 * `EnabledWhen` predicate below) and for `toolVisibleToCapabilities` in McpHttpServer.
 */
export const capabilitiesAllow = (
  required: McpCapability | undefined,
  capabilities: ReadonlySet<McpCapability>,
): boolean => {
  if (required === undefined) return true;
  if (required === "cc.connections.google.read") {
    return (
      capabilities.has(required) ||
      Array.from(capabilities).some((capability) => capability.startsWith("cc.connections.google."))
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
    // Per-credential `tools/list` visibility rides on this `EnabledWhen` predicate (effect rc.112
    // removed the request-scoped list filter). It reads the request's bearer credential off the
    // running fiber and hides the tool from credentials lacking its capability. The call path is
    // gated independently in McpInvocationContext, so a hidden tool cannot be invoked either.
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
