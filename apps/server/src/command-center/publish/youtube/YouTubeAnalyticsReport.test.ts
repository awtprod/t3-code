import { describe, expect, it } from "@effect/vitest";

import {
  fetchYouTubeAnalyticsReport,
  parseYouTubeAnalyticsReport,
  validateYouTubeAnalyticsPeriod,
  YOUTUBE_ANALYTICS_MAX_RESPONSE_BYTES,
  type YouTubeAnalyticsReportRequest,
} from "./YouTubeAnalyticsReport.ts";

const request: YouTubeAnalyticsReportRequest = {
  channelId: "UC1234567890123456789012",
  videoId: "AbCdEf12345",
  startDate: "2026-09-01",
  endDate: "2026-09-07",
};
const columns = ["day", "views", "averageViewDuration", "averageViewPercentage"].map((name) => ({
  name,
  columnType: name === "day" ? "DIMENSION" : "METRIC",
  dataType: name === "day" ? "STRING" : "FLOAT",
}));

describe("YouTube Analytics report", () => {
  it("bounds a closed period and builds the owned-channel video query", async () => {
    expect(
      validateYouTubeAnalyticsPeriod(request, Date.parse("2026-09-10T00:00:00Z")),
    ).toBeUndefined();
    expect(
      validateYouTubeAnalyticsPeriod(
        { ...request, endDate: "2026-09-10" },
        Date.parse("2026-09-10T00:00:00Z"),
      ),
    ).toContain("closed period");
    expect(
      validateYouTubeAnalyticsPeriod(
        { ...request, endDate: "2026-10-02" },
        Date.parse("2026-11-01T00:00:00Z"),
      ),
    ).toContain("31 days");
    expect(
      validateYouTubeAnalyticsPeriod(
        { ...request, endDate: "2026-02-30" },
        Date.parse("2026-09-10T00:00:00Z"),
      ),
    ).toContain("invalid");
    expect(
      validateYouTubeAnalyticsPeriod(
        { ...request, startDate: "2026-09-08", endDate: "2026-09-09" },
        Date.parse("2026-09-10T02:00:00Z"),
      ),
    ).toContain("closed period");
    let calledUrl = "";
    const report = await fetchYouTubeAnalyticsReport({
      request,
      accessToken: "test-token",
      fetchImpl: async (input, init) => {
        calledUrl = String(input);
        expect(init?.headers).toEqual({ Authorization: "Bearer test-token" });
        return Response.json({
          kind: "youtubeAnalytics#resultTable",
          columnHeaders: columns,
          rows: [
            ["2026-09-01", 10, 12, 40],
            ["2026-09-03", 30, 20, 80],
          ],
        });
      },
    });
    const query = new URL(calledUrl).searchParams;
    expect(query.get("ids")).toBe(`channel==${request.channelId}`);
    expect(query.get("filters")).toBe(`video==${request.videoId}`);
    expect(query.get("metrics")).toBe("views,averageViewDuration,averageViewPercentage");
    expect(report).toEqual({
      views: 40,
      averageViewDurationSeconds: 18,
      averageViewPercentage: 70,
      freshThroughDate: "2026-09-03",
      status: "partial",
    });
  });

  it("uses column names, not positions, and keeps omitted rows missing rather than zero", () => {
    const reordered = parseYouTubeAnalyticsReport(
      {
        kind: "youtubeAnalytics#resultTable",
        columnHeaders: [columns[3], columns[0], columns[2], columns[1]],
        rows: [[60, "2026-09-07", 14, 5]],
      },
      request,
    );
    expect(reordered).toMatchObject({ views: 5, averageViewPercentage: 60, status: "complete" });
    expect(
      parseYouTubeAnalyticsReport(
        {
          kind: "youtubeAnalytics#resultTable",
          columnHeaders: columns,
        },
        request,
      ),
    ).toEqual({
      views: null,
      averageViewDurationSeconds: null,
      averageViewPercentage: null,
      freshThroughDate: null,
      status: "missing",
    });
  });

  it("rejects malformed rows, duplicate dates, and responses over the streaming bound", async () => {
    expect(() =>
      parseYouTubeAnalyticsReport(
        {
          kind: "youtubeAnalytics#resultTable",
          columnHeaders: columns,
          rows: [
            ["2026-09-01", 1, 10, 40],
            ["2026-09-01", 1, 10, 40],
          ],
        },
        request,
      ),
    ).toThrow("invalid day");
    expect(() =>
      parseYouTubeAnalyticsReport(
        {
          kind: "youtubeAnalytics#resultTable",
          columnHeaders: columns,
          rows: [["2026-09-01", -1, 10, 40]],
        },
        request,
      ),
    ).toThrow("invalid day");
    await expect(
      fetchYouTubeAnalyticsReport({
        request,
        accessToken: "test-token",
        fetchImpl: async () => new Response("x".repeat(YOUTUBE_ANALYTICS_MAX_RESPONSE_BYTES + 1)),
      }),
    ).rejects.toThrow("more data");
  });
});
