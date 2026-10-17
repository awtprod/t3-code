import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { EFFICIENCY_WS_METHODS, WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const efficiencyPreviewEnvironment = createEnvironmentRpcQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:efficiency:preview-decision",
    tag: WS_METHODS.efficiencyPreviewDecision,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
  },
);

/**
 * A thread's efficiency routing (mode, tier, latest decision, routed children)
 * from the server's side channel. V2 thread shells carry no routing fields.
 */
export const efficiencyThreadRoutingEnvironment = createEnvironmentRpcQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:efficiency:thread-routing",
    tag: EFFICIENCY_WS_METHODS.threadRoutingGet,
    staleTimeMs: 2_000,
    idleTtlMs: 60_000,
  },
);

/** Saves a thread's routing mode and tier (also for a thread about to be created). */
export const efficiencyThreadRoutingSet = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:efficiency:thread-routing:set",
  tag: EFFICIENCY_WS_METHODS.threadRoutingSet,
});
