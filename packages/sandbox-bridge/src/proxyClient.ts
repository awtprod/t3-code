// @effect-diagnostics nodeBuiltinImport:off - Standalone container binary; it is bundled without Effect and has no runtime.
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeTls from "node:tls";
import * as NodeNet from "node:net";

/**
 * Outbound HTTP client that honours HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY.
 *
 * Node's `http` and `https` core modules ignore those variables entirely — only
 * undici (and therefore `fetch`) reads them, and only through
 * `EnvHttpProxyAgent`. The sidecars need them honoured because the thread
 * network is created with `--internal`
 * (apps/server/src/sandbox/ContainerSandboxBackend.ts, `network create
 * --internal`), so nothing on it can reach a provider API except by chaining
 * through the egress proxy.
 *
 * Two proxy forms are produced, matching what t3-egress-proxy accepts:
 * CONNECT-then-TLS for https upstreams, and an absolute-URI request for http
 * upstreams.
 */

export type ProxyEnvironment = Readonly<Record<string, string | undefined>>;

const readEnv = (environment: ProxyEnvironment, ...names: ReadonlyArray<string>) => {
  for (const name of names) {
    const value = environment[name]?.trim();
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
};

const defaultPort = (target: URL) =>
  target.port === "" ? (target.protocol === "https:" ? 443 : 80) : Number(target.port);

const bareHost = (hostname: string) =>
  hostname
    .replace(/^\[|]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "");

/**
 * Implements the usual NO_PROXY grammar: comma- or space-separated entries, `*`
 * for everything, an optional leading dot, and an optional `:port` suffix.
 */
export const shouldBypassProxy = (
  hostname: string,
  port: number,
  noProxy: string | undefined,
): boolean => {
  if (noProxy === undefined) return false;
  const host = bareHost(hostname);
  for (const raw of noProxy.split(/[,\s]+/)) {
    const entry = raw.trim().toLowerCase();
    if (entry.length === 0) continue;
    if (entry === "*") return true;
    let pattern = entry;
    const colon = entry.lastIndexOf(":");
    if (colon > 0 && !entry.includes("]") && /^\d+$/.test(entry.slice(colon + 1))) {
      if (Number(entry.slice(colon + 1)) !== port) continue;
      pattern = entry.slice(0, colon);
    }
    pattern = bareHost(pattern).replace(/^\./, "");
    if (pattern.length === 0) continue;
    if (host === pattern || host.endsWith(`.${pattern}`)) return true;
  }
  return false;
};

/** Picks the proxy for `target`, or undefined when it should be dialed directly. */
export const selectProxy = (target: URL, environment: ProxyEnvironment): URL | undefined => {
  if (
    shouldBypassProxy(
      target.hostname,
      defaultPort(target),
      readEnv(environment, "NO_PROXY", "no_proxy"),
    )
  )
    return undefined;
  const raw =
    target.protocol === "https:"
      ? readEnv(environment, "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy")
      : readEnv(environment, "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy");
  if (raw === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : undefined;
};

const proxyAuthHeaders = (proxy: URL): Record<string, string> => {
  if (proxy.username === "") return {};
  const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  return { "proxy-authorization": `Basic ${Buffer.from(credentials).toString("base64")}` };
};

const proxyPort = (proxy: URL) =>
  proxy.port === "" ? (proxy.protocol === "https:" ? 443 : 80) : Number(proxy.port);

/** Issues CONNECT and hands back the tunnelled socket. */
const openTunnel = (proxy: URL, host: string, port: number) =>
  new Promise<NodeNet.Socket>((resolve, reject) => {
    const authority = `${host}:${port}`;
    const request = NodeHttp.request({
      host: proxy.hostname,
      port: proxyPort(proxy),
      method: "CONNECT",
      path: authority,
      headers: { host: authority, ...proxyAuthHeaders(proxy) },
      agent: false,
    });
    request.once("connect", (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy refused CONNECT with status ${response.statusCode ?? 0}`));
        return;
      }
      // Bytes the proxy already sent past the 200 belong to the TLS stream.
      if (head.length > 0) socket.unshift(head);
      resolve(socket);
    });
    request.once("error", reject);
    request.end();
  });

export type UpstreamInit = {
  readonly method?: string | undefined;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly timeoutMs?: number;
};

/**
 * Opens a request to `target`, chaining through a configured proxy when one
 * applies. The returned ClientRequest has not been written to, so the caller
 * still owns the body.
 */
export const requestUpstream = async (
  target: URL,
  init: UpstreamInit,
  environment: ProxyEnvironment,
  onResponse: (incoming: NodeHttp.IncomingMessage) => void,
): Promise<NodeHttp.ClientRequest> => {
  const secure = target.protocol === "https:";
  const port = defaultPort(target);
  const proxy = selectProxy(target, environment);
  const headers = { ...init.headers, host: target.host };
  const common = {
    method: init.method,
    headers,
    setHost: false,
    ...(init.timeoutMs === undefined ? {} : { timeout: init.timeoutMs }),
  };

  if (proxy === undefined) {
    const transport = secure ? NodeHttps : NodeHttp;
    return transport.request(
      { ...common, host: target.hostname, port, path: init.path },
      onResponse,
    );
  }

  if (!secure) {
    // Absolute-URI form; the proxy re-resolves and vets the host itself.
    return NodeHttp.request(
      {
        ...common,
        host: proxy.hostname,
        port: proxyPort(proxy),
        path: `${target.origin}${init.path}`,
        headers: { ...headers, ...proxyAuthHeaders(proxy) },
        agent: false,
      },
      onResponse,
    );
  }

  const socket = await openTunnel(proxy, target.hostname, port);
  const host = target.hostname.replace(/^\[|]$/g, "");
  const secured = NodeTls.connect({
    socket,
    host,
    // RFC 6066 forbids an IP literal in SNI, and Node warns when one is given.
    // Identity is then checked against `host` instead, matching an IP SAN.
    ...(NodeNet.isIP(host) === 0 ? { servername: host } : {}),
  });
  // `agent` is deliberately omitted rather than set to false: Node replaces
  // `agent: false` with a fresh Agent and then ignores createConnection.
  const request = NodeHttps.request(
    { ...common, host: target.hostname, port, path: init.path, createConnection: () => secured },
    onResponse,
  );
  secured.once("error", (error: Error) => request.destroy(error));
  return request;
};
