import type { CapabilityName } from "@command-center/core";
import type { GoogleDraftCreateRequest, GoogleReadRequest } from "@t3tools/contracts";

export type GoogleReadCapability =
  | "cc.connections.google.gmail.read"
  | "cc.connections.google.calendar.read"
  | "cc.connections.google.drive.read";

export type GoogleCapability = GoogleReadCapability | "cc.connections.google.gmail.drafts.create";

export const GOOGLE_READ_CAPABILITIES: ReadonlyArray<GoogleReadCapability> = [
  "cc.connections.google.gmail.read",
  "cc.connections.google.calendar.read",
  "cc.connections.google.drive.read",
];

const CONFIG_CAPABILITIES: Readonly<Record<string, GoogleCapability>> = {
  "gmail.read": "cc.connections.google.gmail.read",
  "gmail.drafts.create": "cc.connections.google.gmail.drafts.create",
  "calendar.read": "cc.connections.google.calendar.read",
  "drive.read": "cc.connections.google.drive.read",
};

export const googleCapabilitiesFromConfig = (
  capabilities: ReadonlyArray<string>,
): ReadonlyArray<GoogleCapability> =>
  [...new Set(capabilities.map((capability) => CONFIG_CAPABILITIES[capability]))].filter(
    (capability): capability is GoogleCapability => capability !== undefined,
  );

export const expandLegacyGoogleCapabilities = (
  capabilities: ReadonlyArray<CapabilityName>,
): ReadonlyArray<CapabilityName> => {
  if (!capabilities.includes("cc.connections.google.read")) return capabilities;
  return [
    ...new Set([
      ...capabilities.filter((capability) => capability !== "cc.connections.google.read"),
      ...GOOGLE_READ_CAPABILITIES,
    ]),
  ];
};

export const googleCapabilityForOperation = (
  operation: GoogleReadRequest["operation"],
): GoogleReadCapability => {
  if (operation.startsWith("gmail.")) return "cc.connections.google.gmail.read";
  if (operation.startsWith("calendar.")) return "cc.connections.google.calendar.read";
  return "cc.connections.google.drive.read";
};

export const googleCapabilityForDraft = (
  _operation: GoogleDraftCreateRequest["operation"],
): GoogleCapability => "cc.connections.google.gmail.drafts.create";

export const hasAnyGoogleReadCapability = (capabilities: ReadonlyArray<CapabilityName>): boolean =>
  GOOGLE_READ_CAPABILITIES.some((capability) => capabilities.includes(capability));
