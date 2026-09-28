import { CommandCenterError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { FetchLike } from "./YouTubeOAuth.ts";
import { YouTubeTokenStore } from "./YouTubeTokenStore.ts";
import {
  uploadYouTubeVideoResumable,
  YouTubeUploadError,
  type YouTubePrivacyStatus,
  type YouTubeVideoMetadata,
} from "./YouTubeUpload.ts";

/**
 * Publish a finished clip already on this environment's disk to the connected YouTube channel.
 * Shorts use the same `videos.insert` call: YouTube classifies vertical videos up to 3 minutes as
 * Shorts on its own, so `short: true` only adds the `#Shorts` hint to the description.
 *
 * Uploads from an unverified Google Cloud app are locked to Private by YouTube, so the default
 * privacy is `private`.
 */

export interface YouTubePublishInput {
  /** Absolute path of the video on this environment's filesystem. */
  readonly filePath: string;
  readonly title: string;
  readonly description?: string;
  readonly tags?: ReadonlyArray<string>;
  /** Defaults to `private`. */
  readonly privacyStatus?: YouTubePrivacyStatus;
  /** ISO timestamp for a scheduled release. Requires `privacyStatus: "private"`. */
  readonly publishAt?: string;
  /** YouTube category id; defaults to "22" (People & Blogs). */
  readonly categoryId?: string;
  readonly madeForKids?: boolean;
  readonly short?: boolean;
  readonly contentType?: string;
}

export interface YouTubePublishResult {
  readonly videoId: string;
  readonly url: string;
  readonly privacyStatus: string;
  readonly channelId?: string;
}

interface YouTubePublishShape {
  readonly publish: (
    input: YouTubePublishInput,
  ) => Effect.Effect<YouTubePublishResult, CommandCenterError>;
}

export class YouTubePublish extends Context.Service<YouTubePublish, YouTubePublishShape>()(
  "@awtprod/command-center/command-center/publish/youtube/YouTubePublish",
) {}

export const DEFAULT_YOUTUBE_CATEGORY_ID = "22";
const TITLE_MAX = 100;
const DESCRIPTION_MAX = 5000;
const TAGS_TOTAL_MAX = 500;
const SHORTS_HINT = "#Shorts";

const isCommandCenterError = Schema.is(CommandCenterError);

const validation = (message: string) => new CommandCenterError({ reason: "validation", message });

/** Validate publish input and build the `videos.insert` body. Returns an error message on failure. */
export function buildYouTubeVideoMetadata(
  input: YouTubePublishInput,
  nowMs: number,
): YouTubeVideoMetadata | string {
  const title = input.title.trim();
  if (title.length === 0) return "A YouTube title is required.";
  if (title.length > TITLE_MAX) return `YouTube titles are limited to ${TITLE_MAX} characters.`;
  let description = input.description?.trim() ?? "";
  if (input.short === true && !/#shorts\b/iu.test(`${title} ${description}`)) {
    description = description.length === 0 ? SHORTS_HINT : `${description}\n\n${SHORTS_HINT}`;
  }
  if (description.length > DESCRIPTION_MAX) {
    return `YouTube descriptions are limited to ${DESCRIPTION_MAX} characters.`;
  }
  if (/[<>]/u.test(title) || /[<>]/u.test(description)) {
    return "YouTube does not allow < or > in titles or descriptions.";
  }
  const tags = (input.tags ?? []).map((tag) => tag.trim()).filter((tag) => tag.length > 0);
  if (tags.join(",").length > TAGS_TOTAL_MAX) {
    return `YouTube tags are limited to ${TAGS_TOTAL_MAX} characters in total.`;
  }
  const privacyStatus = input.privacyStatus ?? "private";
  let publishAt: string | undefined;
  if (input.publishAt !== undefined) {
    const at = Date.parse(input.publishAt);
    if (!Number.isFinite(at)) return "The scheduled publish time is not a valid date.";
    if (at <= nowMs) return "The scheduled publish time must be in the future.";
    if (privacyStatus !== "private") {
      return "Scheduled YouTube videos must be uploaded as private; YouTube makes them public at the scheduled time.";
    }
    publishAt = DateTime.formatIso(DateTime.makeUnsafe(at));
  }
  return {
    snippet: {
      title,
      ...(description.length === 0 ? {} : { description }),
      ...(tags.length === 0 ? {} : { tags }),
      categoryId: input.categoryId ?? DEFAULT_YOUTUBE_CATEGORY_ID,
    },
    status: {
      privacyStatus,
      selfDeclaredMadeForKids: input.madeForKids ?? false,
      ...(publishAt === undefined ? {} : { publishAt }),
    },
  };
}

export interface YouTubePublishOptions {
  readonly fetchImpl?: FetchLike;
  readonly uploadEndpoint?: string;
  readonly chunkSize?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export const make = Effect.fn("YouTubePublish.make")(function* (
  options: YouTubePublishOptions = {},
) {
  const tokens = yield* YouTubeTokenStore;
  const context = yield* Effect.context<never>();
  const runExit = Effect.runPromiseExitWith(context);

  const getAccessToken = async ({ forceRefresh }: { readonly forceRefresh: boolean }) => {
    const exit = await runExit(
      forceRefresh
        ? Effect.andThen(tokens.invalidateAccessToken, tokens.accessToken)
        : tokens.accessToken,
    );
    if (Exit.isSuccess(exit)) return exit.value;
    throw Cause.squash(exit.cause);
  };

  const publish = Effect.fn("YouTubePublish.publish")(function* (input: YouTubePublishInput) {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const metadata = buildYouTubeVideoMetadata(input, now);
    if (typeof metadata === "string") return yield* validation(metadata);
    // Fail fast (before touching the file) when YouTube is not connected.
    yield* tokens.accessToken;
    const video = yield* Effect.tryPromise({
      try: () =>
        uploadYouTubeVideoResumable({
          filePath: input.filePath,
          metadata,
          getAccessToken,
          ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
          ...(options.uploadEndpoint === undefined ? {} : { endpoint: options.uploadEndpoint }),
          ...(options.chunkSize === undefined ? {} : { chunkSize: options.chunkSize }),
          ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
        }),
      catch: (cause) =>
        isCommandCenterError(cause)
          ? cause
          : new CommandCenterError({
              reason:
                cause instanceof YouTubeUploadError && cause.kind === "file"
                  ? "validation"
                  : "connector",
              message:
                cause instanceof Error ? cause.message : "The YouTube upload failed unexpectedly.",
              cause,
            }),
    });
    if (video.channelId !== undefined) {
      yield* tokens
        .recordChannel({ channelId: video.channelId, channelTitle: video.channelTitle })
        .pipe(Effect.ignore);
    }
    return {
      videoId: video.id,
      url: `https://youtu.be/${video.id}`,
      privacyStatus: video.privacyStatus ?? metadata.status.privacyStatus,
      ...(video.channelId === undefined ? {} : { channelId: video.channelId }),
    } satisfies YouTubePublishResult;
  });

  return YouTubePublish.of({ publish });
});

export const makeLayer = (options: YouTubePublishOptions = {}) =>
  Layer.effect(YouTubePublish, make(options));

export const layer = makeLayer();
