import type {
  CommandCenterResponsibilityDetail,
  CommandCenterResponsibilityStatus,
} from "@t3tools/contracts";

function receiptApplies(
  current: CommandCenterResponsibilityStatus,
  receipt: CommandCenterResponsibilityStatus | null,
): receipt is CommandCenterResponsibilityStatus {
  return (
    receipt !== null &&
    receipt.spaceId === current.spaceId &&
    receipt.automationId === current.automationId &&
    receipt.pauseVersion > current.pauseVersion
  );
}

export function withResponsibilityReceipt(
  current: readonly CommandCenterResponsibilityStatus[],
  receipt: CommandCenterResponsibilityStatus | null,
): readonly CommandCenterResponsibilityStatus[] {
  return current.map((item) => (receiptApplies(item, receipt) ? receipt : item));
}

export function withResponsibilityDetailReceipt(
  detail: CommandCenterResponsibilityDetail | null,
  receipt: CommandCenterResponsibilityStatus | null,
): CommandCenterResponsibilityDetail | null {
  if (detail === null || !receiptApplies(detail, receipt)) return detail;
  return { ...detail, ...receipt };
}
