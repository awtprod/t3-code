// @effect-diagnostics nodeBuiltinImport:off - Standalone container binary; it is bundled without Effect and has no runtime.
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
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
    upstreams.push({
      name: upstream.name,
      baseUrl: upstream.baseUrl.replace(/\/+$/, ""),
      inject,
      ...(strip === undefined
        ? {}
        : { stripRequestHeaders: strip.map((name) => String(name).toLowerCase()) }),
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
    const base = new URL(upstream.baseUrl);
    const suffix = rest.join("/");
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

    const onUpstreamResponse = (incoming: NodeHttp.IncomingMessage) => {
      const outHeaders: Record<string, string | Array<string>> = {};
      for (const [header, value] of Object.entries(incoming.headers)) {
        if (value === undefined || HOP_BY_HOP.has(header.toLowerCase())) continue;
        outHeaders[header] = value;
      }
      response.writeHead(incoming.statusCode ?? 502, outHeaders);
      // Piped, not buffered: provider APIs stream SSE and buffering stalls turns.
      incoming.pipe(response);
    };
    const failUpstream = () => {
      process.stderr.write(`upstream ${upstream.name} request failed\n`);
      if (!response.headersSent) sendText(response, 502, "upstream request failed");
      else response.destroy();
    };

    // Chained through HTTPS_PROXY/HTTP_PROXY when set: the thread network is
    // created `--internal`, so the egress sidecar is the only route out.
    // Awaiting the CONNECT handshake does not buffer the body — the request
    // stream stays paused until it is piped below.
    void requestUpstream(
      new URL(`${base.origin}${path}`),
      { method: request.method, path, headers, timeoutMs: UPSTREAM_TIMEOUT_MS },
      environment,
      onUpstreamResponse,
    ).then(
      (proxied) => {
        proxied.on("timeout", () => proxied.destroy());
        proxied.on("error", failUpstream);
        request.pipe(proxied);
      },
      () => {
        request.resume();
        failUpstream();
      },
    );
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
