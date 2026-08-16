import * as NodeCrypto from "node:crypto";
import type { SandboxCommandExecutor } from "./types.ts";

export const REQUIRED_DESKTOP_BINARIES = [
  "startxfce4",
  "chromium",
  "code",
  "tmux",
  "t3-desktop-webrtc",
] as const;

export type DesktopCapability = {
  readonly ready: boolean;
  readonly missing: ReadonlyArray<string>;
};

export type ThreadDesktopSession = {
  readonly threadId: string;
  readonly sessionId: string;
  readonly display: ":1";
  readonly resolution: "1440x900";
  readonly browserProfilePath: string;
  readonly browserAutomationEndpoint: string;
  readonly tmuxSession: string;
  readonly signalingPath: string;
  readonly reconnectKey: string;
  readonly fullscreenSupported: true;
  readonly transport: "webrtc";
  readonly vncEndpoint: null;
};

const safeId = (value: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error("invalid thread id");
  return value;
};

export const desktopSessionForThread = (threadIdValue: string): ThreadDesktopSession => {
  const threadId = safeId(threadIdValue);
  const digest = NodeCrypto.createHash("sha256").update(threadId).digest("hex").slice(0, 24);
  return {
    threadId,
    sessionId: `desktop-${digest}`,
    display: ":1",
    resolution: "1440x900",
    browserProfilePath: `/thread-data/${threadId}/chromium`,
    browserAutomationEndpoint: "http://127.0.0.1:9222",
    tmuxSession: `thread-${digest}`,
    signalingPath: `/api/thread-desktop/${threadId}/signal`,
    reconnectKey: digest,
    fullscreenSupported: true,
    transport: "webrtc",
    vncEndpoint: null,
  };
};

export const detectDesktopCapability = async (
  executor: SandboxCommandExecutor,
): Promise<DesktopCapability> => {
  const missing: Array<string> = [];
  for (const binary of REQUIRED_DESKTOP_BINARIES) {
    const result = await executor.run({
      executable: "sh",
      args: ["-lc", 'command -v -- "$1" >/dev/null 2>&1', "sh", binary],
      timeoutMs: 5_000,
    });
    if (result.exitCode !== 0) missing.push(binary);
  }
  return { ready: missing.length === 0, missing };
};

export const tmuxMirrorCommand = (
  session: ThreadDesktopSession,
  executable: string,
  args: ReadonlyArray<string>,
) => {
  if (executable.length === 0 || executable.includes("\0")) throw new Error("invalid executable");
  if (args.some((arg) => arg.includes("\0"))) throw new Error("invalid command argument");
  return {
    executable: "tmux",
    args: ["new-session", "-A", "-d", "-s", session.tmuxSession, "--", executable, ...args],
  } as const;
};

export const desktopLaunchCommands = (session: ThreadDesktopSession) =>
  [
    { executable: "tmux", args: ["new-session", "-A", "-d", "-s", session.tmuxSession] },
    { executable: "startxfce4", args: [] },
    {
      executable: "chromium",
      args: [
        `--user-data-dir=${session.browserProfilePath}`,
        "--remote-debugging-address=0.0.0.0",
        "--remote-debugging-port=9222",
        "--no-first-run",
      ],
    },
    { executable: "code", args: ["--reuse-window", "/workspace/repo"] },
    {
      executable: "t3-desktop-webrtc",
      args: [
        "--display",
        session.display,
        "--resolution",
        session.resolution,
        "--signaling-path",
        session.signalingPath,
      ],
    },
  ] as const;

type SignalRecord = {
  readonly session: ThreadDesktopSession;
  readonly tokenHashes: Partial<Record<"viewer" | "bridge", Buffer>>;
  connected: boolean;
  expiresAt: number;
  sequence: number;
  messages: Array<{
    readonly sequence: number;
    readonly sender: "viewer" | "bridge";
    readonly type: "offer" | "answer" | "ice" | "input";
    readonly payload: string;
  }>;
};

/** In-memory, thread-bound signaling authorization. Viewer disconnect only marks
 * transport state; it never changes agent pause/takeover state. */
export class ThreadDesktopSignaling {
  readonly #records = new Map<string, SignalRecord>();
  readonly #now: () => number;

  constructor(now: () => number = () => Math.floor(process.uptime() * 1_000)) {
    this.#now = now;
  }

  issue(threadId: string, role: "viewer" | "bridge" = "viewer") {
    const session = desktopSessionForThread(threadId);
    const token = NodeCrypto.randomBytes(32).toString("base64url");
    const existing = this.#records.get(threadId);
    this.#records.set(
      threadId,
      existing === undefined
        ? {
            session,
            tokenHashes: { [role]: NodeCrypto.createHash("sha256").update(token).digest() },
            connected: false,
            expiresAt: this.#now() + 8 * 60 * 60_000,
            sequence: 0,
            messages: [],
          }
        : {
            ...existing,
            tokenHashes: {
              ...existing.tokenHashes,
              [role]: NodeCrypto.createHash("sha256").update(token).digest(),
            },
          },
    );
    return { sessionId: session.sessionId, token };
  }

  attach(input: {
    threadId: string;
    sessionId: string;
    token: string;
    role?: "viewer" | "bridge";
  }) {
    const record = this.#records.get(input.threadId);
    if (record === undefined || record.session.sessionId !== input.sessionId) return null;
    if (record.expiresAt <= this.#now()) {
      this.#records.delete(input.threadId);
      return null;
    }
    const candidate = NodeCrypto.createHash("sha256").update(input.token).digest();
    const expected = record.tokenHashes[input.role ?? "viewer"];
    if (expected === undefined || !NodeCrypto.timingSafeEqual(expected, candidate)) return null;
    record.connected = true;
    return { ...record.session, connected: true as const };
  }

  disconnect(threadId: string) {
    const record = this.#records.get(threadId);
    if (record !== undefined) record.connected = false;
  }

  status(threadId: string) {
    const record = this.#records.get(threadId);
    if (record !== undefined && record.expiresAt <= this.#now()) {
      this.#records.delete(threadId);
      return null;
    }
    return record === undefined ? null : { ...record.session, connected: record.connected };
  }

  publish(input: {
    threadId: string;
    sessionId: string;
    token: string;
    type: "offer" | "answer" | "ice" | "input";
    payload: string;
    role?: "viewer" | "bridge";
  }) {
    if (input.payload.length === 0 || input.payload.length > 256 * 1024) return null;
    const attached = this.attach(input);
    if (attached === null) return null;
    const record = this.#records.get(input.threadId)!;
    record.sequence += 1;
    record.messages.push({
      sequence: record.sequence,
      sender: input.role ?? "viewer",
      type: input.type,
      payload: input.payload,
    });
    if (record.messages.length > 256) record.messages.splice(0, record.messages.length - 256);
    return { sequence: record.sequence };
  }

  messagesAfter(input: {
    threadId: string;
    sessionId: string;
    token: string;
    sequence: number;
    role?: "viewer" | "bridge";
  }) {
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) return null;
    if (this.attach(input) === null) return null;
    const role = input.role ?? "viewer";
    return this.#records
      .get(input.threadId)!
      .messages.filter((message) => message.sequence > input.sequence && message.sender !== role);
  }

  remove(threadId: string) {
    this.#records.delete(threadId);
  }

  purgeExpired() {
    const now = this.#now();
    let purged = 0;
    for (const [threadId, record] of this.#records) {
      if (record.expiresAt > now) continue;
      this.#records.delete(threadId);
      purged += 1;
    }
    return purged;
  }
}
