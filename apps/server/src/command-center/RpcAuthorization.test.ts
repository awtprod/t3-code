import {
  AuthCommandCenterApproveScope,
  AuthCommandCenterOperateScope,
  AuthCommandCenterReadScope,
  COMMAND_CENTER_WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  COMMAND_CENTER_RPC_SCOPE_ENTRIES,
  commandCenterRpcRequiresReadiness,
} from "./RpcAuthorization.ts";

describe("Command Center RPC authorization", () => {
  const scopes = new Map(COMMAND_CENTER_RPC_SCOPE_ENTRIES);

  it("declares an authentication scope for every Command Center RPC", () => {
    expect([...scopes.keys()].toSorted()).toEqual(
      Object.values(COMMAND_CENTER_WS_METHODS).toSorted(),
    );
  });

  it("requires startup integrity readiness for every Command Center RPC", () => {
    expect(Object.values(COMMAND_CENTER_WS_METHODS).every(commandCenterRpcRequiresReadiness)).toBe(
      true,
    );
    expect(commandCenterRpcRequiresReadiness("server.getConfig")).toBe(false);
  });

  it("restricts durable events and timeline reads to the read scope", () => {
    expect(scopes.get(COMMAND_CENTER_WS_METHODS.eventsReplay)).toBe(AuthCommandCenterReadScope);
    expect(scopes.get(COMMAND_CENTER_WS_METHODS.eventsSubscribe)).toBe(AuthCommandCenterReadScope);
    expect(scopes.get(COMMAND_CENTER_WS_METHODS.timelineQuery)).toBe(AuthCommandCenterReadScope);
    expect(scopes.get(COMMAND_CENTER_WS_METHODS.spacesQuery)).toBe(AuthCommandCenterReadScope);
    expect(scopes.get(COMMAND_CENTER_WS_METHODS.connectionsRefresh)).toBe(
      AuthCommandCenterReadScope,
    );
    expect(scopes.get(COMMAND_CENTER_WS_METHODS.itemsQuery)).toBe(AuthCommandCenterReadScope);
    expect(scopes.get(COMMAND_CENTER_WS_METHODS.runsQuery)).toBe(AuthCommandCenterReadScope);
    expect(scopes.get(COMMAND_CENTER_WS_METHODS.automationsQuery)).toBe(AuthCommandCenterReadScope);
    expect(scopes.get(COMMAND_CENTER_WS_METHODS.automationDefinitionGet)).toBe(
      AuthCommandCenterReadScope,
    );
    expect(scopes.get(COMMAND_CENTER_WS_METHODS.approvalsQuery)).toBe(AuthCommandCenterReadScope);
    expect(scopes.get(COMMAND_CENTER_WS_METHODS.artifactsQuery)).toBe(AuthCommandCenterReadScope);
    expect(scopes.get(COMMAND_CENTER_WS_METHODS.connectionsQuery)).toBe(AuthCommandCenterReadScope);
    expect(scopes.get(COMMAND_CENTER_WS_METHODS.memoryQuery)).toBe(AuthCommandCenterReadScope);
    expect(scopes.get(COMMAND_CENTER_WS_METHODS.memorySearch)).toBe(AuthCommandCenterReadScope);
    expect(scopes.get(COMMAND_CENTER_WS_METHODS.automationRunGet)).toBe(AuthCommandCenterReadScope);
    expect(scopes.get(COMMAND_CENTER_WS_METHODS.commandSubmit)).toBe(AuthCommandCenterOperateScope);
    expect(scopes.get(COMMAND_CENTER_WS_METHODS.runStart)).toBe(AuthCommandCenterOperateScope);
    expect(scopes.get(COMMAND_CENTER_WS_METHODS.spacesSync)).toBe(AuthCommandCenterOperateScope);
    expect(scopes.get(COMMAND_CENTER_WS_METHODS.itemUpdate)).toBe(AuthCommandCenterOperateScope);
    expect(scopes.get(COMMAND_CENTER_WS_METHODS.automationRunStart)).toBe(
      AuthCommandCenterOperateScope,
    );
    expect(scopes.get(COMMAND_CENTER_WS_METHODS.automationWebhookAdmit)).toBe(
      AuthCommandCenterOperateScope,
    );
    expect(scopes.get(COMMAND_CENTER_WS_METHODS.automationDefinitionSave)).toBe(
      AuthCommandCenterOperateScope,
    );
    expect(scopes.get(COMMAND_CENTER_WS_METHODS.automationDefinitionCreate)).toBe(
      AuthCommandCenterOperateScope,
    );
    expect(scopes.get(COMMAND_CENTER_WS_METHODS.automationScheduleInterpret)).toBe(
      AuthCommandCenterOperateScope,
    );
    expect(scopes.get(COMMAND_CENTER_WS_METHODS.googleConnectionSetupBegin)).toBe(
      AuthCommandCenterOperateScope,
    );
    expect(scopes.get(COMMAND_CENTER_WS_METHODS.googleConnectionSetupComplete)).toBe(
      AuthCommandCenterOperateScope,
    );
    expect(scopes.get(COMMAND_CENTER_WS_METHODS.googleConnectionRemove)).toBe(
      AuthCommandCenterOperateScope,
    );
    expect(scopes.get(COMMAND_CENTER_WS_METHODS.memoryReview)).toBe(AuthCommandCenterOperateScope);
    expect(scopes.get(COMMAND_CENTER_WS_METHODS.approvalDecide)).toBe(
      AuthCommandCenterApproveScope,
    );
  });
});
