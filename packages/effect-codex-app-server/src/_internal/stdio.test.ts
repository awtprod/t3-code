import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as CodexError from "../errors.ts";
import { makeStderrTail, makeTerminationError } from "./stdio.ts";

describe("Codex App Server child process termination", () => {
  it.effect("retains the process identifier with the exit code", () =>
    Effect.gen(function* () {
      const error = yield* makeTerminationError({
        pid: ChildProcessSpawner.ProcessId(51),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(9)),
      });

      assert.instanceOf(error, CodexError.CodexAppServerProcessExitedError);
      assert.equal(error.pid, 51);
      assert.equal(error.code, 9);
      assert.equal(error.message, "Codex App Server process exited with code 9");
    }),
  );

  it.effect("attaches the stderr tail and summarizes its last lines in the message", () =>
    Effect.gen(function* () {
      const error = yield* makeTerminationError(
        {
          pid: ChildProcessSpawner.ProcessId(53),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
        },
        Effect.succeed(
          [
            "No space left on device (os error 28) at .codex/tmp/arg0/x",
            "",
            "Error: failed to initialize sqlite state runtime under <codex-home>",
            "",
          ].join("\n"),
        ),
      );

      assert.instanceOf(error, CodexError.CodexAppServerProcessExitedError);
      assert.equal(error.code, 1);
      assert.include(error.stderrTail ?? "", "failed to initialize sqlite state runtime");
      assert.equal(
        error.message,
        "Codex App Server process exited with code 1: No space left on device (os error 28) at .codex/tmp/arg0/x | Error: failed to initialize sqlite state runtime under <codex-home>",
      );
    }),
  );

  it.effect("omits a whitespace-only stderr tail", () =>
    Effect.gen(function* () {
      const error = yield* makeTerminationError(
        {
          pid: ChildProcessSpawner.ProcessId(54),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
        },
        Effect.succeed("\n  \n"),
      );

      assert.instanceOf(error, CodexError.CodexAppServerProcessExitedError);
      assert.isUndefined(error.stderrTail);
      assert.equal(error.message, "Codex App Server process exited with code 1");
    }),
  );

  it.effect("retains the process identifier and exact exit-status cause", () =>
    Effect.gen(function* () {
      const rootCause = new Error("private process diagnostics");
      const cause = PlatformError.systemError({
        _tag: "Unknown",
        module: "ChildProcess",
        method: "exitCode",
        cause: rootCause,
      });
      const error = yield* makeTerminationError({
        pid: ChildProcessSpawner.ProcessId(52),
        exitCode: Effect.fail(cause),
      });

      assert.instanceOf(error, CodexError.CodexAppServerTransportError);
      assert.equal(error.pid, 52);
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        "Codex App Server transport operation 'read-process-exit-status' failed.",
      );
      assert.notInclude(error.message, rootCause.message);
    }),
  );
});

describe("Codex App Server stderr tail", () => {
  it("keeps only the most recent characters", () => {
    const tail = makeStderrTail(10);
    tail.append("0123456789");
    tail.append("abc");
    assert.equal(tail.read(), "3456789abc");
  });

  it("caps the message summary to the last lines and a bounded length", () => {
    const lines = Array.from({ length: 12 }, (_, index) => `line ${index} ${"x".repeat(150)}`);
    const summary = CodexError.summarizeCodexStderrTail(
      `${String.fromCharCode(27)}[31m${lines.join("\r\n")}${String.fromCharCode(27)}[0m`,
    );

    assert.isDefined(summary);
    assert.isAtMost(summary!.length, 500);
    assert.isTrue(summary!.startsWith("..."));
    assert.isTrue(summary!.endsWith(lines[11]!));
    assert.notInclude(summary!, "line 6 ");
    assert.notInclude(summary!, String.fromCharCode(27));
  });
});
