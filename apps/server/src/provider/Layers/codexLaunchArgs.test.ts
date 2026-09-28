import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  CODEX_REQUEST_USER_INPUT_FEATURE,
  codexAppServerArgs,
  codexExecLaunchArgs,
  codexRequestUserInputFeatureArgs,
  resolveCodexLaunchArgs,
} from "./codexLaunchArgs.ts";

describe("resolveCodexLaunchArgs", () => {
  it("uses T3CODE_CODEX_LAUNCH_ARGS before configured settings", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { T3CODE_CODEX_LAUNCH_ARGS: "--enable foo" }),
      "--enable foo",
    );
  });

  it("uses configured settings when T3CODE_CODEX_LAUNCH_ARGS is empty", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { T3CODE_CODEX_LAUNCH_ARGS: "   " }),
      "--strict-config",
    );
  });

  it("ignores whitespace-only environment values", () => {
    NodeAssert.equal(resolveCodexLaunchArgs("", { T3CODE_CODEX_LAUNCH_ARGS: "   " }), "");
  });
});

describe("codexAppServerArgs", () => {
  it("returns the app-server command for empty launch args", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs(""), [
      "app-server",
      "-c",
      `features.${CODEX_REQUEST_USER_INPUT_FEATURE}=true`,
    ]);
  });

  it("appends parsed launch args after app-server", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs("--strict-config --enable foo"), [
      "app-server",
      "--strict-config",
      "--enable",
      "foo",
      "-c",
      `features.${CODEX_REQUEST_USER_INPUT_FEATURE}=true`,
    ]);
  });

  it("skips the request-user-input default when launch args configure it", () => {
    for (const launchArgs of [
      "--disable default_mode_request_user_input",
      "-c features.default_mode_request_user_input=false",
      "--enable default_mode_request_user_input",
    ]) {
      NodeAssert.ok(
        !codexAppServerArgs(launchArgs)
          .join(" ")
          .includes(`features.${CODEX_REQUEST_USER_INPUT_FEATURE}=true`),
      );
    }
  });
});

describe("codexRequestUserInputFeatureArgs", () => {
  it("asks Codex to expose the tool in default mode", () => {
    NodeAssert.deepStrictEqual(codexRequestUserInputFeatureArgs(""), [
      "-c",
      "features.default_mode_request_user_input=true",
    ]);
    NodeAssert.deepStrictEqual(codexRequestUserInputFeatureArgs(undefined), [
      "-c",
      "features.default_mode_request_user_input=true",
    ]);
  });

  it("defers to any explicit launch-args mention of the feature", () => {
    for (const launchArgs of [
      "--disable default_mode_request_user_input",
      "--enable default_mode_request_user_input",
      "-c features.default_mode_request_user_input=false",
      "-c features.default_mode_request_user_input=true",
    ]) {
      NodeAssert.deepStrictEqual(codexRequestUserInputFeatureArgs(launchArgs), []);
    }
  });
});

describe("codexExecLaunchArgs", () => {
  it("keeps shared codex flags and omits app-server-only flags", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs('--strict-config --enable foo --listen off --config model="gpt 5"'),
      ["--strict-config", "--enable", "foo", "--config", "model=gpt 5"],
    );
  });

  it("does not pair value-taking flags with adjacent flags", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs("--config --strict-config --enable --disable"), [
      "--strict-config",
    ]);
  });
});
