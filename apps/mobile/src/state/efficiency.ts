/**
 * Efficiency routing atoms for mobile: a thread's routing from the server's
 * `efficiency.threadRouting` side channel and the command that saves it.
 * Mirror of `apps/web/src/state/efficiency.ts` over mobile's atom runtime.
 *
 * @module state/efficiency
 */
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { EFFICIENCY_WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const mobileEfficiency = {
  threadRouting: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "mobile:efficiency:thread-routing",
    tag: EFFICIENCY_WS_METHODS.threadRoutingGet,
    staleTimeMs: 2_000,
    idleTtlMs: 60_000,
  }),
  setThreadRouting: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "mobile:efficiency:thread-routing:set",
    tag: EFFICIENCY_WS_METHODS.threadRoutingSet,
  }),
};
