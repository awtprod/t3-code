// @effect-diagnostics nodeBuiltinImport:off - Standalone container binary; it is bundled without Effect and has no runtime.
// @effect-diagnostics globalTimers:off - The framed-WebSocket idle timer is owned by this process, not an Effect fiber.
import * as NodeHttp from "node:http";
import { parseArgs, parseListenAddress, printedHelp } from "./cli.ts";

/**
 * The sidecar half of the thread preview path. Every subcommand here exists
 * because `apps/server/src/sandbox/ThreadPreviewProxy.ts` invokes it by name
 * over `podman exec --interactive`; the argv and document shapes are dictated
 * by that file, not chosen here.
 *
 * - `serve`   ThreadPreviewProxy.start (line 61-67)
 * - `request` ThreadPreviewProxy.request (line 109)
 * - `websocket-framed` ThreadPreviewProxy.webSocketCommand (line 132)
 * - `cdp-automation`   ThreadPreviewProxy.automate (line 165)
 * - `signal`  ThreadPreviewProxy.signal (line 188)
 */

type Target = { readonly hostname: string; readonly port: number };

const MAX_SIGNAL_MESSAGES = 256;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

const isTarget = (value: unknown): value is Target => {
  if (typeof value !== "object" || value === null) return false;
  const target = value as Record<string, unknown>;
  return (
    typeof target.hostname === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(target.hostname) &&
    Number.isInteger(target.port) &&
    (target.port as number) >= 1 &&
    (target.port as number) <= 65535
  );
};

const readStdin = async () => {
  const chunks: Array<Buffer> = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

/** Reads exactly one newline-terminated JSON document, leaving the rest of stdin intact. */
const readStdinLine = () =>
  new Promise<string>((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) {
        if (buffer.length > 1024 * 1024) {
          cleanup();
          reject(new Error("handshake exceeded 1 MiB"));
        }
        return;
      }
      const line = buffer.subarray(0, newline).toString("utf8");
      const rest = buffer.subarray(newline + 1);
      cleanup();
      if (rest.length > 0) process.stdin.unshift(rest);
      resolve(line);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("stdin closed before handshake"));
    };
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onError);
      process.stdin.pause();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("error", onError);
    process.stdin.resume();
  });

const writeStdout = (value: unknown) =>
  new Promise<void>((resolve) => {
    process.stdout.write(JSON.stringify(value), () => resolve());
  });

/**
 * `request`: one JSON request document on stdin, one
 * `{status, headers, bodyBase64}` document on stdout, then exit. Shape comes
 * from ThreadPreviewProxy.request (payload built at line 98, response validated
 * by `isBridgeResponse` at line 231).
 */
export const runRequest = async () => {
  const raw = await readStdin();
  let document: Record<string, unknown>;
  try {
    document = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return writeStdout(errorResponse(400, "malformed request document"));
  }
  const target = document.target;
  if (!isTarget(target)) return writeStdout(errorResponse(400, "invalid preview target"));
  const method = typeof document.method === "string" ? document.method : "GET";
  const path = typeof document.path === "string" ? document.path : "/";
  const headers =
    typeof document.headers === "object" && document.headers !== null
      ? (document.headers as Record<string, string>)
      : {};
  const bodyBase64 = typeof document.bodyBase64 === "string" ? document.bodyBase64 : "";
  const maxResponseBytes = Number.isInteger(document.maxResponseBytes)
    ? (document.maxResponseBytes as number)
    : DEFAULT_MAX_RESPONSE_BYTES;
  const timeoutMs = Number.isInteger(document.timeoutMs)
    ? (document.timeoutMs as number)
    : DEFAULT_TIMEOUT_MS;
  const body = bodyBase64 === "" ? undefined : Buffer.from(bodyBase64, "base64");

  const response = await new Promise<{
    status: number;
    headers: Record<string, string>;
    bodyBase64: string;
  }>((resolve) => {
    const request = NodeHttp.request(
      {
        host: target.hostname,
        port: target.port,
        method,
        path,
        headers: { ...headers, host: `${target.hostname}:${target.port}` },
        timeout: timeoutMs,
      },
      (incoming) => {
        const chunks: Array<Buffer> = [];
        let size = 0;
        incoming.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxResponseBytes) {
            incoming.destroy();
            resolve(errorResponse(502, "upstream response exceeded limit"));
            return;
          }
          chunks.push(chunk);
        });
        incoming.on("end", () =>
          resolve({
            status: incoming.statusCode ?? 502,
            headers: flattenHeaders(incoming.headers),
            bodyBase64: Buffer.concat(chunks).toString("base64"),
          }),
        );
        incoming.on("error", () => resolve(errorResponse(502, "upstream response failed")));
      },
    );
    request.on("timeout", () => {
      request.destroy();
      resolve(errorResponse(504, "upstream timed out"));
    });
    request.on("error", () => resolve(errorResponse(502, "upstream connection failed")));
    if (body !== undefined) request.write(body);
    request.end();
  });
  return writeStdout(response);
};

const errorResponse = (status: number, message: string) => ({
  status,
  headers: { "content-type": "text/plain; charset=utf-8" },
  bodyBase64: Buffer.from(message).toString("base64"),
});

const flattenHeaders = (headers: NodeHttp.IncomingHttpHeaders) => {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const flat = Array.isArray(value) ? value.join(", ") : value;
    if (name.length > 128 || flat.length > 8192) continue;
    result[name] = flat;
  }
  return result;
};

/**
 * `websocket-framed`: one handshake JSON line on stdin (built by
 * ThreadPreviewProxy.webSocketCommand at line 133), then uint32-BE
 * length-prefixed duplex frames matching the relay in
 * `apps/server/src/sandbox/DesktopHttpRoutes.ts` lines 348-398.
 *
 * The relay arms a 10s handshake timer (DesktopHttpRoutes.ts line 351) that
 * kills this child unless stdout produces something. A zero-length frame on
 * upstream open is therefore mandatory, not cosmetic.
 */
export const runWebSocketFramed = async () => {
  const line = await readStdinLine();
  const handshake = JSON.parse(line) as Record<string, unknown>;
  const target = handshake.target;
  if (!isTarget(target)) throw new Error("invalid preview target");
  const path = typeof handshake.path === "string" ? handshake.path : "/";
  const headers =
    typeof handshake.headers === "object" && handshake.headers !== null
      ? (handshake.headers as Record<string, string>)
      : {};
  const maxFrameBytes = Number.isInteger(handshake.maxFrameBytes)
    ? (handshake.maxFrameBytes as number)
    : 1024 * 1024;
  const idleTimeoutMs = Number.isInteger(handshake.idleTimeoutMs)
    ? (handshake.idleTimeoutMs as number)
    : 60_000;

  const upstreamHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower.startsWith("sec-websocket-") || lower === "upgrade" || lower === "connection")
      continue;
    upstreamHeaders[name] = value;
  }
  const socket = new WebSocket(`ws://${target.hostname}:${target.port}${path}`, {
    headers: upstreamHeaders,
  } as unknown as string[]);
  socket.binaryType = "arraybuffer";

  await new Promise<void>((resolve) => {
    let idleTimer: NodeJS.Timeout | undefined;
    let inbound = Buffer.alloc(0);
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      process.stdin.off("data", onStdin);
      try {
        socket.close();
      } catch {
        /* already closing */
      }
      resolve();
    };
    const touch = () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(finish, idleTimeoutMs);
      idleTimer.unref?.();
    };
    const emit = (payload: Buffer) => {
      const header = Buffer.allocUnsafe(4);
      header.writeUInt32BE(payload.length);
      process.stdout.write(Buffer.concat([header, payload]));
    };
    const onStdin = (chunk: Buffer) => {
      inbound = Buffer.concat([inbound, chunk]);
      while (inbound.length >= 4) {
        const length = inbound.readUInt32BE(0);
        if (length > maxFrameBytes) {
          finish();
          return;
        }
        if (inbound.length < length + 4) return;
        const payload = inbound.subarray(4, length + 4);
        inbound = inbound.subarray(length + 4);
        touch();
        if (socket.readyState === WebSocket.OPEN) socket.send(new Uint8Array(payload));
      }
    };
    socket.addEventListener("open", () => {
      // Unblocks the server relay's handshake timer before any upstream payload.
      emit(Buffer.alloc(0));
      touch();
      process.stdin.on("data", onStdin);
      process.stdin.resume();
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      const payload =
        typeof event.data === "string"
          ? Buffer.from(event.data)
          : Buffer.from(event.data as ArrayBuffer);
      if (payload.length > maxFrameBytes) {
        finish();
        return;
      }
      touch();
      emit(payload);
    });
    socket.addEventListener("close", finish);
    socket.addEventListener("error", finish);
    process.stdin.once("end", finish);
  });
};

/**
 * `cdp-automation`: headless images carry no browser, so this answers with a
 * well-formed document instead of hanging. ThreadPreviewProxy.automate (line
 * 177) only JSON-parses the result, so the shape is ours to define; keeping an
 * `error` key makes the failure legible to callers.
 */
export const runCdpAutomation = async () => {
  const raw = await readStdin();
  let operation = "unknown";
  try {
    const document = JSON.parse(raw) as Record<string, unknown>;
    if (typeof document.operation === "string") operation = document.operation;
  } catch {
    /* report the generic unsupported error below */
  }
  return writeStdout({
    ok: false,
    operation,
    error: {
      code: "automation_unsupported",
      message: "this sandbox image is headless; browser automation is unavailable",
    },
  });
};

type SignalMessage = {
  readonly sequence: number;
  readonly sender: string;
  readonly type: string;
  readonly payload: string;
};

/** Per-session ring buffer backing the `serve --signaling-relay` store. */
class SignalStore {
  readonly #sessions = new Map<string, { sequence: number; messages: Array<SignalMessage> }>();

  publish(sessionId: string, sender: string, type: string, payload: string) {
    const session = this.#sessions.get(sessionId) ?? { sequence: 0, messages: [] };
    session.sequence += 1;
    session.messages.push({ sequence: session.sequence, sender, type, payload });
    if (session.messages.length > MAX_SIGNAL_MESSAGES)
      session.messages.splice(0, session.messages.length - MAX_SIGNAL_MESSAGES);
    this.#sessions.set(sessionId, session);
    return { sequence: session.sequence };
  }

  after(sessionId: string, sequence: number, role: string) {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return [];
    return session.messages.filter(
      (message) => message.sequence > sequence && message.sender !== role,
    );
  }
}

const handleSignalDocument = (store: SignalStore, document: Record<string, unknown>) => {
  const sessionId = typeof document.sessionId === "string" ? document.sessionId : "";
  const role = typeof document.role === "string" ? document.role : "viewer";
  const type = typeof document.type === "string" ? document.type : "";
  if (sessionId === "" || type === "") return { error: "invalid signal document" };
  if (type === "poll") {
    const sequence = Number.isSafeInteger(document.sequence) ? (document.sequence as number) : 0;
    return { messages: store.after(sessionId, sequence, role) };
  }
  const payload = typeof document.payload === "string" ? document.payload : "";
  return store.publish(sessionId, role, type, payload);
};

/**
 * `signal`: stdin JSON in, stdout JSON out, against the local `serve` store.
 * DesktopHttpRoutes.ts line 307 requires a `{messages: [...]}` document for
 * polls; publishes return `{sequence}` (ThreadPreviewProxy.signal, line 194).
 */
export const runSignal = async (endpoint: string) => {
  const raw = await readStdin();
  const url = new URL("/signal", endpoint);
  const answer = await new Promise<unknown>((resolve) => {
    const request = NodeHttp.request(
      {
        host: url.hostname,
        port: url.port === "" ? 80 : Number(url.port),
        method: "POST",
        path: url.pathname,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(raw) },
        timeout: 10_000,
      },
      (incoming) => {
        const chunks: Array<Buffer> = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => {
          if (incoming.statusCode !== 200) {
            resolve({ error: "signaling relay unavailable" });
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            resolve({ error: "signaling relay returned malformed JSON" });
          }
        });
      },
    );
    request.on("timeout", () => {
      request.destroy();
      resolve({ error: "signaling relay timed out" });
    });
    request.on("error", () => resolve({ error: "signaling relay unavailable" }));
    request.end(raw);
  });
  return writeStdout(answer);
};

/**
 * `serve --stdio --listen 0.0.0.0:8080 --signaling-relay`: the sidecar's
 * long-running entrypoint (ThreadPreviewProxy.start, line 62-67). It hosts the
 * signal store that `signal` and the in-container WebRTC bridge talk to; the
 * origin is `http://<sidecar>:8080` (ThreadPreviewProxy line 221).
 */
export const runServe = async (host: string, port: number) => {
  const store = new SignalStore();
  const server = NodeHttp.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    if (request.method !== "POST" || request.url !== "/signal") {
      response.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    const chunks: Array<Buffer> = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 512 * 1024) {
        response.writeHead(413).end();
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      let document: Record<string, unknown>;
      try {
        document = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      } catch {
        response.writeHead(400, { "content-type": "application/json" }).end('{"error":"bad json"}');
        return;
      }
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(handleSignalDocument(store, document)));
    });
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const bound = typeof address === "object" && address !== null ? address.port : port;
  process.stderr.write(`t3-preview-bridge listening on ${host}:${bound}\n`);
  await new Promise<void>((resolve) => server.once("close", () => resolve()));
};

export const main = async (argv: ReadonlyArray<string>) => {
  const args = parseArgs(argv);
  if (
    printedHelp(
      args,
      "usage: t3-preview-bridge <serve|request|websocket-framed|cdp-automation|signal> [--stdio] [--listen host:port] [--signaling-relay]",
    )
  )
    return;
  switch (args.subcommand) {
    case "serve": {
      const { host, port } = parseListenAddress(args.values.get("listen") ?? "0.0.0.0:8080", 8080);
      return runServe(host, port);
    }
    case "request":
      return runRequest();
    case "websocket-framed":
      return runWebSocketFramed();
    case "cdp-automation":
      return runCdpAutomation();
    case "signal":
      // The sidecar hosts its store on the same 8080 the server dials
      // (ThreadPreviewProxy.internalSignalingOrigin, line 221).
      return runSignal(
        args.values.get("endpoint") ??
          process.env.T3_PREVIEW_BRIDGE_ENDPOINT ??
          "http://127.0.0.1:8080",
      );
    default:
      throw new Error(`unknown t3-preview-bridge subcommand: ${args.subcommand ?? "(none)"}`);
  }
};
