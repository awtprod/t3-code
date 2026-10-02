import { isValidAutomationTimeZone } from "@t3tools/shared/automationSchedule";

function parts(at: Date, timezone: string) {
  const entries = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    entries.find((entry) => entry.type === type)?.value ?? "";
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    clock: `${value("hour")}:${value("minute")}`,
  };
}

function utcStartOfLocalDate(localDate: string, timezone: string): string {
  const [year, month, day] = localDate.split("-").map(Number);
  const approximate = Date.UTC(year!, month! - 1, day!);
  let low = approximate - 36 * 60 * 60 * 1_000;
  let high = approximate + 36 * 60 * 60 * 1_000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2_000) * 1_000;
    // @effect-diagnostics-next-line globalDate:off -- Intl requires a native Date at the time-zone boundary.
    if (parts(new Date(middle), timezone).date < localDate) low = middle + 1_000;
    else high = middle;
  }
  // @effect-diagnostics-next-line globalDate:off -- Intl requires a native Date at the time-zone boundary.
  if (parts(new Date(low), timezone).date !== localDate) {
    throw new Error(`Local day ${localDate} does not exist in ${timezone}.`);
  }
  // @effect-diagnostics-next-line globalDate:off -- native ISO output preserves the exact UTC boundary.
  return new Date(low).toISOString();
}

export function digestPeriod(at: string, timezone: string) {
  // @effect-diagnostics-next-line globalDate:off -- Intl requires a native Date for local calendar parts.
  const instant = new Date(at);
  if (Number.isNaN(instant.getTime()) || !isValidAutomationTimeZone(timezone)) {
    throw new Error("The digest instant or time zone is invalid.");
  }
  const localDate = parts(instant, timezone).date;
  const [year, month, day] = localDate.split("-").map(Number);
  // @effect-diagnostics-next-line globalDate:off -- UTC calendar arithmetic is used only to advance the local date label.
  const nextLocalDate = new Date(Date.UTC(year!, month! - 1, day! + 1)).toISOString().slice(0, 10);
  return {
    localDate,
    timezone,
    startAt: utcStartOfLocalDate(localDate, timezone),
    endAt: utcStartOfLocalDate(nextLocalDate, timezone),
  };
}

export function isDigestQuietHour(
  at: string,
  timezone: string,
  quietStart: string | null,
  quietEnd: string | null,
): boolean {
  if (quietStart === null || quietEnd === null) return false;
  // @effect-diagnostics-next-line globalDate:off -- Intl requires a native Date for local clock parts.
  const clock = parts(new Date(at), timezone).clock;
  return quietStart < quietEnd
    ? clock >= quietStart && clock < quietEnd
    : clock >= quietStart || clock < quietEnd;
}
