// @effect-diagnostics nodeBuiltinImport:off - Tests drive the bundled binaries as real processes; there is no Effect runtime here.
import { afterAll, describe, expect, it } from "@effect/vitest";
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import type * as NodeStream from "node:stream";
import {
  closeServer,
  encodeFrame,
  FrameReader,
  listen,
  runBinary,
  spawnBinary,
  spawnListening,
  stopChild,
} from "./support.ts";

/**
 * Drives the bundled t3-preview-bridge over stdio exactly the way
 * ThreadPreviewProxy does through `podman exec --interactive`.
 */

const uint16 = (value: number) => {
  const buffer = Buffer.allocUnsafe(2);
  buffer.writeUInt16BE(value);
  return buffer;
};

const uint64 = (value: number) => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
};

/** Decodes one masked client text frame; enough for what the bridge emits. */
const decodeClientFrame = (buffer: Buffer) => {
  const short = buffer[1]! & 0x7f;
  const offset = short < 126 ? 2 : short === 126 ? 4 : 10;
  const length =
    short < 126
      ? short
      : short === 126
        ? buffer.readUInt16BE(2)
        : Number(buffer.readBigUInt64BE(2));
  const mask = buffer.subarray(offset, offset + 4);
  const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
  for (let index = 0; index < payload.length; index += 1)
    payload[index] = payload[index]! ^ mask[index % 4]!;
  return payload;
};

/** Minimal RFC 6455 server: completes the handshake, queues inbound frames. */
const startWebSocketServer = async () => {
  const server = NodeHttp.createServer();
  const sockets: Array<NodeStream.Duplex> = [];
  const ready: Array<Buffer> = [];
  const waiters: Array<(frame: Buffer) => void> = [];
  const seenHeaders: Array<NodeHttp.IncomingHttpHeaders> = [];
  server.on("upgrade", (request, socket) => {
    sockets.push(socket);
    upgraded.push(socket);
    seenHeaders.push(request.headers);
    const accept = NodeCrypto.createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.on("data", (chunk: Buffer) => {
      const payload = decodeClientFrame(chunk);
      const waiter = waiters.shift();
      if (waiter === undefined) ready.push(payload);
      else waiter(payload);
    });
    socket.on("error", () => socket.destroy());
  });
  const port = await listen(server);
  return {
    port,
    server,
    seenHeaders,
    /** Sends an unmasked server text frame carrying the given payload. */
    send: (payload: Buffer) => {
      const header =
        payload.length < 126
          ? Buffer.from([0x81, payload.length])
          : payload.length < 65_536
            ? Buffer.concat([Buffer.from([0x81, 126]), uint16(payload.length)])
            : Buffer.concat([Buffer.from([0x81, 127]), uint64(payload.length)]);
      sockets[0]!.write(Buffer.concat([header, payload]));
    },
    nextClientFrame: () => {
      const queued = ready.shift();
      return queued === undefined
        ? new Promise<Buffer>((resolve) => waiters.push(resolve))
        : Promise.resolve(queued);
    },
  };
};

const children: Array<ReturnType<typeof spawnBinary>> = [];
const servers: Array<NodeHttp.Server> = [];
// Upgraded sockets detach from the HTTP server, so `close()` alone never
// settles; they are destroyed explicitly during teardown.
const upgraded: Array<NodeStream.Duplex> = [];

const startBridge = async (handshake: Record<string, unknown>) => {
  const child = spawnBinary("t3-preview-bridge", ["websocket-framed"]);
  children.push(child);
  const frames = new FrameReader(child.stdout);
  child.stdin.write(`${JSON.stringify(handshake)}\n`);
  return { child, frames };
};

afterAll(async () => {
  await Promise.all(children.map(stopChild));
  for (const socket of upgraded) socket.destroy();
  await Promise.all(servers.map(closeServer));
});

describe("t3-preview-bridge request", () => {
  it("turns one JSON request document into one JSON response document", async () => {
    const upstream = NodeHttp.createServer((request, response) => {
      response.writeHead(201, { "content-type": "text/plain", "x-seen-path": request.url ?? "" });
      response.end("hello from upstream");
    });
    servers.push(upstream);
    const port = await listen(upstream);

    const result = await runBinary(
      "t3-preview-bridge",
      ["request"],
      JSON.stringify({
        target: { hostname: "127.0.0.1", port },
        method: "GET",
        path: "/app?q=1",
        headers: { accept: "text/plain" },
        bodyBase64: "",
        maxResponseBytes: 8 * 1024 * 1024,
        timeoutMs: 30_000,
      }),
    );

    expect(result.code).toBe(0);
    const document = JSON.parse(result.stdout) as {
      status: number;
      headers: Record<string, string>;
      bodyBase64: string;
    };
    expect(document.status).toBe(201);
    expect(document.headers["x-seen-path"]).toBe("/app?q=1");
    expect(Buffer.from(document.bodyBase64, "base64").toString("utf8")).toBe("hello from upstream");
  });

  it("forwards a request body and answers with a bounded response", async () => {
    const upstream = NodeHttp.createServer((request, response) => {
      const chunks: Array<Buffer> = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ echoed: Buffer.concat(chunks).toString("utf8") }));
      });
    });
    servers.push(upstream);
    const port = await listen(upstream);

    const result = await runBinary(
      "t3-preview-bridge",
      ["request"],
      JSON.stringify({
        target: { hostname: "127.0.0.1", port },
        method: "POST",
        path: "/submit",
        headers: { "content-type": "application/json" },
        bodyBase64: Buffer.from('{"a":1}').toString("base64"),
        maxResponseBytes: 8 * 1024 * 1024,
        timeoutMs: 30_000,
      }),
    );
    const document = JSON.parse(result.stdout) as { status: number; bodyBase64: string };
    expect(document.status).toBe(200);
    expect(JSON.parse(Buffer.from(document.bodyBase64, "base64").toString("utf8"))).toEqual({
      echoed: '{"a":1}',
    });
  });

  it("answers a well-formed error document when the target is invalid", async () => {
    const result = await runBinary(
      "t3-preview-bridge",
      ["request"],
      JSON.stringify({ target: { hostname: "bad host!", port: 80 } }),
    );
    const document = JSON.parse(result.stdout) as { status: number; bodyBase64: string };
    expect(document.status).toBe(400);
    expect(typeof document.bodyBase64).toBe("string");
  });
});

describe("t3-preview-bridge websocket-framed", () => {
  it("emits a zero-length frame the moment the upstream opens", async () => {
    // The server relay kills this child after ~10s of stdout silence
    // (DesktopHttpRoutes.ts line 351), so the open frame is load-bearing.
    const upstream = await startWebSocketServer();
    servers.push(upstream.server);
    const { frames } = await startBridge({
      target: { hostname: "127.0.0.1", port: upstream.port },
      path: "/socket",
      headers: {},
      maxFrameBytes: 1024 * 1024,
      idleTimeoutMs: 60_000,
    });

    expect((await frames.next()).length).toBe(0);
  });

  it("round-trips frames in both directions", async () => {
    const upstream = await startWebSocketServer();
    servers.push(upstream.server);
    const { child, frames } = await startBridge({
      target: { hostname: "127.0.0.1", port: upstream.port },
      path: "/socket",
      headers: { "x-forwarded-marker": "kept" },
      maxFrameBytes: 1024 * 1024,
      idleTimeoutMs: 60_000,
    });
    expect((await frames.next()).length).toBe(0);

    upstream.send(Buffer.from("downstream payload"));
    expect((await frames.next()).toString("utf8")).toBe("downstream payload");

    const inbound = upstream.nextClientFrame();
    child.stdin.write(encodeFrame(Buffer.from("upstream payload")));
    expect((await inbound).toString("utf8")).toBe("upstream payload");
    expect(upstream.seenHeaders[0]?.["x-forwarded-marker"]).toBe("kept");
  });

  it("stops relaying when an upstream frame exceeds maxFrameBytes", async () => {
    const upstream = await startWebSocketServer();
    servers.push(upstream.server);
    const { child, frames } = await startBridge({
      target: { hostname: "127.0.0.1", port: upstream.port },
      path: "/socket",
      headers: {},
      maxFrameBytes: 64,
      idleTimeoutMs: 60_000,
    });
    expect((await frames.next()).length).toBe(0);

    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    upstream.send(Buffer.alloc(256, 0x61));
    // Over-sized upstream frames terminate the relay instead of forwarding.
    expect(await exited).toBe(0);
  });

  it("stops relaying when a downstream frame exceeds maxFrameBytes", async () => {
    const upstream = await startWebSocketServer();
    servers.push(upstream.server);
    const { child, frames } = await startBridge({
      target: { hostname: "127.0.0.1", port: upstream.port },
      path: "/socket",
      headers: {},
      maxFrameBytes: 64,
      idleTimeoutMs: 60_000,
    });
    expect((await frames.next()).length).toBe(0);

    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    child.stdin.write(encodeFrame(Buffer.alloc(256, 0x62)));
    expect(await exited).toBe(0);
  });
});

describe("t3-preview-bridge cdp-automation", () => {
  it("returns a well-formed error document instead of hanging in headless mode", async () => {
    const result = await runBinary(
      "t3-preview-bridge",
      ["cdp-automation"],
      JSON.stringify({
        target: { hostname: "127.0.0.1", port: 9222 },
        operation: "screenshot",
        input: {},
        timeoutMs: 5_000,
        rewriteWebSocketUrls: true,
      }),
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      operation: "screenshot",
      error: { code: "automation_unsupported" },
    });
  });
});

describe("t3-preview-bridge serve and signal", () => {
  it("publishes and polls signaling messages through the sidecar store", async () => {
    const sidecar = await spawnListening("t3-preview-bridge", [
      "serve",
      "--stdio",
      "--listen",
      "127.0.0.1:0",
      "--signaling-relay",
    ]);
    children.push(sidecar.child);
    const endpoint = `http://127.0.0.1:${sidecar.port}`;

    const published = await runBinary(
      "t3-preview-bridge",
      ["signal", "--endpoint", endpoint],
      JSON.stringify({ sessionId: "s1", role: "bridge", type: "offer", payload: "sdp-body" }),
    );
    expect(JSON.parse(published.stdout)).toEqual({ sequence: 1 });

    const polled = await runBinary(
      "t3-preview-bridge",
      ["signal", "--endpoint", endpoint],
      JSON.stringify({ sessionId: "s1", role: "viewer", type: "poll", sequence: 0 }),
    );
    // DesktopHttpRoutes.ts line 307 requires a {messages: [...]} poll document.
    const messages = (JSON.parse(polled.stdout) as { messages: Array<{ payload: string }> })
      .messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.payload).toBe("sdp-body");
  });

  it("reports an error document when the signaling relay is unreachable", async () => {
    const result = await runBinary(
      "t3-preview-bridge",
      ["signal", "--endpoint", "http://127.0.0.1:1"],
      JSON.stringify({ sessionId: "s1", role: "viewer", type: "poll", sequence: 0 }),
    );
    expect(JSON.parse(result.stdout)).toEqual({ error: "signaling relay unavailable" });
  });
});
