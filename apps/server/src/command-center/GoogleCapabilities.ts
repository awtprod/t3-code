import type { CapabilityName } from "@command-center/core";
import type { GoogleReadRequest } from "@t3tools/contracts";

export type GoogleReadCapability =
  | "cc.connections.google.gmail.read"
  | "cc.connections.google.calendar.read"
  | "cc.connections.google.drive.read";

export const GOOGLE_READ_CAPABILITIES: ReadonlyArray<GoogleReadCapability> = [
  "cc.connections.google.gmail.read",
  "cc.connections.google.calendar.read",
  "cc.connections.google.drive.read",
];

const CONFIG_CAPABILITIES: Readonly<Record<string, GoogleReadCapability>> = {
  "gmail.read": "cc.connections.google.gmail.read",
  "calendar.read": "cc.connections.google.calendar.read",
  "drive.read": "cc.connections.google.drive.read",
};

export const googleCapabilitiesFromConfig = (
  capabilities: ReadonlyArray<string>,
): ReadonlyArray<GoogleReadCapability> =>
  [...new Set(capabilities.map((capability) => CONFIG_CAPABILITIES[capability]))].filter(
    (capability): capability is GoogleReadCapability => capability !== undefined,
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

export const hasAnyGoogleReadCapability = (capabilities: ReadonlyArray<CapabilityName>): boolean =>
  GOOGLE_READ_CAPABILITIES.some((capability) => capabilities.includes(capability));
