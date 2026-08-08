import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

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
