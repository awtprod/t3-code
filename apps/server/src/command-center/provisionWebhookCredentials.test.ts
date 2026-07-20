import { expect, it } from "@effect/vitest";

import { argumentsFrom } from "./provisionWebhookCredentials.ts";

it("accepts pnpm's argument separator before the documented base directory", () => {
  expect(argumentsFrom(["--", "--base-dir", "/tmp/command-center-runtime"])).toEqual({
    baseDir: "/tmp/command-center-runtime",
    replace: false,
  });
});

it("preserves the explicit replacement gate", () => {
  expect(argumentsFrom(["--base-dir", "/tmp/command-center-runtime", "--replace"])).toEqual({
    baseDir: "/tmp/command-center-runtime",
    replace: true,
  });
});

it("rejects relative runtime directories", () => {
  expect(() => argumentsFrom(["--base-dir", "relative/runtime"])).toThrow("Usage:");
});
