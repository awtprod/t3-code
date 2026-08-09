import { COMMAND_CENTER_WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createCommandCenterEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();

  return {
    bootstrap: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:command-center:bootstrap",
      tag: COMMAND_CENTER_WS_METHODS.bootstrap,
      staleTimeMs: 2_000,
    }),
    submit: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:submit",
      tag: COMMAND_CENTER_WS_METHODS.commandSubmit,
      scheduler: commandScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.commandId]),
      },
    }),
    startRun: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:start-run",
      tag: COMMAND_CENTER_WS_METHODS.runStart,
      scheduler: commandScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.runId]),
      },
    }),
    syncSpaces: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:sync-spaces",
      tag: COMMAND_CENTER_WS_METHODS.spacesSync,
      scheduler: commandScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId }) => JSON.stringify([environmentId]),
      },
    }),
    updateItem: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:update-item",
      tag: COMMAND_CENTER_WS_METHODS.itemUpdate,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.spaceId, input.itemId]),
      },
    }),
    refreshConnection: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:refresh-connection",
      tag: COMMAND_CENTER_WS_METHODS.connectionsRefresh,
      scheduler: commandScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.spaceId, input.connectionId]),
      },
    }),
    eventReplay: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:command-center:event-replay",
      tag: COMMAND_CENTER_WS_METHODS.eventsReplay,
      staleTimeMs: 1_000,
    }),
    events: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:command-center:events",
      tag: COMMAND_CENTER_WS_METHODS.eventsSubscribe,
      idleTtlMs: 0,
    }),
    timeline: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:command-center:timeline",
      tag: COMMAND_CENTER_WS_METHODS.timelineQuery,
      staleTimeMs: 1_000,
    }),
    artifacts: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:command-center:artifacts",
      tag: COMMAND_CENTER_WS_METHODS.artifactsQuery,
      staleTimeMs: 2_000,
    }),
    memorySearch: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:command-center:memory-search",
      tag: COMMAND_CENTER_WS_METHODS.memorySearch,
      staleTimeMs: 1_000,
    }),
    automationDefinition: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:command-center:automation-definition",
      tag: COMMAND_CENTER_WS_METHODS.automationDefinitionGet,
      staleTimeMs: 1_000,
    }),
    createAutomationDefinition: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:create-automation-definition",
      tag: COMMAND_CENTER_WS_METHODS.automationDefinitionCreate,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.spaceId, input.requestId]),
      },
    }),
    saveAutomationDefinition: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:save-automation-definition",
      tag: COMMAND_CENTER_WS_METHODS.automationDefinitionSave,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.automationId]),
      },
    }),
    interpretAutomationSchedule: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:interpret-automation-schedule",
      tag: COMMAND_CENTER_WS_METHODS.automationScheduleInterpret,
      scheduler: commandScheduler,
      concurrency: {
        mode: "latest",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.spaceId]),
      },
    }),
    admitAutomationWebhook: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:admit-automation-webhook",
      tag: COMMAND_CENTER_WS_METHODS.automationWebhookAdmit,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.spaceId, input.route, input.deliveryId]),
      },
    }),
    decideApproval: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:decide-approval",
      tag: COMMAND_CENTER_WS_METHODS.approvalDecide,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.approvalId]),
      },
    }),
    reviewMemory: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:review-memory",
      tag: COMMAND_CENTER_WS_METHODS.memoryReview,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.memoryId]),
      },
    }),
    googleRead: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:google-read",
      tag: COMMAND_CENTER_WS_METHODS.googleRead,
      scheduler: commandScheduler,
      concurrency: { mode: "parallel" },
    }),
  };
}
