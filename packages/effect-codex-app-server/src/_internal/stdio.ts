import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as CodexError from "../errors.ts";

const encoder = new TextEncoder();

export const makeChildStdio = (handle: ChildProcessSpawner.ChildProcessHandle) =>
  Stdio.make({
    args: Effect.succeed([]),
    stdin: handle.stdout,
    stdout: () =>
      Sink.mapInput(handle.stdin, (chunk: string | Uint8Array) =>
        typeof chunk === "string" ? encoder.encode(chunk) : chunk,
      ),
    stderr: () => Sink.drain,
  });

export const makeInMemoryStdio = Effect.fn("makeInMemoryStdio")(function* () {
  const input = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const output = yield* Queue.unbounded<string>();
  const decoder = new TextDecoder();

  return {
    stdio: Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.fromQueue(input),
      stdout: () =>
        Sink.forEach((chunk: string | Uint8Array) =>
          Queue.offer(
            output,
            typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }),
          ),
        ),
      stderr: () => Sink.drain,
    }),
    input,
    output,
  };
});

/** Upper bound, in UTF-16 code units, of the retained child stderr tail. */
export const CODEX_STDERR_TAIL_MAX_CHARS = 4096;

/**
 * A bounded rolling tail of decoded stderr text. Only the most recent
 * `maxChars` characters are kept, so a chatty child cannot grow it unbounded.
 */
export const makeStderrTail = (maxChars: number = CODEX_STDERR_TAIL_MAX_CHARS) => {
  let tail = "";
  return {
    append: (text: string): void => {
      if (text.length === 0) return;
      tail += text;
      if (tail.length > maxChars) {
        tail = tail.slice(tail.length - maxChars);
      }
    },
    read: (): string => tail,
  };
};

type ChildProcessTerminationHandle = Pick<
  ChildProcessSpawner.ChildProcessHandle,
  "exitCode" | "pid"
>;

/**
 * Build the error reported when the child's stdout ends. `stderrTail`, when
 * provided, is read only after the exit status resolves so it can include the
 * child's final diagnostics (e.g. "No space left on device").
 */
export const makeTerminationError = (
  handle: ChildProcessTerminationHandle,
  stderrTail?: Effect.Effect<string | undefined>,
): Effect.Effect<CodexError.CodexAppServerError> =>
  Effect.matchEffect(handle.exitCode, {
    onFailure: (cause) =>
      Effect.succeed(
        new CodexError.CodexAppServerTransportError({
          operation: "read-process-exit-status",
          pid: handle.pid,
          cause,
        }),
      ),
    onSuccess: (code) => {
      const exited = (tail: string | undefined) =>
        new CodexError.CodexAppServerProcessExitedError({
          code,
          pid: handle.pid,
          ...(tail !== undefined && tail.trim().length > 0 ? { stderrTail: tail } : {}),
        });
      return stderrTail === undefined
        ? Effect.sync(() => exited(undefined))
        : Effect.map(stderrTail, exited);
    },
  });
