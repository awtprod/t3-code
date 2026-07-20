import * as NodeCrypto from "node:crypto";
import type * as Schema from "effect/Schema";

import { type AutomationDefinition, normalizeAutomationDefinition } from "./Definition.ts";

export type AutomationDefinitionDigest = `sha256:${string}`;

export function canonicalJson(value: Schema.Json): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Canonical JSON only supports finite numbers.");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  const object = value as Schema.JsonObject;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`)
    .join(",")}}`;
}

export function canonicalAutomationJson(definition: AutomationDefinition): string {
  return canonicalJson(normalizeAutomationDefinition(definition) as Schema.Json);
}

export function digestAutomationDefinition(
  definition: AutomationDefinition,
): AutomationDefinitionDigest {
  const digest = NodeCrypto.createHash("sha256")
    .update(canonicalAutomationJson(definition), "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}
