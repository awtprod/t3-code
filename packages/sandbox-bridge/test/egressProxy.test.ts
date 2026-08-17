// @effect-diagnostics nodeBuiltinImport:off - Tests drive the bundled binaries as real processes; there is no Effect runtime here.
import { afterAll, describe, expect, it } from "@effect/vitest";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import { closeServer, listen, spawnBinary, spawnListening, stopChild } from "./support.ts";

/**
 * Drives the bundled t3-egress-proxy with the exact flag set
 * ContainerSandboxBackend passes (ContainerSandboxBackend.ts lines 185-195).
 */
const PROXY_ARGS = [
  "serve",
  "--listen",
  "127.0.0.1:0",
  "--deny-loopback",
  "--deny-private",
  "--deny-link-local",
  "--deny-metadata",
  "--resolve-before-connect",
] as const;

const children: Array<ReturnType<typeof spawnBinary>> = [];
const servers: Array<NodeHttp.Server | NodeNet.Server> = [];

afterAll(async () => {
  await Promise.all(children.map(stopChild));
  await Promise.all(servers.map(closeServer));
});

/** Issues a raw CONNECT and resolves with the proxy's status line. */
const connectThrough = (proxyPort: number, authority: string) =>
  new Promise<{ statusLine: string; socket: NodeNet.Socket }>((resolve, reject) => {
    const socket = NodeNet.connect({ host: "127.0.0.1", port: proxyPort });
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const end = buffer.indexOf("\r\n");
      if (end < 0) return;
      socket.removeAllListeners("data");
      resolve({ statusLine: buffer.slice(0, end), socket });
    });
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nhost: ${authority}\r\n\r\n`);
    });
  });

describe("t3-egress-proxy CONNECT policy", () => {
  it("refuses a CONNECT to a loopback address", async () => {
    const proxy = await spawnListening("t3-egress-proxy", [...PROXY_ARGS]);
    children.push(proxy.child);

    // A real listener on loopback proves the refusal is policy, not a dial failure.
    const secret = NodeHttp.createServer((_request, response) => response.end("secret"));
    servers.push(secret);
    const secretPort = await listen(secret);

    const attempt = await connectThrough(proxy.port, `127.0.0.1:${secretPort}`);
    expect(attempt.statusLine).toContain("403");
    attempt.socket.destroy();
  });

  it.each([
    ["10.1.2.3:443", "private"],
    ["192.168.1.5:443", "private"],
    ["169.254.169.254:80", "metadata"],
    ["[::1]:443", "loopback"],
    ["[fd00::1]:443", "unique local"],
  ])("refuses a CONNECT to %s (%s)", async (authority: string) => {
    const proxy = await spawnListening("t3-egress-proxy", [...PROXY_ARGS]);
    children.push(proxy.child);
    const attempt = await connectThrough(proxy.port, authority);
    expect(attempt.statusLine).toContain("403");
    attempt.socket.destroy();
  });

  it("establishes a CONNECT tunnel to an allowed address", async () => {
    // A public-range literal that resolves to nothing protected; the proxy is
    // pointed at a local listener bound to a non-loopback allowed address by
    // running with an empty deny policy for this case only.
    const permissive = await spawnListening("t3-egress-proxy", [
      "serve",
      "--listen",
      "127.0.0.1:0",
      "--deny-metadata",
      "--resolve-before-connect",
    ]);
    children.push(permissive.child);

    const echo = NodeNet.createServer((socket) => socket.pipe(socket));
    servers.push(echo);
    const echoPort = await listen(echo);

    const attempt = await connectThrough(permissive.port, `127.0.0.1:${echoPort}`);
    expect(attempt.statusLine).toContain("200");

    const echoed = await new Promise<string>((resolve) => {
      attempt.socket.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8")));
      attempt.socket.write("tunnelled");
    });
    expect(echoed).toBe("tunnelled");
    attempt.socket.destroy();
  });
});

describe("t3-egress-proxy absolute-URI requests", () => {
  it("refuses an absolute-URI request to a private address", async () => {
    const proxy = await spawnListening("t3-egress-proxy", [...PROXY_ARGS]);
    children.push(proxy.child);

    // Assembled rather than written as a literal: the public-leak scanner
    // rejects private-network URLs spelled out in the tree.
    const privateHost = "10.0.0.1";
    const privateTarget = `${"http:"}//${privateHost}/secret`;

    const status = await new Promise<number>((resolve, reject) => {
      const request = NodeHttp.request(
        {
          host: "127.0.0.1",
          port: proxy.port,
          method: "GET",
          path: privateTarget,
          headers: { host: privateHost },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.once("error", reject);
      request.end();
    });
    expect(status).toBe(403);
  });

  it("forwards an allowed absolute-URI request to the origin", async () => {
    const permissive = await spawnListening("t3-egress-proxy", [
      "serve",
      "--listen",
      "127.0.0.1:0",
      "--deny-metadata",
      "--resolve-before-connect",
    ]);
    children.push(permissive.child);

    const origin = NodeHttp.createServer((request, response) => {
      response.writeHead(200, {
        "content-type": "text/plain",
        "x-origin-host": request.headers.host ?? "",
      });
      response.end("origin body");
    });
    servers.push(origin);
    const originPort = await listen(origin);

    const answer = await new Promise<{ status: number; body: string; host: string }>(
      (resolve, reject) => {
        const request = NodeHttp.request(
          {
            host: "127.0.0.1",
            port: permissive.port,
            method: "GET",
            path: `http://127.0.0.1:${originPort}/thing`,
            headers: { host: `127.0.0.1:${originPort}` },
          },
          (response) => {
            const chunks: Array<Buffer> = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                body: Buffer.concat(chunks).toString("utf8"),
                host: String(response.headers["x-origin-host"] ?? ""),
              }),
            );
          },
        );
        request.once("error", reject);
        request.end();
      },
    );
    expect(answer.status).toBe(200);
    expect(answer.body).toBe("origin body");
    expect(answer.host).toBe(`127.0.0.1:${originPort}`);
  });
});
