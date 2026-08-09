import {
  type AutomationDefinition,
  type AutomationValidationIssue,
  decodeAutomationDefinitionShape,
  normalizeAutomationDefinition,
} from "./Definition.ts";
import {
  canonicalAutomationJson,
  digestAutomationDefinition,
  type AutomationDefinitionDigest,
} from "./Digest.ts";

export interface AutomationSaveGuardInput {
  readonly expectedDigest: AutomationDefinitionDigest | null;
  readonly currentDefinition: unknown | null;
  readonly nextDefinition: unknown;
}

export type AutomationSaveGuardResult =
  | {
      readonly status: "ready";
      readonly definition: AutomationDefinition;
      readonly previousDigest: AutomationDefinitionDigest | null;
      readonly nextDigest: AutomationDefinitionDigest;
      readonly canonicalJson: string;
    }
  | {
      readonly status: "conflict";
      readonly expectedDigest: AutomationDefinitionDigest | null;
      readonly currentDigest: AutomationDefinitionDigest | null;
    }
  | {
      readonly status: "invalid";
      readonly target: "current" | "next";
      readonly issues: ReadonlyArray<AutomationValidationIssue>;
    };

export function expectedDigestMatches(
  expectedDigest: AutomationDefinitionDigest | null,
  currentDigest: AutomationDefinitionDigest | null,
): boolean {
  return expectedDigest === currentDigest;
}

/**
 * Pure optimistic-concurrency guard. The caller performs the atomic file write
 * only when this function returns `ready`.
 */
export function prepareAutomationSave(input: AutomationSaveGuardInput): AutomationSaveGuardResult {
  let previousDigest: AutomationDefinitionDigest | null = null;
  if (input.currentDefinition !== null) {
    const current = decodeAutomationDefinitionShape(input.currentDefinition);
    if (!current.ok) return { status: "invalid", target: "current", issues: current.issues };
    previousDigest = digestAutomationDefinition(current.definition);
  }

  if (!expectedDigestMatches(input.expectedDigest, previousDigest)) {
    return {
      status: "conflict",
      expectedDigest: input.expectedDigest,
      currentDigest: previousDigest,
    };
  }

  const next = decodeAutomationDefinitionShape(input.nextDefinition);
  if (!next.ok) return { status: "invalid", target: "next", issues: next.issues };

  return {
    status: "ready",
    definition: normalizeAutomationDefinition(next.definition),
    previousDigest,
    nextDigest: digestAutomationDefinition(next.definition),
    canonicalJson: canonicalAutomationJson(next.definition),
  };
}
