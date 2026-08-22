import type { SandboxCommand, SandboxCommandExecutor } from "./types.ts";
import * as NodeCrypto from "node:crypto";
import { AuthenticatedPreviewRouter } from "./AuthenticatedPreviewRouter.ts";

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
/** Conservative sidecar ceilings; mirrors the egress and credential sidecars. */
const PREVIEW_PROXY_MEMORY = "256m";
const PREVIEW_PROXY_CPUS = "0.5";

export type PreviewProxyRequest = {
  readonly routeId: string;
  readonly threadId: string;
  readonly token: string;
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
};

export class ThreadPreviewProxy {
  readonly #runtime: "docker" | "podman";
  readonly #executor: SandboxCommandExecutor;
  readonly #router: AuthenticatedPreviewRouter;
  readonly #containers = new Map<string, string>();

  constructor(
    runtime: "docker" | "podman",
    executor: SandboxCommandExecutor,
    router: AuthenticatedPreviewRouter,
  ) {
    this.#runtime = runtime;
    this.#executor = executor;
    this.#router = router;
  }

  async start(threadId: string, networkName: string, image: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(networkName))
      throw new Error("invalid sandbox network name");
    if (!/^[a-z0-9][a-z0-9._/-]{0,200}@sha256:[a-f0-9]{64}$/i.test(image))
      throw new Error("preview proxy image must be pinned by sha256 digest");
    const name = previewContainerName(threadId);
    await this.#mustRun({
      executable: this.#runtime,
      args: [
        "run",
        "--detach",
        "--name",
        name,
        "--network",
        networkName,
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
        PREVIEW_PROXY_MEMORY,
        "--memory-swap",
        PREVIEW_PROXY_MEMORY,
        "--cpus",
        PREVIEW_PROXY_CPUS,
        image,
        "t3-preview-bridge",
        "serve",
        "--stdio",
        "--listen",
        "0.0.0.0:8080",
        "--signaling-relay",
      ],
      timeoutMs: 60_000,
    });
    this.#containers.set(threadId, name);
  }

  async request(input: PreviewProxyRequest) {
    const target = this.#router.resolve(input);
    const container = this.#containers.get(input.threadId);
    if (target === null || container === undefined)
      throw new Error("preview route is not authorized or ready");
    if (!/^(GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE)$/i.test(input.method))
      throw new Error("unsupported preview method");
    if (!input.path.startsWith("/") || input.path.startsWith("//") || input.path.includes("\\"))
      throw new Error("invalid preview path");
    if ((input.body?.byteLength ?? 0) > MAX_BODY_BYTES)
      throw new Error("preview request body is too large");
    const safeHeaders = Object.fromEntries(
      Object.entries(input.headers).filter(
        ([name]) =>
          ![
            "authorization",
            "cookie",
            "dpop",
            "proxy-authorization",
            "host",
            "connection",
            "upgrade",
          ].includes(name.toLowerCase()),
      ),
    );
    const payload = JSON.stringify({
      target,
      method: input.method.toUpperCase(),
      path: input.path,
      headers: safeHeaders,
      bodyBase64: input.body === undefined ? "" : Buffer.from(input.body).toString("base64"),
      maxResponseBytes: MAX_BODY_BYTES,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    const result = await this.#mustRun({
      executable: this.#runtime,
      args: ["exec", "--interactive", container, "t3-preview-bridge", "request"],
      stdin: payload,
      timeoutMs: REQUEST_TIMEOUT_MS + 2_000,
    });
    if (Buffer.byteLength(result.stdout) > MAX_BODY_BYTES * 2)
      throw new Error("preview response exceeded limit");
    const decoded: unknown = JSON.parse(result.stdout);
    if (!isBridgeResponse(decoded)) throw new Error("preview bridge returned a malformed response");
    const body = Buffer.from(decoded.bodyBase64, "base64");
    if (body.byteLength > MAX_BODY_BYTES) throw new Error("preview response body is too large");
    return { status: decoded.status, headers: decoded.headers, body: new Uint8Array(body) };
  }

  webSocketCommand(
    input: Pick<PreviewProxyRequest, "routeId" | "threadId" | "token" | "path" | "headers">,
  ) {
    const target = this.#router.resolve(input);
    const container = this.#containers.get(input.threadId);
    if (target === null || container === undefined) return null;
    if (!input.path.startsWith("/") || input.path.startsWith("//") || input.path.includes("\\"))
      return null;
    return {
      executable: this.#runtime,
      args: ["exec", "--interactive", container, "t3-preview-bridge", "websocket-framed"],
      handshake: JSON.stringify({
        target,
        path: input.path,
        headers: Object.fromEntries(
          Object.entries(input.headers).filter(
            ([name]) =>
              !["authorization", "cookie", "dpop", "proxy-authorization", "host"].includes(
                name.toLowerCase(),
              ),
          ),
        ),
        maxFrameBytes: 1024 * 1024,
        idleTimeoutMs: 60_000,
      }),
    };
  }

  async automate(input: {
    routeId: string;
    threadId: string;
    token: string;
    operation: string;
    payload: unknown;
    timeoutMs: number;
  }) {
    const target = this.#router.resolve(input);
    const container = this.#containers.get(input.threadId);
    if (target === null || container === undefined)
      throw new Error("browser automation target is not authorized or ready");
    const timeoutMs = Math.min(Math.max(input.timeoutMs, 1_000), 60_000);
    const result = await this.#mustRun({
      executable: this.#runtime,
      args: ["exec", "--interactive", container, "t3-preview-bridge", "cdp-automation"],
      stdin: JSON.stringify({
        target,
        operation: input.operation,
        input: input.payload,
        timeoutMs,
        rewriteWebSocketUrls: true,
      }),
      timeoutMs: timeoutMs + 2_000,
    });
    if (Buffer.byteLength(result.stdout) > 8 * 1024 * 1024)
      throw new Error("browser automation result exceeded limit");
    return JSON.parse(result.stdout) as unknown;
  }

  async signal(threadId: string, payload: unknown) {
    const container = this.#containers.get(threadId);
    if (container === undefined) throw new Error("thread signaling sidecar is not ready");
    const encoded = JSON.stringify(payload);
    if (Buffer.byteLength(encoded) > 256 * 1024)
      throw new Error("signaling payload exceeded limit");
    const result = await this.#mustRun({
      executable: this.#runtime,
      args: ["exec", "--interactive", container, "t3-preview-bridge", "signal"],
      stdin: encoded,
      timeoutMs: 10_000,
    });
    if (Buffer.byteLength(result.stdout) > 512 * 1024)
      throw new Error("signaling response exceeded limit");
    return JSON.parse(result.stdout) as unknown;
  }

  async stop(threadId: string) {
    const container = this.#containers.get(threadId);
    if (container === undefined) return;
    this.#containers.delete(threadId);
    this.#router.removeThread(threadId);
    await this.#executor
      .run({ executable: this.#runtime, args: ["rm", "--force", container], timeoutMs: 30_000 })
      .catch(() => undefined);
  }

  async recover(threadId: string) {
    const name = previewContainerName(threadId);
    const result = await this.#executor.run({
      executable: this.#runtime,
      args: ["inspect", "--format", "{{.State.Running}}", name],
      timeoutMs: 10_000,
    });
    if (result.exitCode !== 0 || result.stdout.trim() !== "true") return false;
    this.#containers.set(threadId, name);
    return true;
  }

  internalSignalingOrigin(threadId: string) {
    if (!this.#containers.has(threadId)) throw new Error("thread signaling sidecar is not ready");
    return `http://${previewContainerName(threadId)}:8080`;
  }

  async #mustRun(command: SandboxCommand) {
    const result = await this.#executor.run(command);
    if (result.exitCode !== 0) throw new Error(result.stderr || "preview proxy command failed");
    return result;
  }
}

const isBridgeResponse = (
  value: unknown,
): value is { status: number; headers: Record<string, string>; bodyBase64: string } => {
  if (typeof value !== "object" || value === null) return false;
  const response = value as Record<string, unknown>;
  return (
    Number.isInteger(response.status) &&
    Number(response.status) >= 100 &&
    Number(response.status) <= 599 &&
    typeof response.bodyBase64 === "string" &&
    typeof response.headers === "object" &&
    response.headers !== null &&
    Object.entries(response.headers).every(
      ([key, item]) => key.length <= 128 && typeof item === "string" && item.length <= 8192,
    )
  );
};

const previewContainerName = (threadId: string) =>
  `t3-preview-${NodeCrypto.createHash("sha256").update(threadId).digest("hex").slice(0, 24)}`;
