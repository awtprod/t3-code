import type { CapabilityName } from "@command-center/core";
import * as Context from "effect/Context";
import { Tool } from "effect/unstable/ai";

import type { McpCapability } from "./McpInvocationContext.ts";

export const REQUIRED_CAPABILITY_META_KEY = "t3.requiredCapability";

export const requireCapability = <T extends Tool.Any>(tool: T, capability: McpCapability): T =>
  tool.annotate(Tool.Meta, {
    ...(Context.getOrUndefined(tool.annotations, Tool.Meta) ?? {}),
    [REQUIRED_CAPABILITY_META_KEY]: capability,
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
