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
    inbox: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:command-center:inbox",
      tag: COMMAND_CENTER_WS_METHODS.inboxQuery,
      staleTimeMs: 1_000,
    }),
    inboxDetail: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:command-center:inbox-detail",
      tag: COMMAND_CENTER_WS_METHODS.inboxDetail,
      staleTimeMs: 1_000,
    }),
    commentOnInboxItem: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:inbox-comment",
      tag: COMMAND_CENTER_WS_METHODS.inboxComment,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.spaceId, input.itemId]),
      },
    }),
    requestInboxChanges: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:inbox-request-changes",
      tag: COMMAND_CENTER_WS_METHODS.inboxRequestChanges,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.spaceId, input.itemId]),
      },
    }),
    createInboxCandidate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:inbox-candidate-create",
      tag: COMMAND_CENTER_WS_METHODS.inboxCandidateCreate,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.spaceId, input.itemId]),
      },
    }),
    acceptInboxCandidate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:inbox-candidate-accept",
      tag: COMMAND_CENTER_WS_METHODS.inboxCandidateAccept,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.spaceId, input.itemId]),
      },
    }),
    approveInboxAdjustment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:inbox-adjustment-approve",
      tag: COMMAND_CENTER_WS_METHODS.inboxAdjustmentApprove,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.spaceId, input.itemId]),
      },
    }),
    discardInboxCandidate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:inbox-candidate-discard",
      tag: COMMAND_CENTER_WS_METHODS.inboxCandidateDiscard,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.spaceId, input.itemId]),
      },
    }),
    resolveInboxChangeRequest: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:inbox-change-request-resolve",
      tag: COMMAND_CENTER_WS_METHODS.inboxChangeRequestResolve,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.spaceId, input.itemId]),
      },
    }),
    snoozeInboxItem: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:inbox-snooze",
      tag: COMMAND_CENTER_WS_METHODS.inboxSnooze,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.spaceId, input.itemId]),
      },
    }),
    unsnoozeInboxItem: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:inbox-unsnooze",
      tag: COMMAND_CENTER_WS_METHODS.inboxUnsnooze,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.spaceId, input.itemId]),
      },
    }),
    dismissInboxItem: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:inbox-dismiss",
      tag: COMMAND_CENTER_WS_METHODS.inboxDismiss,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.spaceId, input.itemId]),
      },
    }),
    reopenInboxItem: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:inbox-reopen",
      tag: COMMAND_CENTER_WS_METHODS.inboxReopen,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.spaceId, input.itemId]),
      },
    }),
    sprintPlans: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:command-center:sprint-plans",
      tag: COMMAND_CENTER_WS_METHODS.sprintPlanList,
      staleTimeMs: 1_000,
    }),
    previewSprintPlanImport: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:sprint-plan-preview-import",
      tag: COMMAND_CENTER_WS_METHODS.sprintPlanPreviewImport,
      scheduler: commandScheduler,
      concurrency: {
        mode: "latest",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.spaceId, input.planId]),
      },
    }),
    applySprintPlanImport: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:sprint-plan-apply-import",
      tag: COMMAND_CENTER_WS_METHODS.sprintPlanApplyImport,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.spaceId, input.planId]),
      },
    }),
    sprintPlanCurrent: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:command-center:sprint-plan-current",
      tag: COMMAND_CENTER_WS_METHODS.sprintPlanGetCurrent,
      staleTimeMs: 1_000,
    }),
    sprintPlanOriginal: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:command-center:sprint-plan-original",
      tag: COMMAND_CENTER_WS_METHODS.sprintPlanGetOriginal,
      staleTimeMs: 5_000,
    }),
    patchSprintPlanTask: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:sprint-plan-patch-task",
      tag: COMMAND_CENTER_WS_METHODS.sprintPlanPatchTask,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.spaceId, input.planId]),
      },
    }),
    resolveSprintPlanDateConflict: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:sprint-plan-resolve-date-conflict",
      tag: COMMAND_CENTER_WS_METHODS.sprintPlanResolveDateConflict,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.spaceId, input.planId]),
      },
    }),
    sprintPlanHistory: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:command-center:sprint-plan-history",
      tag: COMMAND_CENTER_WS_METHODS.sprintPlanListHistory,
      staleTimeMs: 1_000,
    }),
    createItem: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:create-item",
      tag: COMMAND_CENTER_WS_METHODS.itemCreate,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.spaceId, input.requestId]),
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
    beginGoogleConnectionSetup: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:google-connection-setup-begin",
      tag: COMMAND_CENTER_WS_METHODS.googleConnectionSetupBegin,
      scheduler: commandScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.spaceId, input.email]),
      },
    }),
    completeGoogleConnectionSetup: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:google-connection-setup-complete",
      tag: COMMAND_CENTER_WS_METHODS.googleConnectionSetupComplete,
      scheduler: commandScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.sessionId]),
      },
    }),
    removeGoogleConnection: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:google-connection-remove",
      tag: COMMAND_CENTER_WS_METHODS.googleConnectionRemove,
      scheduler: commandScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.spaceId, input.connectionId]),
      },
    }),
    publishConnections: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:command-center:publish-connections",
      tag: COMMAND_CENTER_WS_METHODS.publishConnectionsQuery,
      staleTimeMs: 5_000,
    }),
    beginPublishConnectionSetup: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:publish-connection-setup-begin",
      tag: COMMAND_CENTER_WS_METHODS.publishConnectionSetupBegin,
      scheduler: commandScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.provider]),
      },
    }),
    completePublishConnectionSetup: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:publish-connection-setup-complete",
      tag: COMMAND_CENTER_WS_METHODS.publishConnectionSetupComplete,
      scheduler: commandScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.sessionId]),
      },
    }),
    removePublishConnection: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:publish-connection-remove",
      tag: COMMAND_CENTER_WS_METHODS.publishConnectionRemove,
      scheduler: commandScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.provider]),
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
    observationsList: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:command-center:observations-list",
      tag: COMMAND_CENTER_WS_METHODS.observationsList,
      staleTimeMs: 1_000,
    }),
    observationsGet: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:command-center:observations-get",
      tag: COMMAND_CENTER_WS_METHODS.observationsGet,
      staleTimeMs: 1_000,
    }),
    observationsHistory: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:command-center:observations-history",
      tag: COMMAND_CENTER_WS_METHODS.observationsHistory,
      staleTimeMs: 1_000,
    }),
    createManualObservation: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:observation-create-manual",
      tag: COMMAND_CENTER_WS_METHODS.observationsCreateManual,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.observation.spaceId, input.observation.id]),
      },
    }),
    importObservations: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:observations-import",
      tag: COMMAND_CENTER_WS_METHODS.observationsImport,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.spaceId]),
      },
    }),
    correctObservation: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:observation-correct",
      tag: COMMAND_CENTER_WS_METHODS.observationsCorrect,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.spaceId, input.observationId]),
      },
    }),
    retireObservation: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:observation-retire",
      tag: COMMAND_CENTER_WS_METHODS.observationsRetire,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.spaceId, input.observationId]),
      },
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
    // Windows media picker: read-only browse of the configured Windows host.
    // "latest" per environment so fast folder clicks drop stale listings.
    windowsMediaRoots: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:windows-media-roots",
      tag: COMMAND_CENTER_WS_METHODS.windowsMediaRoots,
      scheduler: commandScheduler,
      concurrency: {
        mode: "latest",
        key: ({ environmentId }) => JSON.stringify([environmentId, "roots"]),
      },
    }),
    windowsMediaList: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:command-center:windows-media-list",
      tag: COMMAND_CENTER_WS_METHODS.windowsMediaList,
      scheduler: commandScheduler,
      concurrency: {
        mode: "latest",
        key: ({ environmentId }) => JSON.stringify([environmentId, "list"]),
      },
    }),
  };
}
