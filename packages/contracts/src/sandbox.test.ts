import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_SANDBOX_RESOURCE_LIMITS,
  SandboxCommand,
  SandboxConfig,
  SandboxEvent,
  SandboxSpawnWorkerInput,
  SandboxState,
} from "./sandbox.ts";

const baseState = {
  lifecycle: "ready",
  sandboxId: "sb-thread-1",
  runtime: "podman",
  runtimeRef: "container-123",
  branch: {
    branchName: "threads/thread-1",
    baseCommit: "a".repeat(40),
  },
  limits: DEFAULT_SANDBOX_RESOURCE_LIMITS,
  desktop: { status: "ready", sessionId: "desktop-1", readyAt: "2026-08-15T00:00:01Z" },
  services: [],
  controller: { kind: "none" },
  createdAt: "2026-08-15T00:00:00Z",
  lastActiveAt: "2026-08-15T00:00:01Z",
};

describe("sandbox contracts", () => {
  it("decodes a complete ready state", () => {
    const decoded = Schema.decodeUnknownSync(SandboxState)(baseState);
    expect(decoded.sandboxId).toBe("sb-thread-1");
    expect(decoded.limits.cpuCount).toBe(2);
  });

  it("represents lazy provisioning without a runtime identity", () => {
    const {
      sandboxId: _sandboxId,
      runtime: _runtime,
      runtimeRef: _runtimeRef,
      ...state
    } = baseState;
    const decoded = Schema.decodeUnknownSync(SandboxState)({
      ...state,
      lifecycle: "unprovisioned",
      desktop: { status: "unavailable" },
    });
    expect(decoded.lifecycle).toBe("unprovisioned");
  });

  it("rejects malformed and unbounded limits", () => {
    const decode = Schema.decodeUnknownSync(SandboxConfig);
    expect(() => decode({ limits: { ...DEFAULT_SANDBOX_RESOURCE_LIMITS, cpuCount: 0 } })).toThrow();
    expect(() =>
      decode({ limits: { ...DEFAULT_SANDBOX_RESOURCE_LIMITS, processCount: 1.5 } }),
    ).toThrow();
    expect(() => decode({ desktop: { width: 99999, height: 900, webRtcEnabled: true } })).toThrow();
  });

  it("rejects invalid branch hashes and oversized inherited patches", () => {
    const decode = Schema.decodeUnknownSync(SandboxSpawnWorkerInput);
    expect(() =>
      decode({ parentThreadId: "parent", task: "work", inheritedCommit: "main" }),
    ).toThrow();
    expect(() =>
      decode({
        parentThreadId: "parent",
        task: "work",
        inheritedCommit: "a".repeat(40),
        inheritedPatch: { sha256: "b".repeat(64), sizeBytes: 50 * 1024 * 1024 + 1 },
      }),
    ).toThrow();
  });

  it("decodes lifecycle commands and events and rejects unknown variants", () => {
    expect(
      Schema.decodeUnknownSync(SandboxCommand)({
        type: "sandbox.takeover",
        threadId: "thread-1",
        sessionId: "viewer-1",
      }).type,
    ).toBe("sandbox.takeover");
    expect(
      Schema.decodeUnknownSync(SandboxEvent)({
        type: "sandbox.reconciled",
        threadId: "thread-1",
        occurredAt: "2026-08-15T00:00:00Z",
        disposition: "orphan-removed",
      }).type,
    ).toBe("sandbox.reconciled");
    expect(() =>
      Schema.decodeUnknownSync(SandboxCommand)({
        type: "sandbox.destroy-host",
        threadId: "thread-1",
      }),
    ).toThrow();
  });
});
