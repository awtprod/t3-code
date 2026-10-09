import type { RepositoryIdentity, SourceControlProviderError } from "@t3tools/contracts";
import {
  detectSourceControlProviderFromGitRemoteUrl,
  normalizeGitRemoteUrl,
} from "@t3tools/shared/git";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";
import {
  hardenedHostGitArguments,
  hardenedHostGitEnvironment,
  resolveTrustedHostExecutable,
} from "../vcs/HostGitSecurity.ts";

const DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY = 512;
const DEFAULT_POSITIVE_CACHE_TTL = Duration.minutes(1);
const DEFAULT_NEGATIVE_CACHE_TTL = Duration.minutes(1);

export interface RepositoryIdentityResolverOptions {
  readonly cacheCapacity?: number;
  readonly positiveCacheTtl?: Duration.Input;
  readonly negativeCacheTtl?: Duration.Input;
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

function parseRemoteFetchUrls(stdout: string): Map<string, string> {
  const remotes = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(trimmed);
    if (!match) continue;
    const [, remoteName = "", remoteUrl = "", direction = ""] = match;
    if (direction !== "fetch" || remoteName.length === 0 || remoteUrl.length === 0) {
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

function buildRepositoryIdentity(input: {
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly rootPath: string;
}): RepositoryIdentity {
  const canonicalKey = normalizeGitRemoteUrl(input.remoteUrl);
  const sourceControlProvider = detectSourceControlProviderFromGitRemoteUrl(input.remoteUrl);
  const repositoryPath = canonicalKey.split("/").slice(1).join("/");
  const repositoryPathSegments = repositoryPath.split("/").filter((segment) => segment.length > 0);
  const [owner] = repositoryPathSegments;
  const repositoryName = repositoryPathSegments.at(-1);

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
  };
}

const resolveRepositoryIdentityCacheKey = Effect.fn("RepositoryIdentityResolver.resolveCacheKey")(
  function* (cwd: string) {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const gitExecutable = resolveTrustedHostExecutable("git", { writableRoots: [cwd] });
    if (gitExecutable === undefined) return null;

    // git is a real executable on every platform — no cmd.exe shell mode, which
    // would split paths containing spaces during cmd's re-tokenization.
    const topLevelResult = yield* processRunner
      .run({
        command: gitExecutable,
        args: hardenedHostGitArguments(["-C", cwd, "rev-parse", "--show-toplevel"]),
        env: hardenedHostGitEnvironment([], { writableRoots: [cwd] }),
        extendEnv: false,
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.option);
    if (topLevelResult._tag === "None") {
      return null;
    }
    if (topLevelResult.value.code !== 0) {
      const bareResult = yield* processRunner
        .run({
          command: gitExecutable,
          args: hardenedHostGitArguments(["-C", cwd, "rev-parse", "--is-bare-repository"]),
          env: hardenedHostGitEnvironment([], { writableRoots: [cwd] }),
          extendEnv: false,
          timeoutBehavior: "timedOutResult",
        })
        .pipe(Effect.option);
      return bareResult._tag === "Some" &&
        bareResult.value.code === 0 &&
        bareResult.value.stdout.trim() === "true"
        ? cwd
        : null;
    }

    const candidate = topLevelResult.value.stdout.trim();
    return candidate.length > 0 ? candidate : null;
  },
);

const resolveRemoteFetchUrlsFromCacheKey = Effect.fn(
  "RepositoryIdentityResolver.resolveRemotesFromCacheKey",
)(function* (
  cacheKey: string,
): Effect.fn.Return<ReadonlyMap<string, string> | null, never, ProcessRunner.ProcessRunner> {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const gitExecutable = resolveTrustedHostExecutable("git", { writableRoots: [cacheKey] });
  if (gitExecutable === undefined) return null;
  const remoteResult = yield* processRunner
    .run({
      command: gitExecutable,
      args: hardenedHostGitArguments(["-C", cacheKey, "remote", "-v"]),
      env: hardenedHostGitEnvironment([], { writableRoots: [cacheKey] }),
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

  const repositoryRootCache = yield* Cache.makeWith<string, string | null>(
    (cwd) =>
      resolveRepositoryIdentityCacheKey(cwd).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
      ),
    {
      capacity: cacheCapacity,
      timeToLive: Exit.match({
        onSuccess: (value) =>
          value === null ? Duration.zero : (options.positiveCacheTtl ?? DEFAULT_POSITIVE_CACHE_TTL),
        onFailure: () => Duration.zero,
      }),
    },
  );

  const remoteFetchUrlCache = yield* Cache.makeWith<string, ReadonlyMap<string, string> | null>(
    (cacheKey) =>
      resolveRemoteFetchUrlsFromCacheKey(cacheKey).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
      ),
    {
      capacity: cacheCapacity,
      timeToLive: Exit.match({
        onSuccess: (value) =>
          value === null || value.size === 0
            ? (options.negativeCacheTtl ?? DEFAULT_NEGATIVE_CACHE_TTL)
            : (options.positiveCacheTtl ?? DEFAULT_POSITIVE_CACHE_TTL),
        onFailure: () => Duration.zero,
      }),
    },
  );

  // The primary remote's identity, refined once per cache entry. It reads the
  // remote list through the cache above, which `resolveRemoteKeys` shares.
  const repositoryIdentityCache = yield* Cache.makeWith<string, RepositoryIdentity | null>(
    (cacheKey) =>
      Cache.get(remoteFetchUrlCache, cacheKey).pipe(
        Effect.map((remotes) => {
          const remote = remotes === null ? null : pickPrimaryRemote(remotes);
          return remote === null ? null : buildRepositoryIdentity({ ...remote, rootPath: cacheKey });
        }),
        Effect.flatMap((identity) =>
          identity !== null && options.refine
            ? options.refine(identity).pipe(Effect.catch(() => Effect.succeed(identity)))
            : Effect.succeed(identity),
        ),
      ),
    {
      capacity: cacheCapacity,
      timeToLive: Exit.match({
        onSuccess: (value) =>
          value === null
            ? (options.negativeCacheTtl ?? DEFAULT_NEGATIVE_CACHE_TTL)
            : (options.positiveCacheTtl ?? DEFAULT_POSITIVE_CACHE_TTL),
        onFailure: () => Duration.zero,
      }),
    },
  );

  const remoteFetchUrls = Effect.fn("RepositoryIdentityResolver.remoteFetchUrls")(function* (
    cwd: string,
  ) {
    const cacheKey = yield* Cache.get(repositoryRootCache, cwd);
    if (cacheKey === null) return null;
    const remotes = yield* Cache.get(remoteFetchUrlCache, cacheKey);
    return remotes === null ? null : { cacheKey, remotes };
  });

  const resolve: RepositoryIdentityResolver["Service"]["resolve"] = Effect.fn(
    "RepositoryIdentityResolver.resolve",
  )(function* (cwd, options) {
    if (options?.refresh) yield* Cache.invalidate(repositoryRootCache, cwd);
    const cacheKey = yield* Cache.get(repositoryRootCache, cwd);
    if (cacheKey === null) return null;
    if (options?.refresh) {
      yield* Cache.invalidate(remoteFetchUrlCache, cacheKey);
      yield* Cache.invalidate(repositoryIdentityCache, cacheKey);
    }
    return yield* Cache.get(repositoryIdentityCache, cacheKey);
  });

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
