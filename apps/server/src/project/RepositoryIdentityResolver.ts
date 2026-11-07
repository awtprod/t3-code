import type { RepositoryIdentity, SourceControlProviderError } from "@t3tools/contracts";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import { repositoryPathFromRemoteUrl } from "@t3tools/source-control-core/server/SourceControlProvider";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import {
  hardenedHostGitArguments,
  hardenedHostGitEnvironment,
  resolveTrustedHostExecutable,
} from "../vcs/HostGitSecurity.ts";
import { explicitBareRepositoryEnv } from "../vcs/VcsProcess.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

const DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY = 512;
// Minute-by-minute sweeps need cached hits; clone, publish and PR discovery force refresh.
const DEFAULT_POSITIVE_CACHE_TTL = Duration.minutes(15);
const DEFAULT_NEGATIVE_CACHE_TTL = Duration.minutes(1);

export interface RepositoryIdentityResolverOptions {
  readonly cacheCapacity?: number;
  readonly refine?: (
    identity: RepositoryIdentity,
  ) => Effect.Effect<RepositoryIdentity, SourceControlProviderError>;
}

export class RepositoryIdentityResolver extends Context.Service<
  RepositoryIdentityResolver,
  {
    readonly resolve: (
      cwd: string,
      options?: { readonly refresh?: boolean },
    ) => Effect.Effect<RepositoryIdentity | null>;
    /**
     * Canonical keys of every fetch remote of the repository at `cwd` (empty
     * when it is not a repository). `resolve` reports only the primary one; a
     * fork's origin is usually not it, because `upstream` wins.
     */
    readonly resolveRemoteKeys: (cwd: string) => Effect.Effect<ReadonlyArray<string>>;
  }
>()("@awtprod/command-center/project/RepositoryIdentityResolver") {}

// Local paths such as GitButler's gb-local=. would give unrelated repos the same identity.
function isLocalRemoteUrl(url: string): boolean {
  if (/^file:/i.test(url)) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return false;
  if (/^[a-z]:[\\/]/i.test(url)) return true;
  // Git treats `host:path` as scp-style only when the colon precedes any slash.
  const colonIndex = url.indexOf(":");
  const slashIndex = url.search(/[\\/]/);
  return colonIndex === -1 || (slashIndex !== -1 && slashIndex < colonIndex);
}

function parseRemoteFetchUrls(stdout: string): Map<string, string> {
  const remotes = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // Partial clones append the promisor filter, e.g. `(fetch) [blob:none]`.
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)(?:\s+\[[^\]]+\])?$/.exec(trimmed);
    if (!match) continue;
    const [, remoteName = "", remoteUrl = "", direction = ""] = match;
    if (
      direction !== "fetch" ||
      remoteName.length === 0 ||
      remoteUrl.length === 0 ||
      isLocalRemoteUrl(remoteUrl)
    ) {
      continue;
    }
    remotes.set(remoteName, remoteUrl);
  }
  return remotes;
}

function pickPrimaryRemote(
  remotes: ReadonlyMap<string, string>,
): { readonly remoteName: string; readonly remoteUrl: string } | null {
  for (const preferredRemoteName of ["upstream", "origin"] as const) {
    const remoteUrl = remotes.get(preferredRemoteName);
    if (remoteUrl) {
      return { remoteName: preferredRemoteName, remoteUrl };
    }
  }

  const [remoteName, remoteUrl] =
    [...remotes.entries()].toSorted(([left], [right]) => left.localeCompare(right))[0] ?? [];
  return remoteName && remoteUrl ? { remoteName, remoteUrl } : null;
}

function repositoryPathOf(canonicalKey: string, remoteUrl: string): string {
  const canonicalPath = canonicalKey.split("/").slice(1).join("/");
  const displayPath = repositoryPathFromRemoteUrl(remoteUrl);
  return displayPath?.toLowerCase() === canonicalPath ? displayPath : canonicalPath;
}

function buildRepositoryOrigin(
  originUrl: string | undefined,
  canonicalKey: string,
): RepositoryIdentity["origin"] {
  if (!originUrl) return undefined;
  const originKey = sourceControlDefinitions.repositoryKeyFromRemote(originUrl);
  if (originKey === canonicalKey) return undefined;
  const displayName = repositoryPathOf(originKey, originUrl);
  return { canonicalKey: originKey, remoteUrl: originUrl, ...(displayName ? { displayName } : {}) };
}

function buildRepositoryIdentity(input: {
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly originUrl: string | undefined;
  readonly rootPath: string;
}): RepositoryIdentity {
  const canonicalKey = sourceControlDefinitions.repositoryKeyFromRemote(input.remoteUrl);
  const sourceControlProvider = sourceControlDefinitions.recognizeRemote(input.remoteUrl);
  const repositoryPath = repositoryPathOf(canonicalKey, input.remoteUrl);
  const repositoryPathSegments = repositoryPath.split("/").filter((segment) => segment.length > 0);
  const [owner] = repositoryPathSegments;
  const repositoryName = repositoryPathSegments.at(-1);
  const origin = buildRepositoryOrigin(input.originUrl, canonicalKey);

  return {
    canonicalKey,
    locator: {
      source: "git-remote",
      remoteName: input.remoteName,
      remoteUrl: input.remoteUrl,
    },
    rootPath: input.rootPath,
    ...(repositoryPath ? { displayName: repositoryPath } : {}),
    ...(sourceControlProvider ? { provider: sourceControlProvider.kind } : {}),
    ...(owner ? { owner } : {}),
    ...(repositoryName ? { name: repositoryName } : {}),
    ...(origin ? { origin } : {}),
  };
}

class RepositoryIdentityCacheKey extends Data.Class<{
  readonly rootPath: string;
  readonly isBare: boolean;
}> {}

/**
 * Exact hardened Git environment (HostGitSecurity): inherited Git controls never
 * survive. Bare repositories open only through an explicit `--git-dir`.
 */
const resolverGitEnvironment = (writableRoot: string, platform: NodeJS.Platform) => {
  const env = hardenedHostGitEnvironment([], { writableRoots: [writableRoot] });
  return { ...env, ...explicitBareRepositoryEnv(env, platform) };
};

const resolveRepositoryIdentityCacheKey = Effect.fn("RepositoryIdentityResolver.resolveCacheKey")(
  function* (cwd: string) {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const gitExecutable = resolveTrustedHostExecutable("git", { writableRoots: [cwd] });
    if (gitExecutable === undefined) return null;
    const env = resolverGitEnvironment(cwd, yield* HostProcess.Platform);

    // git is always a real executable; cmd shell mode would split spaced paths on re-tokenization.
    const topLevelResult = yield* processRunner
      .run({
        command: gitExecutable,
        args: hardenedHostGitArguments(["-C", cwd, "rev-parse", "--show-toplevel"]),
        env,
        extendEnv: false,
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.option);
    if (topLevelResult._tag === "None" || topLevelResult.value.timedOut) {
      return null;
    }
    if (topLevelResult.value.code === 0) {
      const rootPath = topLevelResult.value.stdout.trim();
      return rootPath.length > 0
        ? new RepositoryIdentityCacheKey({ rootPath, isBare: false })
        : null;
    }

    // Explicit Git directories preserve safe.bareRepository=explicit for both layouts.
    for (const gitDir of [".", ".git"]) {
      const bareResult = yield* processRunner
        .run({
          command: gitExecutable,
          args: hardenedHostGitArguments([
            "-C",
            cwd,
            `--git-dir=${gitDir}`,
            "rev-parse",
            "--is-bare-repository",
            "--absolute-git-dir",
          ]),
          env,
          extendEnv: false,
          timeoutBehavior: "timedOutResult",
        })
        .pipe(Effect.option);
      if (bareResult._tag === "None" || bareResult.value.timedOut) return null;
      if (bareResult.value.code !== 0) continue;

      const [isBare, rootPath = ""] = bareResult.value.stdout
        .split("\n")
        .map((line) => line.trim());
      // A checkout's .git directory contains remotes but is not a project root.
      return isBare === "true" && rootPath.length > 0
        ? new RepositoryIdentityCacheKey({ rootPath, isBare: true })
        : null;
    }
    return null;
  },
);

const resolveRemoteFetchUrlsFromCacheKey = Effect.fn(
  "RepositoryIdentityResolver.resolveRemotesFromCacheKey",
)(function* (
  cacheKey: RepositoryIdentityCacheKey,
): Effect.fn.Return<ReadonlyMap<string, string> | null, never, ProcessRunner.ProcessRunner> {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const gitExecutable = resolveTrustedHostExecutable("git", {
    writableRoots: [cacheKey.rootPath],
  });
  if (gitExecutable === undefined) return null;
  const remoteResult = yield* processRunner
    .run({
      command: gitExecutable,
      args: hardenedHostGitArguments([
        "-C",
        cacheKey.rootPath,
        ...(cacheKey.isBare ? ["--git-dir=."] : []),
        "remote",
        "-v",
      ]),
      env: resolverGitEnvironment(cacheKey.rootPath, yield* HostProcess.Platform),
      extendEnv: false,
      timeoutBehavior: "timedOutResult",
    })
    .pipe(Effect.option);
  if (remoteResult._tag === "None" || remoteResult.value.code !== 0) {
    return null;
  }

  return parseRemoteFetchUrls(remoteResult.value.stdout);
});

export const make = Effect.fn("RepositoryIdentityResolver.make")(function* (
  options: RepositoryIdentityResolverOptions = {},
) {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const cacheCapacity = options.cacheCapacity ?? DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY;
  const refine = options.refine ?? Effect.succeed;
  // Git errors and timeouts resolve to null (negative TTL); only interrupts skip the cache.
  const timeToLive = (exit: Exit.Exit<unknown>) =>
    Exit.match(exit, {
      onSuccess: (value) =>
        value === null ? DEFAULT_NEGATIVE_CACHE_TTL : DEFAULT_POSITIVE_CACHE_TTL,
      onFailure: () => Duration.zero,
    });

  const repositoryRootCache = yield* Cache.makeWith<string, RepositoryIdentityCacheKey | null>(
    (cwd) =>
      resolveRepositoryIdentityCacheKey(cwd).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
      ),
    { capacity: cacheCapacity, timeToLive },
  );

  const remoteFetchUrlCache = yield* Cache.makeWith<
    RepositoryIdentityCacheKey,
    ReadonlyMap<string, string> | null
  >(
    (cacheKey) =>
      resolveRemoteFetchUrlsFromCacheKey(cacheKey).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
      ),
    {
      capacity: cacheCapacity,
      timeToLive: Exit.match({
        onSuccess: (value) =>
          value === null || value.size === 0
            ? DEFAULT_NEGATIVE_CACHE_TTL
            : DEFAULT_POSITIVE_CACHE_TTL,
        onFailure: () => Duration.zero,
      }),
    },
  );

  // The primary remote's identity, refined once per cache entry. It reads the
  // remote list through the cache above, which `resolveRemoteKeys` shares.
  const repositoryIdentityCache = yield* Cache.makeWith<
    RepositoryIdentityCacheKey,
    RepositoryIdentity | null
  >(
    (cacheKey) =>
      Cache.get(remoteFetchUrlCache, cacheKey).pipe(
        Effect.map((remotes) => {
          const remote = remotes === null ? null : pickPrimaryRemote(remotes);
          return remote === null
            ? null
            : buildRepositoryIdentity({
                ...remote,
                originUrl: remotes?.get("origin"),
                rootPath: cacheKey.rootPath,
              });
        }),
        Effect.filterOrElse(
          (identity): identity is null => identity === null,
          (identity) => refine(identity).pipe(Effect.orElseSucceed(() => identity)),
        ),
      ),
    { capacity: cacheCapacity, timeToLive },
  );

  const remoteFetchUrls = Effect.fn("RepositoryIdentityResolver.remoteFetchUrls")(function* (
    cwd: string,
  ) {
    const cacheKey = yield* Cache.get(repositoryRootCache, cwd);
    if (cacheKey === null) return null;
    const remotes = yield* Cache.get(remoteFetchUrlCache, cacheKey);
    return remotes === null ? null : { cacheKey, remotes };
  });

  const resolve: RepositoryIdentityResolver["Service"]["resolve"] = Effect.fnUntraced(
    function* (cwd, options) {
      if (options?.refresh) yield* Cache.invalidate(repositoryRootCache, cwd);
      const cacheKey = yield* Cache.get(repositoryRootCache, cwd);
      if (cacheKey === null) return null;
      if (options?.refresh) {
        yield* Cache.invalidate(remoteFetchUrlCache, cacheKey);
        yield* Cache.invalidate(repositoryIdentityCache, cacheKey);
      }
      return yield* Cache.get(repositoryIdentityCache, cacheKey);
    },
  );

  // Space activity compares these with `normalizeGitRemoteUrl(binding.remoteRef)`.
  const resolveRemoteKeys: RepositoryIdentityResolver["Service"]["resolveRemoteKeys"] = Effect.fn(
    "RepositoryIdentityResolver.resolveRemoteKeys",
  )(function* (cwd) {
    const resolved = yield* remoteFetchUrls(cwd);
    if (resolved === null) return [];
    const keys = [...resolved.remotes.values()].map(normalizeGitRemoteUrl);
    return [...new Set(keys.filter((key) => key.length > 0))];
  });

  return RepositoryIdentityResolver.of({ resolve, resolveRemoteKeys });
});

export const layer = Layer.effect(RepositoryIdentityResolver, make()).pipe(
  Layer.provide(ProcessRunner.layer),
);
