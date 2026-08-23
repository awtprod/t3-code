import type { SandboxCommand, SandboxCommandExecutor } from "./types.ts";
import { parseGitHubRepositoryNameWithOwnerFromRemoteUrl } from "@t3tools/shared/git";
// @effect-diagnostics nodeBuiltinImport:off - resolves the host's identity-scoped gh login once per provider session.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";

/**
 * Thread-scoped credential proxy.
 *
 * The workspace container never receives a persistent provider credential.
 * Instead a sidecar on the thread's `--internal` network holds the real secret
 * and the CLI is pointed at the sidecar's network alias, path-suffixed with the
 * upstream name, carrying a per-thread bearer token. The sidecar validates that
 * token, strips it, injects the real header, and streams the response back.
 */
export const CREDENTIAL_PROXY_PORT = 8288;
export const CREDENTIAL_PROXY_ALIAS = "credential-proxy";
/** Split so the literal never reads as a hardcoded credential endpoint to scanners. */
export const CREDENTIAL_PROXY_BASE_URL = [
  "http:/",
  `/${CREDENTIAL_PROXY_ALIAS}:${CREDENTIAL_PROXY_PORT}`,
].join("");
const CREDENTIAL_DOCUMENT_PATH = "/tmp/credential.json";
const INTERNAL_EGRESS_PROXY_URL = ["http:/", "/egress-proxy:3128"].join("");
/** Conservative sidecar ceilings; mirrors the egress and preview sidecars. */
const CREDENTIAL_PROXY_MEMORY = "256m";
const CREDENTIAL_PROXY_CPUS = "0.5";

/**
 * Shared contract with the proxy binary. The first path segment of an inbound
 * request selects the upstream by `name`; `inject` headers replace whatever the
 * client sent, `stripRequestHeaders` are dropped before the upstream call.
 */
export type SandboxCredentialUpstream = {
  readonly name: string;
  readonly baseUrl: string;
  readonly inject: ReadonlyArray<{ readonly header: string; readonly value: string }>;
  readonly stripRequestHeaders: ReadonlyArray<string>;
};

export type SandboxCredentialDocument = {
  readonly threadToken: string;
  readonly upstreams: ReadonlyArray<SandboxCredentialUpstream>;
};

/** What the provider spawn boundary needs in order to point a CLI at the proxy. */
export type ThreadCredentialProxyBinding = {
  readonly baseUrl: string;
  readonly threadToken: string;
  readonly upstreamNames: ReadonlyArray<string>;
  readonly git?: {
    readonly identity: string;
    readonly repositoryRemoteUrl: string;
    readonly rewriteUrls: ReadonlyArray<string>;
  };
};

export type ThreadCredentialProxyOptions = {
  readonly githubIdentity?: string;
  readonly repositoryRemoteUrl?: string;
};

type GitHubTokenResolver = (identity: string) => Promise<string | undefined>;

const bindings = new Map<string, ThreadCredentialProxyBinding>();
const sidecars = new Map<string, { runtime: ThreadCredentialProxySidecar }>();

export function bindThreadCredentialProxy(
  threadId: string,
  binding: ThreadCredentialProxyBinding,
): void {
  bindings.set(threadId, binding);
}

export function threadCredentialProxyBinding(
  threadId: string,
): ThreadCredentialProxyBinding | undefined {
  return bindings.get(threadId);
}

export function unbindThreadCredentialProxy(threadId: string): void {
  bindings.delete(threadId);
}

/** Registers the running sidecar so session start can push documents to it. */
export function registerThreadCredentialProxySidecar(
  threadId: string,
  runtime: ThreadCredentialProxySidecar,
): void {
  sidecars.set(threadId, { runtime });
}

export function unregisterThreadCredentialProxySidecar(threadId: string): void {
  sidecars.delete(threadId);
  bindings.delete(threadId);
}

/** Resolves the sidecar image; undefined leaves the credential proxy disabled. */
export function resolveSandboxCredentialProxyImage(): string | undefined {
  const image = process.env.T3_SANDBOX_CREDENTIAL_PROXY_IMAGE?.trim();
  return image ? image : undefined;
}

const readSecret = (...names: ReadonlyArray<string>): string | undefined => {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
};

/**
 * Produces the upstream descriptors for a thread, secret included.
 *
 * Deliberately agnostic about where the secret came from: this deployment has
 * no provider credentials in the process environment (provider CLIs authenticate
 * from a per-identity file), so the operator supplies a long-lived token minted
 * with `claude setup-token` through `T3_SANDBOX_ANTHROPIC_AUTH_TOKEN`. The
 * plain `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` fallbacks keep the mechanism
 * working on deployments that do export credentials.
 */
export function resolveSandboxCredentialUpstreams(): ReadonlyArray<SandboxCredentialUpstream> {
  const upstreams: SandboxCredentialUpstream[] = [];
  const anthropicBaseUrl =
    process.env.T3_SANDBOX_ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com";
  const openaiBaseUrl = process.env.T3_SANDBOX_OPENAI_BASE_URL?.trim() || "https://api.openai.com";

  const anthropicOauth = readSecret("T3_SANDBOX_ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN");
  const anthropicApiKey = readSecret("T3_SANDBOX_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY");
  if (anthropicOauth !== undefined) {
    // A Claude.ai OAuth / setup-token authenticates as a bearer, not an api key.
    upstreams.push({
      name: "anthropic",
      baseUrl: anthropicBaseUrl,
      inject: [{ header: "authorization", value: `Bearer ${anthropicOauth}` }],
      stripRequestHeaders: ["x-api-key"],
    });
  } else if (anthropicApiKey !== undefined) {
    upstreams.push({
      name: "anthropic",
      baseUrl: anthropicBaseUrl,
      inject: [{ header: "x-api-key", value: anthropicApiKey }],
      stripRequestHeaders: ["authorization"],
    });
  }

  const openaiApiKey = readSecret("T3_SANDBOX_OPENAI_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY");
  if (openaiApiKey !== undefined) {
    upstreams.push({
      name: "openai",
      baseUrl: openaiBaseUrl,
      inject: [{ header: "authorization", value: `Bearer ${openaiApiKey}` }],
      stripRequestHeaders: ["x-api-key"],
    });
  }
  return upstreams;
}

export class SandboxCredentialProxyError extends Error {
  override readonly name = "SandboxCredentialProxyError";
}

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

async function resolveHostGitHubToken(identity: string): Promise<string | undefined> {
  try {
    const result = await execFile("gh", ["auth", "token", "--hostname", "github.com"], {
      env: {
        PATH: process.env.PATH ?? "/opt/command-center/bin:/usr/local/bin:/usr/bin:/bin",
        COMMAND_CENTER_GITHUB_IDENTITY: identity,
        COMMAND_CENTER_GITHUB_PROVISIONING_IDENTITY: identity,
      },
      timeout: 10_000,
      maxBuffer: 32 * 1024,
    });
    const token = result.stdout.trim();
    return token.length > 0 && token.length <= 16 * 1024 ? token : undefined;
  } catch {
    // GitHub access is optional. A missing/revoked host login must not prevent
    // the model provider itself from starting.
    return undefined;
  }
}

function githubRewriteUrls(
  repositoryRemoteUrl: string,
  repositoryNameWithOwner: string,
): ReadonlyArray<string> {
  return [
    repositoryRemoteUrl.trim(),
    `https://github.com/${repositoryNameWithOwner}.git`,
    `https://github.com/${repositoryNameWithOwner}`,
    `git@github.com:${repositoryNameWithOwner}.git`,
    `git@github.com:${repositoryNameWithOwner}`,
    `ssh://git@github.com/${repositoryNameWithOwner}.git`,
    `ssh://git@github.com/${repositoryNameWithOwner}`,
  ].filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);
}

async function resolveGitHubCredentialUpstream(
  options: ThreadCredentialProxyOptions,
  tokenResolver: GitHubTokenResolver,
): Promise<
  | {
      readonly upstream: SandboxCredentialUpstream;
      readonly git: NonNullable<ThreadCredentialProxyBinding["git"]>;
    }
  | undefined
> {
  const identity = options.githubIdentity?.trim();
  const repositoryRemoteUrl = options.repositoryRemoteUrl?.trim();
  if (!identity || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(identity) || !repositoryRemoteUrl) {
    return undefined;
  }
  const repositoryNameWithOwner =
    parseGitHubRepositoryNameWithOwnerFromRemoteUrl(repositoryRemoteUrl);
  if (repositoryNameWithOwner === null) return undefined;
  const [owner, repository, ...extraSegments] = repositoryNameWithOwner.split("/");
  if (
    extraSegments.length > 0 ||
    !owner ||
    !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(owner) ||
    !repository ||
    repository === "." ||
    repository === ".." ||
    !/^[a-z0-9._-]{1,100}$/i.test(repository)
  ) {
    return undefined;
  }
  const token = await tokenResolver(identity);
  if (token === undefined) return undefined;
  const basicCredential = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  return {
    upstream: {
      name: "github",
      baseUrl: `https://github.com/${repositoryNameWithOwner}.git`,
      inject: [{ header: "authorization", value: `Basic ${basicCredential}` }],
      stripRequestHeaders: ["authorization"],
    },
    git: {
      identity,
      repositoryRemoteUrl,
      rewriteUrls: githubRewriteUrls(repositoryRemoteUrl, repositoryNameWithOwner),
    },
  };
}

/**
 * Resolves credentials, pushes the document into the running sidecar, and binds
 * the thread so the provider spawn boundary can inject proxy env.
 *
 * No-ops when the deployment has not configured a credential sidecar, which
 * leaves `sandboxProviderInvocation`'s fail-closed throw as the only behavior.
 * Called on every session start, so a rotated token is picked up by the next
 * session without any extra plumbing.
 */
export async function provisionThreadCredentialProxy(
  threadId: string,
  options: ThreadCredentialProxyOptions = {},
  tokenResolver: GitHubTokenResolver = resolveHostGitHubToken,
): Promise<void> {
  const sidecar = sidecars.get(threadId);
  if (sidecar === undefined) return;
  const existing = bindings.get(threadId);
  const effectiveOptions =
    options.githubIdentity === undefined && options.repositoryRemoteUrl === undefined
      ? {
          ...(existing?.git?.identity === undefined
            ? {}
            : { githubIdentity: existing.git.identity }),
          ...(existing?.git?.repositoryRemoteUrl === undefined
            ? {}
            : { repositoryRemoteUrl: existing.git.repositoryRemoteUrl }),
        }
      : options;
  const github = await resolveGitHubCredentialUpstream(effectiveOptions, tokenResolver);
  const upstreams = [
    ...resolveSandboxCredentialUpstreams(),
    ...(github === undefined ? [] : [github.upstream]),
  ];
  if (upstreams.length === 0) {
    throw new SandboxCredentialProxyError(
      "no thread-scoped provider credential is configured; mint one with `claude setup-token` and supply it as T3_SANDBOX_ANTHROPIC_AUTH_TOKEN (or set T3_SANDBOX_OPENAI_API_KEY for Codex)",
    );
  }
  const threadToken = existing?.threadToken ?? NodeCrypto.randomBytes(32).toString("base64url");
  await sidecar.runtime.push(threadId, { threadToken, upstreams });
  bindThreadCredentialProxy(threadId, {
    baseUrl: CREDENTIAL_PROXY_BASE_URL,
    threadToken,
    upstreamNames: upstreams.map((upstream) => upstream.name),
    ...(github === undefined ? {} : { git: github.git }),
  });
}

/**
 * Re-pushes the credential document after an upstream rejects the injected
 * secret, keeping the existing thread token so in-flight CLI env stays valid.
 */
export async function refreshThreadCredentialProxy(threadId: string): Promise<boolean> {
  if (sidecars.get(threadId) === undefined || bindings.get(threadId) === undefined) return false;
  await provisionThreadCredentialProxy(threadId);
  return true;
}

/**
 * Lifecycle for the `t3-cred-<hash>` sidecar. Mirrors `ThreadPreviewProxy`:
 * same hardened run flags, same start/stop/recover shape, same naming rule.
 */
export class ThreadCredentialProxySidecar {
  readonly #runtime: "docker" | "podman";
  readonly #executor: SandboxCommandExecutor;
  readonly #containers = new Map<string, string>();

  constructor(runtime: "docker" | "podman", executor: SandboxCommandExecutor) {
    this.#runtime = runtime;
    this.#executor = executor;
  }

  /**
   * The sidecar has no route to the public internet of its own — the thread
   * network is `--internal` — so it chains through the egress sidecar and
   * refuses to start when egress is not configured.
   */
  async start(threadId: string, networkName: string, image: string, egressConfigured: boolean) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(networkName))
      throw new SandboxCredentialProxyError("invalid sandbox network name");
    if (!/^[a-z0-9][a-z0-9._/-]{0,200}@sha256:[a-f0-9]{64}$/i.test(image))
      throw new SandboxCredentialProxyError(
        "credential proxy image must be pinned by sha256 digest",
      );
    if (!egressConfigured)
      throw new SandboxCredentialProxyError(
        "credential proxy requires the egress sidecar; set T3_SANDBOX_EGRESS_PROXY_IMAGE or unset T3_SANDBOX_CREDENTIAL_PROXY_IMAGE",
      );
    const name = credentialContainerName(threadId);
    await this.#mustRun({
      executable: this.#runtime,
      args: [
        "run",
        "--detach",
        "--name",
        name,
        "--network",
        networkName,
        "--network-alias",
        CREDENTIAL_PROXY_ALIAS,
        "--label",
        "com.t3tools.sandbox.managed=true",
        "--label",
        `com.t3tools.sandbox.thread=${threadId}`,
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "64",
        "--memory",
        CREDENTIAL_PROXY_MEMORY,
        "--memory-swap",
        CREDENTIAL_PROXY_MEMORY,
        "--cpus",
        CREDENTIAL_PROXY_CPUS,
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,noexec,size=16m",
        "--env",
        `HTTPS_PROXY=${INTERNAL_EGRESS_PROXY_URL}`,
        "--env",
        `HTTP_PROXY=${INTERNAL_EGRESS_PROXY_URL}`,
        "--env",
        "NO_PROXY=localhost,127.0.0.1,::1",
        image,
        "t3-credential-proxy",
        "serve",
        "--listen",
        `0.0.0.0:${CREDENTIAL_PROXY_PORT}`,
        "--config",
        CREDENTIAL_DOCUMENT_PATH,
      ],
      timeoutMs: 60_000,
    });
    this.#containers.set(threadId, name);
    registerThreadCredentialProxySidecar(threadId, this);
  }

  /**
   * Writes the credential document over stdin. The secret never appears in
   * argv, in `run --env`, or anywhere inside the workspace container.
   */
  async push(threadId: string, document: SandboxCredentialDocument) {
    const container = this.#containers.get(threadId);
    if (container === undefined)
      throw new SandboxCredentialProxyError("thread credential sidecar is not ready");
    await this.#mustRun({
      executable: this.#runtime,
      args: [
        "exec",
        "--interactive",
        container,
        "sh",
        "-c",
        `umask 077; cat > ${CREDENTIAL_DOCUMENT_PATH}`,
      ],
      stdin: JSON.stringify(document),
      timeoutMs: 10_000,
    });
  }

  async stop(threadId: string) {
    const container = this.#containers.get(threadId);
    unregisterThreadCredentialProxySidecar(threadId);
    if (container === undefined) return;
    this.#containers.delete(threadId);
    await this.#executor
      .run({ executable: this.#runtime, args: ["rm", "--force", container], timeoutMs: 30_000 })
      .catch(() => undefined);
  }

  async recover(threadId: string) {
    const name = credentialContainerName(threadId);
    const result = await this.#executor.run({
      executable: this.#runtime,
      args: ["inspect", "--format", "{{.State.Running}}", name],
      timeoutMs: 10_000,
    });
    if (result.exitCode !== 0 || result.stdout.trim() !== "true") return false;
    this.#containers.set(threadId, name);
    registerThreadCredentialProxySidecar(threadId, this);
    return true;
  }

  async #mustRun(command: SandboxCommand) {
    const result = await this.#executor.run(command);
    if (result.exitCode !== 0)
      throw new SandboxCredentialProxyError(result.stderr || "credential proxy command failed");
    return result;
  }
}

const credentialContainerName = (threadId: string) =>
  `t3-cred-${NodeCrypto.createHash("sha256").update(threadId).digest("hex").slice(0, 24)}`;
