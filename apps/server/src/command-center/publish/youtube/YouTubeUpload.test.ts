// @effect-diagnostics preferSchemaOverJson:off nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";

import type { FetchLike } from "./YouTubeOAuth.ts";
import {
  nextOffsetFromRange,
  UPLOAD_CHUNK_GRANULARITY,
  uploadYouTubeVideoResumable,
  YouTubeUploadError,
  type YouTubeVideoMetadata,
} from "./YouTubeUpload.ts";

const CHUNK = UPLOAD_CHUNK_GRANULARITY;
const TOTAL = CHUNK * 2 + 1000;
const SESSION = "https://upload.test/session/abc";
const METADATA: YouTubeVideoMetadata = {
  snippet: { title: "Clip", categoryId: "22" },
  status: { privacyStatus: "private", selfDeclaredMadeForKids: false },
};
const VIDEO = {
  id: "vid123",
  snippet: { channelId: "UC1", channelTitle: "Chan" },
  status: { privacyStatus: "private", uploadStatus: "uploaded" },
};

let dir: string;
let filePath: string;
let fileBytes: Buffer;

beforeAll(async () => {
  dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "yt-upload-test-"));
  filePath = NodePath.join(dir, "clip.mp4");
  fileBytes = Buffer.alloc(TOTAL);
  for (let index = 0; index < TOTAL; index += 1) fileBytes[index] = index % 251;
  await NodeFSP.writeFile(filePath, fileBytes);
});

afterAll(async () => {
  await NodeFSP.rm(dir, { recursive: true, force: true });
});

interface Call {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Uint8Array | string | undefined;
}

type Reply = {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
};

/**
 * A fake resumable-upload server. It stores received bytes, answers 308/200 like YouTube, and lets
 * a test inject a scripted reply (or a thrown network error) for the Nth request.
 */
const fakeYouTube = (script: Record<number, Reply | "network-error"> = {}) => {
  const calls: Call[] = [];
  const received = Buffer.alloc(TOTAL);
  let committed = 0;
  const fetchImpl: FetchLike = async (input, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body as Uint8Array | string | undefined;
    calls.push({ method: init?.method ?? "GET", url: String(input), headers, body });
    const scripted = script[calls.length];
    if (scripted === "network-error") throw new TypeError("fetch failed");
    if (scripted !== undefined) {
      return new Response(scripted.body === undefined ? null : JSON.stringify(scripted.body), {
        status: scripted.status,
        headers: scripted.headers ?? {},
      });
    }
    if (init?.method === "POST") {
      return new Response(null, { status: 200, headers: { Location: SESSION } });
    }
    const range = headers["Content-Range"] ?? "";
    const chunk = /bytes (\d+)-(\d+)\/(\d+)/u.exec(range);
    if (chunk !== null && body instanceof Uint8Array) {
      const start = Number(chunk[1]);
      received.set(body, start);
      committed = Math.max(committed, start + body.byteLength);
    }
    if (committed >= TOTAL) return new Response(JSON.stringify(VIDEO), { status: 200 });
    return new Response(null, {
      status: 308,
      headers: committed === 0 ? {} : { Range: `bytes=0-${committed - 1}` },
    });
  };
  return { calls, fetchImpl, received: () => received };
};

const tokens = () => {
  const requests: boolean[] = [];
  return {
    requests,
    getAccessToken: async ({ forceRefresh }: { readonly forceRefresh: boolean }) => {
      requests.push(forceRefresh);
      return forceRefresh ? "token-2" : "token-1";
    },
  };
};

const noSleep = async () => {};

describe("uploadYouTubeVideoResumable", () => {
  it("parses 308 Range headers", () => {
    expect(nextOffsetFromRange("bytes=0-262143")).toBe(262_144);
    expect(nextOffsetFromRange(null)).toBe(0);
  });

  it("opens a session, streams chunks through 308s, and returns the video", async () => {
    const server = fakeYouTube();
    const progress: number[] = [];
    const video = await uploadYouTubeVideoResumable({
      filePath,
      metadata: METADATA,
      contentType: "video/mp4",
      chunkSize: CHUNK + 1234, // rounded down to a 256 KiB multiple
      fetchImpl: server.fetchImpl,
      endpoint: "https://upload.test/videos",
      getAccessToken: tokens().getAccessToken,
      sleep: noSleep,
      onProgress: (uploaded) => progress.push(uploaded),
    });
    expect(video).toEqual({
      id: "vid123",
      channelId: "UC1",
      channelTitle: "Chan",
      privacyStatus: "private",
      uploadStatus: "uploaded",
    });

    const [init, ...puts] = server.calls;
    expect(init?.method).toBe("POST");
    const initUrl = new URL(init?.url ?? "");
    expect(initUrl.searchParams.get("uploadType")).toBe("resumable");
    expect(initUrl.searchParams.get("part")).toBe("snippet,status");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer token-1",
      "X-Upload-Content-Length": String(TOTAL),
      "X-Upload-Content-Type": "video/mp4",
    });
    expect(JSON.parse(String(init?.body))).toEqual(METADATA);

    expect(puts.map((call) => [call.url, call.headers["Content-Range"]])).toEqual([
      [SESSION, `bytes 0-${CHUNK - 1}/${TOTAL}`],
      [SESSION, `bytes ${CHUNK}-${2 * CHUNK - 1}/${TOTAL}`],
      [SESSION, `bytes ${2 * CHUNK}-${TOTAL - 1}/${TOTAL}`],
    ]);
    expect(server.received().equals(fileBytes)).toBe(true);
    expect(progress).toEqual([CHUNK, 2 * CHUNK, TOTAL]);
  });

  it("recovers from a failed chunk by querying the session and resuming", async () => {
    // Call 3 (second chunk) gets a 503; call 4 must be a status query; the upload then resumes.
    const server = fakeYouTube({ 3: { status: 503 } });
    const sleeps: number[] = [];
    const video = await uploadYouTubeVideoResumable({
      filePath,
      metadata: METADATA,
      chunkSize: CHUNK,
      fetchImpl: server.fetchImpl,
      getAccessToken: tokens().getAccessToken,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(video.id).toBe("vid123");
    const ranges = server.calls.slice(1).map((call) => call.headers["Content-Range"]);
    expect(ranges).toEqual([
      `bytes 0-${CHUNK - 1}/${TOTAL}`,
      `bytes ${CHUNK}-${2 * CHUNK - 1}/${TOTAL}`, // 503
      `bytes */${TOTAL}`, // status query -> 308 Range: bytes=0-(CHUNK-1)
      `bytes ${CHUNK}-${2 * CHUNK - 1}/${TOTAL}`, // resent
      `bytes ${2 * CHUNK}-${TOTAL - 1}/${TOTAL}`,
    ]);
    expect(server.calls[3]?.headers["Content-Length"]).toBe("0");
    expect(sleeps).toHaveLength(1);
    expect(server.received().equals(fileBytes)).toBe(true);
  });

  it("resumes after a network error and refreshes the token after a 401", async () => {
    const server = fakeYouTube({ 2: "network-error", 4: { status: 401 } });
    const auth = tokens();
    const video = await uploadYouTubeVideoResumable({
      filePath,
      metadata: METADATA,
      chunkSize: CHUNK,
      fetchImpl: server.fetchImpl,
      getAccessToken: auth.getAccessToken,
      sleep: noSleep,
    });
    expect(video.id).toBe("vid123");
    expect(auth.requests).toEqual([false, true]);
    expect(server.calls.at(-1)?.headers.Authorization).toBe("Bearer token-2");
    expect(server.received().equals(fileBytes)).toBe(true);
  });

  it("fails as ambiguous once retries are exhausted", async () => {
    const server = fakeYouTube({ 2: { status: 503 }, 3: { status: 503 }, 4: { status: 503 } });
    const error = await uploadYouTubeVideoResumable({
      filePath,
      metadata: METADATA,
      chunkSize: CHUNK,
      maxRetries: 2,
      fetchImpl: server.fetchImpl,
      getAccessToken: tokens().getAccessToken,
      sleep: noSleep,
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(YouTubeUploadError);
    expect((error as YouTubeUploadError).kind).toBe("ambiguous");
    expect((error as YouTubeUploadError).message).toContain("check YouTube Studio");
  });

  it("surfaces quota exhaustion without retrying", async () => {
    const server = fakeYouTube({
      1: {
        status: 403,
        body: { error: { message: "quota", errors: [{ reason: "quotaExceeded" }] } },
      },
    });
    const error = await uploadYouTubeVideoResumable({
      filePath,
      metadata: METADATA,
      fetchImpl: server.fetchImpl,
      getAccessToken: tokens().getAccessToken,
      sleep: noSleep,
    }).catch((cause: unknown) => cause);
    expect((error as YouTubeUploadError).kind).toBe("quota");
    expect(server.calls).toHaveLength(1);
  });

  it("reports an expired upload session as ambiguous", async () => {
    const server = fakeYouTube({ 3: { status: 404 } });
    const error = await uploadYouTubeVideoResumable({
      filePath,
      metadata: METADATA,
      chunkSize: CHUNK,
      fetchImpl: server.fetchImpl,
      getAccessToken: tokens().getAccessToken,
      sleep: noSleep,
    }).catch((cause: unknown) => cause);
    expect((error as YouTubeUploadError).kind).toBe("ambiguous");
    expect((error as YouTubeUploadError).status).toBe(404);
  });

  it("rejects a missing file before contacting YouTube", async () => {
    const server = fakeYouTube();
    const error = await uploadYouTubeVideoResumable({
      filePath: NodePath.join(dir, "missing.mp4"),
      metadata: METADATA,
      fetchImpl: server.fetchImpl,
      getAccessToken: tokens().getAccessToken,
    }).catch((cause: unknown) => cause);
    expect((error as YouTubeUploadError).kind).toBe("file");
    expect(server.calls).toHaveLength(0);
  });
});
