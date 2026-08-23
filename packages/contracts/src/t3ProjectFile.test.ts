import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { T3ProjectFile } from "./t3ProjectFile.ts";

const decode = Schema.decodeUnknownSync(T3ProjectFile);

describe("T3ProjectFile", () => {
  it("decodes a full project file", () => {
    const decoded = decode({
      $schema: "https://t3.codes/schema/t3.json",
      iconPath: "assets/logo.svg",
      scripts: [
        {
          name: "Dev",
          command: "pnpm dev",
          icon: "play",
          runOnWorktreeCreate: false,
          previewUrl: "http://localhost:3000",
          autoOpenPreview: true,
        },
        { name: "Test", command: "pnpm test" },
      ],
    });

    expect(decoded.iconPath).toBe("assets/logo.svg");
    expect(decoded.scripts).toHaveLength(2);
    expect(decoded.scripts?.[1]).toEqual({ name: "Test", command: "pnpm test" });
  });

  it("decodes an empty object and ignores unknown fields", () => {
    expect(decode({})).toEqual({});
    expect(decode({ futureField: true })).toEqual({});
  });

  it("cannot inject Command Center governance or credentials", () => {
    expect(
      decode({
        spaces: [{ id: "forged" }],
        policies: { deploy: "allow" },
        connections: [{ token: "secret" }],
        credentials: { apiKey: "secret" },
        automations: [{ command: "publish" }],
        scripts: [{ name: "Test", command: "pnpm test" }],
      }),
    ).toEqual({ scripts: [{ name: "Test", command: "pnpm test" }] });
  });

  it("trims icon paths and script fields", () => {
    const decoded = decode({
      iconPath: " assets/logo.svg ",
      scripts: [{ name: " Dev ", command: " pnpm dev " }],
    });

    expect(decoded.iconPath).toBe("assets/logo.svg");
    expect(decoded.scripts?.[0]).toEqual({ name: "Dev", command: "pnpm dev" });
  });

  it("rejects scripts without a command", () => {
    expect(() => decode({ scripts: [{ name: "Dev" }] })).toThrow();
  });

  it("rejects unknown script icons", () => {
    expect(() =>
      decode({ scripts: [{ name: "Dev", command: "pnpm dev", icon: "rocket" }] }),
    ).toThrow();
  });

  it("decodes defaultThreadEnvMode and rejects unknown modes", () => {
    expect(decode({ defaultThreadEnvMode: "worktree" }).defaultThreadEnvMode).toBe("worktree");
    expect(decode({ defaultThreadEnvMode: "local" }).defaultThreadEnvMode).toBe("local");
    expect(() => decode({ defaultThreadEnvMode: "remote" })).toThrow();
  });

  it("decodes bounded digest-pinned sandbox declarations", () => {
    const sandbox = decode({
      sandbox: {
        image: `desktop@sha256:${"a".repeat(64)}`,
        services: [
          {
            name: "db",
            image: `postgres@sha256:${"b".repeat(64)}`,
            internalPorts: [5432],
            generatedEnvironment: [{ key: "POSTGRES_PASSWORD", kind: "password" }],
          },
        ],
        setup: [{ executable: "pnpm", args: ["install", "--frozen-lockfile"] }],
        caches: [{ digest: "c".repeat(64), target: "/cache/pnpm" }],
        previewPorts: [3000],
        limits: {
          cpuCount: 4,
          memoryBytes: 12 * 1024 ** 3,
          diskBytes: 20 * 1024 ** 3,
          processCount: 512,
          idleTimeoutSeconds: 3600,
          maximumLifetimeSeconds: 28_800,
        },
      },
    }).sandbox;
    expect(sandbox?.services?.[0]?.name).toBe("db");
    expect(sandbox?.services?.[0]?.generatedEnvironment?.[0]?.key).toBe("POSTGRES_PASSWORD");
    expect(sandbox?.limits?.memoryBytes).toBe(12 * 1024 ** 3);
    expect(() => decode({ sandbox: { image: "desktop:latest" } })).toThrow();
    expect(() =>
      decode({ sandbox: { image: `desktop@sha256:${"a".repeat(64)}`, previewPorts: [0] } }),
    ).toThrow();
  });
});
