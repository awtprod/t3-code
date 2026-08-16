import { describe, expect, it } from "@effect/vitest";
import { AuthenticatedPreviewRouter } from "./AuthenticatedPreviewRouter.ts";
import { ThreadCredentialBroker } from "./CredentialBroker.ts";
import {
  desktopLaunchCommands,
  desktopSessionForThread,
  detectDesktopCapability,
  ThreadDesktopSignaling,
  tmuxMirrorCommand,
} from "./DesktopSession.ts";
import { evaluateEgressDestination, evaluateResolvedEgressDestination } from "./EgressPolicy.ts";
import { planThreadServiceStack } from "./ThreadServiceStack.ts";
import { ThreadServiceStackRuntime } from "./ThreadServiceStack.ts";
import type { SandboxCommand, SandboxCommandResult, ThreadSandboxBackend } from "./types.ts";
import { ThreadDesktopRuntime } from "./ThreadDesktopRuntime.ts";
import { resolveSignalingUrl } from "./ThreadDesktopRuntime.ts";
import { ThreadPreviewProxy } from "./ThreadPreviewProxy.ts";
import { desktopGateway } from "./DesktopGatewayService.ts";

describe("thread desktop infrastructure", () => {
  it("derives stable, thread-isolated desktop and browser identities without VNC", () => {
    const first = desktopSessionForThread("thread-a");
    const again = desktopSessionForThread("thread-a");
    const second = desktopSessionForThread("thread-b");
    expect(first).toEqual(again);
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.browserProfilePath).not.toBe(second.browserProfilePath);
    expect(first.transport).toBe("webrtc");
    expect(first.vncEndpoint).toBeNull();
    expect(first.fullscreenSupported).toBe(true);
  });

  it("fails desktop readiness closed when an external capability is missing", async () => {
    const executor = {
      run: async (command: { args: ReadonlyArray<string> }) => ({
        exitCode: command.args.at(-1) === "code" ? 1 : 0,
        stdout: "",
        stderr: "",
      }),
    };
    await expect(detectDesktopCapability(executor)).resolves.toEqual({
      ready: false,
      missing: ["code"],
    });
  });

  it("mirrors commands through the thread's named tmux session without shell joining", () => {
    const session = desktopSessionForThread("thread-a");
    expect(tmuxMirrorCommand(session, "printf", ["%s", "hello; still-an-argument"])).toEqual({
      executable: "tmux",
      args: [
        "new-session",
        "-A",
        "-d",
        "-s",
        session.tmuxSession,
        "--",
        "printf",
        "%s",
        "hello; still-an-argument",
      ],
    });
  });

  it("launches one visible Chromium profile and WebRTC media with no VNC process", () => {
    const commands = desktopLaunchCommands(desktopSessionForThread("thread-a"));
    expect(commands.map((command) => command.executable)).toEqual([
      "tmux",
      "startxfce4",
      "chromium",
      "code",
      "t3-desktop-webrtc",
    ]);
    expect(commands.flatMap((command) => command.args).join(" ")).not.toMatch(/vnc/i);
    expect(commands.flatMap((command) => command.args)).toContain(
      "--remote-debugging-address=0.0.0.0",
    );
  });

  it("detects and starts desktop processes through in-container exec", async () => {
    const calls: Array<{ executable: string; args?: ReadonlyArray<string> }> = [];
    const backend = {
      exec: async (
        _threadId: string,
        input: { executable: string; args?: ReadonlyArray<string> },
      ) => {
        calls.push(input);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    } as unknown as ThreadSandboxBackend;
    const runtime = new ThreadDesktopRuntime(backend);
    await runtime.start(
      "thread-a",
      { sessionId: "desktop", token: "bridge-token" },
      "https://command.example.test",
    );
    expect(calls.some((call) => call.executable === "chromium")).toBe(false);
    expect(calls.filter((call) => call.executable === "tmux").length).toBeGreaterThanOrEqual(5);
    expect(runtime.automationTarget("thread-a").endpoint).toBe("http://127.0.0.1:9222");
  });

  it("requires an absolute sandbox-reachable signaling origin", () => {
    expect(
      resolveSignalingUrl("https://command.example.test", "/api/thread-desktop/thread-a/signal"),
    ).toBe("https://command.example.test/api/thread-desktop/thread-a/signal");
    expect(() => resolveSignalingUrl("http://127.0.0.1:3773", "/signal")).toThrow(/reachable/);
    expect(() => resolveSignalingUrl("not-an-origin", "/signal")).toThrow(/invalid/);
  });

  it("treats thrown in-container capability probes as missing", async () => {
    const backend = {
      exec: async (_threadId: string, input: { args?: ReadonlyArray<string> }) => {
        if (input.args?.at(-1) === "code") throw new Error("not found");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    } as unknown as ThreadSandboxBackend;
    await expect(new ThreadDesktopRuntime(backend).detect("thread-a")).resolves.toEqual({
      ready: false,
      missing: ["code"],
    });
  });

  it("authenticates WebRTC attachment and keeps disconnects paused until explicit reconnect", () => {
    const signaling = new ThreadDesktopSignaling();
    const issued = signaling.issue("thread-a");
    const bridge = signaling.issue("thread-a", "bridge");
    expect(signaling.attach({ ...issued, threadId: "thread-b" })).toBeNull();
    const attached = signaling.attach({ ...issued, threadId: "thread-a" });
    expect(attached?.connected).toBe(true);
    signaling.disconnect("thread-a");
    expect(signaling.status("thread-a")?.connected).toBe(false);
    expect(signaling.attach({ ...issued, threadId: "thread-a" })?.connected).toBe(true);
    expect(
      signaling.publish({
        ...bridge,
        threadId: "thread-a",
        role: "bridge",
        type: "offer",
        payload: "sdp",
      }),
    ).toEqual({ sequence: 1 });
    expect(signaling.messagesAfter({ ...issued, threadId: "thread-a", sequence: 0 })).toEqual([
      { sequence: 1, sender: "bridge", type: "offer", payload: "sdp" },
    ]);
  });

  it("issues one-time thread-bound viewer tickets", () => {
    const issued = desktopGateway.issueViewerTicket("thread-a");
    expect(desktopGateway.consumeViewerTicket("thread-b", issued.ticket)).toBe(false);
    const valid = desktopGateway.issueViewerTicket("thread-a");
    expect(desktopGateway.consumeViewerTicket("thread-a", valid.ticket)).toBe(true);
    expect(desktopGateway.consumeViewerTicket("thread-a", valid.ticket)).toBe(false);
  });

  it("rejects oversized signaling payloads and bounds retained history", () => {
    const signaling = new ThreadDesktopSignaling();
    const issued = signaling.issue("thread-a");
    const bridge = signaling.issue("thread-a", "bridge");
    expect(
      signaling.publish({
        ...issued,
        threadId: "thread-a",
        type: "ice",
        payload: "x".repeat(256 * 1024 + 1),
      }),
    ).toBeNull();
    for (let index = 0; index < 300; index += 1)
      signaling.publish({
        ...bridge,
        threadId: "thread-a",
        role: "bridge",
        type: "ice",
        payload: String(index),
      });
    expect(signaling.messagesAfter({ ...issued, threadId: "thread-a", sequence: 0 })).toHaveLength(
      256,
    );
  });

  it("purges expired signaling sessions and gates human input on takeover", () => {
    let now = 0;
    const signaling = new ThreadDesktopSignaling(() => now);
    signaling.issue("thread-expiring");
    now = 8 * 60 * 60_000 + 1;
    expect(signaling.purgeExpired()).toBe(1);
    desktopGateway.setHumanControl("thread-a", false);
    expect(desktopGateway.acceptsHumanInput("thread-a")).toBe(false);
    desktopGateway.setHumanControl("thread-a", true);
    expect(desktopGateway.acceptsHumanInput("thread-a")).toBe(true);
    desktopGateway.removeThread("thread-a");
  });

  it("requires both route token and matching thread identity", () => {
    const router = new AuthenticatedPreviewRouter();
    router.register({
      routeId: "app",
      threadId: "thread-a",
      hostname: "exact-container-a",
      internalPort: 3000,
      token: "secret-a",
    });
    expect(router.resolve({ routeId: "app", threadId: "thread-a", token: "secret-a" })).toEqual({
      hostname: "exact-container-a",
      port: 3000,
    });
    expect(router.resolve({ routeId: "app", threadId: "thread-b", token: "secret-a" })).toBeNull();
    expect(router.resolve({ routeId: "app", threadId: "thread-a", token: "secret-b" })).toBeNull();
  });

  it("allows identical internal service ports in isolated thread networks", () => {
    const declaration = [
      { name: "web", image: `web@sha256:${"a".repeat(64)}`, internalPorts: [3000] },
    ];
    const [a] = planThreadServiceStack("thread-a", declaration);
    const [b] = planThreadServiceStack("thread-b", declaration);
    expect(a!.internalPorts).toEqual([3000]);
    expect(b!.internalPorts).toEqual([3000]);
    expect(a!.hostPorts).toEqual([]);
    expect(a!.networkName).not.toBe(b!.networkName);
    expect(a!.name).not.toBe(b!.name);
  });

  it("starts service containers without host ports or credentials in argv", async () => {
    const commands: SandboxCommand[] = [];
    const executor = {
      run: async (command: SandboxCommand): Promise<SandboxCommandResult> => {
        commands.push(command);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const runtime = new ThreadServiceStackRuntime("podman", executor);
    await runtime.start(
      "thread-a",
      [
        {
          name: "database",
          image: `postgres@sha256:${"b".repeat(64)}`,
          internalPorts: [5432],
          environment: { DATABASE_PASSWORD: "not-in-argv" },
        },
      ],
      "t3-net-authoritative",
    );
    const run = commands[0]!;
    expect(run.args).not.toContain("-p");
    expect(run.args.join(" ")).not.toContain("not-in-argv");
    expect(run.stdin).toContain("DATABASE_PASSWORD=not-in-argv");
    expect(run.args).toContain("t3-net-authoritative");
  });

  it("generates thread-scoped service credentials only in stdin", async () => {
    const commands: SandboxCommand[] = [];
    const runtime = new ThreadServiceStackRuntime("podman", {
      run: async (command) => {
        commands.push(command);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const [service] = await runtime.start(
      "thread-a",
      [
        {
          name: "database",
          image: `postgres@sha256:${"b".repeat(64)}`,
          generatedEnvironment: [
            { key: "POSTGRES_DB", kind: "database-name" },
            { key: "POSTGRES_PASSWORD", kind: "password" },
          ],
        },
      ],
      "t3-net-authoritative",
    );
    expect(service?.environment.POSTGRES_DB).toMatch(/^db_[a-f0-9]{16}$/);
    expect(service?.environment.POSTGRES_PASSWORD?.length).toBeGreaterThan(32);
    expect(commands[0]?.args.join(" ")).not.toContain(service?.environment.POSTGRES_PASSWORD);
    expect(commands[0]?.stdin).toContain("POSTGRES_PASSWORD=");
  });

  it("expires and thread-scopes one-shot credentials", () => {
    let now = 1_000;
    const broker = new ThreadCredentialBroker(() => now);
    const wrongThread = broker.issue({
      threadId: "thread-a",
      scope: "git",
      value: "value",
      ttlMs: 100,
    });
    expect(broker.redeem({ ...wrongThread, threadId: "thread-b", scope: "git" })).toBeNull();
    expect(broker.redeem({ ...wrongThread, threadId: "thread-a", scope: "git" })).toBe("value");
    expect(broker.redeem({ ...wrongThread, threadId: "thread-a", scope: "git" })).toBeNull();
    const expired = broker.issue({
      threadId: "thread-a",
      scope: "package",
      value: "value",
      ttlMs: 100,
    });
    now += 101;
    expect(broker.redeem({ ...expired, threadId: "thread-a", scope: "package" })).toBeNull();
    const revoked = broker.issue({
      threadId: "thread-a",
      scope: "git",
      value: "value",
      ttlMs: 100,
    });
    expect(broker.revoke(revoked.id, "thread-b")).toBe(false);
    expect(broker.revoke(revoked.id, "thread-a")).toBe(true);
    expect(broker.redeem({ ...revoked, threadId: "thread-a", scope: "git" })).toBeNull();
  });

  const privateUrl = (host: string, path = "") => ["http:/", "/", host, path].join("");

  it.each([
    "http://127.0.0.1",
    privateUrl([10, 2, 3, 4].join(".")),
    privateUrl([172, 16, 0, 1].join(".")),
    privateUrl([192, 168, 1, 2].join(".")),
    privateUrl([169, 254, 169, 254].join("."), "/latest/meta-data"),
    "http://[::1]",
    privateUrl(`[${["fd00", "", "1"].join(":")}]`),
    "file:///etc/passwd",
  ])("denies protected egress destination %s", (destination: string) => {
    expect(evaluateEgressDestination(destination).allowed).toBe(false);
  });

  it("denies known cross-sandbox hosts while allowing public HTTPS", () => {
    expect(evaluateEgressDestination(privateUrl("thread-b"), new Set(["thread-b"])).allowed).toBe(
      false,
    );
    expect(evaluateEgressDestination("https://example.com")).toEqual({ allowed: true });
  });

  it("denies DNS rebinding to a private address", async () => {
    await expect(
      evaluateResolvedEgressDestination("https://public.example", async () => ["10.0.0.8"]),
    ).resolves.toEqual({ allowed: false, reason: "destination resolved to a protected address" });
  });

  it("isolates preview proxy routes, bounds bodies, and cleans up its container", async () => {
    const commands: SandboxCommand[] = [];
    const executor = {
      run: async (command: SandboxCommand): Promise<SandboxCommandResult> => {
        commands.push(command);
        return command.args.includes("request")
          ? {
              exitCode: 0,
              stdout: JSON.stringify({ status: 200, headers: {}, bodyBase64: "" }),
              stderr: "",
            }
          : command.args.includes("signal")
            ? { exitCode: 0, stdout: JSON.stringify({ messages: [] }), stderr: "" }
            : { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const router = new AuthenticatedPreviewRouter();
    router.register({
      routeId: "app",
      threadId: "thread-a",
      hostname: "exact-container-a",
      internalPort: 3000,
      token: "route-token",
    });
    const proxy = new ThreadPreviewProxy("podman", executor, router);
    await proxy.start("thread-a", "t3-net-authoritative", `proxy@sha256:${"a".repeat(64)}`);
    expect(proxy.internalSignalingOrigin("thread-a")).toMatch(
      /^http:\/\/t3-preview-[a-f0-9]{24}:8080$/,
    );
    expect(commands[0]?.args).toContain("--signaling-relay");
    await expect(proxy.signal("thread-a", { type: "poll" })).resolves.toEqual({ messages: [] });
    expect(await proxy.recover("thread-a")).toBe(false);
    await expect(
      proxy.request({
        routeId: "app",
        threadId: "thread-b",
        token: "route-token",
        method: "GET",
        path: "/",
        headers: {},
      }),
    ).rejects.toThrow(/authorized/);
    await expect(
      proxy.request({
        routeId: "app",
        threadId: "thread-a",
        token: "route-token",
        method: "POST",
        path: "/",
        headers: {},
        body: new Uint8Array(8 * 1024 * 1024 + 1),
      }),
    ).rejects.toThrow(/too large/);
    await expect(
      proxy.request({
        routeId: "app",
        threadId: "thread-a",
        token: "route-token",
        method: "GET",
        path: "/",
        headers: {},
      }),
    ).resolves.toMatchObject({ status: 200 });
    expect(
      proxy.webSocketCommand({
        routeId: "app",
        threadId: "thread-b",
        token: "route-token",
        path: "/hmr",
        headers: {},
      }),
    ).toBeNull();
    const websocket = proxy.webSocketCommand({
      routeId: "app",
      threadId: "thread-a",
      token: "route-token",
      path: "/hmr",
      headers: { authorization: "Bearer secret" },
    });
    expect(websocket?.args).toContain("websocket-framed");
    expect(websocket?.handshake).not.toContain("Bearer secret");
    await proxy.stop("thread-a");
    expect(commands.at(-1)?.args[0]).toBe("rm");
    expect(commands.at(-1)?.args[1]).toBe("--force");
    expect(commands.at(-1)?.args[2]).toMatch(/^t3-preview-[a-f0-9]{24}$/);
  });
});
