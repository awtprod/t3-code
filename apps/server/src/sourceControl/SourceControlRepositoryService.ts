import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import {
  GitCommandError,
  SourceControlProviderError,
  SourceControlRepositoryError,
  type GitCommandFailureReason,
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
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import {
  parseGitCloneProgressLine,
  type GitCloneProgressLine,
} from "../project/gitCloneProgress.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { AUTHENTICATED_CLONE_OPERATION } from "../vcs/GitVcsDriverCore.ts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
import * as GitHubProfileAuth from "./GitHubProfileAuth.ts";
import * as GitHubRequestPolicy from "@t3tools/source-control-github/server/GitHubRequestPolicy";
import { parseGitHubRepositorySelector } from "@t3tools/source-control-github/server/gitHubRepositoryResolution";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { cloneUrlForProtocol, cloneUrlProtocol } from "@t3tools/shared/cloneUrl";
const isSourceControlRepositoryError = Schema.is(SourceControlRepositoryError);
const isSourceControlProviderError = Schema.is(SourceControlProviderError);
const isGitCommandError = Schema.is(GitCommandError);

export class SourceControlRepositoryService extends Context.Service<
  SourceControlRepositoryService,
  {
    readonly lookupRepository: (
      input: SourceControlRepositoryLookupInput,
    ) => Effect.Effect<SourceControlRepositoryInfo, SourceControlRepositoryError>;
    readonly prepareClone: (
      input: SourceControlCloneRepositoryInput,
    ) => Effect.Effect<SourceControlPreparedClone, SourceControlRepositoryError>;
    readonly cloneRepository: (
      input: SourceControlCloneRepositoryInput,
      options?: SourceControlCloneOptions,
    ) => Effect.Effect<SourceControlCloneRepositoryResult, SourceControlRepositoryError>;
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
  readonly remoteUrl: string;
  readonly cloneUrl: string;
  readonly repository: SourceControlRepositoryInfo | null;
}

export interface SourceControlCloneOptions {
  readonly onProgress?: (line: GitCloneProgressLine) => Effect.Effect<void>;
  /** Overrides the default clone budget; `null` disables the deadline. */
  readonly timeoutMs?: number | null;
}

// Older/mobile synchronous RPCs need deadlines; tracked clones use progress and Cancel instead.
const CLONE_TIMEOUT_MS = 120_000;
const CLONE_ENV = {
  // Force piped progress immediately; refuse credential prompts that would hang without a tty.
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
            (isSourceControlProviderError(cause)
              ? SourceControlProvider.userFacingSourceControlDetail(cause.cause)
              : undefined) ?? "The source control operation could not be completed.",
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

// Redact credentials from client clone snapshots; git still receives the original URL.
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

// Userinfo can contain @; remove through the last one before the host boundary.
const URL_WITH_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/]+@/gi;

function redactUrlCredentials(text: string): string {
  return text.replace(URL_WITH_USERINFO, "$1");
}

// The remote already exists after push failure; advise fixing access and pushing.
// Use fixed text and provider URLs because git stderr can expose credentials.
function publishPushFailureDetail(input: {
  readonly urls: SourceControlRepositoryCloneUrls;
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly reason: GitCommandFailureReason | undefined;
}): string {
  const created = `Created ${input.urls.nameWithOwner} and added it as remote "${input.remoteName}", but the push failed`;
  const switchToHttps = `git remote set-url ${input.remoteName} ${input.urls.url}`;
  const usesSsh = input.remoteUrl === input.urls.sshUrl;
  switch (input.reason) {
    case "authentication_failed":
      return usesSsh
        ? `${created} because SSH authentication was rejected. Add an SSH key to your account, or switch the remote to HTTPS with "${switchToHttps}", then push again.`
        : `${created} because Git could not authenticate. Check your Git credentials, then push again.`;
    case "host_key_unverified":
      return `${created} because the host's SSH key is not trusted yet. Verify it by connecting once with ssh, or switch the remote to HTTPS with "${switchToHttps}", then push again.`;
    default:
      return `${created}. Fix the problem, then push again.`;
  }
}

/**
 * SSH rejection can be retried over HTTPS when the host's credential helper is available.
 * Explicit SSH requests must not fall back; unknown URL shapes must not be guessed.
 */
function httpsFallbackUrl(
  input: SourceControlCloneRepositoryInput,
  prepared: SourceControlPreparedClone,
): string | null {
  if (input.protocol === "ssh" || cloneUrlProtocol(prepared.cloneUrl) !== "ssh") return null;
  if (prepared.repository?.sshUrl === prepared.cloneUrl) return prepared.repository.url;
  return cloneUrlForProtocol(prepared.cloneUrl, "https");
}

const isSshRejection = (error: SourceControlRepositoryError) =>
  isGitCommandError(error.cause) &&
  (error.cause.reason === "authentication_failed" || error.cause.reason === "host_key_unverified");

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

/**
 * A github.com clone URL in a form GitHub hands out: HTTPS, scp-style SSH, or
 * an SSH URL. Other hosts, SSH aliases, userinfo, and extra path segments do
 * not match.
 */
const GITHUB_CLONE_URL =
  /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/iu;

/**
 * The HTTPS clone URL for a repository whose owner has an approved GitHub
 * profile, or null. The driver authenticates that URL with the owner's profile
 * (AUTHENTICATED_CLONE_OPERATION); SSH would instead depend on keys and host
 * keys the server may not have. publishRepository applies the same rule.
 */
function managedGitHubCloneUrl(remoteUrl: string): string | null {
  const match = GITHUB_CLONE_URL.exec(remoteUrl.trim());
  const owner = match?.[1];
  const name = match?.[2];
  if (!owner || !name || name === "." || name === "..") return null;
  return GitHubProfileAuth.approvedGitHubProfileForOwner(owner) === null
    ? null
    : `https://github.com/${owner}/${name}.git`;
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

/** @public */
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

  const lookupRepository = Effect.fn("SourceControlRepositoryService.lookupRepository")(
    function* (input: SourceControlRepositoryLookupInput) {
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
            Effect.provideService(GitHubRequestPolicy.PinnedGitHubCredential, {
              host: "github.com",
              token: profile.token,
              credentialFingerprint: profile.fingerprint,
            }),
          );
      return toRepositoryInfo(providerKind, urls);
    },
    // Someone adding or cloning a repository is waiting, so a background rate-limit pause must not
    // refuse the lookup.
    Effect.provideService(SourceControlRateLimit.Interactive, true),
  );

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
        // Skip existing parents: recursive mkdir on a Windows drive root fails with EPERM.
        const parentPath = path.dirname(normalizedDestination);
        if (!(yield* fileSystem.exists(parentPath))) {
          yield* fileSystem.makeDirectory(parentPath, { recursive: true });
        }
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
      provider = input.provider;
    }

    if (!remoteUrl) {
      return yield* new SourceControlRepositoryError({
        operation: "cloneRepository",
        provider,
        detail: "Enter a repository path or clone URL before cloning.",
      });
    }
    // Clients pick the transport (the add-project palette sends GitHub's SSH
    // URL), but a managed owner is cloned over HTTPS with its profile.
    const cloneUrl = managedGitHubCloneUrl(remoteUrl) ?? remoteUrl;
    return {
      destinationPath: preparedDestination.destinationPath,
      remoteUrl: redactRemoteUrl(cloneUrl),
      cloneUrl,
      repository,
    } satisfies SourceControlPreparedClone;
  });

  const runClone = Effect.fn("SourceControlRepositoryService.runClone")(function* (
    input: SourceControlCloneRepositoryInput,
    destinationPath: string,
    cloneUrl: string,
    options?: SourceControlCloneOptions,
  ) {
    const onProgress = options?.onProgress;
    // Git mixes progress and diagnostics on stderr; retain non-progress tail lines for failure details.
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
        // The driver adds the owner's profile header only for a managed
        // GitHub HTTPS URL; any other clone runs exactly as before.
        operation: AUTHENTICATED_CLONE_OPERATION,
        cwd: path.dirname(destinationPath),
        args: ["clone", "--progress", "--", cloneUrl, path.basename(destinationPath)],
        timeoutMs: options?.timeoutMs === undefined ? CLONE_TIMEOUT_MS : options.timeoutMs,
        // Buffered output is unused and progress can be huge; cap it while retaining line callbacks.
        maxOutputBytes: 256 * 1024,
        appendTruncationMarker: true,
        keepLineCallbacksAfterTruncation: true,
        env: CLONE_ENV,
        progress: { onStderrLine },
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new SourceControlRepositoryError({
              operation: "cloneRepository",
              provider: input.provider ?? SourceControlProviderKind.make("unknown"),
              // Without an exit code git never ran (e.g. the profile for a
              // managed owner is unavailable); the driver's detail says why.
              detail:
                stderrTail.length > 0
                  ? stderrTail.join(" ")
                  : cause.exitCode === undefined
                    ? cause.detail
                    : "The repository could not be cloned.",
              cause,
            }),
        ),
      );
  });

  const cloneRepository = Effect.fn("SourceControlRepositoryService.cloneRepository")(function* (
    input: SourceControlCloneRepositoryInput,
    options?: SourceControlCloneOptions,
  ) {
    const prepared = yield* prepareClone(input);
    const httpsUrl = httpsFallbackUrl(input, prepared);
    const remoteUrl = yield* runClone(
      input,
      prepared.destinationPath,
      prepared.cloneUrl,
      options,
    ).pipe(
      Effect.as(prepared.remoteUrl),
      // @effect-diagnostics-next-line catchConditionalRefailToCatchIf:off - The condition also narrows httpsUrl for the fallback closure.
      Effect.catch((sshError) =>
        httpsUrl === null || !isSshRejection(sshError)
          ? Effect.fail(sshError)
          : runClone(input, prepared.destinationPath, httpsUrl, options).pipe(
              Effect.as(redactRemoteUrl(httpsUrl)),
              Effect.mapError(
                (httpsError) =>
                  new SourceControlRepositoryError({
                    operation: "cloneRepository",
                    provider: sshError.provider,
                    detail: `${sshError.detail} Cloning over HTTPS instead also failed: ${httpsError.detail}`,
                    cause: httpsError.cause,
                  }),
              ),
            ),
      ),
    );

    return {
      cwd: prepared.destinationPath,
      remoteUrl,
      repository: prepared.repository,
    };
  });

  const discardClone = Effect.fn("SourceControlRepositoryService.discardClone")(function* (
    destinationPath: string,
  ) {
    const normalized = yield* normalizeDestinationPath(destinationPath);
    // Only .git-bearing partial clones may be deleted; other files arrived after the empty-directory check.
    // Missing destinations are already discarded; other read failures must refuse removal.
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
    // Preserve the workspace directory after removing partial contents; retry while interrupted git closes files.
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
            if (
              provider.getRepositoryVisibility === undefined ||
              provider.getRepositoryIsEmpty === undefined
            ) {
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
            const isEmpty = yield* provider.getRepositoryIsEmpty({
              cwd: input.cwd,
              repository,
            });
            if (!isEmpty) {
              return yield* new SourceControlRepositoryError({
                operation: "publishRepository",
                provider: providerKind,
                detail: "The existing repository contains source. Inspect it before pushing.",
              });
            }
            return urls;
          })
        : create;
      const urls = yield* profile === null
        ? loadRepository
        : loadRepository.pipe(
            Effect.provideService(GitHubRequestPolicy.PinnedGitHubCredential, {
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

      // Empty repos cannot push HEAD; report partial success because the remote already exists.
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
        // A managed GitHub profile reports a partial publish; otherwise explain the failed push.
        if (profile !== null) return yield* partial("push_failed", remoteName, pushOutcome.failure);
        const cause = pushOutcome.failure;
        return yield* new SourceControlRepositoryError({
          operation: "publishRepository",
          provider: providerKind,
          detail: publishPushFailureDetail({ urls, remoteName, remoteUrl, reason: cause.reason }),
          cause,
        });
      }
      const pushResult = pushOutcome.success;

      return {
        repository: toRepositoryInfo(providerKind, urls),
        remoteName,
        remoteUrl,
        branch: pushResult.branch,
        status: "pushed" as const,
      };
    },
  );

  // Forwarders retain the underlying operation spans.
  return SourceControlRepositoryService.of({
    lookupRepository: Effect.fnUntraced(function* (input) {
      return yield* lookupRepository(input).pipe(
        mapRepositoryError("lookupRepository", input.provider),
      );
    }),
    prepareClone: Effect.fnUntraced(function* (input) {
      return yield* prepareClone(input).pipe(
        mapRepositoryError(
          "cloneRepository",
          input.provider ?? SourceControlProviderKind.make("unknown"),
        ),
      );
    }),
    cloneRepository: Effect.fnUntraced(function* (input, options) {
      return yield* cloneRepository(input, options).pipe(
        mapRepositoryError(
          "cloneRepository",
          input.provider ?? SourceControlProviderKind.make("unknown"),
        ),
      );
    }),
    discardClone: Effect.fnUntraced(function* (destinationPath) {
      return yield* discardClone(destinationPath).pipe(
        mapRepositoryError("discardClone", SourceControlProviderKind.make("unknown")),
      );
    }),
    publishRepository: Effect.fnUntraced(function* (input) {
      return yield* publishRepository(input).pipe(
        mapRepositoryError("publishRepository", input.provider),
      );
    }),
  });
});

export const layer = Layer.effect(SourceControlRepositoryService, make);
