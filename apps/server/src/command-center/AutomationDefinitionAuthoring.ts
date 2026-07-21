import type {
  CommandCenterAutomationDefinitionCreateInput,
  CommandCenterAutomationSourceDefinition,
} from "@t3tools/contracts";
import type * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";

import { canonicalJson } from "./automation/index.ts";

export const AUTHORING_LAYOUT_KEY = "_commandCenter";

const withoutSchema = (
  definition: CommandCenterAutomationSourceDefinition,
): Omit<CommandCenterAutomationSourceDefinition, "$schema"> => {
  const { $schema: _schema, ...without } = definition;
  return without;
};

export function preservePrivateSourceFields(
  current: CommandCenterAutomationSourceDefinition,
  next: CommandCenterAutomationSourceDefinition,
): CommandCenterAutomationSourceDefinition {
  const { _commandCenter: _callerAuthoringMarker, ...editableLayout } = next.layout;
  const shared = {
    ...withoutSchema(next),
    layout: {
      ...editableLayout,
      ...(current.layout._commandCenter === undefined
        ? {}
        : { _commandCenter: current.layout._commandCenter }),
    },
    policy: current.policy,
  };
  return current.$schema === undefined ? shared : { $schema: current.$schema, ...shared };
}

export const sourceFileContents = (definition: CommandCenterAutomationSourceDefinition): string =>
  `${JSON.stringify(definition, null, 2)}\n`;

export function automaticAutomationId(name: string): string {
  const normalized = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 96)
    .replace(/-+$/gu, "");
  return normalized.length === 0 ? "automation" : normalized;
}

export function automationCreateRequestDigest(
  input: CommandCenterAutomationDefinitionCreateInput,
): string {
  const document: Schema.Json = {
    requestId: input.requestId,
    spaceId: input.spaceId,
    ...(input.preferredAutomationId === undefined
      ? {}
      : { preferredAutomationId: input.preferredAutomationId }),
    name: input.name,
    enabled: input.enabled,
    trigger: input.trigger,
    nodes: input.nodes,
    edges: input.edges,
    layout: input.layout,
  };
  return NodeCrypto.createHash("sha256").update(canonicalJson(document), "utf8").digest("hex");
}

export const automationCreateRequestSuffix = (requestId: string): string =>
  NodeCrypto.createHash("sha256").update(requestId, "utf8").digest("hex").slice(0, 10);

export function readAuthoringMarker(
  definition: CommandCenterAutomationSourceDefinition,
): { readonly requestId: string; readonly requestDigest: string } | undefined {
  const marker = definition.layout[AUTHORING_LAYOUT_KEY];
  if (marker === null || typeof marker !== "object" || Array.isArray(marker)) return undefined;
  const record = marker as Readonly<Record<string, Schema.Json>>;
  const requestId = record.requestId;
  const digest = record.requestDigest;
  return typeof requestId === "string" && typeof digest === "string"
    ? { requestId, requestDigest: digest }
    : undefined;
}
