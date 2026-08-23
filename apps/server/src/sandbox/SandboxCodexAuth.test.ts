// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import { readSandboxCodexChatgptAuth } from "./SandboxCodexAuth.ts";

describe("SandboxCodexAuth", () => {
  it.effect("extracts only the external ChatGPT fields", () =>
    Effect.gen(function* () {
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sandbox-codex-auth-"));
      yield* Effect.addFinalizer(() => Effect.sync(() => NodeFS.rmSync(home, { recursive: true })));
      NodeFS.writeFileSync(
        NodePath.join(home, "auth.json"),
        '{"auth_mode":"chatgpt","tokens":{"access_token":"access-test-only","account_id":"account-test-only","id_token":"id-must-not-cross","refresh_token":"refresh-must-not-cross"}}',
        { mode: 0o600 },
      );

      const auth = yield* readSandboxCodexChatgptAuth(home);

      expect(auth).toEqual({
        accessToken: "access-test-only",
        chatgptAccountId: "account-test-only",
      });
      expect(Object.keys(auth ?? {}).sort()).toEqual(["accessToken", "chatgptAccountId"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("ignores non-ChatGPT auth so the API-key proxy path can handle it", () =>
    Effect.gen(function* () {
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sandbox-codex-auth-"));
      yield* Effect.addFinalizer(() => Effect.sync(() => NodeFS.rmSync(home, { recursive: true })));
      NodeFS.writeFileSync(
        NodePath.join(home, "auth.json"),
        '{"auth_mode":"apikey","OPENAI_API_KEY":"test-only"}',
        { mode: 0o600 },
      );

      expect(yield* readSandboxCodexChatgptAuth(home)).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails closed when ChatGPT auth lacks an account identifier", () =>
    Effect.gen(function* () {
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sandbox-codex-auth-"));
      yield* Effect.addFinalizer(() => Effect.sync(() => NodeFS.rmSync(home, { recursive: true })));
      NodeFS.writeFileSync(
        NodePath.join(home, "auth.json"),
        '{"auth_mode":"chatgpt","tokens":{"access_token":"access-test-only","refresh_token":"refresh-test-only"}}',
        { mode: 0o600 },
      );

      const error = yield* readSandboxCodexChatgptAuth(home).pipe(Effect.flip);
      expect(error.issue).toContain("account identifier");
      expect(error.cause).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
