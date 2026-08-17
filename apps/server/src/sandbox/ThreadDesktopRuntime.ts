import * as Effect from "effect/Effect";
import type { ThreadSandboxBackend } from "./types.ts";
import {
  OPTIONAL_HEADLESS_BINARIES,
  REQUIRED_DESKTOP_BINARIES,
  REQUIRED_HEADLESS_BINARIES,
  desktopSessionForThread,
  type DesktopCapability,
  type ThreadDesktopSession,
} from "./DesktopSession.ts";
import { resolveSandboxDesktopMode } from "./SandboxRuntimeManager.ts";

export class ThreadDesktopRuntime {
  readonly #backend: ThreadSandboxBackend;
  readonly #started = new Map<string, ThreadDesktopSession>();

  constructor(backend: ThreadSandboxBackend) {
    this.#backend = backend;
  }

  async detect(threadId: string): Promise<DesktopCapability> {
    const probe = (binary: string) =>
      this.#backend
        .exec(threadId, {
          executable: "sh",
          args: ["-lc", 'command -v -- "$1" >/dev/null 2>&1', "sh", binary],
          timeoutMs: 5_000,
        })
        .then(
          () => true,
          () => false,
        );
    const missing: Array<string> = [];
    if (resolveSandboxDesktopMode() === "disabled") {
      for (const binary of REQUIRED_HEADLESS_BINARIES)
        if (!(await probe(binary))) missing.push(binary);
      const degraded: Array<string> = [];
      for (const binary of OPTIONAL_HEADLESS_BINARIES)
        if (!(await probe(binary))) degraded.push(binary);
      // Provider CLIs are soft requirements: a missing one degrades the thread
      // rather than failing provisioning, so it is reported, not thrown.
      if (degraded.length > 0)
        Effect.runFork(
          Effect.logWarning("Sandbox image is missing provider CLIs", { threadId, degraded }),
        );
      return { ready: missing.length === 0, missing, degraded };
    }
    for (const binary of REQUIRED_DESKTOP_BINARIES)
      if (!(await probe(binary))) missing.push(binary);
    return { ready: missing.length === 0, missing };
  }

  async start(
    threadId: string,
    bridgeCredential: { sessionId: string; token: string },
    signalingOrigin: string,
  ) {
    const existing = this.#started.get(threadId);
    if (existing !== undefined) return existing;
    const capability = await this.detect(threadId);
    if (!capability.ready)
      throw new Error(
        `desktop image is missing required capabilities: ${capability.missing.join(", ")}`,
      );
    const session = desktopSessionForThread(threadId);
    const signalingUrl = resolveSignalingUrl(signalingOrigin, session.signalingPath);
    try {
      await this.#backend.exec(threadId, {
        executable: "mkdir",
        args: ["-p", session.browserProfilePath],
        timeoutMs: 5_000,
      });
      await this.#backend.exec(threadId, {
        executable: "sh",
        args: ["-lc", "umask 077; cat > /tmp/t3-desktop-webrtc-auth.json"],
        stdin: JSON.stringify({ ...bridgeCredential, role: "bridge" }),
        timeoutMs: 5_000,
      });
      await this.#backend.exec(threadId, {
        executable: "tmux",
        args: ["new-session", "-A", "-d", "-s", session.tmuxSession, "-n", "terminal"],
        env: { DISPLAY: session.display },
        timeoutMs: 10_000,
      });
      await this.#tmux(threadId, session, "xserver", "Xvfb", [
        session.display,
        "-screen",
        "0",
        `${session.resolution}x24`,
        "-nolisten",
        "tcp",
      ]);
      await this.#backend.exec(threadId, {
        executable: "sh",
        args: [
          "-lc",
          'i=0; while [ $i -lt 100 ]; do xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && exit 0; i=$((i+1)); sleep .1; done; exit 1',
        ],
        env: { DISPLAY: session.display },
        timeoutMs: 12_000,
      });
      await this.#tmux(threadId, session, "desktop", "startxfce4", []);
      await this.#tmux(threadId, session, "browser", "chromium", [
        `--user-data-dir=${session.browserProfilePath}`,
        "--remote-debugging-address=0.0.0.0",
        "--remote-debugging-port=9222",
        "--no-first-run",
        "--disable-dev-shm-usage",
      ]);
      await this.#tmux(threadId, session, "editor", "code", ["--reuse-window", "/workspace/repo"]);
      await this.#tmux(threadId, session, "webrtc", "t3-desktop-webrtc", [
        "--display",
        session.display,
        "--resolution",
        session.resolution,
        "--signaling-url",
        signalingUrl,
        "--auth-file",
        "/tmp/t3-desktop-webrtc-auth.json",
      ]);
      await this.#backend.exec(threadId, {
        executable: "sh",
        args: [
          "-lc",
          "i=0; while [ $i -lt 100 ]; do wget -qO- http://127.0.0.1:9222/json/version >/dev/null && exit 0; i=$((i+1)); sleep .1; done; exit 1",
        ],
        timeoutMs: 12_000,
      });
    } catch (error) {
      await this.stop(threadId);
      throw error;
    }
    this.#started.set(threadId, session);
    return session;
  }

  async stop(threadId: string) {
    const session = this.#started.get(threadId) ?? desktopSessionForThread(threadId);
    await this.#backend
      .exec(threadId, {
        executable: "tmux",
        args: ["kill-session", "-t", session.tmuxSession],
        timeoutMs: 10_000,
      })
      .catch(() => undefined);
    this.#started.delete(threadId);
    await this.#backend
      .exec(threadId, {
        executable: "rm",
        args: ["-f", "/tmp/t3-desktop-webrtc-auth.json"],
        timeoutMs: 5_000,
      })
      .catch(() => undefined);
  }

  automationTarget(threadId: string) {
    const session = this.#started.get(threadId);
    if (session === undefined) throw new Error(`desktop for thread ${threadId} is not ready`);
    return {
      threadId,
      endpoint: session.browserAutomationEndpoint,
      profilePath: session.browserProfilePath,
    };
  }

  async recover(threadId: string) {
    const session = desktopSessionForThread(threadId);
    const tmux = await this.#backend
      .exec(threadId, {
        executable: "tmux",
        args: ["has-session", "-t", session.tmuxSession],
        timeoutMs: 5_000,
      })
      .then(
        () => true,
        () => false,
      );
    const cdp = await this.#backend
      .exec(threadId, {
        executable: "wget",
        args: ["-qO-", "http://127.0.0.1:9222/json/version"],
        timeoutMs: 5_000,
      })
      .then(
        () => true,
        () => false,
      );
    if (!tmux || !cdp) return null;
    this.#started.set(threadId, session);
    return session;
  }

  async #tmux(
    threadId: string,
    session: ThreadDesktopSession,
    windowName: string,
    executable: string,
    args: ReadonlyArray<string>,
  ) {
    const result = await this.#backend.exec(threadId, {
      executable: "tmux",
      args: [
        "new-window",
        "-d",
        "-t",
        session.tmuxSession,
        "-n",
        windowName,
        "--",
        executable,
        ...args,
      ],
      env: { DISPLAY: session.display },
      timeoutMs: 10_000,
    });
    if (result.exitCode !== 0)
      throw new Error(`failed to start desktop ${windowName}: ${result.stderr}`);
  }
}

export const resolveSignalingUrl = (origin: string, path: string) => {
  let url: URL;
  try {
    url = new URL(path, origin);
  } catch {
    throw new Error("desktop signaling origin is invalid");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.origin !== new URL(origin).origin
  )
    throw new Error("desktop signaling origin must be an absolute HTTP(S) origin");
  if (["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(url.hostname.replace(/^\[|\]$/g, "")))
    throw new Error("desktop signaling origin must be reachable from the sandbox network");
  return url.toString();
};
