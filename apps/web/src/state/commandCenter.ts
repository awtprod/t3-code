import { createCommandCenterEnvironmentAtoms } from "@t3tools/client-runtime/state/command-center";

import { connectionAtomRuntime } from "../connection/runtime";

export const commandCenterEnvironment = createCommandCenterEnvironmentAtoms(connectionAtomRuntime);
