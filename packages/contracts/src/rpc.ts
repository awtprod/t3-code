import * as Schema from "effect/Schema";
import {
  INSTAGRAM_REEL_METHODS,
  InstagramReelRequest,
  InstagramReelSelection,
  InstagramReelApprove,
  InstagramReelReceipt,
  InstagramReelAccount,
} from "./commandCenter.ts";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { Approval, Item, Memory, ObservationSnapshot } from "@command-center/core";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ProviderAuthCancelInput,
  ProviderAuthCompleteInput,
  ProviderAuthState,
  ProviderInstallCancelInput,
  ProviderInstallState,
  ProviderSetupError,
  ProviderSetupInput,
} from "./providerSetup.ts";
import {
  CommandCenterObservationCorrectionRequest,
  CommandCenterObservationGetRequest,
  CommandCenterObservationHistoryPage,
  CommandCenterObservationHistoryRequest,
  CommandCenterObservationImportInput,
  CommandCenterObservationImportReceipt,
  CommandCenterObservationListPage,
  CommandCenterObservationListRequest,
  CommandCenterObservationManualCreateRequest,
  CommandCenterObservationMutationReceipt,
  CommandCenterObservationRetirementRequest,
} from "./commandCenterObservations.ts";
import {
  COMMAND_CENTER_YOUTUBE_ANALYTICS_FETCH_METHOD,
  CommandCenterYouTubeAnalyticsFetchInput,
  CommandCenterYouTubeAnalyticsFetchResult,
} from "./commandCenterYouTubeAnalytics.ts";

import { ExternalLauncherError, LaunchEditorInput } from "./editor.ts";
import {
  AuthAccessStreamError,
  AuthAccessStreamEvent,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import {
  BackgroundPolicySnapshot,
  ClientActivityReportInput,
  HostPowerSnapshot,
} from "./background.ts";
import {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  FilesystemBrowseError,
} from "./filesystem.ts";
import {
  AgentSessionImportInput,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionImportResult,
  AgentSessionScanInput,
  AgentSessionScanResult,
  AgentSessionScanError,
} from "./agentSessions.ts";
import {
  AssetAccessError,
  AssetCreateUrlInput,
  AssetCreateUrlResult,
  AttachmentCreateUploadUrlInput,
  AttachmentCreateUploadUrlResult,
  AttachmentDeleteInput,
  AttachmentUploadSigningKeyError,
} from "./assets.ts";
import {
  WorktreeSetupCancelInput,
  WorktreeSetupCancelResult,
  WorktreeSetupStreamEvent,
  WorktreeSetupSubscribeInput,
} from "./worktreeSetup.ts";
import {
  GitActionProgressEvent,
  VcsSwitchRefInput,
  VcsSwitchRefResult,
  GitCommandError,
  VcsCreateRefInput,
  VcsCreateRefResult,
  VcsCreateWorktreeInput,
  VcsCreateWorktreeResult,
  VcsInitInput,
  VcsListRefsInput,
  VcsListRefsResult,
  GitManagerServiceError,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  VcsPullInput,
  GitPullRequestRefInput,
  VcsPullResult,
  VcsRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  VcsStatusInput,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "./git.ts";
import {
  ReviewDiffFileContentsInput,
  ReviewDiffFileContentsResult,
  ReviewDiffPreviewError,
  ReviewDiffPreviewInput,
  ReviewDiffPreviewResult,
} from "./review.ts";
import { KeybindingsConfigError } from "./keybindings.ts";
import {
  ClientOrchestrationCommand,
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetSnapshotError,
  OrchestrationSearchThreadsError,
  OrchestrationSearchThreadsInput,
  OrchestrationGetTurnDiffError,
  OrchestrationGetTurnDiffInput,
  OrchestrationRpcSchemas,
  OrchestrationGetWorkflowScriptError,
} from "./orchestration.ts";
import {
  ProviderUploadFeedbackError,
  ProviderUploadFeedbackInput,
  ProviderUploadFeedbackResult,
} from "./provider.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  PullRequestActionInput,
  PullRequestActivity,
  PullRequestCommentInput,
  PullRequestCommentUpdateInput,
  PullRequestDetail,
  PullRequestDiffFileContentsInput,
  PullRequestDiffFileContentsResult,
  PullRequestInvalidateInput,
  PullRequestListInput,
  PullRequestListResult,
  PullRequestListStatsInput,
  PullRequestListStatsResult,
  PullRequestOperationError,
  PullRequestReactionInput,
  PullRequestRef,
  PullRequestRoutingResult,
  PullRequestRoutingIdentityInput,
  PullRequestRoutingIdentityResult,
  PullRequestStack,
  PullRequestLinkedThreadsResult,
  PullRequestSummary,
  PullRequestReviewerCandidateList,
  PullRequestReviewerRequestInput,
  PullRequestLabelCandidateList,
  PullRequestLabelChangeInput,
  PullRequestSubmitReviewInput,
  PullRequestThreadCommentsInput,
  PullRequestThreadCommentsResult,
  PullRequestThreadReplyInput,
  PullRequestThreadResolutionInput,
  PullRequestUnavailableError,
  PullRequestUpdateInput,
} from "./pullRequest.ts";
import {
  RelayClientInstallFailedError,
  RelayClientInstallProgressEventSchema,
  RelayClientStatusSchema,
} from "./relayClient.ts";
import {
  ProjectListEntriesError,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectReadFileError,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectSearchContentsError,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesError,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileError,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project.ts";
import {
  TerminalAttachInput,
  TerminalAttachStreamEvent,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalError,
  TerminalEvent,
  TerminalMetadataStreamEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal.ts";
import {
  DiscoveredLocalServerList,
  ConfiguredLocalServerUrls,
  PreviewCloseInput,
  PreviewError,
  PreviewEvent,
  PreviewListInput,
  PreviewListResult,
  PreviewNavigateInput,
  PreviewOpenInput,
  PreviewRefreshInput,
  PreviewReportStatusInput,
  PreviewResizeInput,
  PreviewSessionSnapshot,
} from "./preview.ts";
import {
  DeviceActionInput,
  DeviceCloseInput,
  DeviceConfigureInput,
  DeviceDetail,
  DeviceDetailInput,
  DeviceError,
  DeviceListInput,
  SshDeviceHostConfig,
  DeviceHostSummary,
  DeviceOpenInput,
  DeviceServiceState,
  DeviceSession,
  DeviceShutdownInput,
} from "./device.ts";
import {
  PreviewAutomationError,
  PreviewAutomationHost,
  PreviewAutomationHostFocus,
  PreviewAutomationResponse,
  PreviewAutomationStreamEvent,
} from "./previewAutomation.ts";
import {
  ServerConfigStreamEvent,
  DesktopUpdateCommitInput,
  ServerConfig,
  ServerProviderUpdateError,
  ServerProviderUpdateInput,
  ServerLifecycleStreamEvent,
  ServerRemoveKeybindingInput,
  ServerRemoveKeybindingResult,
  ServerProviderUpdatedPayload,
  ServerSelfUpdateError,
  ServerSelfUpdateInput,
  ServerSelfUpdateProgressEvent,
  ServerSelfUpdateResult,
  ServerTraceDiagnosticsResult,
  ServerProcessDiagnosticsResult,
  ServerProcessResourceHistoryInput,
  ServerProcessResourceHistoryResult,
  ServerSignalProcessInput,
  ServerSignalProcessResult,
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
} from "./server.ts";
import {
  HostResourcesSnapshot,
  ResourceTelemetryHistory,
  ResourceTelemetryHistoryInput,
  ResourceTelemetryRetryResult,
  ResourceTelemetrySnapshot,
} from "./resourceTelemetry.ts";
import {
  UsageLimitSourceError,
  ProviderConsumeResetCreditInput,
  ProviderConsumeResetCreditResult,
} from "./providerUsageLimits.ts";
import { UsagePricing, UsageReadError, UsageSummary, UsageSummaryInput } from "./usage.ts";
import { ServerSettings, ServerSettingsError, ServerSettingsPatch } from "./settings.ts";
import { UsageQueryError, UsageQueryInput, UsageQueryResult } from "./usage.ts";
import { EfficiencyPreviewInput, EfficiencyPreviewResult } from "./efficiency.ts";
import {
  ProjectCloneActionInput,
  ProjectCloneActionResult,
  ProjectCloneListEvent,
  ProjectCloneStartInput,
  ProjectCloneStartResult,
  ProjectCloneSubscribeInput,
} from "./projectClone.ts";
import {
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
  SourceControlDiscoveryResult,
  SourceControlPublishRepositoryInput,
  SourceControlPublishRepositoryResult,
  SourceControlRepositoryError,
  SourceControlRepositoryInfo,
  SourceControlRepositoryLookupInput,
} from "./sourceControl.ts";
import { VcsError } from "./vcs.ts";
import {
  COMMAND_CENTER_WS_METHODS,
  CommandCenterApprovalDecisionInput,
  CommandCenterApprovalsQueryInput,
  CommandCenterApprovalsQueryResult,
  CommandCenterArtifactsQueryInput,
  CommandCenterArtifactsQueryResult,
  CommandCenterAutomationExecution,
  CommandCenterAutomationDefinitionCreateInput,
  CommandCenterAutomationDefinitionGetInput,
  CommandCenterAutomationDefinitionSaveInput,
  CommandCenterAutomationScheduleInterpretInput,
  CommandCenterAutomationScheduleInterpretResult,
  CommandCenterAutomationDefinitionSnapshot,
  CommandCenterAutomationRunGetInput,
  CommandCenterAutomationRunStartInput,
  CommandCenterAutomationWebhookAdmitInput,
  CommandCenterAutomationsQueryInput,
  CommandCenterAutomationsQueryResult,
  CommandCenterBootstrap,
  CommandCenterCommandSubmitInput,
  CommandCenterCommandSubmitResult,
  CommandCenterConnectionRefreshInput,
  CommandCenterConnectionRefreshResult,
  CommandCenterGoogleConnectionSetupBeginInput,
  CommandCenterGoogleConnectionSetupBeginResult,
  CommandCenterGoogleConnectionSetupCompleteInput,
  CommandCenterGoogleConnectionSetupCompleteResult,
  CommandCenterGoogleConnectionRemoveInput,
  CommandCenterGoogleConnectionRemoveResult,
  CommandCenterPublishConnectionRemoveInput,
  CommandCenterPublishConnectionRemoveResult,
  CommandCenterPublishConnectionSetupBeginInput,
  CommandCenterPublishConnectionSetupBeginResult,
  CommandCenterPublishConnectionSetupCompleteInput,
  CommandCenterPublishConnectionSetupCompleteResult,
  CommandCenterPublishConnectionsQueryInput,
  CommandCenterPublishConnectionsQueryResult,
  CommandCenterConnectionsQueryInput,
  CommandCenterConnectionsQueryResult,
  CommandCenterError,
  CommandCenterItemCreateInput,
  CommandCenterItemUpdateInput,
  CommandCenterItemUpdateResult,
  CommandCenterItemsQueryInput,
  CommandCenterItemsQueryResult,
  CommandCenterMemoryQueryInput,
  CommandCenterMemoryQueryResult,
  CommandCenterMemoryProposeInput,
  CommandCenterMemoryRememberInput,
  CommandCenterMemoryReviewInput,
  CommandCenterMemorySearchInput,
  CommandCenterMemorySearchResults,
  CommandCenterRunsQueryInput,
  CommandCenterRunsQueryResult,
  CommandCenterRunStartInput,
  CommandCenterRunStartResult,
  CommandCenterSpacesQueryInput,
  CommandCenterSpacesQueryResult,
  CommandCenterSpacesSyncInput,
  CommandCenterSpacesSyncResult,
  GoogleReadRequest,
  CommandCenterWindowsMediaListInput,
  CommandCenterWindowsMediaListResult,
  CommandCenterWindowsMediaRootsInput,
  CommandCenterWindowsMediaRootsResult,
  GoogleReadResult,
} from "./commandCenter.ts";
import {
  CommandCenterInboxApproveAdjustmentInput,
  CommandCenterInboxCandidateCreateInput,
  CommandCenterInboxCandidateMutationInput,
  CommandCenterInboxCommentInput,
  CommandCenterInboxDetail,
  CommandCenterInboxDetailInput,
  CommandCenterInboxDraftApproveInput,
  CommandCenterInboxDraftReceipt,
  CommandCenterInboxDraftReceiptInput,
  CommandCenterInboxMutationResult,
  CommandCenterInboxQueryInput,
  CommandCenterInboxQueryResult,
  CommandCenterInboxRequestChangesInput,
  CommandCenterInboxResolveChangeRequestInput,
  CommandCenterInboxSimpleMutationInput,
  CommandCenterInboxSnoozeInput,
} from "./commandCenterInbox.ts";
import {
  CommandCenterSprintPlanApplyImportInput,
  CommandCenterSprintPlanApplyImportResult,
  CommandCenterSprintPlanGetInput,
  CommandCenterSprintPlanGetOriginalInput,
  CommandCenterSprintPlanGetOriginalResult,
  CommandCenterSprintPlanGetResult,
  CommandCenterSprintPlanListHistoryInput,
  CommandCenterSprintPlanListHistoryResult,
  CommandCenterSprintPlanListInput,
  CommandCenterSprintPlanListResult,
  CommandCenterSprintPlanPatchTaskInput,
  CommandCenterSprintPlanPatchTaskResult,
  CommandCenterSprintPlanPreviewImportInput,
  CommandCenterSprintPlanPreviewImportResult,
  CommandCenterSprintPlanResolveDateConflictInput,
  CommandCenterSprintPlanResolveDateConflictResult,
} from "./commandCenterSprintPlan.ts";
import {
  CommandCenterDigestMarkViewedInput,
  CommandCenterDigestPreferences,
  CommandCenterDigestPreferencesUpdateInput,
  CommandCenterDigestQueryInput,
  CommandCenterDigestQueryResult,
  CommandCenterDigestSnapshot,
} from "./commandCenterDigest.ts";
import {
  CommandCenterEventEnvelope,
  CommandCenterEventPage,
  CommandCenterEventReplayInput,
  CommandCenterEventStreamError,
  CommandCenterEventSubscribeInput,
  CommandCenterTimelinePage,
  CommandCenterTimelineQuery,
} from "./commandCenterEvents.ts";
import {
  CommandCenterResponsibilitiesListInput,
  CommandCenterResponsibilitiesListResult,
  CommandCenterResponsibilityGetInput,
  CommandCenterResponsibilityPauseInput,
  CommandCenterResponsibilityStatus,
  CommandCenterResponsibilityDetail,
  CommandCenterResponsibilityError,
} from "./commandCenterResponsibilities.ts";

export const WS_METHODS = {
  // Project registry methods
  projectsList: "projects.list",
  projectsAdd: "projects.add",
  projectsRemove: "projects.remove",
  projectsListEntries: "projects.listEntries",
  projectsReadFile: "projects.readFile",
  projectsSearchContents: "projects.searchContents",
  projectsSearchEntries: "projects.searchEntries",
  projectsWriteFile: "projects.writeFile",

  // Shell methods
  shellOpenInEditor: "shell.openInEditor",

  // Filesystem methods
  filesystemBrowse: "filesystem.browse",
  agentSessionsScan: "agentSessions.scan",
  agentSessionsImport: "agentSessions.import",
  assetsCreateUrl: "assets.createUrl",
  attachmentsCreateUploadUrl: "attachments.createUploadUrl",
  attachmentsDelete: "attachments.delete",

  // Provider methods
  providerUploadFeedback: "provider.uploadFeedback",
  providerAuthStart: "provider.auth.start",
  providerConsumeResetCredit: "provider.consumeResetCredit",
  providerAuthComplete: "provider.auth.complete",
  providerAuthCancel: "provider.auth.cancel",
  providerAuthLogout: "provider.auth.logout",
  providerAuthSubscribe: "provider.auth.subscribe",
  providerInstallStart: "provider.install.start",
  providerInstallCancel: "provider.install.cancel",
  providerInstallSubscribe: "provider.install.subscribe",
  providerInstallRemove: "provider.install.remove",

  // VCS methods
  vcsPull: "vcs.pull",
  vcsRefreshStatus: "vcs.refreshStatus",
  vcsListRefs: "vcs.listRefs",
  vcsCreateWorktree: "vcs.createWorktree",
  vcsRemoveWorktree: "vcs.removeWorktree",
  vcsCreateRef: "vcs.createRef",
  vcsSwitchRef: "vcs.switchRef",
  vcsInit: "vcs.init",

  // Git workflow methods
  gitRunStackedAction: "git.runStackedAction",
  gitResolvePullRequest: "git.resolvePullRequest",
  gitPreparePullRequestThread: "git.preparePullRequestThread",

  // Review methods
  reviewGetDiffPreview: "review.getDiffPreview",
  reviewGetDiffFileContents: "review.getDiffFileContents",

  // Terminal methods
  terminalOpen: "terminal.open",
  terminalAttach: "terminal.attach",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalClear: "terminal.clear",
  terminalRestart: "terminal.restart",
  terminalClose: "terminal.close",

  // Preview methods
  previewOpen: "preview.open",
  previewNavigate: "preview.navigate",
  previewResize: "preview.resize",
  previewRefresh: "preview.refresh",
  previewClose: "preview.close",
  previewList: "preview.list",
  previewReportStatus: "preview.reportStatus",
  previewAutomationConnect: "previewAutomation.connect",
  previewAutomationRespond: "previewAutomation.respond",
  previewAutomationFocusHost: "previewAutomation.focusHost",

  // Device methods
  deviceConfigure: "device.configure",
  deviceList: "device.list",
  deviceTestHost: "device.testHost",
  deviceOpen: "device.open",
  deviceClose: "device.close",
  deviceShutdown: "device.shutdown",
  deviceDetail: "device.detail",
  deviceAction: "device.action",

  // Server meta
  serverProbe: "server.probe",
  serverGetConfig: "server.getConfig",
  serverRefreshProviders: "server.refreshProviders",
  serverUpdateProvider: "server.updateProvider",
  serverUpdateServer: "server.updateServer",
  serverUpdateServerWithProgress: "server.updateServerWithProgress",
  serverCommitDesktopUpdate: "server.commitDesktopUpdate",
  serverUpsertKeybinding: "server.upsertKeybinding",
  serverRemoveKeybinding: "server.removeKeybinding",
  serverGetSettings: "server.getSettings",
  serverUpdateSettings: "server.updateSettings",
  efficiencyPreviewDecision: "efficiency.previewDecision",
  serverDiscoverSourceControl: "server.discoverSourceControl",
  serverGetTraceDiagnostics: "server.getTraceDiagnostics",
  serverGetProcessDiagnostics: "server.getProcessDiagnostics",
  serverGetHostResources: "server.getHostResources",
  serverGetProcessResourceHistory: "server.getProcessResourceHistory",
  serverGetResourceTelemetryHistory: "server.getResourceTelemetryHistory",
  serverRetryResourceTelemetry: "server.retryResourceTelemetry",
  serverSignalProcess: "server.signalProcess",
  serverReportClientActivity: "server.reportClientActivity",
  serverReportHostPowerState: "server.reportHostPowerState",
  serverGetBackgroundPolicy: "server.getBackgroundPolicy",
  usageQuery: "usage.query",
  serverGetUsageSummary: "server.getUsageSummary",
  serverRefreshUsageRates: "server.refreshUsageRates",

  // Cloud environment methods
  cloudGetRelayClientStatus: "cloud.getRelayClientStatus",
  cloudInstallRelayClient: "cloud.installRelayClient",

  // Pull request methods
  pullRequestsList: "pullRequests.list",
  pullRequestsListStats: "pullRequests.listStats",
  pullRequestsSummary: "pullRequests.summary",
  pullRequestsRouting: "pullRequests.routing",
  pullRequestsRoutingIdentity: "pullRequests.routingIdentity",
  pullRequestsStack: "pullRequests.stack",
  pullRequestsLinkedThreads: "pullRequests.linkedThreads",
  pullRequestsDetail: "pullRequests.detail",
  pullRequestsActivity: "pullRequests.activity",
  pullRequestsThreadComments: "pullRequests.threadComments",
  pullRequestsDiffFileContents: "pullRequests.diffFileContents",
  pullRequestsRunAction: "pullRequests.runAction",
  pullRequestsUpdate: "pullRequests.update",
  pullRequestsComment: "pullRequests.comment",
  pullRequestsUpdateComment: "pullRequests.updateComment",
  pullRequestsSubmitReview: "pullRequests.submitReview",
  pullRequestsReplyToThread: "pullRequests.replyToThread",
  pullRequestsSetThreadResolution: "pullRequests.setThreadResolution",
  pullRequestsSetReaction: "pullRequests.setReaction",
  pullRequestsInvalidate: "pullRequests.invalidate",
  pullRequestsSubscribeRefreshes: "pullRequests.subscribeRefreshes",
  pullRequestsReviewerCandidates: "pullRequests.reviewerCandidates",
  pullRequestsRequestReviewers: "pullRequests.requestReviewers",
  pullRequestsLabelCandidates: "pullRequests.labelCandidates",
  pullRequestsSetLabels: "pullRequests.setLabels",

  // Source control methods
  sourceControlLookupRepository: "sourceControl.lookupRepository",
  sourceControlCloneRepository: "sourceControl.cloneRepository",
  sourceControlPublishRepository: "sourceControl.publishRepository",
  projectCloneStart: "projectClone.start",
  projectCloneCancel: "projectClone.cancel",
  projectCloneRetry: "projectClone.retry",
  subscribeProjectClones: "subscribeProjectClones",

  // Streaming subscriptions
  subscribeVcsStatus: "subscribeVcsStatus",
  subscribeWorktreeSetup: "subscribeWorktreeSetup",
  worktreeSetupCancel: "worktreeSetup.cancel",
  subscribeTerminalEvents: "subscribeTerminalEvents",
  subscribeTerminalMetadata: "subscribeTerminalMetadata",
  subscribePreviewEvents: "subscribePreviewEvents",
  subscribeDiscoveredLocalServers: "subscribeDiscoveredLocalServers",
  subscribeDeviceState: "subscribeDeviceState",
  subscribeServerConfig: "subscribeServerConfig",
  subscribeServerLifecycle: "subscribeServerLifecycle",
  subscribeAuthAccess: "subscribeAuthAccess",
  subscribeBackgroundPolicy: "subscribeBackgroundPolicy",
  subscribeResourceTelemetry: "subscribeResourceTelemetry",
} as const;

export const WsCommandCenterBootstrapRpc = Rpc.make(COMMAND_CENTER_WS_METHODS.bootstrap, {
  payload: Schema.Struct({}),
  success: CommandCenterBootstrap,
  error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
});

export const WsCommandCenterCommandSubmitRpc = Rpc.make(COMMAND_CENTER_WS_METHODS.commandSubmit, {
  payload: CommandCenterCommandSubmitInput,
  success: CommandCenterCommandSubmitResult,
  error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
});

export const WsCommandCenterRunStartRpc = Rpc.make(COMMAND_CENTER_WS_METHODS.runStart, {
  payload: CommandCenterRunStartInput,
  success: CommandCenterRunStartResult,
  error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
});

export const WsCommandCenterEventsReplayRpc = Rpc.make(COMMAND_CENTER_WS_METHODS.eventsReplay, {
  payload: CommandCenterEventReplayInput,
  success: CommandCenterEventPage,
  error: Schema.Union([CommandCenterEventStreamError, EnvironmentAuthorizationError]),
});

export const WsCommandCenterEventsSubscribeRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.eventsSubscribe,
  {
    payload: CommandCenterEventSubscribeInput,
    success: CommandCenterEventEnvelope,
    error: Schema.Union([CommandCenterEventStreamError, EnvironmentAuthorizationError]),
    stream: true,
  },
);

export const WsCommandCenterTimelineQueryRpc = Rpc.make(COMMAND_CENTER_WS_METHODS.timelineQuery, {
  payload: CommandCenterTimelineQuery,
  success: CommandCenterTimelinePage,
  error: Schema.Union([CommandCenterEventStreamError, EnvironmentAuthorizationError]),
});

export const WsCommandCenterSpacesQueryRpc = Rpc.make(COMMAND_CENTER_WS_METHODS.spacesQuery, {
  payload: CommandCenterSpacesQueryInput,
  success: CommandCenterSpacesQueryResult,
  error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
});

export const WsCommandCenterSpacesSyncRpc = Rpc.make(COMMAND_CENTER_WS_METHODS.spacesSync, {
  payload: CommandCenterSpacesSyncInput,
  success: CommandCenterSpacesSyncResult,
  error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
});

export const WsCommandCenterItemsQueryRpc = Rpc.make(COMMAND_CENTER_WS_METHODS.itemsQuery, {
  payload: CommandCenterItemsQueryInput,
  success: CommandCenterItemsQueryResult,
  error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
});

export const WsCommandCenterInboxQueryRpc = Rpc.make(COMMAND_CENTER_WS_METHODS.inboxQuery, {
  payload: CommandCenterInboxQueryInput,
  success: CommandCenterInboxQueryResult,
  error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
});

export const WsCommandCenterDigestQueryRpc = Rpc.make(COMMAND_CENTER_WS_METHODS.digestQuery, {
  payload: CommandCenterDigestQueryInput,
  success: CommandCenterDigestQueryResult,
  error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
});
export const WsCommandCenterDigestPreferencesUpdateRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.digestPreferencesUpdate,
  {
    payload: CommandCenterDigestPreferencesUpdateInput,
    success: CommandCenterDigestPreferences,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);
export const WsCommandCenterDigestMarkViewedRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.digestMarkViewed,
  {
    payload: CommandCenterDigestMarkViewedInput,
    success: CommandCenterDigestSnapshot,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);

export const WsCommandCenterInboxDetailRpc = Rpc.make(COMMAND_CENTER_WS_METHODS.inboxDetail, {
  payload: CommandCenterInboxDetailInput,
  success: CommandCenterInboxDetail,
  error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
});

export const WsCommandCenterInboxCommentRpc = Rpc.make(COMMAND_CENTER_WS_METHODS.inboxComment, {
  payload: CommandCenterInboxCommentInput,
  success: CommandCenterInboxMutationResult,
  error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
});

export const WsCommandCenterInboxRequestChangesRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.inboxRequestChanges,
  {
    payload: CommandCenterInboxRequestChangesInput,
    success: CommandCenterInboxMutationResult,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);

export const WsCommandCenterInboxCandidateCreateRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.inboxCandidateCreate,
  {
    payload: CommandCenterInboxCandidateCreateInput,
    success: CommandCenterInboxMutationResult,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);

export const WsCommandCenterInboxCandidateAcceptRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.inboxCandidateAccept,
  {
    payload: CommandCenterInboxCandidateMutationInput,
    success: CommandCenterInboxMutationResult,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);

export const WsCommandCenterInboxAdjustmentApproveRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.inboxAdjustmentApprove,
  {
    payload: CommandCenterInboxApproveAdjustmentInput,
    success: CommandCenterInboxMutationResult,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);

export const WsCommandCenterInboxCandidateDiscardRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.inboxCandidateDiscard,
  {
    payload: CommandCenterInboxCandidateMutationInput,
    success: CommandCenterInboxMutationResult,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);

export const WsCommandCenterInboxChangeRequestResolveRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.inboxChangeRequestResolve,
  {
    payload: CommandCenterInboxResolveChangeRequestInput,
    success: CommandCenterInboxMutationResult,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);

export const WsCommandCenterInboxSnoozeRpc = Rpc.make(COMMAND_CENTER_WS_METHODS.inboxSnooze, {
  payload: CommandCenterInboxSnoozeInput,
  success: CommandCenterInboxMutationResult,
  error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
});

export const WsCommandCenterInboxUnsnoozeRpc = Rpc.make(COMMAND_CENTER_WS_METHODS.inboxUnsnooze, {
  payload: CommandCenterInboxSimpleMutationInput,
  success: CommandCenterInboxMutationResult,
  error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
});

export const WsCommandCenterInboxDismissRpc = Rpc.make(COMMAND_CENTER_WS_METHODS.inboxDismiss, {
  payload: CommandCenterInboxSimpleMutationInput,
  success: CommandCenterInboxMutationResult,
  error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
});

export const WsCommandCenterInboxReopenRpc = Rpc.make(COMMAND_CENTER_WS_METHODS.inboxReopen, {
  payload: CommandCenterInboxSimpleMutationInput,
  success: CommandCenterInboxMutationResult,
  error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
});

export const WsCommandCenterSprintPlanListRpc = Rpc.make(COMMAND_CENTER_WS_METHODS.sprintPlanList, {
  payload: CommandCenterSprintPlanListInput,
  success: CommandCenterSprintPlanListResult,
  error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
});

export const WsCommandCenterSprintPlanPreviewImportRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.sprintPlanPreviewImport,
  {
    payload: CommandCenterSprintPlanPreviewImportInput,
    success: CommandCenterSprintPlanPreviewImportResult,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);

export const WsCommandCenterSprintPlanApplyImportRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.sprintPlanApplyImport,
  {
    payload: CommandCenterSprintPlanApplyImportInput,
    success: CommandCenterSprintPlanApplyImportResult,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);

export const WsCommandCenterSprintPlanGetCurrentRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.sprintPlanGetCurrent,
  {
    payload: CommandCenterSprintPlanGetInput,
    success: CommandCenterSprintPlanGetResult,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);

export const WsCommandCenterSprintPlanGetOriginalRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.sprintPlanGetOriginal,
  {
    payload: CommandCenterSprintPlanGetOriginalInput,
    success: CommandCenterSprintPlanGetOriginalResult,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);

export const WsCommandCenterSprintPlanPatchTaskRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.sprintPlanPatchTask,
  {
    payload: CommandCenterSprintPlanPatchTaskInput,
    success: CommandCenterSprintPlanPatchTaskResult,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);

export const WsCommandCenterSprintPlanResolveDateConflictRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.sprintPlanResolveDateConflict,
  {
    payload: CommandCenterSprintPlanResolveDateConflictInput,
    success: CommandCenterSprintPlanResolveDateConflictResult,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);

export const WsCommandCenterSprintPlanListHistoryRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.sprintPlanListHistory,
  {
    payload: CommandCenterSprintPlanListHistoryInput,
    success: CommandCenterSprintPlanListHistoryResult,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);

export const WsCommandCenterInboxDraftApproveRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.inboxDraftApprove,
  {
    payload: CommandCenterInboxDraftApproveInput,
    success: CommandCenterInboxDraftReceipt,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);

export const WsCommandCenterInboxDraftReceiptRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.inboxDraftReceipt,
  {
    payload: CommandCenterInboxDraftReceiptInput,
    success: Schema.NullOr(CommandCenterInboxDraftReceipt),
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);

export const WsCommandCenterRunsQueryRpc = Rpc.make(COMMAND_CENTER_WS_METHODS.runsQuery, {
  payload: CommandCenterRunsQueryInput,
  success: CommandCenterRunsQueryResult,
  error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
});

export const WsCommandCenterAutomationsQueryRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.automationsQuery,
  {
    payload: CommandCenterAutomationsQueryInput,
    success: CommandCenterAutomationsQueryResult,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);

export const WsCommandCenterResponsibilitiesListRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.responsibilitiesList,
  {
    payload: CommandCenterResponsibilitiesListInput,
    success: CommandCenterResponsibilitiesListResult,
    error: Schema.Union([CommandCenterResponsibilityError, EnvironmentAuthorizationError]),
  },
);

export const WsCommandCenterResponsibilityGetRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.responsibilityGet,
  {
    payload: CommandCenterResponsibilityGetInput,
    success: CommandCenterResponsibilityDetail,
    error: Schema.Union([CommandCenterResponsibilityError, EnvironmentAuthorizationError]),
  },
);

export const WsCommandCenterResponsibilityPauseRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.responsibilityPause,
  {
    payload: CommandCenterResponsibilityPauseInput,
    success: CommandCenterResponsibilityStatus,
    error: Schema.Union([CommandCenterResponsibilityError, EnvironmentAuthorizationError]),
  },
);

export const WsCommandCenterResponsibilityResumeRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.responsibilityResume,
  {
    payload: CommandCenterResponsibilityPauseInput,
    success: CommandCenterResponsibilityStatus,
    error: Schema.Union([CommandCenterResponsibilityError, EnvironmentAuthorizationError]),
  },
);

export const WsCommandCenterAutomationDefinitionGetRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.automationDefinitionGet,
  {
    payload: CommandCenterAutomationDefinitionGetInput,
    success: CommandCenterAutomationDefinitionSnapshot,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);

export const WsCommandCenterAutomationDefinitionCreateRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.automationDefinitionCreate,
  {
    payload: CommandCenterAutomationDefinitionCreateInput,
    success: CommandCenterAutomationDefinitionSnapshot,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);

export const WsCommandCenterAutomationDefinitionSaveRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.automationDefinitionSave,
  {
    payload: CommandCenterAutomationDefinitionSaveInput,
    success: CommandCenterAutomationDefinitionSnapshot,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);

export const WsCommandCenterAutomationScheduleInterpretRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.automationScheduleInterpret,
  {
    payload: CommandCenterAutomationScheduleInterpretInput,
    success: CommandCenterAutomationScheduleInterpretResult,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);

export const WsCommandCenterApprovalsQueryRpc = Rpc.make(COMMAND_CENTER_WS_METHODS.approvalsQuery, {
  payload: CommandCenterApprovalsQueryInput,
  success: CommandCenterApprovalsQueryResult,
  error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
});

export const WsCommandCenterArtifactsQueryRpc = Rpc.make(COMMAND_CENTER_WS_METHODS.artifactsQuery, {
  payload: CommandCenterArtifactsQueryInput,
  success: CommandCenterArtifactsQueryResult,
  error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
});

export const WsCommandCenterConnectionsQueryRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.connectionsQuery,
  {
    payload: CommandCenterConnectionsQueryInput,
    success: CommandCenterConnectionsQueryResult,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);

export const WsCommandCenterConnectionRefreshRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.connectionsRefresh,
  {
    payload: CommandCenterConnectionRefreshInput,
    success: CommandCenterConnectionRefreshResult,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);

export const WsCommandCenterGoogleConnectionSetupBeginRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.googleConnectionSetupBegin,
  {
    payload: CommandCenterGoogleConnectionSetupBeginInput,
    success: CommandCenterGoogleConnectionSetupBeginResult,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);

export const WsCommandCenterGoogleConnectionSetupCompleteRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.googleConnectionSetupComplete,
  {
    payload: CommandCenterGoogleConnectionSetupCompleteInput,
    success: CommandCenterGoogleConnectionSetupCompleteResult,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);

export const WsCommandCenterGoogleConnectionRemoveRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.googleConnectionRemove,
  {
    payload: CommandCenterGoogleConnectionRemoveInput,
    success: CommandCenterGoogleConnectionRemoveResult,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);

export const WsInstagramReelRequestRpc = Rpc.make(INSTAGRAM_REEL_METHODS.request, {
  payload: InstagramReelRequest,
  success: InstagramReelReceipt,
  error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
});
export const WsInstagramReelQueryRpc = Rpc.make(INSTAGRAM_REEL_METHODS.query, {
  payload: InstagramReelSelection,
  success: InstagramReelReceipt,
  error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
});
export const WsInstagramReelApproveRpc = Rpc.make(INSTAGRAM_REEL_METHODS.approve, {
  payload: InstagramReelApprove,
  success: InstagramReelReceipt,
  error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
});
export const WsInstagramReelCancelRpc = Rpc.make(INSTAGRAM_REEL_METHODS.cancel, {
  payload: InstagramReelSelection,
  success: InstagramReelReceipt,
  error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
});

export const WsInstagramReelAccountRpc = Rpc.make(INSTAGRAM_REEL_METHODS.account, {
  payload: Schema.Struct({}),
  success: InstagramReelAccount,
  error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
});

export const WsCommandCenterPublishConnectionsQueryRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.publishConnectionsQuery,
  {
    payload: CommandCenterPublishConnectionsQueryInput,
    success: CommandCenterPublishConnectionsQueryResult,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);

export const WsCommandCenterPublishConnectionSetupBeginRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.publishConnectionSetupBegin,
  {
    payload: CommandCenterPublishConnectionSetupBeginInput,
    success: CommandCenterPublishConnectionSetupBeginResult,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);

export const WsCommandCenterPublishConnectionSetupCompleteRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.publishConnectionSetupComplete,
  {
    payload: CommandCenterPublishConnectionSetupCompleteInput,
    success: CommandCenterPublishConnectionSetupCompleteResult,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);

export const WsCommandCenterPublishConnectionRemoveRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.publishConnectionRemove,
  {
    payload: CommandCenterPublishConnectionRemoveInput,
    success: CommandCenterPublishConnectionRemoveResult,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);

export const WsCommandCenterMemoryQueryRpc = Rpc.make(COMMAND_CENTER_WS_METHODS.memoryQuery, {
  payload: CommandCenterMemoryQueryInput,
  success: CommandCenterMemoryQueryResult,
  error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
});

export const WsCommandCenterMemorySearchRpc = Rpc.make(COMMAND_CENTER_WS_METHODS.memorySearch, {
  payload: CommandCenterMemorySearchInput,
  success: CommandCenterMemorySearchResults,
  error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
});

export const WsCommandCenterItemCreateRpc = Rpc.make(COMMAND_CENTER_WS_METHODS.itemCreate, {
  payload: CommandCenterItemCreateInput,
  success: Item,
  error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
});

export const WsCommandCenterItemUpdateRpc = Rpc.make(COMMAND_CENTER_WS_METHODS.itemUpdate, {
  payload: CommandCenterItemUpdateInput,
  success: CommandCenterItemUpdateResult,
  error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
});

export const WsCommandCenterMemoryRememberRpc = Rpc.make(COMMAND_CENTER_WS_METHODS.memoryRemember, {
  payload: CommandCenterMemoryRememberInput,
  success: Memory,
  error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
});

export const WsCommandCenterMemoryProposeRpc = Rpc.make(COMMAND_CENTER_WS_METHODS.memoryPropose, {
  payload: CommandCenterMemoryProposeInput,
  success: Memory,
  error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
});

export const WsCommandCenterMemoryReviewRpc = Rpc.make(COMMAND_CENTER_WS_METHODS.memoryReview, {
  payload: CommandCenterMemoryReviewInput,
  success: Memory,
  error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
});

export const WsCommandCenterApprovalDecideRpc = Rpc.make(COMMAND_CENTER_WS_METHODS.approvalDecide, {
  payload: CommandCenterApprovalDecisionInput,
  success: Approval,
  error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
});

export const WsCommandCenterAutomationRunStartRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.automationRunStart,
  {
    payload: CommandCenterAutomationRunStartInput,
    success: CommandCenterAutomationExecution,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);

export const WsCommandCenterAutomationRunGetRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.automationRunGet,
  {
    payload: CommandCenterAutomationRunGetInput,
    success: CommandCenterAutomationExecution,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);

export const WsCommandCenterAutomationWebhookAdmitRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.automationWebhookAdmit,
  {
    payload: CommandCenterAutomationWebhookAdmitInput,
    success: CommandCenterAutomationExecution,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);

export const WsCommandCenterGoogleReadRpc = Rpc.make(COMMAND_CENTER_WS_METHODS.googleRead, {
  payload: GoogleReadRequest,
  success: GoogleReadResult,
  error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
});

export const WsCommandCenterWindowsMediaListRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.windowsMediaList,
  {
    payload: CommandCenterWindowsMediaListInput,
    success: CommandCenterWindowsMediaListResult,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);

export const WsCommandCenterWindowsMediaRootsRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.windowsMediaRoots,
  {
    payload: CommandCenterWindowsMediaRootsInput,
    success: CommandCenterWindowsMediaRootsResult,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);

export const WsCommandCenterObservationsListRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.observationsList,
  {
    payload: CommandCenterObservationListRequest,
    success: CommandCenterObservationListPage,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);
export const WsCommandCenterObservationsGetRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.observationsGet,
  {
    payload: CommandCenterObservationGetRequest,
    success: ObservationSnapshot,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);
export const WsCommandCenterObservationsHistoryRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.observationsHistory,
  {
    payload: CommandCenterObservationHistoryRequest,
    success: CommandCenterObservationHistoryPage,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);
export const WsCommandCenterYouTubeAnalyticsFetchRpc = Rpc.make(
  COMMAND_CENTER_YOUTUBE_ANALYTICS_FETCH_METHOD,
  {
    payload: CommandCenterYouTubeAnalyticsFetchInput,
    success: CommandCenterYouTubeAnalyticsFetchResult,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);
export const WsCommandCenterObservationsCreateManualRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.observationsCreateManual,
  {
    payload: CommandCenterObservationManualCreateRequest,
    success: CommandCenterObservationMutationReceipt,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);
export const WsCommandCenterObservationsImportRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.observationsImport,
  {
    payload: CommandCenterObservationImportInput,
    success: CommandCenterObservationImportReceipt,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);
export const WsCommandCenterObservationsCorrectRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.observationsCorrect,
  {
    payload: CommandCenterObservationCorrectionRequest,
    success: CommandCenterObservationMutationReceipt,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);
export const WsCommandCenterObservationsRetireRpc = Rpc.make(
  COMMAND_CENTER_WS_METHODS.observationsRetire,
  {
    payload: CommandCenterObservationRetirementRequest,
    success: CommandCenterObservationMutationReceipt,
    error: Schema.Union([CommandCenterError, EnvironmentAuthorizationError]),
  },
);

const WsServerUpsertKeybindingRpc = Rpc.make(WS_METHODS.serverUpsertKeybinding, {
  payload: ServerUpsertKeybindingInput,
  success: ServerUpsertKeybindingResult,
  error: Schema.Union([KeybindingsConfigError, EnvironmentAuthorizationError]),
});

const WsServerRemoveKeybindingRpc = Rpc.make(WS_METHODS.serverRemoveKeybinding, {
  payload: ServerRemoveKeybindingInput,
  success: ServerRemoveKeybindingResult,
  error: Schema.Union([KeybindingsConfigError, EnvironmentAuthorizationError]),
});

const WsServerProbeRpc = Rpc.make(WS_METHODS.serverProbe, {
  payload: Schema.Struct({}),
  success: Schema.Struct({}),
  error: EnvironmentAuthorizationError,
});

const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: Schema.Struct({}),
  success: ServerConfig,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError, EnvironmentAuthorizationError]),
});

const WsServerRefreshProvidersRpc = Rpc.make(WS_METHODS.serverRefreshProviders, {
  payload: Schema.Struct({
    /**
     * When supplied, only refresh this specific provider instance. When
     * omitted, refresh all configured instances — the legacy `refresh()`
     * behaviour retained for transports that still dispatch untargeted
     * refreshes.
     */
    instanceId: Schema.optional(ProviderInstanceId),
    cwd: Schema.optional(TrimmedNonEmptyString),
    /** Explicit user request. Background status refreshes must not open agent sessions. */
    refreshModels: Schema.optional(Schema.Boolean),
  }),
  success: ServerProviderUpdatedPayload,
  error: Schema.Union([EnvironmentAuthorizationError, ProviderSetupError]),
});

const WsServerUpdateProviderRpc = Rpc.make(WS_METHODS.serverUpdateProvider, {
  payload: ServerProviderUpdateInput,
  success: ServerProviderUpdatedPayload,
  error: Schema.Union([ServerProviderUpdateError, EnvironmentAuthorizationError]),
});

const ProviderSetupRpcError = Schema.Union([ProviderSetupError, EnvironmentAuthorizationError]);

const WsProviderConsumeResetCreditRpc = Rpc.make(WS_METHODS.providerConsumeResetCredit, {
  payload: ProviderConsumeResetCreditInput,
  success: ProviderConsumeResetCreditResult,
  error: Schema.Union([ProviderSetupError, UsageLimitSourceError, EnvironmentAuthorizationError]),
});

const WsProviderAuthStartRpc = Rpc.make(WS_METHODS.providerAuthStart, {
  payload: ProviderSetupInput,
  success: ProviderAuthState,
  error: ProviderSetupRpcError,
});

const WsProviderAuthCompleteRpc = Rpc.make(WS_METHODS.providerAuthComplete, {
  payload: ProviderAuthCompleteInput,
  success: ProviderAuthState,
  error: ProviderSetupRpcError,
});

const WsProviderAuthCancelRpc = Rpc.make(WS_METHODS.providerAuthCancel, {
  payload: ProviderAuthCancelInput,
  success: ProviderAuthState,
  error: ProviderSetupRpcError,
});

const WsProviderAuthLogoutRpc = Rpc.make(WS_METHODS.providerAuthLogout, {
  payload: ProviderSetupInput,
  success: ProviderAuthState,
  error: ProviderSetupRpcError,
});

const WsProviderAuthSubscribeRpc = Rpc.make(WS_METHODS.providerAuthSubscribe, {
  payload: ProviderSetupInput,
  success: ProviderAuthState,
  error: ProviderSetupRpcError,
  stream: true,
});

const WsProviderInstallStartRpc = Rpc.make(WS_METHODS.providerInstallStart, {
  payload: ProviderSetupInput,
  success: ProviderInstallState,
  error: ProviderSetupRpcError,
});

const WsProviderInstallCancelRpc = Rpc.make(WS_METHODS.providerInstallCancel, {
  payload: ProviderInstallCancelInput,
  success: ProviderInstallState,
  error: ProviderSetupRpcError,
});

const WsProviderInstallSubscribeRpc = Rpc.make(WS_METHODS.providerInstallSubscribe, {
  payload: ProviderSetupInput,
  success: ProviderInstallState,
  error: ProviderSetupRpcError,
  stream: true,
});

const WsProviderInstallRemoveRpc = Rpc.make(WS_METHODS.providerInstallRemove, {
  payload: ProviderSetupInput,
  success: ProviderInstallState,
  error: ProviderSetupRpcError,
});

const WsServerUpdateServerRpc = Rpc.make(WS_METHODS.serverUpdateServer, {
  payload: ServerSelfUpdateInput,
  success: ServerSelfUpdateResult,
  error: Schema.Union([ServerSelfUpdateError, EnvironmentAuthorizationError]),
});

const WsServerUpdateServerWithProgressRpc = Rpc.make(WS_METHODS.serverUpdateServerWithProgress, {
  payload: ServerSelfUpdateInput,
  success: ServerSelfUpdateProgressEvent,
  error: Schema.Union([ServerSelfUpdateError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsServerCommitDesktopUpdateRpc = Rpc.make(WS_METHODS.serverCommitDesktopUpdate, {
  payload: DesktopUpdateCommitInput,
  success: ServerSelfUpdateResult,
  error: Schema.Union([ServerSelfUpdateError, EnvironmentAuthorizationError]),
});

const WsServerGetSettingsRpc = Rpc.make(WS_METHODS.serverGetSettings, {
  payload: Schema.Struct({}),
  success: ServerSettings,
  error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
});

const WsServerUpdateSettingsRpc = Rpc.make(WS_METHODS.serverUpdateSettings, {
  payload: Schema.Struct({ patch: ServerSettingsPatch }),
  success: ServerSettings,
  error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
});

export const WsEfficiencyPreviewDecisionRpc = Rpc.make(WS_METHODS.efficiencyPreviewDecision, {
  payload: EfficiencyPreviewInput,
  success: EfficiencyPreviewResult,
  error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
});

const WsServerDiscoverSourceControlRpc = Rpc.make(WS_METHODS.serverDiscoverSourceControl, {
  payload: Schema.Struct({}),
  success: SourceControlDiscoveryResult,
  error: EnvironmentAuthorizationError,
});

const WsServerGetTraceDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetTraceDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerTraceDiagnosticsResult,
  error: EnvironmentAuthorizationError,
});

const WsServerGetProcessDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetProcessDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerProcessDiagnosticsResult,
  error: EnvironmentAuthorizationError,
});

const WsServerGetHostResourcesRpc = Rpc.make(WS_METHODS.serverGetHostResources, {
  payload: Schema.Struct({}),
  success: HostResourcesSnapshot,
  error: EnvironmentAuthorizationError,
});

const WsServerGetProcessResourceHistoryRpc = Rpc.make(WS_METHODS.serverGetProcessResourceHistory, {
  payload: ServerProcessResourceHistoryInput,
  success: ServerProcessResourceHistoryResult,
  error: EnvironmentAuthorizationError,
});

const WsServerGetResourceTelemetryHistoryRpc = Rpc.make(
  WS_METHODS.serverGetResourceTelemetryHistory,
  {
    payload: ResourceTelemetryHistoryInput,
    success: ResourceTelemetryHistory,
    error: EnvironmentAuthorizationError,
  },
);

const WsServerRetryResourceTelemetryRpc = Rpc.make(WS_METHODS.serverRetryResourceTelemetry, {
  payload: Schema.Struct({}),
  success: ResourceTelemetryRetryResult,
  error: EnvironmentAuthorizationError,
});

const WsServerGetUsageSummaryRpc = Rpc.make(WS_METHODS.serverGetUsageSummary, {
  payload: UsageSummaryInput,
  success: UsageSummary,
  error: Schema.Union([EnvironmentAuthorizationError, UsageReadError]),
});

/**
 * Refetches the model rate table ahead of its daily TTL, so a model released
 * since the last fetch gets priced. The next usage summary uses the new table.
 */
const WsServerRefreshUsageRatesRpc = Rpc.make(WS_METHODS.serverRefreshUsageRates, {
  payload: Schema.Struct({}),
  success: UsagePricing,
  error: EnvironmentAuthorizationError,
});

const WsServerSignalProcessRpc = Rpc.make(WS_METHODS.serverSignalProcess, {
  payload: ServerSignalProcessInput,
  success: ServerSignalProcessResult,
  error: EnvironmentAuthorizationError,
});

const WsCloudGetRelayClientStatusRpc = Rpc.make(WS_METHODS.cloudGetRelayClientStatus, {
  payload: Schema.Struct({}),
  success: RelayClientStatusSchema,
  error: EnvironmentAuthorizationError,
});

const WsCloudInstallRelayClientRpc = Rpc.make(WS_METHODS.cloudInstallRelayClient, {
  payload: Schema.Struct({}),
  success: RelayClientInstallProgressEventSchema,
  error: Schema.Union([RelayClientInstallFailedError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsServerReportClientActivityRpc = Rpc.make(WS_METHODS.serverReportClientActivity, {
  payload: ClientActivityReportInput,
  error: EnvironmentAuthorizationError,
});

const WsServerReportHostPowerStateRpc = Rpc.make(WS_METHODS.serverReportHostPowerState, {
  payload: HostPowerSnapshot,
  error: EnvironmentAuthorizationError,
});

const WsServerGetBackgroundPolicyRpc = Rpc.make(WS_METHODS.serverGetBackgroundPolicy, {
  payload: Schema.Struct({}),
  success: BackgroundPolicySnapshot,
  error: EnvironmentAuthorizationError,
});

export const WsUsageQueryRpc = Rpc.make(WS_METHODS.usageQuery, {
  payload: UsageQueryInput,
  success: UsageQueryResult,
  error: Schema.Union([UsageQueryError, EnvironmentAuthorizationError]),
});

const PullRequestRpcError = Schema.Union([
  PullRequestUnavailableError,
  PullRequestOperationError,
  EnvironmentAuthorizationError,
]);

const WsPullRequestsListRpc = Rpc.make(WS_METHODS.pullRequestsList, {
  payload: PullRequestListInput,
  success: PullRequestListResult,
  error: PullRequestRpcError,
});

/**
 * The line counts for rows already on the page. Its own call because on GitHub the pair costs
 * 40-60% of the listing read that answers everything else on the row, so the rows arrive first
 * and their stats a moment later.
 */
const WsPullRequestsListStatsRpc = Rpc.make(WS_METHODS.pullRequestsListStats, {
  payload: PullRequestListStatsInput,
  success: PullRequestListStatsResult,
  error: PullRequestRpcError,
});

const WsPullRequestsRoutingRpc = Rpc.make(WS_METHODS.pullRequestsRouting, {
  payload: PullRequestRef,
  success: PullRequestRoutingResult,
  error: PullRequestRpcError,
});

const WsPullRequestsRoutingIdentityRpc = Rpc.make(WS_METHODS.pullRequestsRoutingIdentity, {
  payload: PullRequestRoutingIdentityInput,
  success: PullRequestRoutingIdentityResult,
  error: PullRequestRpcError,
});

const WsPullRequestsSummaryRpc = Rpc.make(WS_METHODS.pullRequestsSummary, {
  payload: PullRequestRef,
  success: PullRequestSummary,
  error: PullRequestRpcError,
});

const WsPullRequestsStackRpc = Rpc.make(WS_METHODS.pullRequestsStack, {
  payload: PullRequestRef,
  success: Schema.NullOr(PullRequestStack),
  error: PullRequestRpcError,
});

const WsPullRequestsLinkedThreadsRpc = Rpc.make(WS_METHODS.pullRequestsLinkedThreads, {
  payload: PullRequestRef,
  success: PullRequestLinkedThreadsResult,
  error: PullRequestRpcError,
});

const WsPullRequestsDetailRpc = Rpc.make(WS_METHODS.pullRequestsDetail, {
  payload: PullRequestRef,
  success: PullRequestDetail,
  error: PullRequestRpcError,
});

const WsPullRequestsActivityRpc = Rpc.make(WS_METHODS.pullRequestsActivity, {
  payload: PullRequestRef,
  success: PullRequestActivity,
  error: PullRequestRpcError,
});

const WsPullRequestsThreadCommentsRpc = Rpc.make(WS_METHODS.pullRequestsThreadComments, {
  payload: PullRequestThreadCommentsInput,
  success: PullRequestThreadCommentsResult,
  error: PullRequestRpcError,
});

const WsPullRequestsDiffFileContentsRpc = Rpc.make(WS_METHODS.pullRequestsDiffFileContents, {
  payload: PullRequestDiffFileContentsInput,
  success: PullRequestDiffFileContentsResult,
  error: PullRequestRpcError,
});

const WsPullRequestsRunActionRpc = Rpc.make(WS_METHODS.pullRequestsRunAction, {
  payload: PullRequestActionInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsUpdateRpc = Rpc.make(WS_METHODS.pullRequestsUpdate, {
  payload: PullRequestUpdateInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsCommentRpc = Rpc.make(WS_METHODS.pullRequestsComment, {
  payload: PullRequestCommentInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsUpdateCommentRpc = Rpc.make(WS_METHODS.pullRequestsUpdateComment, {
  payload: PullRequestCommentUpdateInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsSubmitReviewRpc = Rpc.make(WS_METHODS.pullRequestsSubmitReview, {
  payload: PullRequestSubmitReviewInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsReplyToThreadRpc = Rpc.make(WS_METHODS.pullRequestsReplyToThread, {
  payload: PullRequestThreadReplyInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsSetThreadResolutionRpc = Rpc.make(WS_METHODS.pullRequestsSetThreadResolution, {
  payload: PullRequestThreadResolutionInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsSetReactionRpc = Rpc.make(WS_METHODS.pullRequestsSetReaction, {
  payload: PullRequestReactionInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsInvalidateRpc = Rpc.make(WS_METHODS.pullRequestsInvalidate, {
  payload: PullRequestInvalidateInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsSubscribeRefreshesRpc = Rpc.make(WS_METHODS.pullRequestsSubscribeRefreshes, {
  payload: Schema.Struct({}),
  success: NonNegativeInt,
  error: EnvironmentAuthorizationError,
  stream: true,
});

/**
 * Read on its own rather than as part of the detail: the people who may be asked are only wanted
 * once somebody opens the menu, and reading them with every change request would spend a request
 * per host on a list nobody looked at.
 */
const WsPullRequestsReviewerCandidatesRpc = Rpc.make(WS_METHODS.pullRequestsReviewerCandidates, {
  payload: PullRequestRef,
  success: PullRequestReviewerCandidateList,
  error: PullRequestRpcError,
});

const WsPullRequestsRequestReviewersRpc = Rpc.make(WS_METHODS.pullRequestsRequestReviewers, {
  payload: PullRequestReviewerRequestInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

/** Read when the label menu opens, for the same reason the reviewer candidates are. */
const WsPullRequestsLabelCandidatesRpc = Rpc.make(WS_METHODS.pullRequestsLabelCandidates, {
  payload: PullRequestRef,
  success: PullRequestLabelCandidateList,
  error: PullRequestRpcError,
});

const WsPullRequestsSetLabelsRpc = Rpc.make(WS_METHODS.pullRequestsSetLabels, {
  payload: PullRequestLabelChangeInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsSourceControlLookupRepositoryRpc = Rpc.make(WS_METHODS.sourceControlLookupRepository, {
  payload: SourceControlRepositoryLookupInput,
  success: SourceControlRepositoryInfo,
  error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
});

const WsSourceControlCloneRepositoryRpc = Rpc.make(WS_METHODS.sourceControlCloneRepository, {
  payload: SourceControlCloneRepositoryInput,
  success: SourceControlCloneRepositoryResult,
  error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
});

// Clone-backed project creation. `start` returns once the project exists and
// the clone is running; progress arrives on the subscription.
const WsProjectCloneStartRpc = Rpc.make(WS_METHODS.projectCloneStart, {
  payload: ProjectCloneStartInput,
  success: ProjectCloneStartResult,
  error: Schema.Union([
    SourceControlRepositoryError,
    OrchestrationDispatchCommandError,
    EnvironmentAuthorizationError,
  ]),
});

const WsProjectCloneCancelRpc = Rpc.make(WS_METHODS.projectCloneCancel, {
  payload: ProjectCloneActionInput,
  success: ProjectCloneActionResult,
  error: EnvironmentAuthorizationError,
});

const WsProjectCloneRetryRpc = Rpc.make(WS_METHODS.projectCloneRetry, {
  payload: ProjectCloneActionInput,
  success: ProjectCloneActionResult,
  error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
});

const WsSubscribeProjectClonesRpc = Rpc.make(WS_METHODS.subscribeProjectClones, {
  payload: ProjectCloneSubscribeInput,
  success: ProjectCloneListEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsSourceControlPublishRepositoryRpc = Rpc.make(WS_METHODS.sourceControlPublishRepository, {
  payload: SourceControlPublishRepositoryInput,
  success: SourceControlPublishRepositoryResult,
  error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
});

const WsProjectsSearchEntriesRpc = Rpc.make(WS_METHODS.projectsSearchEntries, {
  payload: ProjectSearchEntriesInput,
  success: ProjectSearchEntriesResult,
  error: Schema.Union([ProjectSearchEntriesError, EnvironmentAuthorizationError]),
});

const WsProjectsSearchContentsRpc = Rpc.make(WS_METHODS.projectsSearchContents, {
  payload: ProjectSearchContentsInput,
  success: ProjectSearchContentsResult,
  error: Schema.Union([ProjectSearchContentsError, EnvironmentAuthorizationError]),
});

const WsProjectsListEntriesRpc = Rpc.make(WS_METHODS.projectsListEntries, {
  payload: ProjectListEntriesInput,
  success: ProjectListEntriesResult,
  error: Schema.Union([ProjectListEntriesError, EnvironmentAuthorizationError]),
});

const WsProjectsReadFileRpc = Rpc.make(WS_METHODS.projectsReadFile, {
  payload: ProjectReadFileInput,
  success: ProjectReadFileResult,
  error: Schema.Union([ProjectReadFileError, EnvironmentAuthorizationError]),
});

const WsProjectsWriteFileRpc = Rpc.make(WS_METHODS.projectsWriteFile, {
  payload: ProjectWriteFileInput,
  success: ProjectWriteFileResult,
  error: Schema.Union([ProjectWriteFileError, EnvironmentAuthorizationError]),
});

const WsShellOpenInEditorRpc = Rpc.make(WS_METHODS.shellOpenInEditor, {
  payload: LaunchEditorInput,
  error: Schema.Union([ExternalLauncherError, EnvironmentAuthorizationError]),
});

const WsFilesystemBrowseRpc = Rpc.make(WS_METHODS.filesystemBrowse, {
  payload: FilesystemBrowseInput,
  success: FilesystemBrowseResult,
  error: Schema.Union([FilesystemBrowseError, EnvironmentAuthorizationError]),
});

const WsAgentSessionsScanRpc = Rpc.make(WS_METHODS.agentSessionsScan, {
  payload: AgentSessionScanInput,
  success: AgentSessionScanResult,
  error: Schema.Union([AgentSessionScanError, EnvironmentAuthorizationError]),
});

const WsAgentSessionsImportRpc = Rpc.make(WS_METHODS.agentSessionsImport, {
  payload: AgentSessionImportInput,
  success: AgentSessionImportResult,
  error: Schema.Union([
    AgentSessionImportProjectChangedError,
    AgentSessionImportProjectNotFoundError,
    AgentSessionScanError,
    EnvironmentAuthorizationError,
  ]),
});

const WsAssetsCreateUrlRpc = Rpc.make(WS_METHODS.assetsCreateUrl, {
  payload: AssetCreateUrlInput,
  success: AssetCreateUrlResult,
  error: Schema.Union([AssetAccessError, EnvironmentAuthorizationError]),
});

const WsAttachmentsCreateUploadUrlRpc = Rpc.make(WS_METHODS.attachmentsCreateUploadUrl, {
  payload: AttachmentCreateUploadUrlInput,
  success: AttachmentCreateUploadUrlResult,
  error: Schema.Union([AttachmentUploadSigningKeyError, EnvironmentAuthorizationError]),
});

const WsAttachmentsDeleteRpc = Rpc.make(WS_METHODS.attachmentsDelete, {
  payload: AttachmentDeleteInput,
  error: EnvironmentAuthorizationError,
});

const WsProviderUploadFeedbackRpc = Rpc.make(WS_METHODS.providerUploadFeedback, {
  payload: ProviderUploadFeedbackInput,
  success: ProviderUploadFeedbackResult,
  error: Schema.Union([ProviderUploadFeedbackError, EnvironmentAuthorizationError]),
});

const WsSubscribeVcsStatusRpc = Rpc.make(WS_METHODS.subscribeVcsStatus, {
  payload: VcsStatusInput,
  success: VcsStatusStreamEvent,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsVcsPullRpc = Rpc.make(WS_METHODS.vcsPull, {
  payload: VcsPullInput,
  success: VcsPullResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsVcsRefreshStatusRpc = Rpc.make(WS_METHODS.vcsRefreshStatus, {
  payload: VcsStatusInput,
  success: VcsStatusResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

const WsSubscribeWorktreeSetupRpc = Rpc.make(WS_METHODS.subscribeWorktreeSetup, {
  payload: WorktreeSetupSubscribeInput,
  success: WorktreeSetupStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsWorktreeSetupCancelRpc = Rpc.make(WS_METHODS.worktreeSetupCancel, {
  payload: WorktreeSetupCancelInput,
  success: WorktreeSetupCancelResult,
  error: EnvironmentAuthorizationError,
});

const WsGitRunStackedActionRpc = Rpc.make(WS_METHODS.gitRunStackedAction, {
  payload: GitRunStackedActionInput,
  success: GitActionProgressEvent,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsGitResolvePullRequestRpc = Rpc.make(WS_METHODS.gitResolvePullRequest, {
  payload: GitPullRequestRefInput,
  success: GitResolvePullRequestResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

const WsGitPreparePullRequestThreadRpc = Rpc.make(WS_METHODS.gitPreparePullRequestThread, {
  payload: GitPreparePullRequestThreadInput,
  success: GitPreparePullRequestThreadResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

const WsVcsListRefsRpc = Rpc.make(WS_METHODS.vcsListRefs, {
  payload: VcsListRefsInput,
  success: VcsListRefsResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsVcsCreateWorktreeRpc = Rpc.make(WS_METHODS.vcsCreateWorktree, {
  payload: VcsCreateWorktreeInput,
  success: VcsCreateWorktreeResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsVcsRemoveWorktreeRpc = Rpc.make(WS_METHODS.vcsRemoveWorktree, {
  payload: VcsRemoveWorktreeInput,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsVcsCreateRefRpc = Rpc.make(WS_METHODS.vcsCreateRef, {
  payload: VcsCreateRefInput,
  success: VcsCreateRefResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsVcsSwitchRefRpc = Rpc.make(WS_METHODS.vcsSwitchRef, {
  payload: VcsSwitchRefInput,
  success: VcsSwitchRefResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsVcsInitRpc = Rpc.make(WS_METHODS.vcsInit, {
  payload: VcsInitInput,
  error: Schema.Union([VcsError, EnvironmentAuthorizationError]),
});

/**
 * Ephemeral live diff preview for compact/mobile surfaces.
 * Not the persisted T3 Review model. Future review sessions should use
 * review.open* + review.getSnapshot.
 */
const WsReviewGetDiffPreviewRpc = Rpc.make(WS_METHODS.reviewGetDiffPreview, {
  payload: ReviewDiffPreviewInput,
  success: ReviewDiffPreviewResult,
  error: Schema.Union([ReviewDiffPreviewError, EnvironmentAuthorizationError]),
});

const WsReviewGetDiffFileContentsRpc = Rpc.make(WS_METHODS.reviewGetDiffFileContents, {
  payload: ReviewDiffFileContentsInput,
  success: ReviewDiffFileContentsResult,
  error: Schema.Union([ReviewDiffPreviewError, EnvironmentAuthorizationError]),
});

const WsTerminalOpenRpc = Rpc.make(WS_METHODS.terminalOpen, {
  payload: TerminalOpenInput,
  success: TerminalSessionSnapshot,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

const WsTerminalAttachRpc = Rpc.make(WS_METHODS.terminalAttach, {
  payload: TerminalAttachInput,
  success: TerminalAttachStreamEvent,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsTerminalWriteRpc = Rpc.make(WS_METHODS.terminalWrite, {
  payload: TerminalWriteInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

const WsTerminalResizeRpc = Rpc.make(WS_METHODS.terminalResize, {
  payload: TerminalResizeInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

const WsTerminalClearRpc = Rpc.make(WS_METHODS.terminalClear, {
  payload: TerminalClearInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

const WsTerminalRestartRpc = Rpc.make(WS_METHODS.terminalRestart, {
  payload: TerminalRestartInput,
  success: TerminalSessionSnapshot,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

const WsTerminalCloseRpc = Rpc.make(WS_METHODS.terminalClose, {
  payload: TerminalCloseInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

const WsPreviewOpenRpc = Rpc.make(WS_METHODS.previewOpen, {
  payload: PreviewOpenInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

const WsPreviewNavigateRpc = Rpc.make(WS_METHODS.previewNavigate, {
  payload: PreviewNavigateInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

const WsPreviewResizeRpc = Rpc.make(WS_METHODS.previewResize, {
  payload: PreviewResizeInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

const WsPreviewRefreshRpc = Rpc.make(WS_METHODS.previewRefresh, {
  payload: PreviewRefreshInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

const WsPreviewCloseRpc = Rpc.make(WS_METHODS.previewClose, {
  payload: PreviewCloseInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

const WsPreviewListRpc = Rpc.make(WS_METHODS.previewList, {
  payload: PreviewListInput,
  success: PreviewListResult,
  error: EnvironmentAuthorizationError,
});

const WsPreviewReportStatusRpc = Rpc.make(WS_METHODS.previewReportStatus, {
  payload: PreviewReportStatusInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

const WsPreviewAutomationConnectRpc = Rpc.make(WS_METHODS.previewAutomationConnect, {
  payload: PreviewAutomationHost,
  success: PreviewAutomationStreamEvent,
  error: Schema.Union([PreviewAutomationError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsPreviewAutomationRespondRpc = Rpc.make(WS_METHODS.previewAutomationRespond, {
  payload: PreviewAutomationResponse,
  error: Schema.Union([PreviewAutomationError, EnvironmentAuthorizationError]),
});

const WsPreviewAutomationFocusHostRpc = Rpc.make(WS_METHODS.previewAutomationFocusHost, {
  payload: PreviewAutomationHostFocus,
  error: EnvironmentAuthorizationError,
});

const WsSubscribePreviewEventsRpc = Rpc.make(WS_METHODS.subscribePreviewEvents, {
  payload: Schema.Struct({}),
  success: PreviewEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsSubscribeDiscoveredLocalServersRpc = Rpc.make(WS_METHODS.subscribeDiscoveredLocalServers, {
  payload: Schema.Struct({
    configuredUrls: Schema.optional(ConfiguredLocalServerUrls),
  }),
  success: DiscoveredLocalServerList,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsDeviceTestHostRpc = Rpc.make(WS_METHODS.deviceTestHost, {
  payload: SshDeviceHostConfig,
  success: DeviceHostSummary,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceListRpc = Rpc.make(WS_METHODS.deviceList, {
  payload: DeviceListInput,
  success: DeviceServiceState,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceConfigureRpc = Rpc.make(WS_METHODS.deviceConfigure, {
  payload: DeviceConfigureInput,
  success: DeviceServiceState,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceOpenRpc = Rpc.make(WS_METHODS.deviceOpen, {
  payload: DeviceOpenInput,
  success: DeviceSession,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceCloseRpc = Rpc.make(WS_METHODS.deviceClose, {
  payload: DeviceCloseInput,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceShutdownRpc = Rpc.make(WS_METHODS.deviceShutdown, {
  payload: DeviceShutdownInput,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceDetailRpc = Rpc.make(WS_METHODS.deviceDetail, {
  payload: DeviceDetailInput,
  success: DeviceDetail,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceActionRpc = Rpc.make(WS_METHODS.deviceAction, {
  payload: DeviceActionInput,
  success: DeviceDetail,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsSubscribeDeviceStateRpc = Rpc.make(WS_METHODS.subscribeDeviceState, {
  payload: Schema.Struct({}),
  success: DeviceServiceState,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsOrchestrationDispatchCommandRpc = Rpc.make(ORCHESTRATION_WS_METHODS.dispatchCommand, {
  payload: ClientOrchestrationCommand,
  success: OrchestrationRpcSchemas.dispatchCommand.output,
  error: Schema.Union([OrchestrationDispatchCommandError, EnvironmentAuthorizationError]),
});

const WsOrchestrationGetWorkflowScriptRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getWorkflowScript, {
  payload: OrchestrationRpcSchemas.getWorkflowScript.input,
  success: OrchestrationRpcSchemas.getWorkflowScript.output,
  error: Schema.Union([OrchestrationGetWorkflowScriptError, EnvironmentAuthorizationError]),
});

const WsOrchestrationGetTurnDiffRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getTurnDiff, {
  payload: OrchestrationGetTurnDiffInput,
  success: OrchestrationRpcSchemas.getTurnDiff.output,
  error: Schema.Union([OrchestrationGetTurnDiffError, EnvironmentAuthorizationError]),
});

const WsOrchestrationGetFullThreadDiffRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getFullThreadDiff, {
  payload: OrchestrationGetFullThreadDiffInput,
  success: OrchestrationRpcSchemas.getFullThreadDiff.output,
  error: Schema.Union([OrchestrationGetFullThreadDiffError, EnvironmentAuthorizationError]),
});

const WsOrchestrationSearchThreadsRpc = Rpc.make(ORCHESTRATION_WS_METHODS.searchThreads, {
  payload: OrchestrationSearchThreadsInput,
  success: OrchestrationRpcSchemas.searchThreads.output,
  error: Schema.Union([OrchestrationSearchThreadsError, EnvironmentAuthorizationError]),
});

const WsOrchestrationGetArchivedShellSnapshotRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
  {
    payload: OrchestrationRpcSchemas.getArchivedShellSnapshot.input,
    success: OrchestrationRpcSchemas.getArchivedShellSnapshot.output,
    error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]),
  },
);

const WsOrchestrationSubscribeShellRpc = Rpc.make(ORCHESTRATION_WS_METHODS.subscribeShell, {
  payload: OrchestrationRpcSchemas.subscribeShell.input,
  success: OrchestrationRpcSchemas.subscribeShell.output,
  error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsOrchestrationSubscribeThreadRpc = Rpc.make(ORCHESTRATION_WS_METHODS.subscribeThread, {
  payload: OrchestrationRpcSchemas.subscribeThread.input,
  success: OrchestrationRpcSchemas.subscribeThread.output,
  error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsSubscribeTerminalEventsRpc = Rpc.make(WS_METHODS.subscribeTerminalEvents, {
  payload: Schema.Struct({}),
  success: TerminalEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsSubscribeTerminalMetadataRpc = Rpc.make(WS_METHODS.subscribeTerminalMetadata, {
  payload: Schema.Struct({}),
  success: TerminalMetadataStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeServerConfigRpc = Rpc.make(WS_METHODS.subscribeServerConfig, {
  payload: Schema.Struct({
    /**
     * Whether this client understands `environmentThemesUpdated` events.
     * Already-shipped clients decode the stream against the old event union
     * and would die on an unknown member, so the server emits the theme
     * stream only to subscribers that ask for it. Absent on old clients;
     * dropped by old servers.
     */
    environmentThemes: Schema.optional(Schema.Boolean),
    /** Whether this client understands `usageLimitSourcesUpdated` events. */
    usageLimitSources: Schema.optional(Schema.Boolean),
    /**
     * Whether this client answers `/usage-limits` itself. The server injects
     * that command into provider catalogs only for such clients; an older
     * client would send it to the provider as an ordinary prompt.
     */
    usageLimitsCommand: Schema.optional(Schema.Boolean),
  }),
  success: ServerConfigStreamEvent,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsSubscribeServerLifecycleRpc = Rpc.make(WS_METHODS.subscribeServerLifecycle, {
  payload: Schema.Struct({}),
  success: ServerLifecycleStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsSubscribeAuthAccessRpc = Rpc.make(WS_METHODS.subscribeAuthAccess, {
  payload: Schema.Struct({}),
  success: AuthAccessStreamEvent,
  error: Schema.Union([AuthAccessStreamError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsSubscribeBackgroundPolicyRpc = Rpc.make(WS_METHODS.subscribeBackgroundPolicy, {
  payload: Schema.Struct({}),
  success: BackgroundPolicySnapshot,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsSubscribeResourceTelemetryRpc = Rpc.make(WS_METHODS.subscribeResourceTelemetry, {
  payload: Schema.Struct({}),
  success: ResourceTelemetrySnapshot,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsRpcGroup = RpcGroup.make(
  WsCommandCenterBootstrapRpc,
  WsCommandCenterCommandSubmitRpc,
  WsCommandCenterRunStartRpc,
  WsCommandCenterEventsReplayRpc,
  WsCommandCenterEventsSubscribeRpc,
  WsCommandCenterTimelineQueryRpc,
  WsCommandCenterSpacesQueryRpc,
  WsCommandCenterSpacesSyncRpc,
  WsCommandCenterItemsQueryRpc,
  WsCommandCenterInboxQueryRpc,
  WsCommandCenterDigestQueryRpc,
  WsCommandCenterDigestPreferencesUpdateRpc,
  WsCommandCenterDigestMarkViewedRpc,
  WsCommandCenterInboxDetailRpc,
  WsCommandCenterInboxCommentRpc,
  WsCommandCenterInboxRequestChangesRpc,
  WsCommandCenterInboxCandidateCreateRpc,
  WsCommandCenterInboxCandidateAcceptRpc,
  WsCommandCenterInboxAdjustmentApproveRpc,
  WsCommandCenterInboxCandidateDiscardRpc,
  WsCommandCenterInboxChangeRequestResolveRpc,
  WsCommandCenterInboxSnoozeRpc,
  WsCommandCenterInboxUnsnoozeRpc,
  WsCommandCenterInboxDismissRpc,
  WsCommandCenterInboxReopenRpc,
  WsCommandCenterSprintPlanListRpc,
  WsCommandCenterSprintPlanPreviewImportRpc,
  WsCommandCenterSprintPlanApplyImportRpc,
  WsCommandCenterSprintPlanGetCurrentRpc,
  WsCommandCenterSprintPlanGetOriginalRpc,
  WsCommandCenterSprintPlanPatchTaskRpc,
  WsCommandCenterSprintPlanResolveDateConflictRpc,
  WsCommandCenterSprintPlanListHistoryRpc,
  WsCommandCenterInboxDraftApproveRpc,
  WsCommandCenterInboxDraftReceiptRpc,
  WsCommandCenterRunsQueryRpc,
  WsCommandCenterAutomationsQueryRpc,
  WsCommandCenterResponsibilitiesListRpc,
  WsCommandCenterResponsibilityGetRpc,
  WsCommandCenterResponsibilityPauseRpc,
  WsCommandCenterResponsibilityResumeRpc,
  WsCommandCenterAutomationDefinitionGetRpc,
  WsCommandCenterAutomationDefinitionCreateRpc,
  WsCommandCenterAutomationDefinitionSaveRpc,
  WsCommandCenterAutomationScheduleInterpretRpc,
  WsCommandCenterApprovalsQueryRpc,
  WsCommandCenterArtifactsQueryRpc,
  WsCommandCenterConnectionsQueryRpc,
  WsCommandCenterConnectionRefreshRpc,
  WsCommandCenterGoogleConnectionSetupBeginRpc,
  WsCommandCenterGoogleConnectionSetupCompleteRpc,
  WsCommandCenterGoogleConnectionRemoveRpc,
  WsCommandCenterPublishConnectionsQueryRpc,
  WsInstagramReelRequestRpc,
  WsInstagramReelAccountRpc,
  WsInstagramReelQueryRpc,
  WsInstagramReelApproveRpc,
  WsInstagramReelCancelRpc,
  WsCommandCenterPublishConnectionSetupBeginRpc,
  WsCommandCenterPublishConnectionSetupCompleteRpc,
  WsCommandCenterPublishConnectionRemoveRpc,
  WsCommandCenterMemoryQueryRpc,
  WsCommandCenterMemorySearchRpc,
  WsCommandCenterItemCreateRpc,
  WsCommandCenterItemUpdateRpc,
  WsCommandCenterMemoryRememberRpc,
  WsCommandCenterMemoryProposeRpc,
  WsCommandCenterMemoryReviewRpc,
  WsCommandCenterApprovalDecideRpc,
  WsCommandCenterAutomationRunStartRpc,
  WsCommandCenterAutomationRunGetRpc,
  WsCommandCenterAutomationWebhookAdmitRpc,
  WsCommandCenterGoogleReadRpc,
  WsCommandCenterWindowsMediaListRpc,
  WsCommandCenterWindowsMediaRootsRpc,
  WsCommandCenterObservationsListRpc,
  WsCommandCenterObservationsGetRpc,
  WsCommandCenterObservationsHistoryRpc,
  WsCommandCenterYouTubeAnalyticsFetchRpc,
  WsCommandCenterObservationsCreateManualRpc,
  WsCommandCenterObservationsImportRpc,
  WsCommandCenterObservationsCorrectRpc,
  WsCommandCenterObservationsRetireRpc,
  WsServerProbeRpc,
  WsServerGetConfigRpc,
  WsServerRefreshProvidersRpc,
  WsServerUpdateProviderRpc,
  WsProviderConsumeResetCreditRpc,
  WsProviderAuthStartRpc,
  WsProviderAuthCompleteRpc,
  WsProviderAuthCancelRpc,
  WsProviderAuthLogoutRpc,
  WsProviderAuthSubscribeRpc,
  WsProviderInstallStartRpc,
  WsProviderInstallCancelRpc,
  WsProviderInstallSubscribeRpc,
  WsProviderInstallRemoveRpc,
  WsServerUpdateServerRpc,
  WsServerUpdateServerWithProgressRpc,
  WsServerCommitDesktopUpdateRpc,
  WsServerUpsertKeybindingRpc,
  WsServerRemoveKeybindingRpc,
  WsServerGetSettingsRpc,
  WsServerUpdateSettingsRpc,
  WsEfficiencyPreviewDecisionRpc,
  WsServerDiscoverSourceControlRpc,
  WsServerGetTraceDiagnosticsRpc,
  WsServerGetProcessDiagnosticsRpc,
  WsServerGetHostResourcesRpc,
  WsServerGetProcessResourceHistoryRpc,
  WsServerGetResourceTelemetryHistoryRpc,
  WsServerRetryResourceTelemetryRpc,
  WsServerGetUsageSummaryRpc,
  WsServerRefreshUsageRatesRpc,
  WsServerSignalProcessRpc,
  WsServerReportClientActivityRpc,
  WsServerReportHostPowerStateRpc,
  WsServerGetBackgroundPolicyRpc,
  WsUsageQueryRpc,
  WsCloudGetRelayClientStatusRpc,
  WsCloudInstallRelayClientRpc,
  WsPullRequestsListRpc,
  WsPullRequestsListStatsRpc,
  WsPullRequestsSummaryRpc,
  WsPullRequestsRoutingRpc,
  WsPullRequestsRoutingIdentityRpc,
  WsPullRequestsStackRpc,
  WsPullRequestsLinkedThreadsRpc,
  WsPullRequestsDetailRpc,
  WsPullRequestsActivityRpc,
  WsPullRequestsThreadCommentsRpc,
  WsPullRequestsDiffFileContentsRpc,
  WsPullRequestsRunActionRpc,
  WsPullRequestsUpdateRpc,
  WsPullRequestsCommentRpc,
  WsPullRequestsUpdateCommentRpc,
  WsPullRequestsSubmitReviewRpc,
  WsPullRequestsReplyToThreadRpc,
  WsPullRequestsSetThreadResolutionRpc,
  WsPullRequestsSetReactionRpc,
  WsPullRequestsInvalidateRpc,
  WsPullRequestsSubscribeRefreshesRpc,
  WsPullRequestsReviewerCandidatesRpc,
  WsPullRequestsRequestReviewersRpc,
  WsPullRequestsLabelCandidatesRpc,
  WsPullRequestsSetLabelsRpc,
  WsSourceControlLookupRepositoryRpc,
  WsSourceControlCloneRepositoryRpc,
  WsSourceControlPublishRepositoryRpc,
  WsProjectCloneStartRpc,
  WsProjectCloneCancelRpc,
  WsProjectCloneRetryRpc,
  WsSubscribeProjectClonesRpc,
  WsProjectsListEntriesRpc,
  WsProjectsReadFileRpc,
  WsProjectsSearchContentsRpc,
  WsProjectsSearchEntriesRpc,
  WsProjectsWriteFileRpc,
  WsShellOpenInEditorRpc,
  WsFilesystemBrowseRpc,
  WsAgentSessionsScanRpc,
  WsAgentSessionsImportRpc,
  WsAssetsCreateUrlRpc,
  WsAttachmentsCreateUploadUrlRpc,
  WsAttachmentsDeleteRpc,
  WsProviderUploadFeedbackRpc,
  WsSubscribeVcsStatusRpc,
  WsSubscribeWorktreeSetupRpc,
  WsWorktreeSetupCancelRpc,
  WsVcsPullRpc,
  WsVcsRefreshStatusRpc,
  WsGitRunStackedActionRpc,
  WsGitResolvePullRequestRpc,
  WsGitPreparePullRequestThreadRpc,
  WsVcsListRefsRpc,
  WsVcsCreateWorktreeRpc,
  WsVcsRemoveWorktreeRpc,
  WsVcsCreateRefRpc,
  WsVcsSwitchRefRpc,
  WsVcsInitRpc,
  WsReviewGetDiffPreviewRpc,
  WsReviewGetDiffFileContentsRpc,
  WsTerminalOpenRpc,
  WsTerminalAttachRpc,
  WsTerminalWriteRpc,
  WsTerminalResizeRpc,
  WsTerminalClearRpc,
  WsTerminalRestartRpc,
  WsTerminalCloseRpc,
  WsSubscribeTerminalEventsRpc,
  WsSubscribeTerminalMetadataRpc,
  WsPreviewOpenRpc,
  WsPreviewNavigateRpc,
  WsPreviewResizeRpc,
  WsPreviewRefreshRpc,
  WsPreviewCloseRpc,
  WsPreviewListRpc,
  WsPreviewReportStatusRpc,
  WsPreviewAutomationConnectRpc,
  WsPreviewAutomationRespondRpc,
  WsPreviewAutomationFocusHostRpc,
  WsSubscribePreviewEventsRpc,
  WsSubscribeDiscoveredLocalServersRpc,
  WsDeviceConfigureRpc,
  WsDeviceListRpc,
  WsDeviceTestHostRpc,
  WsDeviceOpenRpc,
  WsDeviceCloseRpc,
  WsDeviceShutdownRpc,
  WsDeviceDetailRpc,
  WsDeviceActionRpc,
  WsSubscribeDeviceStateRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeServerLifecycleRpc,
  WsSubscribeAuthAccessRpc,
  WsSubscribeBackgroundPolicyRpc,
  WsSubscribeResourceTelemetryRpc,
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationGetWorkflowScriptRpc,
  WsOrchestrationGetTurnDiffRpc,
  WsOrchestrationGetFullThreadDiffRpc,
  WsOrchestrationSearchThreadsRpc,
  WsOrchestrationGetArchivedShellSnapshotRpc,
  WsOrchestrationSubscribeShellRpc,
  WsOrchestrationSubscribeThreadRpc,
);
