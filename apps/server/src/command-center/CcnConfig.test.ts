// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as ServerConfig from "../config.ts";
import { canonicalJson } from "./automation/Digest.ts";
import { loadCcnClipConfig } from "./CcnConfig.ts";

it.effect("keeps CCN roots disabled until a bounded operator file is present", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ccn-config-test-")),
    );
    try {
      const located = { ...config, commandCenterConfigDir: directory };
      expect((yield* Effect.promise(() => loadCcnClipConfig(located))).approvedRoots).toEqual({});
      const file = NodePath.join(directory, "ccn-recording-roots.json");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(file, canonicalJson({ roots: [{ id: "root-a", path: directory }] })),
      );
      expect((yield* Effect.promise(() => loadCcnClipConfig(located))).approvedRoots).toEqual({
        "root-a": directory,
      });
      yield* Effect.promise(() =>
        NodeFSP.writeFile(file, canonicalJson({ roots: [{ id: "root-a", path: "relative" }] })),
      );
      expect(
        yield* Effect.tryPromise({
          try: () => loadCcnClipConfig(located),
          catch: () => new Error("Invalid roots file"),
        }).pipe(Effect.flip),
      ).toBeInstanceOf(Error);
      yield* Effect.promise(() => NodeFSP.writeFile(file, "x".repeat(32 * 1024 + 1)));
      expect(
        yield* Effect.tryPromise({
          try: () => loadCcnClipConfig(located),
          catch: () => new Error("Oversized roots file"),
        }).pipe(Effect.flip),
      ).toBeInstanceOf(Error);
      yield* Effect.promise(() => NodeFSP.rm(file));
      yield* Effect.promise(() => NodeFSP.symlink(NodePath.join(directory, "missing"), file));
      expect(
        yield* Effect.tryPromise({
          try: () => loadCcnClipConfig(located),
          catch: () => new Error("Inaccessible roots file"),
        }).pipe(Effect.flip),
      ).toBeInstanceOf(Error);
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
    }
  }).pipe(
    Effect.provide(
      ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "ccn-config-test-" }),
    ),
    Effect.provide(NodeServices.layer),
  ),
);
