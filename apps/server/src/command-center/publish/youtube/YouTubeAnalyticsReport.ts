// @effect-diagnostics globalFetch:off preferSchemaOverJson:off globalDate:off globalTimers:off
import type { FetchLike } from "./YouTubeOAuth.ts";

const YOUTUBE_ANALYTICS_REPORT_ENDPOINT = "https://youtubeanalytics.googleapis.com/v2/reports";
export const YOUTUBE_ANALYTICS_MAX_RESPONSE_BYTES = 64 * 1024;
const YOUTUBE_ANALYTICS_TIMEOUT_MS = 10_000;
const YOUTUBE_ANALYTICS_MAX_DAYS = 31;

export class YouTubeAnalyticsReportError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "YouTubeAnalyticsReportError";
    this.status = status;
  }
}

export interface YouTubeAnalyticsReportRequest {
  readonly channelId: string;
  readonly videoId: string;
  readonly startDate: string;
  readonly endDate: string;
}

export interface YouTubeAnalyticsReport {
  readonly views: number | null;
  readonly averageViewDurationSeconds: number | null;
  readonly averageViewPercentage: number | null;
  readonly freshThroughDate: string | null;
  readonly status: "complete" | "partial" | "missing";
}

const reportError = (message: string, status?: number) =>
  new YouTubeAnalyticsReportError(message, status);

export function validateYouTubeAnalyticsPeriod(
  request: YouTubeAnalyticsReportRequest,
  nowMs: number,
): string | undefined {
  if (!/^UC[A-Za-z0-9_-]{22}$/u.test(request.channelId)) return "Enter a YouTube channel ID.";
  if (!/^[A-Za-z0-9_-]{11}$/u.test(request.videoId)) return "Enter a YouTube video ID.";
  const start = Date.parse(`${request.startDate}T00:00:00.000Z`);
  const end = Date.parse(`${request.endDate}T00:00:00.000Z`);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    new Date(start).toISOString().slice(0, 10) !== request.startDate ||
    new Date(end).toISOString().slice(0, 10) !== request.endDate ||
    start > end
  ) {
    return "The Analytics date range is invalid.";
  }
  if (end - start >= YOUTUBE_ANALYTICS_MAX_DAYS * 86_400_000) {
    return `Analytics requests may cover at most ${YOUTUBE_ANALYTICS_MAX_DAYS} days.`;
  }
  const pacificDate = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const part = (type: string) => pacificDate.find((value) => value.type === type)?.value ?? "";
  const today = `${part("year")}-${part("month")}-${part("day")}`;
  if (request.endDate >= today) return "Choose a closed period ending before today.";
  return undefined;
}

function youtubeAnalyticsReportUrl(request: YouTubeAnalyticsReportRequest): URL {
  const url = new URL(YOUTUBE_ANALYTICS_REPORT_ENDPOINT);
  url.searchParams.set("ids", `channel==${request.channelId}`);
  url.searchParams.set("startDate", request.startDate);
  url.searchParams.set("endDate", request.endDate);
  url.searchParams.set("metrics", "views,averageViewDuration,averageViewPercentage");
  url.searchParams.set("dimensions", "day");
  url.searchParams.set("filters", `video==${request.videoId}`);
  url.searchParams.set("sort", "day");
  url.searchParams.set("maxResults", String(YOUTUBE_ANALYTICS_MAX_DAYS + 1));
  url.searchParams.set("prettyPrint", "false");
  return url;
}

async function readBounded(response: Response): Promise<unknown> {
  if (response.body === null) throw reportError("YouTube returned an empty Analytics response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > YOUTUBE_ANALYTICS_MAX_RESPONSE_BYTES) {
        throw reportError("YouTube Analytics returned more data than this request allows.");
      }
      chunks.push(result.value);
    }
  } catch (cause) {
    await reader.cancel().catch(() => undefined);
    throw cause;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw reportError("YouTube Analytics returned invalid JSON.");
  }
}

const recordOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export function parseYouTubeAnalyticsReport(
  raw: unknown,
  request: YouTubeAnalyticsReportRequest,
): YouTubeAnalyticsReport {
  const table = recordOf(raw);
  if (table?.kind !== "youtubeAnalytics#resultTable" || !Array.isArray(table.columnHeaders)) {
    throw reportError("YouTube Analytics returned an unexpected report shape.");
  }
  const headers = table.columnHeaders.map((value) => recordOf(value)?.name);
  if (
    headers.length !== 4 ||
    new Set(headers).size !== 4 ||
    !["day", "views", "averageViewDuration", "averageViewPercentage"].every((name) =>
      headers.includes(name),
    )
  ) {
    throw reportError("YouTube Analytics returned unexpected report columns.");
  }
  const rows = table.rows === undefined ? [] : table.rows;
  if (!Array.isArray(rows) || rows.length > YOUTUBE_ANALYTICS_MAX_DAYS) {
    throw reportError("YouTube Analytics returned too many or malformed rows.");
  }
  if (rows.length === 0) {
    return {
      views: null,
      averageViewDurationSeconds: null,
      averageViewPercentage: null,
      freshThroughDate: null,
      status: "missing",
    };
  }
  const index = (name: string) => headers.indexOf(name);
  const seen = new Set<string>();
  let views = 0;
  let weightedDuration = 0;
  let weightedPercentage = 0;
  let freshThroughDate: string | null = null;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== headers.length) {
      throw reportError("YouTube Analytics returned a malformed row.");
    }
    const day = row[index("day")];
    const count = row[index("views")];
    const duration = row[index("averageViewDuration")];
    const percentage = row[index("averageViewPercentage")];
    if (
      typeof day !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(day) ||
      day < request.startDate ||
      day > request.endDate ||
      seen.has(day) ||
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      typeof duration !== "number" ||
      !Number.isFinite(duration) ||
      duration < 0 ||
      typeof percentage !== "number" ||
      !Number.isFinite(percentage) ||
      percentage < 0
    ) {
      throw reportError("YouTube Analytics returned an invalid day or metric.");
    }
    seen.add(day);
    views += count;
    if (!Number.isSafeInteger(views)) throw reportError("YouTube Analytics view count overflowed.");
    weightedDuration += duration * count;
    weightedPercentage += percentage * count;
    freshThroughDate =
      freshThroughDate === null || day > String(freshThroughDate) ? day : freshThroughDate;
  }
  return {
    views,
    averageViewDurationSeconds: views === 0 ? null : weightedDuration / views,
    averageViewPercentage: views === 0 ? null : weightedPercentage / views,
    freshThroughDate,
    status: freshThroughDate === request.endDate ? "complete" : "partial",
  };
}

export async function fetchYouTubeAnalyticsReport(input: {
  readonly request: YouTubeAnalyticsReportRequest;
  readonly accessToken: string;
  readonly fetchImpl?: FetchLike;
  readonly signal?: AbortSignal;
  readonly endpoint?: string;
}): Promise<YouTubeAnalyticsReport> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), YOUTUBE_ANALYTICS_TIMEOUT_MS);
  const abort = () => controller.abort();
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (input.signal?.aborted) controller.abort();
    const url = youtubeAnalyticsReportUrl(input.request);
    if (input.endpoint !== undefined) {
      const replacement = new URL(input.endpoint);
      replacement.search = url.search;
      url.href = replacement.href;
    }
    const response = await (input.fetchImpl ?? fetch)(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${input.accessToken}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw reportError(
        response.status === 401
          ? "YouTube Analytics authorization expired. Reconnect YouTube."
          : response.status === 403
            ? "This account cannot read Analytics for the requested channel, or the Analytics API is unavailable."
            : `YouTube Analytics returned HTTP ${response.status}.`,
        response.status,
      );
    }
    return parseYouTubeAnalyticsReport(await readBounded(response), input.request);
  } catch (cause) {
    if (cause instanceof YouTubeAnalyticsReportError) throw cause;
    throw reportError(
      controller.signal.aborted
        ? "YouTube Analytics timed out or was cancelled."
        : "YouTube Analytics could not be reached.",
    );
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abort);
  }
}
