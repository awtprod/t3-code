import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import {
  GitCommandError,
  SourceControlProviderError,
  SourceControlRepositoryError,
  type SourceControlCloneRepositoryInput,
  type SourceControlCloneRepositoryResult,
  type SourceControlCloneProtocol,
  SourceControlProviderKind,
  type SourceControlPublishRepositoryInput,
  type SourceControlPublishRepositoryResult,
  type SourceControlRepositoryCloneUrls,
  type SourceControlRepositoryInfo,
  type SourceControlRepositoryLookupInput,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  parseGitCloneProgressLine,
  type GitCloneProgressLine,
} from "../project/gitCloneProgress.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as BitbucketApi from "@t3tools/source-control-bitbucket/server/BitbucketApi";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
import * as GitHubProfileAuth from "./GitHubProfileAuth.ts";
import * as GitHubApi from "@t3tools/source-control-github/server/GitHubApi";
import { parseGitHubRepositorySelector } from "@t3tools/source-control-github/server/gitHubRepositoryResolution";
import * as HostProcess from "@t3tools/shared/HostProcess";
const isSourceControlRepositoryError = Schema.is(SourceControlRepositoryError);
const isSourceControlProviderError = Schema.is(SourceControlProviderError);
const isBitbucketRepositoryLocatorError = Schema.is(BitbucketApi.BitbucketRepositoryLocatorError);

export class SourceControlRepositoryService extends Context.Service<
  SourceControlRepositoryService,
  {
    readonly lookupRepository: (
      input: SourceControlRepositoryLookupInput,
    ) => Effect.Effect<SourceControlRepositoryInfo, SourceControlRepositoryError>;
    /**
     * Everything `cloneRepository` checks before running git: the resolved
     * remote, the normalized destination, and that the destination is empty.
     * Lets a caller create the project first and clone afterwards.
     */
    readonly prepareClone: (
      input: SourceControlCloneRepositoryInput,
    ) => Effect.Effect<SourceControlPreparedClone, SourceControlRepositoryError>;
    readonly cloneRepository: (
      input: SourceControlCloneRepositoryInput,
      options?: SourceControlCloneOptions,
    ) => Effect.Effect<SourceControlCloneRepositoryResult, SourceControlRepositoryError>;
    /** Removes a partial or failed clone so the destination is empty again. */
    readonly discardClone: (
      destinationPath: string,
    ) => Effect.Effect<void, SourceControlRepositoryError>;
    readonly publishRepository: (
      input: SourceControlPublishRepositoryInput,
    ) => Effect.Effect<SourceControlPublishRepositoryResult, SourceControlRepositoryError>;
  }
>()("@awtprod/command-center/sourceControl/SourceControlRepositoryService") {}

export interface SourceControlPreparedClone {
  readonly destinationPath: string;
  /** Credential-free; safe to show and to store in snapshots. */
  readonly remoteUrl: string;
  /** What git is given; may carry embedded credentials. */
  readonly cloneUrl: string;
  readonly repository: SourceControlRepositoryInfo | null;
}

export interface SourceControlCloneOptions {
  readonly onProgress?: (line: GitCloneProgressLine) => Effect.Effect<void>;
  /** Overrides the default clone budget; `null` disables the deadline. */
  readonly timeoutMs?: number | null;
}

// The synchronous RPC (older clients, mobile) keeps a deadline: nothing else
// tells the user a clone stalled. The tracked path passes null and relies on
// progress and Cancel instead.
const CLONE_TIMEOUT_MS = 120_000;
const CLONE_ENV = {
  // `--progress` forces the transfer counters through the pipe; the delay env
  // makes the checkout counter start immediately. No tty means a credential
  // prompt would hang forever, so tell git to fail instead.
  GIT_PROGRESS_DELAY: "0",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
} satisfies NodeJS.ProcessEnv;

function mapRepositoryError(operation: string, provider: SourceControlProviderKind) {
  return Effect.mapError((cause: unknown) =>
    isSourceControlRepositoryError(cause)
      ? cause
      : new SourceControlRepositoryError({
          operation,
          provider,
          detail:
            isSourceControlProviderError(cause) &&
            cause.provider === "bitbucket" &&
            isBitbucketRepositoryLocatorError(cause.cause)
              ? BitbucketApi.BitbucketRepositoryLocatorError.detail
              : "The source control operation could not be completed.",
          cause,
        }),
  );
}

function toRepositoryInfo(
  provider: SourceControlProviderKind,
  urls: SourceControlRepositoryCloneUrls,
): SourceControlRepositoryInfo {
  return {
    provider,
    nameWithOwner: urls.nameWithOwner,
    url: urls.url,
    sshUrl: urls.sshUrl,
  };
}

/**
 * The URL clients see. A pasted `https://user:token@host/…` must not travel
 * back over `subscribeProjectClones` to every reader; git still gets the
 * original.
 */
function redactRemoteUrl(remoteUrl: string): string {
  try {
    const url = new URL(remoteUrl);
    // Clone URLs have no legitimate query; when one is present it is a token.
    if (url.username.length === 0 && url.password.length === 0 && url.search.length === 0) {
      return remoteUrl;
    }
    url.username = "";
    url.password = "";
    url.search = "";
    return url.toString();
  } catch {
    return remoteUrl;
  }
}

// Userinfo may itself contain `@`; everything up to the last one before the
// host boundary goes.
const URL_WITH_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/]+@/gi;

/** Drops `user:token@` from any URL embedded in free text. */
function redactUrlCredentials(text: string): string {
  return text.replace(URL_WITH_USERINFO, "$1");
}

function selectRemoteUrl(
  urls: SourceControlRepositoryCloneUrls,
  protocol: SourceControlCloneProtocol | undefined,
): string {
  switch (protocol ?? "auto") {
    case "https":
      return urls.url;
    case "ssh":
    case "auto":
      return urls.sshUrl;
  }
}

function managedGitHubRepository(repository: string) {
  const locator = parseGitHubRepositorySelector(repository, "github.com");
  if (locator?.host !== "github.com") return { profile: null, repository: repository.trim() };
  const profile = GitHubProfileAuth.approvedGitHubProfileForOwner(locator.owner);
  return {
    profile,
    repository: profile === null ? repository.trim() : `${locator.owner}/${locator.name}`,
  };
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const path = yield* Path.Path;
  const providers = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const profileAuth = yield* GitHubProfileAuth.GitHubProfileAuth;

  const ensureConcreteProvider = (input: {
    readonly operation: string;
    readonly provider: SourceControlProviderKind;
  }) => {
    if (input.provider !== "unknown") {
      return Effect.succeed(input.provider);
    }

    return Effect.fail(
      new SourceControlRepositoryError({
        operation: input.operation,
        provider: input.provider,
        detail: "Choose a source control provider before continuing.",
      }),
    );
  };

  const lookupRepository = Effect.fn("SourceControlRepositoryService.lookupRepository")(function* (
    input: SourceControlRepositoryLookupInput,
  ) {
    const providerKind = yield* ensureConcreteProvider({
      operation: "lookupRepository",
      provider: input.provider,
    });
    const provider = yield* providers.get(providerKind);
    const selected =
      providerKind === "github"
        ? managedGitHubRepository(input.repository)
        : { profile: null, repository: input.repository.trim() };
    const selectedProfile = selected.profile;
    const profile =
      selectedProfile === null
        ? null
        : yield* profileAuth.get(selectedProfile).pipe(
            Effect.mapError(
              () =>
                new SourceControlRepositoryError({
                  operation: "lookupRepository",
                  provider: providerKind,
                  detail: `GitHub profile ${selectedProfile} is unavailable.`,
                }),
            ),
          );
    const lookup = provider.getRepositoryCloneUrls({
      cwd: input.cwd ?? config.cwd,
      repository: selected.repository,
    });
    const urls = yield* profile === null
      ? lookup
      : lookup.pipe(
          Effect.provideService(GitHubApi.PinnedGitHubCredential, {
            host: "github.com",
            token: profile.token,
            credentialFingerprint: profile.fingerprint,
          }),
        );
    return toRepositoryInfo(providerKind, urls);
  });

  const normalizeDestinationPath = Effect.fn("SourceControlRepositoryService.normalizeDestination")(
    function* (destinationPath: string) {
      const trimmed = destinationPath.trim();
      if (trimmed.length === 0) {
        return yield* new SourceControlRepositoryError({
          operation: "cloneRepository",
          provider: SourceControlProviderKind.make("unknown"),
          detail: "Choose a destination path before cloning.",
        });
      }

      return path.resolve(expandHomePath(trimmed, yield* HostProcess.HomeDirectory));
    },
  );

  const prepareDestination = Effect.fn("SourceControlRepositoryService.prepareDestination")(
    function* (destinationPath: string) {
      const normalizedDestination = yield* normalizeDestinationPath(destinationPath);
      if (yield* fileSystem.exists(normalizedDestination)) {
        const entries = yield* fileSystem
          .readDirectory(normalizedDestination, { recursive: false })
          .pipe(
            Effect.mapError(
              (cause) =>
                new SourceControlRepositoryError({
                  operation: "cloneRepository",
                  provider: SourceControlProviderKind.make("unknown"),
                  detail: "Destination path already exists and is not a directory.",
                  cause,
                }),
            ),
          );
        if (entries.length > 0) {
          return yield* new SourceControlRepositoryError({
            operation: "cloneRepository",
            provider: SourceControlProviderKind.make("unknown"),
            detail: "Destination path already exists and is not empty.",
          });
        }
      } else {
        yield* fileSystem.makeDirectory(path.dirname(normalizedDestination), { recursive: true });
      }

      return {
        destinationPath: normalizedDestination,
        parentPath: path.dirname(normalizedDestination),
        directoryName: path.basename(normalizedDestination),
      };
    },
  );

  const prepareClone = Effect.fn("SourceControlRepositoryService.prepareClone")(function* (
    input: SourceControlCloneRepositoryInput,
  ) {
    const preparedDestination = yield* prepareDestination(input.destinationPath);
    let repository: SourceControlRepositoryInfo | null = null;
    let remoteUrl = input.remoteUrl?.trim() ?? null;
    let provider: SourceControlProviderKind =
      input.provider ?? SourceControlProviderKind.make("unknown");

    if (input.provider && input.repository) {
      repository = yield* lookupRepository({
        provider: input.provider,
        repository: input.repository,
        cwd: preparedDestination.parentPath,
      });
      remoteUrl = selectRemoteUrl(repository, input.protocol);
      if (
        provider === "github" &&
        GitHubProfileAuth.approvedGitHubProfileForOwner(
          repository.nameWithOwner.split("/")[0] ?? "",
        ) !== null
      ) {
        remoteUrl = `https://github.com/${repository.nameWithOwner}.git`;
      }
      provider = input.provider;
    }

    if (!remoteUrl) {
      return yield* new SourceControlRepositoryError({
        operation: "cloneRepository",
        provider,
        detail: "Enter a repository path or clone URL before cloning.",
      });
    }
    const managedSsh =
      /^git@github\.com:(awtprod|ccn|charlottecomedynetwork)\/([A-Za-z0-9_.-]+)\.git$/iu.exec(
        remoteUrl,
      );
    if (managedSsh !== null) {
      remoteUrl = `https://github.com/${managedSsh[1]}/${managedSsh[2]}.git`;
    }

    return {
      destinationPath: preparedDestination.destinationPath,
      remoteUrl: redactRemoteUrl(remoteUrl),
      cloneUrl: remoteUrl,
      repository,
    } satisfies SourceControlPreparedClone;
  });

  const cloneRepository = Effect.fn("SourceControlRepositoryService.cloneRepository")(function* (
    input: SourceControlCloneRepositoryInput,
    options?: SourceControlCloneOptions,
  ) {
    const prepared = yield* prepareClone(input);
    const managedUrl =
      /^https:\/\/github\.com\/(awtprod|ccn|charlottecomedynetwork)\/([A-Za-z0-9_.-]+)\.git$/iu.exec(
        prepared.cloneUrl,
      );
    const selectedProfile =
      managedUrl === null
        ? null
        : GitHubProfileAuth.approvedGitHubProfileForOwner(managedUrl[1] ?? "");
    const profile =
      selectedProfile === null
        ? null
        : yield* profileAuth.get(selectedProfile).pipe(
            Effect.mapError(
              () =>
                new SourceControlRepositoryError({
                  operation: "cloneRepository",
                  provider: SourceControlProviderKind.make("github"),
                  detail: `GitHub profile ${selectedProfile} is unavailable.`,
                }),
            ),
          );
    const trustedConfig =
      profile === null
        ? undefined
        : {
            remoteUrl: prepared.cloneUrl,
            key: `http.${prepared.cloneUrl}.extraheader`,
            value: Redacted.make(
              `AUTHORIZATION: basic ${Base64.encode(`x-access-token:${Redacted.value(profile.token)}`)}`,
            ),
          };
    const onProgress = options?.onProgress;
    // Git interleaves progress redraws with its real messages on stderr. The
    // last non-progress lines are what explain a failure ("Repository not
    // found", "Permission denied"), so keep them for the error detail.
    const stderrTail: Array<string> = [];
    const onStderrLine = (line: string) => {
      const parsed = parseGitCloneProgressLine(line);
      if (parsed) return onProgress ? onProgress(parsed) : Effect.void;
      return Effect.sync(() => {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith("Cloning into")) return;
        // Git echoes the remote in some failures; the tail becomes user-facing text.
        stderrTail.push(redactUrlCredentials(trimmed));
        if (stderrTail.length > 4) stderrTail.shift();
      });
    };
    yield* git
      .execute({
        operation: "SourceControlRepositoryService.cloneRepository",
        cwd: path.dirname(prepared.destinationPath),
        args: [
          "clone",
          "--progress",
          "--",
          prepared.cloneUrl,
          path.basename(prepared.destinationPath),
        ],
        timeoutMs: options?.timeoutMs === undefined ? CLONE_TIMEOUT_MS : options.timeoutMs,
        // Progress redraws add up on a slow multi-GB clone. The buffered copy
        // is never read (the tail is kept by hand above), so keep it small
        // and let the line callbacks keep flowing past the cap.
        maxOutputBytes: 256 * 1024,
        appendTruncationMarker: true,
        keepLineCallbacksAfterTruncation: true,
        env: CLONE_ENV,
        ...(trustedConfig === undefined ? {} : { trustedConfig }),
        progress: { onStderrLine },
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new SourceControlRepositoryError({
              operation: "cloneRepository",
              provider: input.provider ?? SourceControlProviderKind.make("unknown"),
              detail:
                stderrTail.length > 0
                  ? stderrTail.join(" ")
                  : "The repository could not be cloned.",
              cause,
            }),
        ),
      );

    return {
      cwd: prepared.destinationPath,
      remoteUrl: prepared.remoteUrl,
      repository: prepared.repository,
    };
  });

  const discardClone = Effect.fn("SourceControlRepositoryService.discardClone")(function* (
    destinationPath: string,
  ) {
    const normalized = yield* normalizeDestinationPath(destinationPath);
    // Only what git left behind may go. The destination was empty when the
    // clone started, so anything without a `.git` inside was put there by
    // someone else since; refuse rather than delete their files.
    // A missing destination is already discarded; any other read failure
    // (a file in its place, permissions) is not something to remove through.
    const entries = yield* fileSystem.readDirectory(normalized).pipe(
      Effect.catchIf(
        (cause) => cause.reason._tag === "NotFound",
        () => Effect.succeed<ReadonlyArray<string>>([]),
      ),
      Effect.mapError(
        (cause) =>
          new SourceControlRepositoryError({
            operation: "discardClone",
            provider: SourceControlProviderKind.make("unknown"),
            detail: "The clone destination could not be inspected.",
            cause,
          }),
      ),
    );
    if (entries.length > 0 && !entries.includes(".git")) {
      return yield* new SourceControlRepositoryError({
        operation: "discardClone",
        provider: SourceControlProviderKind.make("unknown"),
        detail: "Destination path contains files that are not from the clone.",
      });
    }
    // The directory itself is the project's workspace root and must stay;
    // only git's partial contents go. An interrupted git may still be closing
    // files, so removal retries briefly.
    yield* fileSystem.remove(normalized, { recursive: true, force: true }).pipe(
      Effect.andThen(fileSystem.makeDirectory(normalized, { recursive: true })),
      Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 5 }),
      Effect.mapError(
        (cause) =>
          new SourceControlRepositoryError({
            operation: "discardClone",
            provider: SourceControlProviderKind.make("unknown"),
            detail: "The partial clone could not be removed.",
            cause,
          }),
      ),
    );
  });

  const publishRepository = Effect.fn("SourceControlRepositoryService.publishRepository")(
    function* (input: SourceControlPublishRepositoryInput) {
      const providerKind = yield* ensureConcreteProvider({
        operation: "publishRepository",
        provider: input.provider,
      });
      const provider = yield* providers.get(providerKind);
      const selected =
        providerKind === "github"
          ? managedGitHubRepository(input.repository)
          : { profile: null, repository: input.repository.trim() };
      const repository = selected.repository;
      const selectedProfile = selected.profile;
      const preferredName = input.remoteName?.trim() || "origin";
      if (selectedProfile !== null && !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(preferredName)) {
        return yield* new SourceControlRepositoryError({
          operation: "publishRepository",
          provider: providerKind,
          detail: "Choose a valid Git remote name.",
        });
      }
      const profile =
        selectedProfile === null
          ? null
          : yield* profileAuth.get(selectedProfile).pipe(
              Effect.mapError(
                () =>
                  new SourceControlRepositoryError({
                    operation: "publishRepository",
                    provider: providerKind,
                    detail: `GitHub profile ${selectedProfile} is unavailable.`,
                  }),
              ),
            );
      if (input.resumeExisting && profile === null) {
        return yield* new SourceControlRepositoryError({
          operation: "publishRepository",
          provider: providerKind,
          detail: "Continuing an existing repository requires a selected GitHub profile.",
        });
      }
      const create = provider.createRepository({
        cwd: input.cwd,
        repository,
        visibility: input.visibility,
      });
      const loadRepository = input.resumeExisting
        ? Effect.gen(function* () {
            if (provider.getRepositoryVisibility === undefined) {
              return yield* new SourceControlRepositoryError({
                operation: "publishRepository",
                provider: providerKind,
                detail: "This provider cannot verify an existing repository.",
              });
            }
            const urls = yield* provider.getRepositoryCloneUrls({ cwd: input.cwd, repository });
            const visibility = yield* provider.getRepositoryVisibility({
              cwd: input.cwd,
              repository,
            });
            if (visibility !== input.visibility) {
              return yield* new SourceControlRepositoryError({
                operation: "publishRepository",
                provider: providerKind,
                detail: "Existing repository visibility differs from the selected visibility.",
              });
            }
            return urls;
          })
        : create;
      const urls = yield* profile === null
        ? loadRepository
        : loadRepository.pipe(
            Effect.provideService(GitHubApi.PinnedGitHubCredential, {
              host: "github.com",
              token: profile.token,
              credentialFingerprint: profile.fingerprint,
            }),
          );
      if (
        profile !== null &&
        (urls.nameWithOwner.toLowerCase() !== repository.toLowerCase() ||
          urls.url !== `https://github.com/${urls.nameWithOwner}` ||
          urls.sshUrl !== `git@github.com:${urls.nameWithOwner}.git`)
      ) {
        return yield* new SourceControlRepositoryError({
          operation: "publishRepository",
          provider: providerKind,
          detail: "GitHub returned a repository different from the selected account and name.",
        });
      }
      const remoteUrl =
        profile === null
          ? selectRemoteUrl(urls, input.protocol)
          : `https://github.com/${urls.nameWithOwner}.git`;
      if (input.resumeExisting) {
        const existing = yield* git.execute({
          operation: "SourceControlRepositoryService.publishRepository.existingRemote",
          cwd: input.cwd,
          args: ["remote", "get-url", "--push", "--all", preferredName],
          allowNonZeroExit: true,
        });
        const existingUrl = existing.stdout.trim();
        if (
          existing.exitCode === 0 &&
          existingUrl !== "" &&
          existingUrl !== remoteUrl &&
          existingUrl !== urls.sshUrl
        ) {
          return yield* new SourceControlRepositoryError({
            operation: "publishRepository",
            provider: providerKind,
            detail: "The selected remote points to a different repository.",
          });
        }
      }
      const remoteOutcome = yield* Effect.result(
        git.ensureRemote({
          cwd: input.cwd,
          preferredName,
          url: remoteUrl,
        }),
      );
      const partial = (
        status: "remote_failed" | "push_failed",
        remoteName: string,
        error?: GitCommandError,
      ) =>
        git
          .execute({
            operation: "SourceControlRepositoryService.publishRepository.partialBranch",
            cwd: input.cwd,
            args: ["branch", "--show-current"],
            allowNonZeroExit: true,
          })
          .pipe(
            Effect.map((result) => result.stdout.trim() || "HEAD"),
            Effect.orElseSucceed(() => "HEAD"),
            Effect.map((branch) => ({
              repository: toRepositoryInfo(providerKind, urls),
              remoteName,
              remoteUrl,
              branch,
              status,
              ...(error?.reason === undefined ? {} : { failureReason: error.reason }),
            })),
          );
      if (Result.isFailure(remoteOutcome)) {
        if (profile === null) return yield* remoteOutcome.failure;
        return yield* partial("remote_failed", preferredName, remoteOutcome.failure);
      }
      const remoteName = remoteOutcome.success;
      if (profile !== null) {
        const readRemoteUrls = Effect.gen(function* () {
          const [fetch, push, effective] = yield* Effect.all([
            git.execute({
              operation: "SourceControlRepositoryService.publishRepository.fetchUrl",
              cwd: input.cwd,
              args: ["config", "--get-all", `remote.${remoteName}.url`],
              allowNonZeroExit: true,
            }),
            git.execute({
              operation: "SourceControlRepositoryService.publishRepository.pushUrl",
              cwd: input.cwd,
              args: ["config", "--get-all", `remote.${remoteName}.pushurl`],
              allowNonZeroExit: true,
            }),
            git.execute({
              operation: "SourceControlRepositoryService.publishRepository.effectivePushUrl",
              cwd: input.cwd,
              args: ["remote", "get-url", "--push", "--all", remoteName],
              allowNonZeroExit: true,
            }),
          ]);
          return {
            fetch: fetch.exitCode === 0 ? fetch.stdout.trim() : "",
            push: push.exitCode === 0 ? push.stdout.trim() : "",
            effective: effective.exitCode === 0 ? effective.stdout.trim() : "",
          };
        });
        const safeRemote = yield* Effect.result(
          Effect.gen(function* () {
            let configured = yield* readRemoteUrls;
            if (
              configured.fetch === urls.sshUrl &&
              (configured.push === "" || configured.push === urls.sshUrl) &&
              configured.effective === urls.sshUrl
            ) {
              yield* git.execute({
                operation: "SourceControlRepositoryService.publishRepository.useHttps",
                cwd: input.cwd,
                args: ["remote", "set-url", remoteName, remoteUrl],
              });
              if (configured.push !== "") {
                yield* git.execute({
                  operation: "SourceControlRepositoryService.publishRepository.useHttpsPush",
                  cwd: input.cwd,
                  args: ["remote", "set-url", "--push", remoteName, remoteUrl, urls.sshUrl],
                });
              }
              configured = yield* readRemoteUrls;
            }
            return (
              configured.fetch === remoteUrl &&
              (configured.push === "" || configured.push === remoteUrl) &&
              configured.effective === remoteUrl
            );
          }),
        );
        if (Result.isFailure(safeRemote) || !safeRemote.success) {
          return yield* partial("remote_failed", remoteName);
        }
      }

      // An empty local repo (no commits) would make `git push HEAD:...` fail
      // with an opaque "src refspec HEAD does not match any". Treat this as a
      // partial success: the remote was created and wired up, but there is
      // nothing to push yet.
      const hasCommits = yield* git
        .execute({
          operation: "SourceControlRepositoryService.publishRepository.headCheck",
          cwd: input.cwd,
          args: ["rev-parse", "--verify", "HEAD"],
        })
        .pipe(
          Effect.map(() => true),
          Effect.orElseSucceed(() => false),
        );
      if (!hasCommits) {
        const details = yield* git.statusDetails(input.cwd).pipe(Effect.orElseSucceed(() => null));
        return {
          repository: toRepositoryInfo(providerKind, urls),
          remoteName,
          remoteUrl,
          branch: details?.branch ?? "main",
          status: "remote_added" as const,
        };
      }

      const pushOutcome = yield* Effect.result(
        git.pushCurrentBranch(input.cwd, null, { remoteName }),
      );
      if (Result.isFailure(pushOutcome)) {
        if (profile === null) return yield* pushOutcome.failure;
        return yield* partial("push_failed", remoteName, pushOutcome.failure);
      }
      const pushResult = pushOutcome.success;

      return {
        repository: toRepositoryInfo(providerKind, urls),
        remoteName,
        remoteUrl,
        branch: pushResult.branch,
        ...(pushResult.upstreamBranch ? { upstreamBranch: pushResult.upstreamBranch } : {}),
        status: "pushed" as const,
      };
    },
  );

  return SourceControlRepositoryService.of({
    lookupRepository: (input) =>
      lookupRepository(input).pipe(mapRepositoryError("lookupRepository", input.provider)),
    prepareClone: (input) =>
      prepareClone(input).pipe(
        mapRepositoryError(
          "cloneRepository",
          input.provider ?? SourceControlProviderKind.make("unknown"),
        ),
      ),
    cloneRepository: (input, options) =>
      cloneRepository(input, options).pipe(
        mapRepositoryError(
          "cloneRepository",
          input.provider ?? SourceControlProviderKind.make("unknown"),
        ),
      ),
    discardClone: (destinationPath) =>
      discardClone(destinationPath).pipe(
        mapRepositoryError("discardClone", SourceControlProviderKind.make("unknown")),
      ),
    publishRepository: (input) =>
      publishRepository(input).pipe(mapRepositoryError("publishRepository", input.provider)),
  });
});

export const layer = Layer.effect(SourceControlRepositoryService, make);
