// @effect-diagnostics nodeBuiltinImport:off - Tests drive the bundled binaries as real processes; there is no Effect runtime here.
import { afterAll, describe, expect, it } from "@effect/vitest";
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import {
  closeServer,
  listen,
  spawnBinary,
  spawnListening,
  stopChild,
  waitForStderr,
} from "./support.ts";

/**
 * Drives the bundled t3-credential-proxy over HTTP. The config document shape
 * and routing rules here are the contract shared with the server side, which
 * writes /tmp/credential.json into the container after it starts.
 */

const children: Array<ReturnType<typeof spawnBinary>> = [];
const servers: Array<NodeHttp.Server> = [];
const directories: Array<string> = [];

afterAll(async () => {
  await Promise.all(children.map(stopChild));
  await Promise.all(servers.map(closeServer));
  await Promise.all(directories.map((path) => NodeFSP.rm(path, { recursive: true, force: true })));
});

const makeConfigDir = async () => {
  const path = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-credential-"));
  directories.push(path);
  return { directory: path, configPath: NodePath.join(path, "credential.json") };
};

const startProxy = async (configPath: string) => {
  const started = await spawnListening("t3-credential-proxy", [
    "serve",
    "--listen",
    "127.0.0.1:0",
    "--config",
    configPath,
  ]);
  children.push(started.child);
  return started;
};

type Answer = { status: number; body: string; headers: NodeHttp.IncomingHttpHeaders };

const call = (
  port: number,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<Answer> =>
  new Promise((resolve, reject) => {
    const request = NodeHttp.request(
      { host: "127.0.0.1", port, method: body === undefined ? "GET" : "POST", path, headers },
      (response) => {
        const chunks: Array<Buffer> = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
          }),
        );
      },
    );
    request.once("error", reject);
    request.end(body);
  });

const THREAD_TOKEN = NodeCrypto.randomBytes(24).toString("base64url");
const REAL_SECRET = "sk-ant-not-a-real-secret";

/** Records every request the upstream saw so header handling can be asserted. */
const startUpstream = async () => {
  const seen: Array<{ headers: NodeHttp.IncomingHttpHeaders; url: string }> = [];
  const server = NodeHttp.createServer((request, response) => {
    seen.push({ headers: request.headers, url: request.url ?? "" });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, path: request.url }));
  });
  servers.push(server);
  const port = await listen(server);
  return { seen, port, server };
};

const writeConfig = (
  configPath: string,
  upstreamPort: number,
  overrides: Record<string, unknown> = {},
) =>
  NodeFSP.writeFile(
    configPath,
    JSON.stringify({
      threadToken: THREAD_TOKEN,
      upstreams: [
        {
          name: "anthropic",
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          inject: [{ header: "x-api-key", value: REAL_SECRET }],
          stripRequestHeaders: ["authorization"],
        },
      ],
      ...overrides,
    }),
    { mode: 0o600 },
  );

describe("t3-credential-proxy configuration lifecycle", () => {
  it("serves 503 until the server pushes a config, then hot-reloads it", async () => {
    const { configPath } = await makeConfigDir();
    const proxy = await startProxy(configPath);

    const beforeConfig = await call(proxy.port, "/anthropic/v1/messages", {
      authorization: `Bearer ${THREAD_TOKEN}`,
    });
    expect(beforeConfig.status).toBe(503);

    const upstream = await startUpstream();
    // The reload is awaited on the binary's own stderr announcement, so the
    // test never polls or sleeps for the watcher.
    const reloaded = waitForStderr(proxy.child, /credential config loaded with upstreams \[.*]/);
    await writeConfig(configPath, upstream.port);
    expect(await reloaded).toContain("[anthropic]");

    const afterConfig = await call(proxy.port, "/anthropic/v1/messages", {
      authorization: `Bearer ${THREAD_TOKEN}`,
    });
    expect(afterConfig.status).toBe(200);
    expect(JSON.parse(afterConfig.body)).toEqual({ ok: true, path: "/v1/messages" });
  });
});

describe("t3-credential-proxy authorization and routing", () => {
  const ready = async () => {
    const { configPath } = await makeConfigDir();
    const upstream = await startUpstream();
    await writeConfig(configPath, upstream.port);
    const proxy = await startProxy(configPath);
    return { proxy, upstream };
  };

  it("rejects a wrong thread token with 401", async () => {
    const { proxy } = await ready();
    const answer = await call(proxy.port, "/anthropic/v1/messages", {
      authorization: "Bearer wrong-token",
    });
    expect(answer.status).toBe(401);
  });

  it("rejects a token of matching length but different value with 401", async () => {
    const { proxy } = await ready();
    const sameLength = `${"a".repeat(THREAD_TOKEN.length - 1)}b`;
    const answer = await call(proxy.port, "/anthropic/v1/messages", {
      authorization: `Bearer ${sameLength}`,
    });
    expect(answer.status).toBe(401);
  });

  it("rejects a missing Authorization header with 401", async () => {
    const { proxy } = await ready();
    expect((await call(proxy.port, "/anthropic/v1/messages", {})).status).toBe(401);
  });

  it("injects the real secret and never forwards the thread token", async () => {
    const { proxy, upstream } = await ready();
    const answer = await call(
      proxy.port,
      "/anthropic/v1/messages",
      { authorization: `Bearer ${THREAD_TOKEN}`, "content-type": "application/json" },
      JSON.stringify({ model: "claude" }),
    );
    expect(answer.status).toBe(200);
    const seen = upstream.seen.at(-1)!;
    expect(seen.headers["x-api-key"]).toBe(REAL_SECRET);
    expect(seen.headers.authorization).toBeUndefined();
    expect(JSON.stringify(seen.headers)).not.toContain(THREAD_TOKEN);
    expect(seen.url).toBe("/v1/messages");
  });

  it("answers 404 for an unknown first path segment instead of passing it through", async () => {
    const { proxy, upstream } = await ready();
    const before = upstream.seen.length;
    const answer = await call(proxy.port, "/evil-host/v1/messages", {
      authorization: `Bearer ${THREAD_TOKEN}`,
    });
    expect(answer.status).toBe(404);
    expect(upstream.seen).toHaveLength(before);
  });
});

describe("t3-credential-proxy streaming", () => {
  it("streams response chunks through without buffering the whole body", async () => {
    const { configPath } = await makeConfigDir();
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const upstream = NodeHttp.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: first\n\n");
      // The response is deliberately left open; the assertion below only
      // completes if the proxy forwarded the first chunk before the end.
      void held.then(() => {
        response.write("data: second\n\n");
        response.end();
      });
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);
    await writeConfig(configPath, upstreamPort);
    const proxy = await startProxy(configPath);

    const firstChunk = await new Promise<string>((resolve, reject) => {
      const request = NodeHttp.request(
        {
          host: "127.0.0.1",
          port: proxy.port,
          method: "GET",
          path: "/anthropic/v1/messages",
          headers: { authorization: `Bearer ${THREAD_TOKEN}`, accept: "text/event-stream" },
        },
        (response) => {
          response.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8")));
        },
      );
      request.once("error", reject);
      request.end();
    });
    expect(firstChunk).toContain("data: first");
    release?.();
  });

  it("streams a request body to the upstream as it arrives", async () => {
    const { configPath } = await makeConfigDir();
    const firstBodyChunk = Promise.withResolvers<string>();
    const upstream = NodeHttp.createServer((request, response) => {
      request.once("data", (chunk: Buffer) => firstBodyChunk.resolve(chunk.toString("utf8")));
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);
    await writeConfig(configPath, upstreamPort);
    const proxy = await startProxy(configPath);

    const request = NodeHttp.request({
      host: "127.0.0.1",
      port: proxy.port,
      method: "POST",
      path: "/anthropic/v1/messages",
      headers: { authorization: `Bearer ${THREAD_TOKEN}`, "transfer-encoding": "chunked" },
    });
    request.on("error", () => undefined);
    request.write("streamed-prefix");
    expect(await firstBodyChunk.promise).toBe("streamed-prefix");
    request.end();
  });
});
