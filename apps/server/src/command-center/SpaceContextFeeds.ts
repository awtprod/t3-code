/**
 * SpaceContextFeeds - owner business context for the Space agent brief.
 *
 * A Space config may declare up to six context feeds (`Space.contextFeeds`):
 * a command (`argv`) or a file (`path`) whose text the brief shows under
 * "Business context". The config repository is the trust boundary, as for
 * `shell.scoped` automation nodes: a command runs without a shell, in the
 * config directory, with only PATH, HOME, LANG and TZ from the server's
 * environment. Output is untrusted reference data, capped per feed at
 * `maxChars`, and every failure becomes a short reason, so the section never
 * fails the brief. Results are cached per Space and feed definition for the
 * feed's `refreshMinutes` (one minute after a failure).
 *
 * @module SpaceContextFeeds
 */
import type { Space as SpaceType, SpaceContextFeed } from "@command-center/core";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProcessRunner } from "../processRunner.ts";
import { CommandCenterConfig } from "./Config.ts";
import type { SpaceBriefContextFeed, SpaceBriefContextFeeds } from "./SpaceBrief.ts";

/** The only server environment variables a feed command sees. */
const FEED_ENVIRONMENT_KEYS = ["PATH", "HOME", "LANG", "TZ"] as const;
/** Feeds of one Space read at the same time. */
const FEED_CONCURRENCY = 3;
/** A feed that failed is retried sooner than a good one is refreshed. */
const FEED_FAILURE_CACHE_TTL = Duration.minutes(1);
const FEED_CACHE_CAPACITY = 256;
/** stderr kept for the warning log only; it never reaches the brief. */
const STDERR_LOG_CHARS = 500;
const TRUNCATED_MARKER = "[truncated]";

/** UTF-8 takes at most 3 bytes per UTF-16 unit; one extra unit shows the output is longer. */
const outputBytes = (maxChars: number) => (maxChars + 1) * 3;

/** Text cut to `maxChars` on a line boundary, ending with `[truncated]` when cut. */
const capFeedText = (text: string, maxChars: number): string => {
  const trimmed = text.trimEnd();
  if (trimmed.length <= maxChars) return trimmed;
  const limit = maxChars - TRUNCATED_MARKER.length - 1;
  const cut = trimmed.lastIndexOf("\n", limit);
  return `${trimmed.slice(0, cut > 0 ? cut : limit).trimEnd()}\n${TRUNCATED_MARKER}`;
};

const feedEnvironment = (): NodeJS.ProcessEnv =>
  Object.fromEntries(
    FEED_ENVIRONMENT_KEYS.flatMap((key) => {
      const value = process.env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );

type FeedOutcome =
  | { readonly text: string }
  | { readonly reason: string; readonly stderr?: string | undefined };

export interface SpaceContextFeedsShape {
  /**
   * The Space's "Business context" brief input in config order, or undefined
   * when the Space declares no feeds. Never fails.
   */
  readonly section: (space: SpaceType) => Effect.Effect<SpaceBriefContextFeeds | undefined>;
}

export class SpaceContextFeeds extends Context.Service<SpaceContextFeeds, SpaceContextFeedsShape>()(
  "@awtprod/command-center/command-center/SpaceContextFeeds",
) {}

/** Keys compare structurally, so a changed feed definition is a new entry. */
interface FeedKey {
  readonly spaceId: string;
  readonly feed: SpaceContextFeed;
}

const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const config = yield* CommandCenterConfig;

  const runCommand = (
    feed: Extract<SpaceContextFeed, { readonly argv: ReadonlyArray<string> }>,
  ): Effect.Effect<FeedOutcome> => {
    const [command, ...args] = feed.argv;
    if (command === undefined) return Effect.succeed({ reason: "no command" });
    return runner
      .run({
        command,
        args,
        cwd: config.configDirectory,
        env: feedEnvironment(),
        extendEnv: false,
        timeout: Duration.seconds(feed.timeoutSeconds),
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: outputBytes(feed.maxChars),
        outputMode: "truncate",
      })
      .pipe(
        Effect.map((result): FeedOutcome => {
          if (result.timedOut) return { reason: `timed out after ${feed.timeoutSeconds} s` };
          if (result.code !== 0) {
            return { reason: `exit ${result.code ?? "unknown"}`, stderr: result.stderr };
          }
          return { text: result.stdout };
        }),
        Effect.catch((cause) =>
          Effect.succeed<FeedOutcome>({
            reason:
              cause._tag === "ProcessSpawnError"
                ? "the command could not be started"
                : "the command output could not be read",
            stderr: cause.message,
          }),
        ),
      );
  };

  const readFile = (feed: Extract<SpaceContextFeed, { readonly path: string }>) =>
    fs.open(feed.path, { flag: "r" }).pipe(
      Effect.flatMap((file) => file.readAlloc(outputBytes(feed.maxChars))),
      Effect.scoped,
      Effect.map((bytes): FeedOutcome => ({
        text: Option.match(bytes, {
          onNone: () => "",
          onSome: (value) => new TextDecoder().decode(value),
        }),
      })),
      Effect.catch((cause) =>
        Effect.succeed<FeedOutcome>({
          reason:
            cause.reason._tag === "NotFound"
              ? "file not found"
              : cause.reason._tag === "PermissionDenied"
                ? "permission denied"
                : "the file could not be read",
        }),
      ),
    );

  const lookup = ({ spaceId, feed }: FeedKey): Effect.Effect<SpaceBriefContextFeed> =>
    (feed.argv !== undefined ? runCommand(feed) : readFile(feed)).pipe(
      // Also bounds a file read that blocks (a FIFO, a stalled mount).
      Effect.timeoutOption(Duration.seconds(feed.timeoutSeconds)),
      Effect.map(
        Option.getOrElse((): FeedOutcome => ({
          reason: `timed out after ${feed.timeoutSeconds} s`,
        })),
      ),
      Effect.flatMap((outcome) =>
        "text" in outcome
          ? Effect.map(Clock.currentTimeMillis, (refreshedAtMs): SpaceBriefContextFeed => ({
              title: feed.title,
              status: "ok",
              text: capFeedText(outcome.text, feed.maxChars),
              refreshedAtMs,
            }))
          : Effect.logWarning("space brief context feed unavailable", {
              spaceId,
              feedId: feed.id,
              reason: outcome.reason,
              ...(outcome.stderr === undefined || outcome.stderr.trim().length === 0
                ? {}
                : { stderr: outcome.stderr.trim().slice(0, STDERR_LOG_CHARS) }),
            }).pipe(
              Effect.as<SpaceBriefContextFeed>({
                title: feed.title,
                status: "unavailable",
                reason: outcome.reason,
              }),
            ),
      ),
    );

  const cache = yield* Cache.makeWith<FeedKey, SpaceBriefContextFeed>(lookup, {
    capacity: FEED_CACHE_CAPACITY,
    timeToLive: (exit, key) =>
      Exit.isSuccess(exit)
        ? exit.value.status === "ok"
          ? Duration.minutes(key.feed.refreshMinutes)
          : FEED_FAILURE_CACHE_TTL
        : Duration.zero,
  });

  const section: SpaceContextFeedsShape["section"] = (space) => {
    const feeds = space.contextFeeds ?? [];
    if (feeds.length === 0) return Effect.undefined;
    return Effect.forEach(feeds, (feed) => Cache.get(cache, { spaceId: space.id, feed }), {
      concurrency: FEED_CONCURRENCY,
    });
  };

  return SpaceContextFeeds.of({ section });
});

export const layer = Layer.effect(SpaceContextFeeds, make);
