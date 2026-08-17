// @effect-diagnostics nodeBuiltinImport:off - Standalone container binary; it is bundled without Effect and has no runtime.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeDnsPromises from "node:dns/promises";
import { parseArgs, parseListenAddress, printedHelp } from "./cli.ts";
import {
  isDeniedHostname,
  vetAddresses,
  vetAddress,
  type DenyClass,
  type IpPolicy,
} from "./ipPolicy.ts";

/**
 * HTTP forward proxy for sandbox workspace containers. Started by
 * `apps/server/src/sandbox/ContainerSandboxBackend.ts` (lines 184-196) as
 * `t3-egress-proxy serve --listen 0.0.0.0:3128 --deny-loopback --deny-private
 * --deny-link-local --deny-metadata --resolve-before-connect`, and reached by
 * the workspace container through HTTP_PROXY/HTTPS_PROXY/ALL_PROXY.
 *
 * Policy is enforced on resolved addresses and the connection is then made to
 * the vetted address, never re-resolved by name. Resolving twice would let a
 * DNS server answer "public" for the check and "127.0.0.1" for the dial.
 */

const DIAL_TIMEOUT_MS = 15_000;
const IDLE_TIMEOUT_MS = 300_000;

export type EgressOptions = {
  readonly policy: IpPolicy;
  readonly resolveBeforeConnect: boolean;
};

type Resolved = { readonly address: string; readonly family: 4 | 6 };

/** Resolves a host to vetted addresses, or explains why it is refused. */
const resolveVetted = async (
  hostname: string,
  options: EgressOptions,
): Promise<{ ok: true; addresses: ReadonlyArray<Resolved> } | { ok: false; reason: string }> => {
  const bare = hostname.replace(/^\[|]$/g, "");
  if (isDeniedHostname(bare, options.policy)) return { ok: false, reason: "loopback name" };
  const literal = NodeNet.isIP(bare);
  if (literal !== 0) {
    const vetted = vetAddress(bare, options.policy);
    return vetted.allowed
      ? { ok: true, addresses: [{ address: bare, family: literal as 4 | 6 }] }
      : { ok: false, reason: vetted.reason };
  }
  if (!options.resolveBeforeConnect) return { ok: false, reason: "name resolution is disabled" };
  let records: ReadonlyArray<{ address: string; family: number }>;
  try {
    records = await NodeDnsPromises.lookup(bare, { all: true, verbatim: true });
  } catch {
    return { ok: false, reason: "host did not resolve" };
  }
  const vetted = vetAddresses(
    records.map((record) => record.address),
    options.policy,
  );
  if (!vetted.allowed) return { ok: false, reason: vetted.reason };
  return {
    ok: true,
    addresses: records.map((record) => ({
      address: record.address,
      family: record.family === 6 ? 6 : 4,
    })),
  };
};

/** Dials the already-vetted address literal. `lookup` is never consulted again. */
const dial = (target: Resolved, port: number) =>
  new Promise<NodeNet.Socket>((resolve, reject) => {
    const socket = NodeNet.connect({
      host: target.address,
      port,
      family: target.family,
      autoSelectFamily: false,
    });
    socket.setTimeout(DIAL_TIMEOUT_MS);
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.once("timeout", () => fail(new Error("dial timed out")));
    socket.once("error", fail);
    socket.once("connect", () => {
      socket.setTimeout(IDLE_TIMEOUT_MS);
      socket.off("error", fail);
      resolve(socket);
    });
  });

const refuse = (response: NodeHttp.ServerResponse, status: number, reason: string) => {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8", connection: "close" });
  response.end(`egress denied: ${reason}\n`);
};

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

export const createEgressServer = (options: EgressOptions) => {
  const server = NodeHttp.createServer();

  server.on("connect", (request, clientSocket, head) => {
    const authority = request.url ?? "";
    const separator = authority.lastIndexOf(":");
    const hostname = separator > 0 ? authority.slice(0, separator) : authority;
    const port = separator > 0 ? Number(authority.slice(separator + 1)) : 443;
    const deny = (reason: string) => {
      clientSocket.end(
        `HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\negress denied: ${reason}\n`,
      );
    };
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      deny("invalid port");
      return;
    }
    clientSocket.on("error", () => clientSocket.destroy());
    void resolveVetted(hostname, options).then(async (vetted) => {
      if (!vetted.ok) {
        process.stderr.write(`CONNECT ${hostname}:${port} denied: ${vetted.reason}\n`);
        deny(vetted.reason);
        return;
      }
      let upstream: NodeNet.Socket;
      try {
        upstream = await dial(vetted.addresses[0]!, port);
      } catch {
        clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n");
        return;
      }
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.on("error", () => clientSocket.destroy());
      upstream.on("timeout", () => upstream.destroy());
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
  });

  server.on("request", (request, response) => {
    const raw = request.url ?? "";
    if (!/^https?:\/\//i.test(raw)) {
      refuse(response, 400, "absolute-URI request required");
      return;
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      refuse(response, 400, "invalid absolute URI");
      return;
    }
    if (url.protocol !== "http:") {
      refuse(response, 400, "use CONNECT for https");
      return;
    }
    const port = url.port === "" ? 80 : Number(url.port);
    void resolveVetted(url.hostname, options).then(async (vetted) => {
      if (!vetted.ok) {
        process.stderr.write(`${request.method} ${url.host} denied: ${vetted.reason}\n`);
        refuse(response, 403, vetted.reason);
        return;
      }
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
        headers[name] = Array.isArray(value) ? value.join(", ") : value;
      }
      headers.host = url.host;
      const upstream = NodeHttp.request(
        {
          host: vetted.addresses[0]!.address,
          port,
          family: vetted.addresses[0]!.family,
          method: request.method,
          path: `${url.pathname}${url.search}`,
          headers,
          setHost: false,
          timeout: IDLE_TIMEOUT_MS,
        },
        (incoming) => {
          const outHeaders: Record<string, string | Array<string>> = {};
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
            outHeaders[name] = value;
          }
          response.writeHead(incoming.statusCode ?? 502, outHeaders);
          incoming.pipe(response);
        },
      );
      upstream.on("timeout", () => upstream.destroy());
      upstream.on("error", () => {
        if (!response.headersSent) refuse(response, 502, "upstream connection failed");
        else response.destroy();
      });
      request.pipe(upstream);
    });
  });

  return server;
};

const DENY_FLAGS: ReadonlyArray<readonly [string, DenyClass]> = [
  ["deny-loopback", "loopback"],
  ["deny-private", "private"],
  ["deny-link-local", "link-local"],
  ["deny-metadata", "metadata"],
];

export const main = async (argv: ReadonlyArray<string>) => {
  const args = parseArgs(argv);
  if (
    printedHelp(
      args,
      "usage: t3-egress-proxy serve [--listen host:port] [--deny-loopback] [--deny-private] [--deny-link-local] [--deny-metadata] [--resolve-before-connect]",
    )
  )
    return;
  if (args.subcommand !== "serve")
    throw new Error(`unknown t3-egress-proxy subcommand: ${args.subcommand ?? "(none)"}`);
  const { host, port } = parseListenAddress(args.values.get("listen") ?? "0.0.0.0:3128", 3128);
  const policy = new Set<DenyClass>();
  for (const [flag, denied] of DENY_FLAGS) if (args.flags.has(flag)) policy.add(denied);
  const server = createEgressServer({
    policy,
    resolveBeforeConnect: args.flags.has("resolve-before-connect"),
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const bound = typeof address === "object" && address !== null ? address.port : port;
  process.stderr.write(
    `t3-egress-proxy listening on ${host}:${bound} denying [${[...policy].join(",")}]\n`,
  );
  await new Promise<void>((resolve) => server.once("close", () => resolve()));
};
