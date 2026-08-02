import {
  AuthCommandCenterApproveScope,
  AuthCommandCenterOperateScope,
  AuthCommandCenterReadScope,
  COMMAND_CENTER_WS_METHODS,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";

export const COMMAND_CENTER_RPC_SCOPE_ENTRIES = [
  [COMMAND_CENTER_WS_METHODS.bootstrap, AuthCommandCenterReadScope],
  [COMMAND_CENTER_WS_METHODS.commandSubmit, AuthCommandCenterOperateScope],
  [COMMAND_CENTER_WS_METHODS.runStart, AuthCommandCenterOperateScope],
  [COMMAND_CENTER_WS_METHODS.eventsReplay, AuthCommandCenterReadScope],
  [COMMAND_CENTER_WS_METHODS.eventsSubscribe, AuthCommandCenterReadScope],
  [COMMAND_CENTER_WS_METHODS.timelineQuery, AuthCommandCenterReadScope],
  [COMMAND_CENTER_WS_METHODS.spacesQuery, AuthCommandCenterReadScope],
  [COMMAND_CENTER_WS_METHODS.spacesSync, AuthCommandCenterOperateScope],
  [COMMAND_CENTER_WS_METHODS.itemsQuery, AuthCommandCenterReadScope],
  [COMMAND_CENTER_WS_METHODS.itemUpdate, AuthCommandCenterOperateScope],
  [COMMAND_CENTER_WS_METHODS.runsQuery, AuthCommandCenterReadScope],
  [COMMAND_CENTER_WS_METHODS.automationsQuery, AuthCommandCenterReadScope],
  [COMMAND_CENTER_WS_METHODS.automationDefinitionGet, AuthCommandCenterReadScope],
  [COMMAND_CENTER_WS_METHODS.automationDefinitionCreate, AuthCommandCenterOperateScope],
  [COMMAND_CENTER_WS_METHODS.automationDefinitionSave, AuthCommandCenterOperateScope],
  [COMMAND_CENTER_WS_METHODS.approvalsQuery, AuthCommandCenterReadScope],
  [COMMAND_CENTER_WS_METHODS.artifactsQuery, AuthCommandCenterReadScope],
  [COMMAND_CENTER_WS_METHODS.connectionsQuery, AuthCommandCenterReadScope],
  [COMMAND_CENTER_WS_METHODS.connectionsRefresh, AuthCommandCenterReadScope],
  [COMMAND_CENTER_WS_METHODS.memoryQuery, AuthCommandCenterReadScope],
  [COMMAND_CENTER_WS_METHODS.memorySearch, AuthCommandCenterReadScope],
  [COMMAND_CENTER_WS_METHODS.itemCreate, AuthCommandCenterOperateScope],
  [COMMAND_CENTER_WS_METHODS.memoryRemember, AuthCommandCenterOperateScope],
  [COMMAND_CENTER_WS_METHODS.memoryPropose, AuthCommandCenterOperateScope],
  [COMMAND_CENTER_WS_METHODS.memoryReview, AuthCommandCenterOperateScope],
  [COMMAND_CENTER_WS_METHODS.approvalDecide, AuthCommandCenterApproveScope],
  [COMMAND_CENTER_WS_METHODS.automationRunStart, AuthCommandCenterOperateScope],
  [COMMAND_CENTER_WS_METHODS.automationRunGet, AuthCommandCenterReadScope],
  [COMMAND_CENTER_WS_METHODS.automationWebhookAdmit, AuthCommandCenterOperateScope],
  [COMMAND_CENTER_WS_METHODS.googleRead, AuthCommandCenterReadScope],
  [COMMAND_CENTER_WS_METHODS.salesProspectsQuery, AuthCommandCenterReadScope],
  [COMMAND_CENTER_WS_METHODS.salesProspectorImport, AuthCommandCenterOperateScope],
  [COMMAND_CENTER_WS_METHODS.salesProspectPropose, AuthCommandCenterOperateScope],
  [COMMAND_CENTER_WS_METHODS.salesProspectUpdate, AuthCommandCenterOperateScope],
  [COMMAND_CENTER_WS_METHODS.salesDraftRequest, AuthCommandCenterOperateScope],
  [COMMAND_CENTER_WS_METHODS.salesDraftDecision, AuthCommandCenterApproveScope],
  [COMMAND_CENTER_WS_METHODS.salesDraftCreate, AuthCommandCenterOperateScope],
] as const satisfies ReadonlyArray<readonly [string, AuthEnvironmentScope]>;

const COMMAND_CENTER_RPC_METHODS = new Set<string>(
  COMMAND_CENTER_RPC_SCOPE_ENTRIES.map(([method]) => method),
);

/** Every Command Center RPC is gated because even its current read paths may
 * refresh private-config projections or rebuild local indexes. */
export const commandCenterRpcRequiresReadiness = (method: string): boolean =>
  COMMAND_CENTER_RPC_METHODS.has(method);
