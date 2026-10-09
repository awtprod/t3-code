// @effect-diagnostics globalFetch:off globalTimers:off preferSchemaOverJson:off nodeBuiltinImport:off - chunked positional reads of multi-GB files are a Node filesystem boundary.
/**
 * Resumable `videos.insert` upload, dependency-free.
 * Protocol: https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
 *
 *   1. POST .../upload/youtube/v3/videos?uploadType=resumable&part=snippet,status with the JSON
 *      metadata -> the `Location` header is the upload session URI.
 *   2. PUT the file in chunks (multiples of 256 KiB) with `Content-Range: bytes a-b/total`.
 *      308 Resume Incomplete + `Range: bytes=0-N` means "next byte is N+1"; 200/201 carries the
 *      created video resource.
 *   3. On a 5xx / network failure, ask the session where it is (`Content-Range: bytes * /total`,
 *      empty body) and resume from there with backoff. A 401 fetches a fresh access token.
 *
 * Only one chunk is held in memory at a time, so multi-GB files are fine.
 */
import * as NodeFSP from "node:fs/promises";

import type { FetchLike } from "./YouTubeOAuth.ts";

export const YOUTUBE_UPLOAD_ENDPOINT = "https://www.googleapis.com/upload/youtube/v3/videos";
/** Chunk sizes must be multiples of 256 KiB (except the final chunk). */
export const UPLOAD_CHUNK_GRANULARITY = 256 * 1024;
export const DEFAULT_UPLOAD_CHUNK_SIZE = 32 * UPLOAD_CHUNK_GRANULARITY; // 8 MiB
export const DEFAULT_UPLOAD_MAX_RETRIES = 6;

export type YouTubePrivacyStatus = "private" | "unlisted" | "public";

export interface YouTubeVideoMetadata {
  readonly snippet: {
    readonly title: string;
    readonly description?: string;
    readonly tags?: ReadonlyArray<string>;
    readonly categoryId?: string;
  };
  readonly status: {
    readonly privacyStatus: YouTubePrivacyStatus;
    readonly selfDeclaredMadeForKids: boolean;
    readonly publishAt?: string;
  };
}

export interface YouTubeUploadedVideo {
  readonly id: string;
  readonly channelId: string | undefined;
  readonly channelTitle: string | undefined;
  readonly privacyStatus: string | undefined;
  readonly uploadStatus: string | undefined;
}

export type YouTubeUploadErrorKind =
  /** Google refused the request (4xx other than 401/404 session loss). Do not retry. */
  | "rejected"
  /** Daily quota exhausted. */
  | "quota"
  /** Retries exhausted mid-upload; the video may or may not exist. Check YouTube before retrying. */
  | "ambiguous"
  /** The local file could not be read. */
  | "file";

export class YouTubeUploadError extends Error {
  readonly kind: YouTubeUploadErrorKind;
  readonly status: number | undefined;
  constructor(kind: YouTubeUploadErrorKind, message: string, status?: number) {
    super(message);
    this.name = "YouTubeUploadError";
    this.kind = kind;
    this.status = status;
  }
}

export interface YouTubeResumableUploadInput {
  readonly filePath: string;
  readonly metadata: YouTubeVideoMetadata;
  /** Returns a valid access token; `forceRefresh` is set after a 401. */
  readonly getAccessToken: (options: { readonly forceRefresh: boolean }) => Promise<string>;
  readonly contentType?: string;
  readonly chunkSize?: number;
  readonly maxRetries?: number;
  readonly fetchImpl?: FetchLike;
  readonly endpoint?: string;
  /** Backoff sleep; injectable for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onProgress?: (uploadedBytes: number, totalBytes: number) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Next byte offset from a 308 `Range: bytes=0-N` header (0 when absent). */
export function nextOffsetFromRange(range: string | null): number {
  const match = range === null ? null : /bytes=0-(\d+)/u.exec(range);
  return match?.[1] === undefined ? 0 : Number(match[1]) + 1;
}

const isRetryableStatus = (status: number) =>
  status === 500 || status === 502 || status === 503 || status === 504 || status === 429;

async function googleErrorReason(response: Response): Promise<{
  readonly reason: string | undefined;
  readonly message: string | undefined;
}> {
  const body: unknown = await response.json().catch(() => undefined);
  const error =
    typeof body === "object" && body !== null
      ? (body as { error?: { message?: unknown; errors?: Array<{ reason?: unknown }> } }).error
      : undefined;
  const reason = error?.errors?.[0]?.reason;
  return {
    reason: typeof reason === "string" ? reason : undefined,
    message: typeof error?.message === "string" ? error.message.slice(0, 300) : undefined,
  };
}

async function failureFor(response: Response, action: string): Promise<YouTubeUploadError> {
  const { reason, message } = await googleErrorReason(response);
  if (reason === "quotaExceeded" || reason === "uploadLimitExceeded") {
    return new YouTubeUploadError(
      "quota",
      reason === "quotaExceeded"
        ? "The daily YouTube API quota is used up. Uploads work again after the quota resets (midnight Pacific)."
        : "This YouTube channel reached its upload limit. Try again later.",
      response.status,
    );
  }
  return new YouTubeUploadError(
    "rejected",
    `YouTube rejected the ${action} (HTTP ${response.status}${reason ? `, ${reason}` : ""})${message ? `: ${message}` : "."}`,
    response.status,
  );
}

function parseVideo(body: unknown): YouTubeUploadedVideo | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const video = body as {
    id?: unknown;
    snippet?: { channelId?: unknown; channelTitle?: unknown };
    status?: { privacyStatus?: unknown; uploadStatus?: unknown };
  };
  if (typeof video.id !== "string" || video.id.length === 0) return undefined;
  const str = (value: unknown) => (typeof value === "string" ? value : undefined);
  return {
    id: video.id,
    channelId: str(video.snippet?.channelId),
    channelTitle: str(video.snippet?.channelTitle),
    privacyStatus: str(video.status?.privacyStatus),
    uploadStatus: str(video.status?.uploadStatus),
  };
}

/** Run a full resumable upload of `filePath` and return the created video. */
export async function uploadYouTubeVideoResumable(
  input: YouTubeResumableUploadInput,
): Promise<YouTubeUploadedVideo> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleep = input.sleep ?? defaultSleep;
  const maxRetries = input.maxRetries ?? DEFAULT_UPLOAD_MAX_RETRIES;
  const requestedChunk = input.chunkSize ?? DEFAULT_UPLOAD_CHUNK_SIZE;
  const chunkSize = Math.max(
    UPLOAD_CHUNK_GRANULARITY,
    Math.floor(requestedChunk / UPLOAD_CHUNK_GRANULARITY) * UPLOAD_CHUNK_GRANULARITY,
  );
  const contentType = input.contentType ?? "video/*";

  let file: NodeFSP.FileHandle;
  let totalBytes: number;
  try {
    file = await NodeFSP.open(input.filePath, "r");
    totalBytes = (await file.stat()).size;
  } catch {
    throw new YouTubeUploadError("file", `The video file ${input.filePath} could not be opened.`);
  }
  try {
    if (totalBytes === 0) {
      throw new YouTubeUploadError("file", `The video file ${input.filePath} is empty.`);
    }

    let accessToken = await input.getAccessToken({ forceRefresh: false });
    let failures = 0;
    /** Returns after a retryable failure's backoff, or throws once retries are exhausted. */
    const backoff = async (detail: string) => {
      failures += 1;
      if (failures > maxRetries) {
        throw new YouTubeUploadError(
          "ambiguous",
          `The YouTube upload was interrupted (${detail}) and could not be resumed. The video may or may not have been created; check YouTube Studio before retrying.`,
        );
      }
      await sleep(Math.min(1000 * 2 ** (failures - 1), 32_000));
    };
    const reauthorize = async () => {
      accessToken = await input.getAccessToken({ forceRefresh: true });
    };

    // 1. Open the session.
    let sessionUri: string | undefined;
    let reauthorizedStart = false;
    while (sessionUri === undefined) {
      const url = new URL(input.endpoint ?? YOUTUBE_UPLOAD_ENDPOINT);
      url.searchParams.set("uploadType", "resumable");
      url.searchParams.set("part", "snippet,status");
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Length": String(totalBytes),
            "X-Upload-Content-Type": contentType,
          },
          body: JSON.stringify(input.metadata),
        });
      } catch {
        await backoff("network error starting the upload");
        continue;
      }
      if (response.ok) {
        const location = response.headers.get("location");
        if (location === null) {
          throw new YouTubeUploadError(
            "rejected",
            "YouTube did not return an upload session address.",
          );
        }
        sessionUri = location;
      } else if (response.status === 401 && !reauthorizedStart) {
        reauthorizedStart = true;
        await reauthorize();
      } else if (isRetryableStatus(response.status)) {
        await backoff(`HTTP ${response.status} starting the upload`);
      } else {
        throw await failureFor(response, "upload request");
      }
    }

    // 2. Send chunks; after any hiccup, ask the session how far it got.
    let offset = 0;
    let needsStatusCheck = false;
    while (true) {
      let response: Response;
      try {
        if (needsStatusCheck) {
          response = await fetchImpl(sessionUri, {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Length": "0",
              "Content-Range": `bytes */${totalBytes}`,
            },
          });
        } else {
          const length = Math.min(chunkSize, totalBytes - offset);
          const buffer = Buffer.allocUnsafe(length);
          let read = 0;
          try {
            while (read < length) {
              const { bytesRead } = await file.read(buffer, read, length - read, offset + read);
              if (bytesRead === 0) break;
              read += bytesRead;
            }
          } catch {
            throw new YouTubeUploadError(
              "file",
              `The video file ${input.filePath} could not be read.`,
            );
          }
          if (read !== length) {
            throw new YouTubeUploadError(
              "file",
              `The video file ${input.filePath} changed during upload.`,
            );
          }
          response = await fetchImpl(sessionUri, {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Length": String(length),
              "Content-Range": `bytes ${offset}-${offset + length - 1}/${totalBytes}`,
              "Content-Type": contentType,
            },
            body: buffer,
          });
        }
      } catch (cause) {
        if (cause instanceof YouTubeUploadError) throw cause;
        await backoff("network error");
        needsStatusCheck = true;
        continue;
      }

      if (response.status === 200 || response.status === 201) {
        const video = parseVideo(await response.json().catch(() => undefined));
        if (video === undefined) {
          throw new YouTubeUploadError(
            "ambiguous",
            "YouTube finished the upload but returned no video id. Check YouTube Studio.",
            response.status,
          );
        }
        input.onProgress?.(totalBytes, totalBytes);
        return video;
      }
      if (response.status === 308) {
        offset = nextOffsetFromRange(response.headers.get("range"));
        needsStatusCheck = false;
        failures = 0;
        input.onProgress?.(offset, totalBytes);
        continue;
      }
      if (response.status === 401) {
        await backoff("access token expired");
        await reauthorize();
        needsStatusCheck = true;
        continue;
      }
      if (response.status === 404 || response.status === 410) {
        throw new YouTubeUploadError(
          "ambiguous",
          "The YouTube upload session expired before the upload finished. Check YouTube Studio, then publish again.",
          response.status,
        );
      }
      if (isRetryableStatus(response.status)) {
        await backoff(`HTTP ${response.status}`);
        needsStatusCheck = true;
        continue;
      }
      throw await failureFor(response, "video upload");
    }
  } finally {
    await file.close().catch(() => undefined);
  }
}
