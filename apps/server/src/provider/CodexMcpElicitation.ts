import type { ProviderApprovalDecision, ProviderApprovalOption } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type * as EffectCodexSchema from "effect-codex-app-server/schema";

const NullableMcpElicitationString = Schema.NullOr(Schema.String);
// Only the persistence hints are read from `_meta`. App names in `_meta` (and
// the message text) are request-controlled, so the prompt names the app by the
// trusted `serverName` instead.
const McpElicitationMetadata = Schema.Struct({
  allowPersistentApproval: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  persist: Schema.optionalKey(
    Schema.NullOr(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  ),
});
const McpElicitationFormField = Schema.Struct({
  type: Schema.optionalKey(NullableMcpElicitationString),
  title: Schema.optionalKey(NullableMcpElicitationString),
  description: Schema.optionalKey(NullableMcpElicitationString),
  default: Schema.optionalKey(Schema.Json),
  enum: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  enumNames: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  oneOf: Schema.optionalKey(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          const: Schema.String,
          title: Schema.optionalKey(NullableMcpElicitationString),
        }),
      ),
    ),
  ),
});
const McpElicitationForm = Schema.Struct({
  properties: Schema.optionalKey(Schema.Record(Schema.String, McpElicitationFormField)),
  required: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
});
const isMcpElicitationMetadata = Schema.is(McpElicitationMetadata);
const isMcpElicitationForm = Schema.is(McpElicitationForm);

type McpElicitationPersistenceDecision = Extract<
  ProviderApprovalDecision,
  "acceptForSession" | "acceptAlways"
>;

function mcpElicitationPersistenceDecision(
  value: string,
): McpElicitationPersistenceDecision | null {
  const normalized = value.toLowerCase();
  if (normalized.includes("session")) return "acceptForSession";
  if (
    normalized.includes("always") ||
    normalized.includes("permanent") ||
    normalized.includes("forever") ||
    normalized.includes("persistent")
  ) {
    return "acceptAlways";
  }
  return null;
}

function mcpElicitationFormFields(payload: EffectCodexSchema.McpServerElicitationRequestParams) {
  if (payload.mode === "url" || !isMcpElicitationForm(payload.requestedSchema)) {
    return undefined;
  }
  return payload.requestedSchema;
}

function mcpElicitationFieldOptions(field: typeof McpElicitationFormField.Type) {
  if (field.oneOf) {
    return field.oneOf.map((option) => ({ value: option.const, label: option.title }));
  }
  return (field.enum ?? []).map((value, index) => ({
    value,
    label: field.enumNames?.[index],
  }));
}

/**
 * The persistence scope a boolean consent field grants when checked. A
 * "this session" checkbox stays session-scoped; only always/persist fields
 * mean "always".
 */
function mcpElicitationBooleanPersistenceDecision(
  key: string,
  field: typeof McpElicitationFormField.Type,
): McpElicitationPersistenceDecision | null {
  return (
    mcpElicitationPersistenceDecision(key) ??
    (key.toLowerCase() === "persist" ? "acceptAlways" : null) ??
    mcpElicitationPersistenceDecision(field.title ?? "") ??
    mcpElicitationPersistenceDecision(field.description ?? "")
  );
}

/**
 * Whole-value match, so `allow_admin`, `disallow` or `approve_all` are never
 * picked as the one-time approval.
 */
function isMcpElicitationOneTimeApprovalValue(value: string): boolean {
  return /^(?:once|accept|approve|allow)(?:[_ -]?once)?$/i.test(value.trim());
}

/** Returns the app and approval choices advertised by an MCP elicitation. */
export function describeMcpElicitation(
  payload: EffectCodexSchema.McpServerElicitationRequestParams,
): { readonly appName: string; readonly options: ReadonlyArray<ProviderApprovalOption> } {
  const metadata = isMcpElicitationMetadata(payload._meta) ? payload._meta : undefined;
  const appName = payload.serverName;
  const persistenceOptions = new Map<McpElicitationPersistenceDecision, string>();
  const persist = metadata?.persist;
  for (const value of typeof persist === "string" ? [persist] : (persist ?? [])) {
    const decision = mcpElicitationPersistenceDecision(value);
    if (decision) persistenceOptions.set(decision, "");
  }
  if (metadata?.allowPersistentApproval) {
    persistenceOptions.set("acceptAlways", "");
  }

  const form = mcpElicitationFormFields(payload);
  for (const [key, field] of Object.entries(form?.properties ?? {})) {
    for (const option of mcpElicitationFieldOptions(field)) {
      const decision = mcpElicitationPersistenceDecision(option.value);
      if (decision) persistenceOptions.set(decision, option.label ?? "");
    }
    const booleanDecision =
      field.type === "boolean" ? mcpElicitationBooleanPersistenceDecision(key, field) : null;
    if (booleanDecision) {
      persistenceOptions.set(booleanDecision, field.title ?? "");
    }
  }

  return {
    appName,
    options: [
      { decision: "cancel", label: "Cancel" },
      { decision: "decline", label: "Decline" },
      ...(persistenceOptions.has("acceptForSession") &&
      toMcpElicitationResponse(payload, "acceptForSession").action === "accept"
        ? [
            {
              decision: "acceptForSession" as const,
              label: persistenceOptions.get("acceptForSession") || "Always allow this session",
            },
          ]
        : []),
      ...(persistenceOptions.has("acceptAlways") &&
      toMcpElicitationResponse(payload, "acceptAlways").action === "accept"
        ? [
            {
              decision: "acceptAlways" as const,
              label: persistenceOptions.get("acceptAlways") || "Always allow",
            },
          ]
        : []),
      { decision: "accept", label: "Approve" },
    ],
  };
}

/** Converts a T3 approval decision into the MCP elicitation wire response. */
export function toMcpElicitationResponse(
  payload: EffectCodexSchema.McpServerElicitationRequestParams,
  decision: ProviderApprovalDecision,
): EffectCodexSchema.McpServerElicitationRequestResponse {
  if (decision === "decline" || decision === "cancel") {
    return { action: decision };
  }

  if (payload.mode === "url") {
    return { action: "decline" };
  }

  const persist =
    decision === "acceptForSession"
      ? "session"
      : decision === "acceptAlways"
        ? "always"
        : undefined;
  const form = mcpElicitationFormFields(payload);
  const content: Record<string, Schema.Json> = {};

  for (const [key, field] of Object.entries(form?.properties ?? {})) {
    const options = mcpElicitationFieldOptions(field);
    const chosenOption = options.find((option) =>
      persist
        ? mcpElicitationPersistenceDecision(option.value) === decision
        : isMcpElicitationOneTimeApprovalValue(option.value),
    );
    const booleanDecision =
      field.type === "boolean" ? mcpElicitationBooleanPersistenceDecision(key, field) : null;
    if (chosenOption) {
      content[key] = chosenOption.value;
    } else if (booleanDecision) {
      // Checked only for the scope it grants: "this session" is not "always".
      content[key] = decision === booleanDecision;
    } else if (field.default !== undefined && field.default !== null) {
      content[key] = field.default;
    }
  }

  if (form?.required?.some((key) => !Object.hasOwn(content, key))) {
    return { action: "decline" };
  }

  return {
    action: "accept",
    ...(persist ? { _meta: { persist } } : {}),
    ...(form ? { content } : {}),
  };
}
