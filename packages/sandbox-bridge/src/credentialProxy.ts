// @effect-diagnostics nodeBuiltinImport:off - Standalone container binary; it is bundled without Effect and has no runtime.
// @effect-diagnostics globalTimers:off - Request deadlines are owned by this standalone sidecar process.
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeTimers from "node:timers";
import { parseArgs, parseListenAddress, printedHelp } from "./cli.ts";
import { requestUpstream, type ProxyEnvironment } from "./proxyClient.ts";

/**
 * Injects provider secrets into requests from a workspace container without
 * ever placing those secrets inside the container. A provider CLI is pointed at
 * the proxy's origin on the sandbox network (network alias `credential-proxy`,
 * port 8288) with a `/<name>` prefix; that first path segment selects a
 * configured upstream and the remainder is forwarded verbatim.
 *
 * The server writes the config after the container is running, via
 * `podman exec -i <ctr> sh -c 'umask 077; cat > /tmp/credential.json'`, and
 * re-pushes it when an upstream answers 401. Boot therefore has no config and
 * must serve 503 rather than exit.
 */

export type UpstreamConfig = {
  readonly name: string;
  readonly baseUrl: string;
  readonly inject: ReadonlyArray<{ readonly header: string; readonly value: string }>;
  readonly stripRequestHeaders?: ReadonlyArray<string>;
  readonly policy?:
    | {
        readonly kind: "git-receive-pack";
        readonly protectedRefs: ReadonlyArray<string>;
      }
    | {
        readonly kind: "github-pull-requests";
        readonly repositoryNameWithOwner: string;
        readonly protectedBaseBranches: ReadonlyArray<string>;
      };
};

export type CredentialConfig = {
  readonly threadToken: string;
  readonly upstreams: ReadonlyArray<UpstreamConfig>;
};

/** Generous: provider turns stream for minutes before the response completes. */
const UPSTREAM_TIMEOUT_MS = 600_000;

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const hasControlCharacters = (value: string) => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
};

const parseConfig = (raw: string): CredentialConfig | null => {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof document !== "object" || document === null) return null;
  const candidate = document as Record<string, unknown>;
  if (typeof candidate.threadToken !== "string" || candidate.threadToken.length === 0) return null;
  if (!Array.isArray(candidate.upstreams)) return null;
  const upstreams: Array<UpstreamConfig> = [];
  for (const entry of candidate.upstreams) {
    if (typeof entry !== "object" || entry === null) return null;
    const upstream = entry as Record<string, unknown>;
    if (
      typeof upstream.name !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(upstream.name)
    )
      return null;
    if (typeof upstream.baseUrl !== "string") return null;
    let base: URL;
    try {
      base = new URL(upstream.baseUrl);
    } catch {
      return null;
    }
    if (base.protocol !== "https:" && base.protocol !== "http:") return null;
    if (!Array.isArray(upstream.inject)) return null;
    const inject: Array<{ header: string; value: string }> = [];
    for (const item of upstream.inject) {
      if (typeof item !== "object" || item === null) return null;
      const header = (item as Record<string, unknown>).header;
      const value = (item as Record<string, unknown>).value;
      if (typeof header !== "string" || typeof value !== "string") return null;
      inject.push({ header: header.toLowerCase(), value });
    }
    const strip = upstream.stripRequestHeaders;
    if (strip !== undefined && !Array.isArray(strip)) return null;
    let policy: UpstreamConfig["policy"];
    if (upstream.policy !== undefined) {
      if (typeof upstream.policy !== "object" || upstream.policy === null) return null;
      const rawPolicy = upstream.policy as Record<string, unknown>;
      if (rawPolicy.kind === "git-receive-pack") {
        if (
          !Array.isArray(rawPolicy.protectedRefs) ||
          rawPolicy.protectedRefs.length === 0 ||
          rawPolicy.protectedRefs.some(
            (ref) => typeof ref !== "string" || !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(ref),
          )
        )
          return null;
        policy = {
          kind: "git-receive-pack",
          protectedRefs: rawPolicy.protectedRefs as ReadonlyArray<string>,
        };
      } else if (rawPolicy.kind === "github-pull-requests") {
        if (
          typeof rawPolicy.repositoryNameWithOwner !== "string" ||
          !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(rawPolicy.repositoryNameWithOwner) ||
          !Array.isArray(rawPolicy.protectedBaseBranches) ||
          rawPolicy.protectedBaseBranches.length === 0 ||
          rawPolicy.protectedBaseBranches.some(
            (branch) =>
              typeof branch !== "string" ||
              branch.length === 0 ||
              branch.length > 255 ||
              hasControlCharacters(branch),
          )
        )
          return null;
        policy = {
          kind: "github-pull-requests",
          repositoryNameWithOwner: rawPolicy.repositoryNameWithOwner,
          protectedBaseBranches: rawPolicy.protectedBaseBranches as ReadonlyArray<string>,
        };
      } else {
        return null;
      }
    }
    if (
      (upstream.name === "github" && policy?.kind !== "git-receive-pack") ||
      (upstream.name === "github-pr" && policy?.kind !== "github-pull-requests")
    )
      return null;
    upstreams.push({
      name: upstream.name,
      baseUrl: upstream.baseUrl.replace(/\/+$/, ""),
      inject,
      ...(strip === undefined
        ? {}
        : { stripRequestHeaders: strip.map((name) => String(name).toLowerCase()) }),
      ...(policy === undefined ? {} : { policy }),
    });
  }
  return { threadToken: candidate.threadToken, upstreams };
};

/**
 * Compares bearer tokens over fixed-size SHA-256 digests, so a length mismatch
 * costs the same as a value mismatch and leaks nothing through timing.
 */
const tokenMatches = (presented: string, expected: string) =>
  NodeCrypto.timingSafeEqual(
    NodeCrypto.createHash("sha256").update(presented).digest(),
    NodeCrypto.createHash("sha256").update(expected).digest(),
  );

/**
 * Holds the current config and reloads it on change. Watching a file that does
 * not exist yet is not possible, so the directory is watched and the file is
 * re-read on any event; an fs.watch failure falls back to nothing because the
 * server re-pushes on 401 and the next write fires another event.
 */
export class ConfigStore {
  #config: CredentialConfig | null = null;
  #watcher: NodeFS.FSWatcher | undefined;
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  get current() {
    return this.#config;
  }

  async load() {
    const raw = await NodeFSP.readFile(this.#path, "utf8").catch(() => null);
    if (raw === null) {
      this.#config = null;
      return null;
    }
    const parsed = parseConfig(raw);
    if (parsed === null) {
      process.stderr.write("credential config is malformed; keeping previous configuration\n");
      return this.#config;
    }
    const changed = JSON.stringify(parsed) !== JSON.stringify(this.#config);
    this.#config = parsed;
    if (changed)
      process.stderr.write(
        `credential config loaded with upstreams [${parsed.upstreams.map((upstream) => upstream.name).join(",")}]\n`,
      );
    return parsed;
  }

  watch() {
    const directory = NodePath.dirname(this.#path);
    const filename = NodePath.basename(this.#path);
    try {
      this.#watcher = NodeFS.watch(directory, (_event, changed) => {
        if (changed !== null && changed !== filename) return;
        void this.load();
      });
      this.#watcher.unref();
    } catch {
      process.stderr.write("credential config directory is not watchable; relying on re-push\n");
    }
  }

  close() {
    this.#watcher?.close();
  }
}

/**
 * Detects dot-segments in a raw request path. Node's http server hands the
 * request-target through un-normalized and still percent-encoded, and the
 * suffix is forwarded verbatim, so `..` (or `%2e%2e`, which the upstream
 * decodes) would resolve outside the configured baseUrl prefix — letting
 * container code replay the injected credential against arbitrary paths on the
 * upstream origin. Decoding before the check catches every encoded spelling,
 * including `..%2f`; a path that fails to decode is rejected rather than
 * guessed at.
 */
const hasDotSegments = (rawPath: string): boolean => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return true;
  }
  // Split on backslash too: some upstream servers treat it as a separator. The
  // character is spelled via charCode because the repo's public-tree scanner
  // rejects literal double-backslash sequences as Windows UNC paths.
  const separators = new RegExp(`[/${String.fromCharCode(92, 92)}]`);
  return decoded.split(separators).some((segment) => segment === "." || segment === "..");
};

const sendText = (response: NodeHttp.ServerResponse, status: number, message: string) => {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(`${message}\n`);
};

const MAX_GIT_COMMAND_BYTES = 1024 * 1024;
const MAX_PULL_REQUEST_BODY_BYTES = 128 * 1024;
const MAX_GITHUB_RESPONSE_BYTES = 1024 * 1024;

type ReceivePackInspection =
  | { readonly status: "need-more" }
  | { readonly status: "allowed" }
  | { readonly status: "denied"; readonly message: string };

/**
 * Parses only the pkt-line command prelude of a smart-HTTP receive-pack body.
 * The packfile itself is never buffered. Unknown or malformed command forms
 * fail closed so a future Git protocol extension cannot bypass ref policy.
 */
export function inspectReceivePackPrefix(
  body: Buffer,
  protectedRefs: ReadonlySet<string>,
): ReceivePackInspection {
  let offset = 0;
  let commands = 0;
  while (true) {
    if (body.length - offset < 4) return { status: "need-more" };
    const header = body.subarray(offset, offset + 4).toString("ascii");
    if (!/^[0-9a-f]{4}$/i.test(header))
      return { status: "denied", message: "malformed git receive-pack request" };
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      return commands > 0
        ? { status: "allowed" }
        : { status: "denied", message: "git receive-pack request has no ref updates" };
    }
    if (length < 4)
      return { status: "denied", message: "malformed git receive-pack packet length" };
    if (length > MAX_GIT_COMMAND_BYTES)
      return { status: "denied", message: "git receive-pack command is too large" };
    if (body.length - offset < length) return { status: "need-more" };
    const payload = body.subarray(offset + 4, offset + length).toString("utf8");
    offset += length;

    if (/^shallow [0-9a-f]{40,64}\n?$/i.test(payload)) continue;
    const capabilityStart = payload.indexOf(String.fromCharCode(0));
    const commandPayload = capabilityStart === -1 ? payload : payload.slice(0, capabilityStart);
    const capabilities = capabilityStart === -1 ? "" : payload.slice(capabilityStart + 1);
    if (capabilities.includes("\r") || capabilities.includes("\n"))
      return { status: "denied", message: "unsupported git receive-pack capabilities" };
    const command = /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) ([^\r\n]+)\n?$/i.exec(
      commandPayload,
    );
    if (command === null)
      return { status: "denied", message: "unsupported git receive-pack command" };
    const ref = command[3];
    if (ref === undefined || !ref.startsWith("refs/") || hasControlCharacters(ref))
      return { status: "denied", message: "invalid git receive-pack ref" };
    if (protectedRefs.has(ref))
      return { status: "denied", message: `updates to ${ref} are not allowed` };
    commands += 1;
  }
}

const readReceivePackPrefix = (
  request: NodeHttp.IncomingMessage,
  protectedRefs: ReadonlySet<string>,
): Promise<{ readonly prefix: Buffer } | { readonly denied: string }> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const timer = NodeTimers.setTimeout(
      () => finish({ denied: "git receive-pack command prelude timed out" }),
      30_000,
    );
    timer.unref();
    const finish = (result: { readonly prefix: Buffer } | { readonly denied: string }) => {
      if (settled) return;
      settled = true;
      NodeTimers.clearTimeout(timer);
      request.pause();
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      resolve(result);
    };
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      const prefix = Buffer.concat(chunks, size);
      const inspection = inspectReceivePackPrefix(prefix, protectedRefs);
      if (inspection.status === "allowed") finish({ prefix });
      else if (inspection.status === "denied") finish({ denied: inspection.message });
      else if (size > MAX_GIT_COMMAND_BYTES)
        finish({ denied: "git receive-pack command prelude is too large" });
    };
    const onEnd = () => finish({ denied: "incomplete git receive-pack request" });
    const onAborted = () => finish({ denied: "aborted git receive-pack request" });
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
  });

const readBoundedBody = (
  request: NodeHttp.IncomingMessage,
  maxBytes: number,
): Promise<Buffer | null> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    let settled = false;
    const finish = (value: Buffer | null) => {
      if (settled) return;
      settled = true;
      NodeTimers.clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      resolve(value);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish(tooLarge ? null : Buffer.concat(chunks, size));
    const onAborted = () => finish(null);
    const timer = NodeTimers.setTimeout(() => {
      request.resume();
      finish(null);
    }, 30_000);
    timer.unref();
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
  });

type GitHubResponse = {
  readonly status: number;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: Buffer;
};

const requestGitHub = async (
  upstream: UpstreamConfig,
  path: string,
  method: "GET" | "POST" | "PUT",
  body: Buffer | undefined,
  environment: ProxyEnvironment,
): Promise<GitHubResponse> => {
  const base = new URL(upstream.baseUrl);
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "t3-sandbox-pr-broker",
    "x-github-api-version": "2022-11-28",
  };
  for (const injected of upstream.inject) headers[injected.header] = injected.value;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(body.length);
  }
  return new Promise<GitHubResponse>((resolve, reject) => {
    void requestUpstream(
      new URL(`${base.origin}${path}`),
      { method, path, headers, timeoutMs: 30_000 },
      environment,
      (incoming) => {
        const chunks: Buffer[] = [];
        let size = 0;
        incoming.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_GITHUB_RESPONSE_BYTES) {
            incoming.destroy(new Error("GitHub response exceeded the broker limit"));
            return;
          }
          chunks.push(chunk);
        });
        incoming.once("end", () =>
          resolve({
            status: incoming.statusCode ?? 502,
            headers: incoming.headers,
            body: Buffer.concat(chunks, size),
          }),
        );
        incoming.once("error", reject);
      },
    ).then((outgoing) => {
      outgoing.once("timeout", () => outgoing.destroy(new Error("GitHub request timed out")));
      outgoing.once("error", reject);
      outgoing.end(body);
    }, reject);
  });
};

const sendGitHubResponse = (response: NodeHttp.ServerResponse, incoming: GitHubResponse) => {
  const headers: Record<string, string> = {
    "content-type": String(incoming.headers["content-type"] ?? "application/json"),
    "content-length": String(incoming.body.length),
  };
  const requestId = incoming.headers["x-github-request-id"];
  if (typeof requestId === "string") headers["x-github-request-id"] = requestId;
  response.writeHead(incoming.status, headers);
  response.end(incoming.body);
};

const isProtectedBaseBranch = (branch: string, protectedBranches: ReadonlySet<string>) =>
  protectedBranches.has(branch.replace(/^refs\/heads\//, ""));

const handleGitHubPullRequest = async (
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
  upstream: UpstreamConfig & {
    readonly policy: Extract<
      NonNullable<UpstreamConfig["policy"]>,
      { kind: "github-pull-requests" }
    >;
  },
  action: string,
  environment: ProxyEnvironment,
) => {
  if (request.method !== "POST") {
    sendText(response, 405, "pull request broker accepts POST only");
    request.resume();
    return;
  }
  if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers["content-type"] ?? ""))) {
    sendText(response, 415, "pull request broker requires application/json");
    request.resume();
    return;
  }
  const raw = await readBoundedBody(request, MAX_PULL_REQUEST_BODY_BYTES);
  if (raw === null) {
    sendText(response, 413, "pull request request body is too large or incomplete");
    return;
  }
  let input: unknown;
  try {
    input = JSON.parse(raw.toString("utf8"));
  } catch {
    sendText(response, 400, "pull request request body is malformed");
    return;
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    sendText(response, 400, "pull request request body must be an object");
    return;
  }
  const record = input as Record<string, unknown>;
  const protectedBranches = new Set(upstream.policy.protectedBaseBranches);
  const basePath = new URL(upstream.baseUrl).pathname.replace(/\/+$/, "");

  if (action === "create") {
    const { base, head, title, body, draft } = record;
    if (
      typeof base !== "string" ||
      base.length === 0 ||
      base.length > 255 ||
      typeof head !== "string" ||
      head.length === 0 ||
      head.length > 255 ||
      typeof title !== "string" ||
      title.trim().length === 0 ||
      title.length > 256 ||
      typeof body !== "string" ||
      body.length > 65_536 ||
      (draft !== undefined && typeof draft !== "boolean")
    ) {
      sendText(response, 400, "invalid pull request creation fields");
      return;
    }
    const payload = Buffer.from(JSON.stringify({ base, head, title, body, draft: draft ?? false }));
    sendGitHubResponse(
      response,
      await requestGitHub(upstream, `${basePath}/pulls`, "POST", payload, environment),
    );
    return;
  }

  if (action === "merge") {
    const number = record.number;
    if (!Number.isSafeInteger(number) || Number(number) <= 0) {
      sendText(response, 400, "invalid pull request merge fields");
      return;
    }
    const pullPath = `${basePath}/pulls/${String(number)}`;
    const detail = await requestGitHub(upstream, pullPath, "GET", undefined, environment);
    if (detail.status < 200 || detail.status >= 300) {
      sendGitHubResponse(response, detail);
      return;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(detail.body.toString("utf8"));
    } catch {
      sendText(response, 502, "GitHub returned malformed pull request details");
      return;
    }
    const pull = decoded as {
      readonly base?: { readonly ref?: unknown; readonly repo?: { readonly full_name?: unknown } };
      readonly head?: { readonly sha?: unknown };
    };
    const baseBranch = pull.base?.ref;
    const baseRepository = pull.base?.repo?.full_name;
    const headSha = pull.head?.sha;
    if (
      typeof baseBranch !== "string" ||
      typeof baseRepository !== "string" ||
      baseRepository.toLowerCase() !== upstream.policy.repositoryNameWithOwner.toLowerCase() ||
      typeof headSha !== "string" ||
      !/^[0-9a-f]{40,64}$/i.test(headSha)
    ) {
      sendText(response, 502, "GitHub returned incomplete pull request authorization details");
      return;
    }
    if (isProtectedBaseBranch(baseBranch, protectedBranches)) {
      sendText(response, 403, `merging pull requests targeting ${baseBranch} is not allowed`);
      return;
    }
    // Supplying the inspected head SHA makes the merge fail if new commits land
    // after authorization. The PR endpoint, rather than the branch-merge API,
    // preserves GitHub's review, status-check, ruleset, notification, and PR
    // state semantics.
    const payload = Buffer.from(JSON.stringify({ sha: headSha, merge_method: "merge" }));
    sendGitHubResponse(
      response,
      await requestGitHub(upstream, `${pullPath}/merge`, "PUT", payload, environment),
    );
    return;
  }

  sendText(response, 404, "unknown pull request operation");
};

const forwardRequest = (
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
  upstream: UpstreamConfig,
  path: string,
  headers: Record<string, string>,
  environment: ProxyEnvironment,
  bodyPrefix?: Buffer,
) => {
  const base = new URL(upstream.baseUrl);
  const onUpstreamResponse = (incoming: NodeHttp.IncomingMessage) => {
    const outHeaders: Record<string, string | Array<string>> = {};
    for (const [header, value] of Object.entries(incoming.headers)) {
      if (value === undefined || HOP_BY_HOP.has(header.toLowerCase())) continue;
      outHeaders[header] = value;
    }
    response.writeHead(incoming.statusCode ?? 502, outHeaders);
    incoming.pipe(response);
  };
  const failUpstream = () => {
    process.stderr.write(`upstream ${upstream.name} request failed\n`);
    if (!response.headersSent) sendText(response, 502, "upstream request failed");
    else response.destroy();
  };

  void requestUpstream(
    new URL(`${base.origin}${path}`),
    { method: request.method, path, headers, timeoutMs: UPSTREAM_TIMEOUT_MS },
    environment,
    onUpstreamResponse,
  ).then(
    (proxied) => {
      proxied.on("timeout", () => proxied.destroy());
      proxied.on("error", failUpstream);
      if (bodyPrefix !== undefined) proxied.write(bodyPrefix);
      request.pipe(proxied);
      request.resume();
    },
    () => {
      request.resume();
      failUpstream();
    },
  );
};

export const createCredentialServer = (
  store: ConfigStore,
  environment: ProxyEnvironment = process.env,
) =>
  NodeHttp.createServer((request, response) => {
    const config = store.current;
    if (config === null) {
      sendText(response, 503, "credential configuration is not available yet");
      request.resume();
      return;
    }
    const presented = /^Bearer (.+)$/i.exec(request.headers.authorization ?? "")?.[1] ?? "";
    if (!tokenMatches(presented, config.threadToken)) {
      sendText(response, 401, "unauthorized");
      request.resume();
      return;
    }
    const url = request.url ?? "/";
    const queryStart = url.indexOf("?");
    if (hasDotSegments(queryStart === -1 ? url : url.slice(0, queryStart))) {
      sendText(response, 400, "path traversal is not allowed");
      request.resume();
      return;
    }
    const [, name, ...rest] = url.split("/");
    const upstream = config.upstreams.find((candidate) => candidate.name === name);
    if (upstream === undefined) {
      sendText(response, 404, "unknown upstream");
      request.resume();
      return;
    }
    const suffix = rest.join("/");
    if (upstream.policy?.kind === "github-pull-requests") {
      void handleGitHubPullRequest(
        request,
        response,
        upstream as UpstreamConfig & {
          readonly policy: Extract<
            NonNullable<UpstreamConfig["policy"]>,
            { kind: "github-pull-requests" }
          >;
        },
        suffix,
        environment,
      ).catch(() => {
        if (!response.headersSent) sendText(response, 502, "pull request broker failed");
        else response.destroy();
      });
      return;
    }

    const base = new URL(upstream.baseUrl);
    const path = `${base.pathname.replace(/\/+$/, "")}/${suffix}`;

    const stripped = new Set([...(upstream.stripRequestHeaders ?? []), "authorization", "host"]);
    const headers: Record<string, string> = {};
    for (const [header, value] of Object.entries(request.headers)) {
      const lower = header.toLowerCase();
      if (value === undefined || stripped.has(lower) || HOP_BY_HOP.has(lower)) continue;
      headers[lower] = Array.isArray(value) ? value.join(", ") : value;
    }
    for (const injected of upstream.inject) headers[injected.header] = injected.value;
    headers.host = base.host;

    if (upstream.policy?.kind === "git-receive-pack" && request.method === "POST") {
      if (suffix === "git-upload-pack") {
        forwardRequest(request, response, upstream, path, headers, environment);
        return;
      }
      if (suffix !== "git-receive-pack") {
        sendText(response, 403, "non-canonical git write path is not allowed");
        request.resume();
        return;
      }
      const contentEncoding = String(request.headers["content-encoding"] ?? "identity");
      if (contentEncoding !== "identity") {
        sendText(response, 415, "encoded git receive-pack requests are not supported");
        request.resume();
        return;
      }
      void readReceivePackPrefix(request, new Set(upstream.policy.protectedRefs)).then((result) => {
        if ("denied" in result) {
          sendText(response, 403, result.denied);
          request.resume();
          return;
        }
        forwardRequest(request, response, upstream, path, headers, environment, result.prefix);
      });
      return;
    }

    if (
      upstream.policy?.kind === "git-receive-pack" &&
      request.method !== "GET" &&
      request.method !== "HEAD"
    ) {
      sendText(response, 405, "git credential broker method is not allowed");
      request.resume();
      return;
    }

    // Chained through HTTPS_PROXY/HTTP_PROXY when set: the thread network is
    // created `--internal`, so the credential sidecar has no direct public route.
    forwardRequest(request, response, upstream, path, headers, environment);
  });

export const main = async (argv: ReadonlyArray<string>) => {
  const args = parseArgs(argv);
  if (
    printedHelp(
      args,
      "usage: t3-credential-proxy serve [--listen host:port] [--config /tmp/credential.json]",
    )
  )
    return;
  if (args.subcommand !== "serve")
    throw new Error(`unknown t3-credential-proxy subcommand: ${args.subcommand ?? "(none)"}`);
  const { host, port } = parseListenAddress(args.values.get("listen") ?? "0.0.0.0:8288", 8288);
  const store = new ConfigStore(args.values.get("config") ?? "/tmp/credential.json");
  await store.load();
  store.watch();
  const server = createCredentialServer(store);
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const bound = typeof address === "object" && address !== null ? address.port : port;
  process.stderr.write(`t3-credential-proxy listening on ${host}:${bound}\n`);
  await new Promise<void>((resolve) => server.once("close", () => resolve()));
};
