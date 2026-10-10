import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";

import * as CodexClient from "./client.ts";
import * as CodexErrors from "./errors.ts";

const mockPeerPath = Effect.map(Effect.service(Path.Path), (path) =>
  path.join(import.meta.dirname, "../test/fixtures/codex-app-server-mock-peer.ts"),
);
const mockPeerArgs = (path: string) => [path];

it.layer(NodeServices.layer)("effect-codex-app-server client", (it) => {
  const makeHandle = (env?: Record<string, string>) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const peerCwd = path.join(import.meta.dirname, "..");
      const command = ChildProcess.make(process.execPath, mockPeerArgs(yield* mockPeerPath), {
        cwd: peerCwd,
        ...(env ? { env: { ...process.env, ...env } } : {}),
      });
      return yield* spawner.spawn(command);
    });

  it.effect("initializes, handles typed server requests, and reads account and skills data", () =>
    Effect.gen(function* () {
      const userInputRequests = yield* Ref.make<Array<unknown>>([]);
      const messageDeltas = yield* Ref.make<Array<unknown>>([]);
      const handle = yield* makeHandle();
      const scope = yield* Scope.make();
      const clientLayer = CodexClient.layerChildProcess(handle);
      const context = yield* Layer.buildWithScope(clientLayer, scope);

      const result = yield* Effect.gen(function* () {
        const client = yield* CodexClient.CodexAppServerClient;

        yield* client.handleServerRequest("item/tool/requestUserInput", (payload) =>
          Ref.update(userInputRequests, (current) => [...current, payload]).pipe(
            Effect.as({
              answers: {
                approved: {
                  answers: ["yes"],
                },
              },
            }),
          ),
        );

        yield* client.handleServerNotification("item/agentMessage/delta", (payload) =>
          Ref.update(messageDeltas, (current) => [...current, payload]),
        );

        const initialized = yield* client.request("initialize", {
          clientInfo: {
            name: "effect-codex-app-server-test",
            title: "Effect Codex App Server Test",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null,
          },
        });
        assert.equal(initialized.userAgent, "mock-codex-app-server");

        yield* client.notify("initialized", undefined);

        const account = yield* client.request("account/read", {});
        assert.equal(account.requiresOpenaiAuth, false);
        assert.deepEqual(account.account, {
          type: "chatgpt",
          email: "mock@example.com",
          planType: "plus",
        });

        const path = yield* Path.Path;
        const peerCwd = path.join(import.meta.dirname, "..");
        const skills = yield* client.request("skills/list", { cwds: [peerCwd] });
        assert.equal(skills.data.length, 1);
        assert.equal(skills.data[0]?.cwd, peerCwd);

        return {
          account,
          skills,
        };
      }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));

      assert.equal(result.skills.data[0]?.skills.length, 0);
      assert.deepEqual(yield* Ref.get(userInputRequests), [
        {
          isBlocking: true,
          itemId: "item-approval-1",
          threadId: "thread-1",
          turnId: "turn-1",
          questions: [
            {
              id: "approved",
              header: "Approve",
              question: "Continue with the mock skills request?",
              options: [
                {
                  label: "yes",
                  description: "Approve the request",
                },
              ],
            },
          ],
        },
      ]);
      assert.deepEqual(yield* Ref.get(messageDeltas), [
        {
          delta: "Mock server is ready.",
          itemId: "item-1",
          threadId: "thread-1",
          turnId: "turn-1",
        },
      ]);
    }),
  );
  it.effect("reports the child's final stderr lines when it exits during startup", () =>
    Effect.gen(function* () {
      const diagnostics = [
        "WARN codex_core: No space left on device (os error 28) at .codex/tmp/arg0/lock",
        "Error: failed to initialize sqlite state runtime under <codex-home>",
        "",
      ].join("\n");
      const handle = yield* makeHandle({
        CODEX_APP_SERVER_TEST_STARTUP_FAILURE_STDERR: diagnostics,
        // ~11 KB of filler, well past the retained tail bound.
        CODEX_APP_SERVER_TEST_STARTUP_FAILURE_FILLER_LINES: "500",
      });
      const forwarded = yield* Ref.make("");
      const scope = yield* Scope.make();
      const clientLayer = CodexClient.layerChildProcess(handle, {
        onStderr: (text) => Ref.update(forwarded, (current) => current + text),
      });
      const context = yield* Layer.buildWithScope(clientLayer, scope);

      const error = yield* Effect.gen(function* () {
        const client = yield* CodexClient.CodexAppServerClient;
        return yield* client.request("initialize", {
          clientInfo: {
            name: "effect-codex-app-server-test",
            title: "Effect Codex App Server Test",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null,
          },
        });
      }).pipe(
        Effect.flip,
        Effect.timeout("5 seconds"),
        Effect.provide(context),
        Effect.ensuring(Scope.close(scope, Exit.void)),
      );

      assert.instanceOf(error, CodexErrors.CodexAppServerProcessExitedError);
      assert.equal(error.code, 1);
      assert.isDefined(error.stderrTail);
      assert.isAtMost(error.stderrTail!.length, 4096);
      assert.isTrue(error.stderrTail!.endsWith(diagnostics));
      assert.equal(
        error.message,
        "Codex App Server process exited with code 1: filler diagnostic line | filler diagnostic line | filler diagnostic line | WARN codex_core: No space left on device (os error 28) at .codex/tmp/arg0/lock | Error: failed to initialize sqlite state runtime under <codex-home>",
      );

      // The client is the sole stderr reader and forwards everything it read.
      const forwardedText = yield* Ref.get(forwarded);
      assert.equal(
        forwardedText.length,
        "filler diagnostic line\n".length * 500 + diagnostics.length,
      );
      assert.isTrue(forwardedText.endsWith(diagnostics));
    }),
  );
  it.effect("waits briefly for stderr that is still in flight when the exit is observed", () =>
    Effect.gen(function* () {
      const diagnostics = "Error: failed to initialize sqlite state runtime\n";
      // stdout has already ended and the exit code is known, but the final
      // stderr bytes arrive a moment later, as they can from a real pipe.
      const handle = {
        pid: ChildProcessSpawner.ProcessId(4242),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.fromEffect(
          Effect.sleep("50 millis").pipe(Effect.as(new TextEncoder().encode(diagnostics))),
        ),
      } as unknown as ChildProcessSpawner.ChildProcessHandle;
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(CodexClient.layerChildProcess(handle), scope);

      const errorFiber = yield* Effect.gen(function* () {
        const client = yield* CodexClient.CodexAppServerClient;
        return yield* client.request("initialize", {
          clientInfo: {
            name: "effect-codex-app-server-test",
            title: "Effect Codex App Server Test",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null,
          },
        });
      }).pipe(
        Effect.flip,
        Effect.provide(context),
        Effect.ensuring(Scope.close(scope, Exit.void)),
        Effect.forkChild,
      );
      // Past the late stderr write, well short of the settle timeout.
      yield* TestClock.adjust("100 millis");
      const error = yield* Fiber.join(errorFiber);

      assert.instanceOf(error, CodexErrors.CodexAppServerProcessExitedError);
      assert.equal(error.stderrTail, diagnostics);
      assert.equal(
        error.message,
        "Codex App Server process exited with code 1: Error: failed to initialize sqlite state runtime",
      );
    }),
  );

  it.effect("drains child stderr so large diagnostics cannot block protocol responses", () =>
    Effect.gen(function* () {
      const handle = yield* makeHandle({
        CODEX_APP_SERVER_TEST_STDERR_BYTES: String(512 * 1024),
      });
      const scope = yield* Scope.make();
      const clientLayer = CodexClient.layerChildProcess(handle);
      const context = yield* Layer.buildWithScope(clientLayer, scope);

      const initialized = yield* Effect.gen(function* () {
        const client = yield* CodexClient.CodexAppServerClient;
        return yield* client.request("initialize", {
          clientInfo: {
            name: "effect-codex-app-server-test",
            title: "Effect Codex App Server Test",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null,
          },
        });
      }).pipe(
        Effect.timeout("5 seconds"),
        Effect.provide(context),
        Effect.ensuring(Scope.close(scope, Exit.void)),
      );

      assert.equal(initialized.userAgent, "mock-codex-app-server");
    }),
  );
});
