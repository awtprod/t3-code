import * as Schema from "effect/Schema";

import { ActionKind, type ActionKind as ActionKindType, RiskLevel } from "./domain.ts";

export const RiskClassification = Schema.Struct({
  actionKind: ActionKind,
  level: RiskLevel,
  approvalRequired: Schema.Boolean,
  reversible: Schema.Boolean,
});
export type RiskClassification = typeof RiskClassification.Type;

const LOW_RISK_ACTIONS: ReadonlySet<ActionKindType> = new Set([
  "read",
  "search",
  "retrieve",
  "preview",
]);

const REVERSIBLE_ACTIONS: ReadonlySet<ActionKindType> = new Set([
  "item.mutate",
  "memory.remember",
  "automation.draft",
  "automation.run",
  "config.commit.local",
  "worktree.edit",
]);

const BLOCKED_ACTIONS: ReadonlySet<ActionKindType> = new Set(["google.write", "unsupported"]);

export function classifyActionRisk(actionKind: ActionKindType): RiskClassification {
  if (LOW_RISK_ACTIONS.has(actionKind)) {
    return { actionKind, level: "low", approvalRequired: false, reversible: false };
  }
  if (REVERSIBLE_ACTIONS.has(actionKind)) {
    return { actionKind, level: "reversible", approvalRequired: false, reversible: true };
  }
  if (BLOCKED_ACTIONS.has(actionKind)) {
    return { actionKind, level: "blocked", approvalRequired: false, reversible: false };
  }
  return {
    actionKind,
    level: "approval-required",
    approvalRequired: true,
    reversible: false,
  };
}
