import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const usageEnvironment = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:usage:query",
  tag: WS_METHODS.usageQuery,
  staleTimeMs: 30_000,
  idleTtlMs: 120_000,
});
