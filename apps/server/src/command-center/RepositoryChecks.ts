import * as NodeCrypto from "node:crypto";

import { ItemId, SpaceId } from "@command-center/core";
import type { CommandCenterError, CommandCenterItemCreateInput } from "@t3tools/contracts";
import {
  normalizeGitRemoteUrl,
  parseGitHubRepositoryNameWithOwnerFromRemoteUrl,
} from "@t3tools/shared/git";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as CommandCenter from "./Service.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as SourceControlRateLimit from "../sourceControl/SourceControlRateLimit.ts";

const MAX_OPEN_PRS = 10;
const MAX_PAGES = 20;
const MAX_CHECKS_PER_PR = 50;
/** Stored PRs with active signals, missing from the polled open page, whose state one poll checks. */
const MAX_CLOSED_PR_LOOKUPS = 5;
const MAX_ACTIVE_SIGNALS_PER_PR = 100;
const COMMAND_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 128 * 1024;

const ApiPullRequest = Schema.Struct({
  number: Schema.Int,
  html_url: Schema.String,
  head: Schema.Struct({ sha: Schema.String }),
  draft: Schema.Boolean,
});
const RequiredCheck = Schema.Struct({
  name: Schema.String,
  bucket: Schema.String,
  completedAt: Schema.NullOr(Schema.String),
  link: Schema.NullOr(Schema.String),
});
const CurrentHead = Schema.Struct({ headRefOid: Schema.String, state: Schema.String });
const decodePullRequests = Schema.decodeUnknownEffect(Schema.Array(ApiPullRequest));
const decodeChecks = Schema.decodeUnknownEffect(Schema.Array(RequiredCheck));
const decodeCurrentHead = Schema.decodeUnknownEffect(CurrentHead);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

type PullRequest = {
  readonly number: number;
  readonly url: string;
  readonly headRefOid: string;
  readonly isDraft: boolean;
};
type Check = typeof RequiredCheck.Type;

type SignalRow = {
  readonly bucket: string;
  readonly completedAt: string | null;
  readonly itemId: string | null;
};
type OldItemRow = { readonly itemId: string; readonly updatedAt: string; readonly status: string };
type ActiveSignalRow = OldItemRow & { readonly headSha: string; readonly checkName: string };
type CursorRow = { readonly nextPage: number };
type ActivePullRequestRow = { readonly prNumber: number };
type RetireItem = (input: {
  readonly itemId: string;
  readonly spaceId: ReturnType<typeof SpaceId.make>;
  readonly expectedUpdatedAt: string;
}) => Effect.Effect<void, CommandCenterError>;

export interface RepositoryCheckObservation {
  readonly repositoryKey: string;
  readonly repositoryId: string;
  readonly spaceId: ReturnType<typeof SpaceId.make>;
  readonly pullRequest: PullRequest;
  readonly check: Check;
  readonly observedAt: string;
}

export class RepositoryChecks extends Context.Service<
  RepositoryChecks,
  {
    readonly poll: (input: {
      readonly spaceId: ReturnType<typeof SpaceId.make>;
      readonly repositoryId: string;
    }) => Effect.Effect<{ readonly scanned: number; readonly created: number }, string>;
  }
>()("@awtprod/command-center/command-center/RepositoryChecks") {}

function signalItemId(observation: RepositoryCheckObservation): string {
  const key = [
    observation.repositoryKey,
    observation.pullRequest.number,
    observation.pullRequest.headRefOid,
    observation.check.name,
    observation.check.completedAt ?? "",
  ].join("\0");
  return `repository-check:${NodeCrypto.createHash("sha256").update(key).digest("hex")}`;
}

/** Persist the observed state before reporting success, with a stable Item ID across retries. */
export function makeRepositoryCheckRecorder(dependencies: {
  readonly sql: SqlClient.SqlClient;
  readonly createItem: (
    input: CommandCenterItemCreateInput,
  ) => Effect.Effect<{ readonly id: string }, CommandCenterError>;
  readonly retireItem: RetireItem;
}) {
  const { sql, createItem, retireItem } = dependencies;
  return Effect.fn("RepositoryChecks.record")(function* (observation: RepositoryCheckObservation) {
    const { repositoryKey, repositoryId, spaceId, pullRequest, check, observedAt } = observation;
    const obsolete = yield* sql<OldItemRow>`
      SELECT i.id AS "itemId", i.updated_at AS "updatedAt", i.status
      FROM command_center_repository_check_signals s
      JOIN command_center_items i ON i.id = s.item_id
      WHERE s.repository_key = ${repositoryKey} AND s.pr_number = ${pullRequest.number}
        AND s.check_name = ${check.name}
        AND (s.head_sha <> ${pullRequest.headRefOid} OR ${check.bucket} <> 'fail')
        AND i.status NOT IN ('done', 'canceled')
      LIMIT 20
    `;
    for (const item of obsolete) {
      yield* retireItem({ itemId: item.itemId, spaceId, expectedUpdatedAt: item.updatedAt });
    }
    const existing = yield* sql<SignalRow>`
      SELECT bucket, completed_at AS "completedAt", item_id AS "itemId"
      FROM command_center_repository_check_signals
      WHERE repository_key = ${repositoryKey} AND pr_number = ${pullRequest.number}
        AND head_sha = ${pullRequest.headRefOid} AND check_name = ${check.name}
      LIMIT 1
    `;
    const previous = existing[0];
    if (previous?.bucket === check.bucket && previous.completedAt === check.completedAt) {
      return false;
    }

    let itemId = previous?.itemId ?? null;
    if (check.bucket === "fail") {
      itemId = signalItemId(observation);
      if (
        previous?.itemId !== null &&
        previous?.itemId !== undefined &&
        previous.itemId !== itemId
      ) {
        const old = yield* sql<OldItemRow>`
          SELECT id AS "itemId", updated_at AS "updatedAt", status
          FROM command_center_items WHERE id = ${previous.itemId} LIMIT 1
        `;
        if (old[0] !== undefined && old[0].status !== "done" && old[0].status !== "canceled") {
          yield* retireItem({
            itemId: old[0].itemId,
            spaceId,
            expectedUpdatedAt: old[0].updatedAt,
          });
        }
      }
      const item = yield* createItem({
        requestId: itemId,
        spaceId,
        kind: "decision",
        priority: "high",
        title: `Required CI failed: ${check.name} on PR #${pullRequest.number}`,
        description: `Open PR: ${pullRequest.url}\nRequired check: ${check.name}\nHead SHA: ${pullRequest.headRefOid}${check.link === null ? "" : `\nCheck: ${check.link}`}`,
      });
      itemId = item.id;
    }
    yield* sql`
      INSERT INTO command_center_repository_check_signals (
        repository_key, space_id, repository_id, pr_number, head_sha,
        check_name, bucket, completed_at, item_id, observed_at
      ) VALUES (
        ${repositoryKey}, ${spaceId}, ${repositoryId}, ${pullRequest.number},
        ${pullRequest.headRefOid}, ${check.name}, ${check.bucket},
        ${check.completedAt}, ${itemId}, ${observedAt}
      ) ON CONFLICT(repository_key, pr_number, head_sha, check_name) DO UPDATE SET
        bucket = excluded.bucket,
        completed_at = excluded.completed_at,
        item_id = excluded.item_id,
        observed_at = excluded.observed_at
    `;
    return check.bucket === "fail" && itemId !== (previous?.itemId ?? null);
  });
}

/** Retire every active Inbox item raised for one PR, e.g. once GitHub reports it closed. */
function retireActivePullRequestSignals(
  dependencies: { readonly sql: SqlClient.SqlClient; readonly retireItem: RetireItem },
  input: {
    readonly repositoryKey: string;
    readonly spaceId: ReturnType<typeof SpaceId.make>;
    readonly prNumber: number;
  },
) {
  return Effect.gen(function* () {
    const active = yield* dependencies.sql<OldItemRow>`
      SELECT DISTINCT i.id AS "itemId", i.updated_at AS "updatedAt", i.status
      FROM command_center_repository_check_signals s
      JOIN command_center_items i ON i.id = s.item_id
      WHERE s.repository_key = ${input.repositoryKey} AND s.pr_number = ${input.prNumber}
        AND i.status NOT IN ('done', 'canceled')
      LIMIT ${MAX_ACTIVE_SIGNALS_PER_PR}
    `;
    for (const item of active) {
      yield* dependencies.retireItem({
        itemId: item.itemId,
        spaceId: input.spaceId,
        expectedUpdatedAt: item.updatedAt,
      });
    }
    return active.length;
  });
}

/**
 * The open-PR list only returns open PRs, so a PR that closes while its required check is failing
 * would otherwise keep its Inbox item forever. Each poll looks up a bounded number of stored PRs
 * with active signals that were not on the polled page, least recently observed first, and
 * retires their items only once GitHub confirms the PR is closed or merged. A lookup error never
 * retires anything and ends the lookups for this poll.
 */
export function makeClosedPullRequestReconciler(dependencies: {
  readonly sql: SqlClient.SqlClient;
  readonly lookupState: (prNumber: number) => Effect.Effect<string, string>;
  readonly retireItem: RetireItem;
}) {
  const { sql, lookupState } = dependencies;
  return Effect.fn("RepositoryChecks.reconcileClosedPullRequests")(function* (input: {
    readonly repositoryKey: string;
    readonly spaceId: ReturnType<typeof SpaceId.make>;
    readonly polledPrNumbers: ReadonlyArray<number>;
    readonly observedAt: string;
  }) {
    const polled = new Set(input.polledPrNumbers);
    const stored = yield* sql<ActivePullRequestRow>`
      SELECT s.pr_number AS "prNumber"
      FROM command_center_repository_check_signals s
      JOIN command_center_items i ON i.id = s.item_id
      WHERE s.repository_key = ${input.repositoryKey} AND s.space_id = ${input.spaceId}
        AND i.status NOT IN ('done', 'canceled')
      GROUP BY s.pr_number
      ORDER BY MAX(s.observed_at) ASC, s.pr_number ASC
      LIMIT ${polled.size + MAX_CLOSED_PR_LOOKUPS}
    `;
    const candidates = stored
      .filter((row) => !polled.has(row.prNumber))
      .slice(0, MAX_CLOSED_PR_LOOKUPS);
    let retired = 0;
    for (const candidate of candidates) {
      const state = yield* lookupState(candidate.prNumber).pipe(Effect.option);
      if (state._tag === "None") break;
      if (state.value === "CLOSED" || state.value === "MERGED") {
        retired += yield* retireActivePullRequestSignals(dependencies, {
          repositoryKey: input.repositoryKey,
          spaceId: input.spaceId,
          prNumber: candidate.prNumber,
        });
        continue;
      }
      // Still open (on another page): rotate it behind PRs that have not been checked yet.
      yield* sql`
        UPDATE command_center_repository_check_signals SET observed_at = ${input.observedAt}
        WHERE repository_key = ${input.repositoryKey} AND pr_number = ${candidate.prNumber}
      `;
    }
    return retired;
  });
}

export const layer = Layer.effect(
  RepositoryChecks,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const commandCenter = yield* CommandCenter.CommandCenterService;
    const github = yield* GitHubCli.GitHubCli;
    const rateLimit = yield* SourceControlRateLimit.SourceControlRateLimit;
    const retireItem: RetireItem = (input) =>
      commandCenter
        .updateItem({
          itemId: ItemId.make(input.itemId),
          spaceId: input.spaceId,
          expectedUpdatedAt: input.expectedUpdatedAt,
          patch: { status: "done" },
        })
        .pipe(Effect.asVoid);
    const record = makeRepositoryCheckRecorder({
      sql,
      createItem: commandCenter.createItem,
      retireItem,
    });

    const poll = Effect.fn("RepositoryChecks.poll")(
      function* (input: {
        readonly spaceId: ReturnType<typeof SpaceId.make>;
        readonly repositoryId: string;
      }) {
        const spaces = (yield* commandCenter.querySpaces({})).spaces;
        const space = spaces.find(
          (candidate) => candidate.id === input.spaceId && candidate.lifecycle === "active",
        );
        const binding = space?.repositories.find(
          (candidate) => candidate.id === input.repositoryId,
        );
        const remote = binding?.remoteRef;
        const nameWithOwner = parseGitHubRepositoryNameWithOwnerFromRemoteUrl(remote ?? null);
        if (remote === undefined || nameWithOwner === null) {
          return yield* Effect.fail(
            "Repository checks require a GitHub remote bound to an active Space.",
          );
        }
        const repositoryKey = normalizeGitRemoteUrl(remote);
        const matches = spaces.flatMap((candidate) =>
          candidate.repositories.filter(
            (repository) =>
              repository.remoteRef !== undefined &&
              normalizeGitRemoteUrl(repository.remoteRef) === repositoryKey,
          ),
        );
        if (matches.length !== 1) {
          return yield* Effect.fail(
            "Repository checks require exactly one Space binding for this remote.",
          );
        }
        const rateKey = { provider: "github" as const, host: "github.com" };
        const lease = yield* rateLimit.check(rateKey);
        const command = Effect.fn("RepositoryChecks.githubRead")(function* (
          args: ReadonlyArray<string>,
          allowNonZeroExit = false,
        ) {
          const output = yield* github
            .execute({
              cwd: process.cwd(),
              args,
              timeoutMs: COMMAND_TIMEOUT_MS,
              maxOutputBytes: MAX_OUTPUT_BYTES,
              allowNonZeroExit,
            })
            .pipe(
              Effect.catchTag("GitHubCliRateLimitError", (error) =>
                rateLimit
                  .recordRateLimit({ ...rateKey, lease })
                  .pipe(Effect.flatMap(() => Effect.fail(error))),
              ),
            );
          if (
            output.stdoutTruncated ||
            output.stderrTruncated ||
            output.stdoutInvalidUtf8 ||
            output.stderrInvalidUtf8
          ) {
            return yield* Effect.fail("GitHub check response exceeded the read limit.");
          }
          if (allowNonZeroExit && ![0, 1, 8].includes(Number(output.exitCode))) {
            return yield* Effect.fail(`GitHub check read failed with exit ${output.exitCode}.`);
          }
          if (/rate limit|too many requests|http 429/iu.test(output.stderr)) {
            yield* rateLimit.recordRateLimit({ ...rateKey, lease });
            return yield* Effect.fail("GitHub API rate limit reached.");
          }
          return yield* decodeJson(output.stdout).pipe(
            Effect.mapError(() => "GitHub returned malformed JSON."),
          );
        });
        const cursor = yield* sql<CursorRow>`
        SELECT next_page AS "nextPage" FROM command_center_repository_check_cursors
        WHERE repository_key = ${repositoryKey} LIMIT 1
      `;
        const page = cursor[0]?.nextPage ?? 1;
        const rawPrs = yield* decodePullRequests(
          yield* command([
            "api",
            `repos/${nameWithOwner}/pulls`,
            "--method",
            "GET",
            "-f",
            "state=open",
            "-f",
            `per_page=${MAX_OPEN_PRS}`,
            "-f",
            `page=${page}`,
          ]),
        ).pipe(Effect.mapError(() => "GitHub returned invalid PR data."));
        const prs = rawPrs.map((pr) => ({
          number: pr.number,
          url: pr.html_url,
          headRefOid: pr.head.sha,
          isDraft: pr.draft,
        }));
        let scanned = 0;
        let created = 0;
        for (const pr of prs) {
          if (
            pr.isDraft ||
            pr.number < 1 ||
            !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/u.test(pr.url) ||
            !/^[a-f0-9]{40}$/iu.test(pr.headRefOid)
          )
            continue;
          const checks = yield* decodeChecks(
            yield* command(
              [
                "pr",
                "checks",
                String(pr.number),
                "--repo",
                nameWithOwner,
                "--required",
                "--json",
                "name,bucket,completedAt,link",
              ],
              true,
            ),
          ).pipe(Effect.mapError(() => "GitHub returned invalid required-check data."));
          if (checks.length > MAX_CHECKS_PER_PR)
            return yield* Effect.fail("PR has too many required checks for a bounded poll.");
          const current = yield* decodeCurrentHead(
            yield* command([
              "pr",
              "view",
              String(pr.number),
              "--repo",
              nameWithOwner,
              "--json",
              "headRefOid,state",
            ]),
          ).pipe(Effect.mapError(() => "GitHub returned invalid current-head data."));
          if (current.state === "CLOSED" || current.state === "MERGED") {
            // Closed between the list read and this read: retire its signals now.
            yield* retireActivePullRequestSignals(
              { sql, retireItem },
              { repositoryKey, spaceId: input.spaceId, prNumber: pr.number },
            );
            continue;
          }
          if (current.state !== "OPEN" || current.headRefOid !== pr.headRefOid) continue;
          const active = yield* sql<ActiveSignalRow>`
          SELECT s.head_sha AS "headSha", s.check_name AS "checkName",
            i.id AS "itemId", i.updated_at AS "updatedAt", i.status
          FROM command_center_repository_check_signals s
          JOIN command_center_items i ON i.id = s.item_id
          WHERE s.repository_key = ${repositoryKey} AND s.pr_number = ${pr.number}
            AND i.status NOT IN ('done', 'canceled')
          LIMIT 101
        `;
          if (active.length > 100)
            return yield* Effect.fail("PR has too many active check signals for a bounded poll.");
          for (const item of active) {
            if (
              item.headSha === pr.headRefOid &&
              checks.some((check) => check.name === item.checkName && check.bucket === "fail")
            )
              continue;
            yield* commandCenter.updateItem({
              itemId: ItemId.make(item.itemId),
              spaceId: input.spaceId,
              expectedUpdatedAt: item.updatedAt,
              patch: { status: "done" },
            });
          }
          for (const check of checks) {
            if (check.name.trim().length === 0 || check.name.length > 256) continue;
            const wasCreated = yield* record({
              repositoryKey,
              repositoryId: input.repositoryId,
              spaceId: input.spaceId,
              pullRequest: pr,
              check,
              observedAt: DateTime.formatIso(yield* DateTime.now),
            });
            scanned += 1;
            if (wasCreated) created += 1;
          }
        }
        const reconcileClosed = makeClosedPullRequestReconciler({
          sql,
          retireItem,
          lookupState: (prNumber) =>
            command([
              "pr",
              "view",
              String(prNumber),
              "--repo",
              nameWithOwner,
              "--json",
              "headRefOid,state",
            ]).pipe(
              Effect.flatMap(decodeCurrentHead),
              Effect.map((current) => current.state),
              Effect.mapError(() => "GitHub PR state lookup failed."),
            ),
        });
        yield* reconcileClosed({
          repositoryKey,
          spaceId: input.spaceId,
          polledPrNumbers: prs.map((pr) => pr.number),
          observedAt: DateTime.formatIso(yield* DateTime.now),
        });
        yield* rateLimit.recordSuccess({ ...rateKey, lease });
        const nextPage = rawPrs.length < MAX_OPEN_PRS || page >= MAX_PAGES ? 1 : page + 1;
        yield* sql`
        INSERT INTO command_center_repository_check_cursors(repository_key, next_page, updated_at)
        VALUES (${repositoryKey}, ${nextPage}, ${DateTime.formatIso(yield* DateTime.now)})
        ON CONFLICT(repository_key) DO UPDATE SET
          next_page = excluded.next_page, updated_at = excluded.updated_at
      `;
        return { scanned, created };
      },
      Effect.timeout(120_000),
      Effect.mapError((cause) => (typeof cause === "string" ? cause : String(cause))),
    );
    return RepositoryChecks.of({ poll });
  }),
);
